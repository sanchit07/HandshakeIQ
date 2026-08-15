import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { setupGoogleAuth, requireAuth, attachSessionIfPresent } from "./googleAuth";
import { generateIntelligenceReport, extractTextFromImage } from "../services/intelligenceService";
import { CalendarService } from "../services/calendarService";
import { searchPerson, enhancedPersonSearch } from "./googleSearchService";
import bcrypt from "bcryptjs";

// Lightweight in-memory per-IP rate limiter to protect paid AI endpoints
function rateLimit(maxRequests: number, windowMs: number) {
  const hits = new Map<string, number[]>();
  return (req: any, res: any, next: any) => {
    const key = req.ip || req.socket?.remoteAddress || 'unknown';
    const now = Date.now();
    const timestamps = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (timestamps.length >= maxRequests) {
      return res.status(429).json({ message: 'Too many requests. Please wait a moment and try again.' });
    }
    timestamps.push(now);
    hits.set(key, timestamps);
    if (hits.size > 10000) hits.clear(); // prevent unbounded growth
    next();
  };
}

const aiRateLimit = rateLimit(10, 60 * 1000); // 10 requests per minute per IP

export async function registerRoutes(app: Express): Promise<Server> {
  // Setup Google OAuth authentication (includes mock Zoho auth)
  await setupGoogleAuth(app);

  // Auth routes - check if user is logged in (optional, returns null if not)
  app.get('/api/auth/user', attachSessionIfPresent, async (req: any, res) => {
    try {
      // If no user session, return null (guest mode)
      if (!req.session?.user) {
        return res.json(null);
      }
      
      const userId = req.session.user.id;
      const user = await storage.getUser(userId);
      if (!user) return res.json(null);
      const { passwordHash, ...safeUser } = user as any;
      res.json(safeUser);
    } catch (error) {
      console.error("Error fetching user:", error);
      // Return null instead of 500 so user can fall back to guest mode
      // This handles DB connectivity issues gracefully
      return res.json(null);
    }
  });

  // Email/password authentication
  const authRateLimit = rateLimit(15, 60 * 1000);

  // Middleware: require an authenticated admin (verified against the database,
  // not just the session, so a revoked admin loses access immediately)
  const requireAdmin = async (req: any, res: any, next: any) => {
    const sessionUser = req.session?.user;
    if (!sessionUser?.id) {
      return res.status(401).json({ message: "Authentication required" });
    }
    try {
      const dbUser = await storage.getUser(sessionUser.id);
      if (!dbUser?.isAdmin) {
        return res.status(403).json({ message: "Admin access required" });
      }
      next();
    } catch (error) {
      console.error("[ADMIN] Error verifying admin:", error);
      res.status(500).json({ message: "Failed to verify permissions" });
    }
  };

  // Admin-only user management (public self-registration is disabled)
  app.get('/api/admin/users', requireAdmin, async (_req, res) => {
    try {
      const allUsers = await storage.getAllUsers();
      res.json(allUsers.map(({ passwordHash, ...u }: any) => u));
    } catch (error) {
      console.error("[ADMIN] Error listing users:", error);
      res.status(500).json({ message: "Failed to list users" });
    }
  });

  app.post('/api/admin/users', requireAdmin, async (req: any, res) => {
    try {
      const { email, password, firstName, lastName, isAdmin } = req.body;
      if (!email || typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ message: "A valid email is required" });
      }
      if (!password || typeof password !== 'string' || password.length < 8) {
        return res.status(400).json({ message: "Password must be at least 8 characters" });
      }

      const existing = await storage.getUserByEmail(email);
      if (existing) {
        return res.status(409).json({ message: "An account with this email already exists." });
      }

      const passwordHash = await bcrypt.hash(password, 10);
      const user = await storage.createUser({
        email: email.trim(),
        firstName: firstName || null,
        lastName: lastName || null,
        passwordHash,
        isAdmin: !!isAdmin,
      });

      const { passwordHash: _, ...safeUser } = user as any;
      res.json(safeUser);
    } catch (error) {
      console.error("[ADMIN] Error creating user:", error);
      res.status(500).json({ message: "Failed to create user" });
    }
  });

  // Change own password (requires login; verifies current password)
  app.post('/api/auth/change-password', authRateLimit, attachSessionIfPresent, async (req: any, res) => {
    try {
      const sessionUser = req.session?.user;
      if (!sessionUser?.id) {
        return res.status(401).json({ message: "Authentication required" });
      }
      const { currentPassword, newPassword } = req.body;
      if (!currentPassword || !newPassword || typeof newPassword !== 'string') {
        return res.status(400).json({ message: "Current and new password are required" });
      }
      if (newPassword.length < 8) {
        return res.status(400).json({ message: "New password must be at least 8 characters" });
      }

      const user = await storage.getUser(sessionUser.id);
      if (!user?.passwordHash) {
        return res.status(400).json({ message: "This account does not use password login" });
      }

      const valid = await bcrypt.compare(currentPassword, user.passwordHash);
      if (!valid) {
        return res.status(401).json({ message: "Current password is incorrect" });
      }

      const passwordHash = await bcrypt.hash(newPassword, 10);
      await storage.upsertUser({ ...user, passwordHash });

      // Invalidate all OTHER sessions for this user so a stolen session
      // can't survive a password change (current session stays valid)
      try {
        const { db } = await import("./db");
        const { sql } = await import("drizzle-orm");
        await db.execute(sql`DELETE FROM sessions WHERE sess->'user'->>'id' = ${user.id} AND sid != ${req.session.id}`);
      } catch (invalidateErr) {
        console.error("[AUTH] Failed to invalidate other sessions:", invalidateErr);
      }

      res.json({ message: "Password changed successfully" });
    } catch (error) {
      console.error("[AUTH] Error changing password:", error);
      res.status(500).json({ message: "Failed to change password" });
    }
  });

  app.post('/api/login/email', authRateLimit, async (req: any, res) => {
    try {
      const { email, password } = req.body;
      if (!email || !password || typeof email !== 'string' || typeof password !== 'string') {
        return res.status(400).json({ message: "Email and password are required" });
      }

      const user = await storage.getUserByEmail(email);
      if (!user || !user.passwordHash) {
        return res.status(401).json({ message: "Invalid email or password" });
      }

      const valid = await bcrypt.compare(password, user.passwordHash);
      if (!valid) {
        return res.status(401).json({ message: "Invalid email or password" });
      }

      // Regenerate session ID to prevent session fixation
      req.session.regenerate((regenErr: any) => {
        if (regenErr) {
          console.error('[EMAIL AUTH] Session regenerate error:', regenErr);
          return res.status(500).json({ message: "Failed to create session" });
        }
        req.session.user = { id: user.id, email: user.email, provider: 'email', isAdmin: !!user.isAdmin };
        req.session.save((err: any) => {
          if (err) {
            console.error('[EMAIL AUTH] Session save error:', err);
            return res.status(500).json({ message: "Failed to create session" });
          }
          res.json({ id: user.id, email: user.email, isAdmin: !!user.isAdmin });
        });
      });
    } catch (error) {
      console.error("[EMAIL AUTH] Login error:", error);
      res.status(500).json({ message: "Login failed" });
    }
  });

  // Search API routes - NO AUTH REQUIRED for guest access
  app.post('/api/search-person', async (req, res) => {
    try {
      const { personName, company, designation } = req.body;
      if (!personName) {
        return res.status(400).json({ message: "personName is required" });
      }
      const results = await enhancedPersonSearch(personName, company, designation);
      res.json({ results });
    } catch (error) {
      console.error("Error searching for person:", error);
      res.status(500).json({ message: "Failed to search for person" });
    }
  });

  // Gemini API routes - NO AUTH REQUIRED for guest access
  app.post('/api/intelligence-report', aiRateLimit, attachSessionIfPresent, async (req: any, res) => {
    try {
      const { personName, company, links, personTitle, personPhotoUrl, socialMediaLinks } = req.body;
      if (!personName || !company) {
        return res.status(400).json({ message: "personName and company are required" });
      }
      
      const userId = req.session?.user?.id || null;
      
      const existingMatch = await storage.findExactMatch(personName, company, userId);
      if (existingMatch) {
        console.log(`[SEARCH HISTORY] Found exact match for ${personName} at ${company}`);
        return res.json({ 
          report: existingMatch.intelligenceReport, 
          sources: existingMatch.sources,
          fromCache: true 
        });
      }
      
      const result = await generateIntelligenceReport(personName, company, links);
      
      try {
        await storage.saveSearchHistory({
          userId,
          personName,
          personCompany: company,
          personTitle,
          personPhotoUrl,
          intelligenceReport: result.report,
          sources: result.sources,
          socialMediaLinks,
        });
        console.log(`[SEARCH HISTORY] Saved search for ${personName} at ${company}`);
      } catch (historyError) {
        console.error("[SEARCH HISTORY] Failed to save search history:", historyError);
      }
      
      res.json({ ...result, fromCache: false });
    } catch (error) {
      console.error("Error generating intelligence report:", error);
      res.status(500).json({ message: "Failed to generate intelligence report" });
    }
  });

  app.post('/api/extract-card', aiRateLimit, async (req, res) => {
    try {
      const { base64Image } = req.body;
      if (!base64Image || typeof base64Image !== 'string') {
        return res.status(400).json({ message: "base64Image is required" });
      }
      if (base64Image.length > 8 * 1024 * 1024 || !/^[A-Za-z0-9+/=]+$/.test(base64Image)) {
        return res.status(400).json({ message: "Invalid or oversized image payload" });
      }
      const result = await extractTextFromImage(base64Image);
      res.json(result);
    } catch (error) {
      console.error("Error extracting card text:", error);
      res.status(500).json({ message: "Failed to extract card text" });
    }
  });

  // Search History API routes - NO AUTH REQUIRED (supports guest mode)
  app.get('/api/search-history', attachSessionIfPresent, async (req: any, res) => {
    try {
      const userId = req.session?.user?.id || null;
      const limit = parseInt(req.query.limit as string) || 50;
      
      const history = await storage.getSearchHistory(userId, limit);
      res.json(history);
    } catch (error) {
      console.error("Error fetching search history:", error);
      res.status(500).json({ message: "Failed to fetch search history" });
    }
  });

  app.get('/api/search-history/recent', attachSessionIfPresent, async (req: any, res) => {
    try {
      const userId = req.session?.user?.id || null;
      const limit = parseInt(req.query.limit as string) || 10;
      
      const recent = await storage.getRecentSearches(userId, limit);
      res.json(recent);
    } catch (error) {
      console.error("Error fetching recent searches:", error);
      res.status(500).json({ message: "Failed to fetch recent searches" });
    }
  });

  app.post('/api/search-history/find-match', attachSessionIfPresent, async (req: any, res) => {
    try {
      const userId = req.session?.user?.id || null;
      const { personName, personCompany } = req.body;
      
      if (!personName) {
        return res.status(400).json({ message: "personName is required" });
      }
      
      const match = await storage.findExactMatch(personName, personCompany, userId);
      res.json(match || null);
    } catch (error) {
      console.error("Error finding exact match:", error);
      res.status(500).json({ message: "Failed to find match" });
    }
  });

  // Calendar API routes - REQUIRE AUTH
  app.get('/api/calendar/today-tomorrow', requireAuth, async (req: any, res) => {
    try {
      const user = req.session.user;
      if (!user.accessToken) {
        return res.status(401).json({ message: "No access token available" });
      }

      const calendarService = new CalendarService(user.accessToken, user.refreshToken);
      const events = await calendarService.getTodayAndTomorrowEvents();
      res.json(events);
    } catch (error) {
      console.error("Error fetching today/tomorrow events:", error);
      res.status(500).json({ message: "Failed to fetch calendar events" });
    }
  });

  app.get('/api/calendar/upcoming', requireAuth, async (req: any, res) => {
    try {
      const user = req.session.user;
      if (!user.accessToken) {
        return res.status(401).json({ message: "No access token available" });
      }

      const days = parseInt(req.query.days as string) || 30;
      const calendarService = new CalendarService(user.accessToken, user.refreshToken);
      const events = await calendarService.getUpcomingEvents(days);
      res.json(events);
    } catch (error) {
      console.error("Error fetching upcoming events:", error);
      res.status(500).json({ message: "Failed to fetch calendar events" });
    }
  });

  // Dossier API routes - REQUIRE AUTH
  app.post('/api/dossiers', requireAuth, async (req: any, res) => {
    try {
      const userId = req.session.user.id;
      const { personName, personTitle, personCompany, personEmail, personPhotoUrl, intelligenceReport, sources, socialMediaLinks, searchQuery } = req.body;
      
      if (!personName) {
        return res.status(400).json({ message: "personName is required" });
      }

      const dossier = await storage.saveDossier({
        userId,
        personName,
        personTitle,
        personCompany,
        personEmail,
        personPhotoUrl,
        intelligenceReport,
        sources,
        socialMediaLinks,
        searchQuery,
      });

      res.json(dossier);
    } catch (error) {
      console.error("Error saving dossier:", error);
      res.status(500).json({ message: "Failed to save dossier" });
    }
  });

  app.get('/api/dossiers', requireAuth, async (req: any, res) => {
    try {
      const userId = req.session.user.id;
      const dossiers = await storage.getDossiersByUser(userId);
      res.json(dossiers);
    } catch (error) {
      console.error("Error fetching dossiers:", error);
      res.status(500).json({ message: "Failed to fetch dossiers" });
    }
  });

  app.get('/api/dossiers/:id', requireAuth, async (req: any, res) => {
    try {
      const dossier = await storage.getDossier(req.params.id);
      if (!dossier) {
        return res.status(404).json({ message: "Dossier not found" });
      }
      
      if (dossier.userId !== req.session.user.id) {
        return res.status(403).json({ message: "Access denied" });
      }

      res.json(dossier);
    } catch (error) {
      console.error("Error fetching dossier:", error);
      res.status(500).json({ message: "Failed to fetch dossier" });
    }
  });

  app.delete('/api/dossiers/:id', requireAuth, async (req: any, res) => {
    try {
      const dossier = await storage.getDossier(req.params.id);
      if (!dossier) {
        return res.status(404).json({ message: "Dossier not found" });
      }
      
      if (dossier.userId !== req.session.user.id) {
        return res.status(403).json({ message: "Access denied" });
      }

      await storage.deleteDossier(req.params.id);
      res.json({ message: "Dossier deleted successfully" });
    } catch (error) {
      console.error("Error deleting dossier:", error);
      res.status(500).json({ message: "Failed to delete dossier" });
    }
  });

  // Notes API routes - REQUIRE AUTH
  app.post('/api/notes', requireAuth, async (req: any, res) => {
    try {
      const { dossierId, content } = req.body;
      
      if (!dossierId || !content) {
        return res.status(400).json({ message: "dossierId and content are required" });
      }

      const dossier = await storage.getDossier(dossierId);
      if (!dossier) {
        return res.status(404).json({ message: "Dossier not found" });
      }
      
      if (dossier.userId !== req.session.user.id) {
        return res.status(403).json({ message: "Access denied" });
      }

      const note = await storage.addNote({ dossierId, content });
      res.json(note);
    } catch (error) {
      console.error("Error adding note:", error);
      res.status(500).json({ message: "Failed to add note" });
    }
  });

  app.get('/api/notes/:dossierId', requireAuth, async (req: any, res) => {
    try {
      const dossier = await storage.getDossier(req.params.dossierId);
      if (!dossier) {
        return res.status(404).json({ message: "Dossier not found" });
      }
      
      if (dossier.userId !== req.session.user.id) {
        return res.status(403).json({ message: "Access denied" });
      }

      const notes = await storage.getNotesByDossier(req.params.dossierId);
      res.json(notes);
    } catch (error) {
      console.error("Error fetching notes:", error);
      res.status(500).json({ message: "Failed to fetch notes" });
    }
  });

  app.put('/api/notes/:id', requireAuth, async (req: any, res) => {
    try {
      const { content } = req.body;
      if (!content) {
        return res.status(400).json({ message: "content is required" });
      }

      const note = await storage.updateNote(req.params.id, content);
      res.json(note);
    } catch (error) {
      console.error("Error updating note:", error);
      res.status(500).json({ message: "Failed to update note" });
    }
  });

  app.delete('/api/notes/:id', requireAuth, async (req: any, res) => {
    try {
      await storage.deleteNote(req.params.id);
      res.json({ message: "Note deleted successfully" });
    } catch (error) {
      console.error("Error deleting note:", error);
      res.status(500).json({ message: "Failed to delete note" });
    }
  });

  const httpServer = createServer(app);
  return httpServer;
}
