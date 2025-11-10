import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { setupGoogleAuth, requireAuth, attachSessionIfPresent } from "./googleAuth";
import { generateIntelligenceReport, extractTextFromImage } from "../services/geminiService";
import { CalendarService } from "../services/calendarService";

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

  // Gemini API routes - NO AUTH REQUIRED for guest access
  app.post('/api/intelligence-report', async (req, res) => {
    try {
      const { personName, company } = req.body;
      if (!personName || !company) {
        return res.status(400).json({ message: "personName and company are required" });
      }
      const result = await generateIntelligenceReport(personName, company);
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

  const httpServer = createServer(app);
  return httpServer;
}
