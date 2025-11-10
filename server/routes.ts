import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { setupAuth, isAuthenticated } from "./replitAuth";
import { generateIntelligenceReport, extractTextFromImage } from "../services/geminiService";

export async function registerRoutes(app: Express): Promise<Server> {
  // Auth middleware
  await setupAuth(app);

  // Auth routes
  app.get('/api/auth/user', isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.claims.sub;
      const user = await storage.getUser(userId);
      res.json(user);
    } catch (error) {
      console.error("Error fetching user:", error);
      res.status(500).json({ message: "Failed to fetch user" });
    }
  });

  // Gemini API routes
  app.post('/api/intelligence-report', isAuthenticated, async (req, res) => {
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

  app.post('/api/extract-card', isAuthenticated, async (req, res) => {
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

  const httpServer = createServer(app);
  return httpServer;
}
