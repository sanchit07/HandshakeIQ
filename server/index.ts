import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

(async () => {
  const server = await registerRoutes(app);

  // In production, serve the built frontend files
  const isProduction = process.env.NODE_ENV === 'production';
  if (isProduction) {
    const distPath = path.join(__dirname, '../dist');
    app.use(express.static(distPath));
    
    // Serve index.html for all non-API routes (SPA routing)
    app.get('*', (req, res) => {
      if (!req.path.startsWith('/api/')) {
        res.sendFile(path.join(distPath, 'index.html'));
      }
    });
  }

  // Error handling middleware
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";
    res.status(status).json({ message });
  });

  const PORT = parseInt(process.env.PORT || '5000', 10);
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT} (${isProduction ? 'production' : 'development'} mode)`);
  });
})();
