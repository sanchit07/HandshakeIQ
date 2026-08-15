import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: false }));

const isProduction = process.env.NODE_ENV === 'production';

(async () => {
  // Register API routes first
  const server = await registerRoutes(app);

  // In production, serve the built frontend files AFTER API routes
  if (isProduction) {
    const distPath = path.join(__dirname, '../dist');
    
    // Serve static assets (js, css, images, etc.)
    app.use(express.static(distPath));
    
    // SPA fallback - serve index.html for all non-API routes
    app.use((req, res, next) => {
      // If request is for API, let it through to 404
      if (req.path.startsWith('/api/')) {
        return next();
      }
      // Otherwise serve the index.html for client-side routing
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  // Error handling middleware (must be last)
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";
    res.status(status).json({ message });
  });

  // Use port 5000 in production (Replit deployment standard), 3000 in development
  const defaultPort = isProduction ? '5000' : '3000';
  const PORT = parseInt(process.env.PORT || defaultPort, 10);
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT} (${isProduction ? 'production' : 'development'} mode)`);
  });
})();
