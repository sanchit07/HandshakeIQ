import express, { type Request, Response, NextFunction } from "express";
import cron from "node-cron";
import { registerRoutes } from "./routes";
import { runDailyJobSearch, recheckRecentShortlist, recheckContactEvidence, verifyBoardPatterns, resolveCanaryFinalUrl } from "./jobs/jobMatchService";
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
    // Pass resolveCanaryFinalUrl so the probe follows redirects: a board that
    // returns 301→homepage for expired postings (instead of 404) is detected
    // as a stale canary rather than silently logged as OK.
    verifyBoardPatterns(undefined, undefined, undefined, undefined, resolveCanaryFinalUrl).catch((err) =>
      console.error('[BOARD PATTERN] Startup probe failed unexpectedly:', err),
    );
  });

  // Daily job search — every day at 7:00 AM Malaysia time
  // Auto-retry wrapper: if the 7 AM run throws, retry after 30 minutes, up to
  // 3 attempts total. runDailyJobSearch is idempotent (skips if the day exists)
  // so retries are safe.
  const RETRY_DELAY_MS = 30 * 60 * 1000;
  const runDailyWithRetries = async (label: string, attempt = 1): Promise<void> => {
    try {
      const result = await runDailyJobSearch();
      console.log(`[CRON] ${label} done (attempt ${attempt}): ${result.count} jobs for ${result.runDate}${result.skipped ? ' (already existed, skipped)' : ''}`);
    } catch (err) {
      console.error(`[CRON] ${label} failed (attempt ${attempt}/3):`, err);
      if (attempt < 3) {
        console.log(`[CRON] Retrying ${label} in 30 minutes`);
        setTimeout(() => { void runDailyWithRetries(label, attempt + 1); }, RETRY_DELAY_MS);
      } else {
        console.error(`[CRON] ${label} exhausted all 3 attempts — will not retry until next scheduled run or restart`);
      }
    }
  };

  cron.schedule('0 7 * * *', async () => {
    console.log('[CRON] Starting scheduled daily job search');
    await runDailyWithRetries('Daily job search');
    // Re-verify recent shortlist jobs (from the past 7 days) and remove any
    // that have gone dead or stale since they were first shortlisted.
    // Runs after the daily search so today's fresh postings are not re-checked
    // immediately (they were just verified during discovery).
    try {
      const recheckResult = await recheckRecentShortlist();
      console.log(
        `[CRON] Recheck done: ${recheckResult.checked} checked, ${recheckResult.removed.length} removed`,
      );
    } catch (err) {
      console.error('[CRON] Recheck of recent shortlist failed (non-fatal):', err);
    }
    // Re-verify contact evidence pages (LinkedIn profiles, press pages) from
    // the same window; contacts whose evidence has gone 404 are marked stale
    // (never deleted) and surfaced in the alerts panel.
    try {
      const ev = await recheckContactEvidence();
      console.log(`[CRON] Contact evidence recheck done: ${ev.checked} checked, ${ev.markedStale} marked stale`);
    } catch (err) {
      console.error('[CRON] Contact evidence recheck failed (non-fatal):', err);
    }
    // Prepare applications for today's shortlist: resolve official apply routes,
    // draft application emails / assisted packets, and queue everything for the
    // user's review. Sequential AI calls; failures are per-job and non-fatal.
    try {
      const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kuala_Lumpur' }).format(new Date());
      const { prepareApplicationsForDate, getApplySummary } = await import('./jobs/applyService');
      const prep = await prepareApplicationsForDate(today);
      const summary = await getApplySummary(today);
      console.log(`[CRON] Apply preparation done: ${prep.prepared} prepared, ${prep.failed} failed — ${summary.awaitingReview} awaiting review, ${summary.needsUser} need input`);
    } catch (err) {
      console.error('[CRON] Apply preparation failed (non-fatal):', err);
    }
  }, { timezone: 'Asia/Kuala_Lumpur' });

  // Catch-up: if the server was down at 7:00 AM, run the (idempotent) daily
  // search shortly after startup when it's already past 7 AM Malaysia time
  setTimeout(async () => {
    try {
      const klHour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kuala_Lumpur', hour: 'numeric', hour12: false }).format(new Date()));
      if (klHour >= 7) {
        await runDailyWithRetries('Startup catch-up job search');
        // Also catch up on apply preparation — a post-7AM restart must not
        // silently leave the day's applications unprepared.
        try {
          const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kuala_Lumpur' }).format(new Date());
          const { prepareApplicationsForDate } = await import('./jobs/applyService');
          const prep = await prepareApplicationsForDate(today);
          console.log(`[CRON] Startup apply-prep catch-up: ${prep.prepared} prepared, ${prep.failed} failed`);
        } catch (err) {
          console.error('[CRON] Startup apply-prep catch-up failed (non-fatal):', err);
        }
      }
    } catch (err) {
      console.error('[CRON] Startup catch-up job search failed:', err);
    }
  }, 30_000);
})();
