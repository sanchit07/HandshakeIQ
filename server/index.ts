import express, { type Request, Response, NextFunction } from "express";
import cron from "node-cron";
import { registerRoutes } from "./routes";
import { runDailyJobSearch, verifyBoardPatterns } from "./jobs/jobMatchService";
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
    // Startup probe: fetch each board's canary URL and confirm it is live and still
    // matches directUrlPatterns. Warns if a board changed its URL structure or the
    // canary job posting has expired.
    verifyBoardPatterns().catch((err) =>
      console.error('[BOARD PATTERN] Startup probe failed unexpectedly:', err),
    );
  });

  // Daily job search — every day at 7:00 AM Malaysia time
  cron.schedule('0 7 * * *', async () => {
    console.log('[CRON] Starting scheduled daily job search');
    try {
        const result = await runDailyJobSearch();
      console.log(`[CRON] Daily job search done: ${result.count} jobs for ${result.runDate}${result.skipped ? ' (already existed, skipped)' : ''}`);
    } catch (err) {
      console.error('[CRON] Daily job search failed:', err);
    }
  }, { timezone: 'Asia/Kuala_Lumpur' });

  // Catch-up: if the server was down at 7:00 AM, run the (idempotent) daily
  // search shortly after startup when it's already past 7 AM Malaysia time
  setTimeout(async () => {
    try {
      const klHour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kuala_Lumpur', hour: 'numeric', hour12: false }).format(new Date()));
      if (klHour >= 7) {
        const result = await runDailyJobSearch();
        if (!result.skipped) {
          console.log(`[CRON] Startup catch-up job search done: ${result.count} jobs for ${result.runDate}`);
        }
      }
    } catch (err) {
      console.error('[CRON] Startup catch-up job search failed:', err);
    }
  }, 30_000);
})();
