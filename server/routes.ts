import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { setupGoogleAuth, requireAuth, attachSessionIfPresent } from "./googleAuth";
import { generateIntelligenceReport, extractTextFromImage } from "../services/geminiService";
import { CalendarService } from "../services/calendarService";
import { searchPerson, enhancedPersonSearch } from "./googleSearchService";

export async function registerRoutes(app: Express): Promise<Server> {
  // Setup Google OAuth authentication
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
      res.json(user);
    } catch (error) {
      console.error("Error fetching user:", error);
      // Return null instead of 500 so user can fall back to guest mode
      // This handles DB connectivity issues gracefully
      return res.json(null);
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
  app.post('/api/intelligence-report', async (req, res) => {
    try {
      const { personName, company, links } = req.body;
      if (!personName || !company) {
        return res.status(400).json({ message: "personName and company are required" });
      }
      const result = await generateIntelligenceReport(personName, company, links);
      res.json(result);
    } catch (error) {
      console.error("Error generating intelligence report:", error);
      res.status(500).json({ message: "Failed to generate intelligence report" });
    }
  });

  app.post('/api/extract-card', async (req, res) => {
    try {
      const { base64Image } = req.body;
      if (!base64Image) {
        return res.status(400).json({ message: "base64Image is required" });
      }
      const result = await extractTextFromImage(base64Image);
      res.json(result);
    } catch (error) {
      console.error("Error extracting card text:", error);
      res.status(500).json({ message: "Failed to extract card text" });
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
