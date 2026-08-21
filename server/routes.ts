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

  // ===== Job Hunt (admin only) =====
  const {
    runDailyJobSearch, getShortlist, getShortlistDates, tailorCvForJob, clearTailoredCv, getQuestionsForJob, answerQuestion, getBoardAlerts, getGoogleDiscoveryStatus,
    getCountrySchedule, saveCountrySchedule, SUPPORTED_COUNTRIES,
  } = await import('./jobs/jobMatchService');

  app.get('/api/schedule', requireAdmin, async (_req, res) => {
    try {
      res.json({ schedule: await getCountrySchedule(), supportedCountries: SUPPORTED_COUNTRIES });
    } catch (error) {
      console.error('[JOBS] Error fetching country schedule:', error);
      res.status(500).json({ message: 'Failed to fetch country schedule' });
    }
  });

  app.put('/api/schedule', requireAdmin, async (req: any, res) => {
    try {
      const rows = Array.isArray(req.body?.schedule) ? req.body.schedule : [];
      res.json({ schedule: await saveCountrySchedule(rows) });
    } catch (error: any) {
      console.error('[JOBS] Error saving country schedule:', error);
      res.status(500).json({ message: error?.message || 'Failed to save country schedule' });
    }
  });

  app.get('/api/jobs/:id/questions', requireAdmin, async (req: any, res) => {
    try {
      res.json(await getQuestionsForJob(req.params.id));
    } catch (error) {
      console.error('[JOBS] Error fetching questions:', error);
      res.status(500).json({ message: 'Failed to fetch questions' });
    }
  });

  app.post('/api/jobs/questions/:qid/answer', requireAdmin, async (req: any, res) => {
    try {
      const answer = typeof req.body?.answer === 'string' ? req.body.answer.trim() : '';
      if (!answer) return res.status(400).json({ message: 'Answer is required' });
      res.json(await answerQuestion(req.params.qid, answer.slice(0, 4000)));
    } catch (error: any) {
      console.error('[JOBS] Error answering question:', error);
      res.status(500).json({ message: error?.message || 'Failed to save answer' });
    }
  });

  app.get('/api/jobs/dates', requireAdmin, async (_req, res) => {
    try {
      res.json(await getShortlistDates());
    } catch (error) {
      console.error('[JOBS] Error listing dates:', error);
      res.status(500).json({ message: 'Failed to list shortlist dates' });
    }
  });

  app.get('/api/jobs', requireAdmin, async (req: any, res) => {
    try {
      const date = typeof req.query.date === 'string' ? req.query.date : undefined;
      res.json(await getShortlist(date));
    } catch (error) {
      console.error('[JOBS] Error fetching shortlist:', error);
      res.status(500).json({ message: 'Failed to fetch shortlist' });
    }
  });

  app.get('/api/jobs/google-discovery-status', requireAdmin, async (_req, res) => {
    try {
      res.json({ googleDiscoveryStatus: getGoogleDiscoveryStatus() });
    } catch (error) {
      console.error('[JOBS] Error fetching Google discovery status:', error);
      res.status(500).json({ message: 'Failed to fetch Google discovery status' });
    }
  });

  app.get('/api/jobs/board-alerts', requireAdmin, async (req: any, res) => {
    try {
      const date = typeof req.query.date === 'string' ? req.query.date : undefined;
      if (!date) return res.status(400).json({ message: 'date query parameter is required' });
      res.json({ alerts: getBoardAlerts(date), googleDiscoveryStatus: getGoogleDiscoveryStatus() });
    } catch (error) {
      console.error('[JOBS] Error fetching board alerts:', error);
      res.status(500).json({ message: 'Failed to fetch board alerts' });
    }
  });

  const jobsRunRateLimit = rateLimit(3, 10 * 60 * 1000); // 3 runs / 10 min
  const tailorRateLimit = rateLimit(10, 60 * 1000);

  app.post('/api/jobs/run', requireAdmin, jobsRunRateLimit, async (req: any, res) => {
    try {
      const result = await runDailyJobSearch(!!req.body?.force);
      res.json({ ...result, googleDiscoveryStatus: getGoogleDiscoveryStatus() });
    } catch (error: any) {
      console.error('[JOBS] Manual run failed:', error);
      // Include any board alerts and Google status collected before the failure
      const runDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kuala_Lumpur' }).format(new Date());
      const alerts = getBoardAlerts(runDate);
      res.status(500).json({
        message: error?.message || 'Job search run failed. Check server logs.',
        boardAlerts: alerts.length > 0 ? alerts : undefined,
        googleDiscoveryStatus: getGoogleDiscoveryStatus(),
      });
    }
  });

  app.post('/api/jobs/:id/tailor-cv', requireAdmin, tailorRateLimit, async (req: any, res) => {
    try {
      // force=true regenerates the CV (e.g. after answering an admin question)
      if (req.body?.force) await clearTailoredCv(req.params.id);
      const job = await tailorCvForJob(req.params.id);
      res.json(job);
    } catch (error: any) {
      console.error('[JOBS] CV tailoring failed:', error);
      res.status(500).json({ message: error?.message || 'CV tailoring failed' });
    }
  });

  app.post('/api/jobs/:id/find-contacts', requireAdmin, tailorRateLimit, async (req: any, res) => {
    try {
      const { discoverContactsForJob } = await import('./jobs/contactDiscoveryService');
      const result = await discoverContactsForJob(req.params.id);
      res.json(result);
    } catch (error: any) {
      console.error('[CONTACTS] Discovery failed:', error);
      res.status(500).json({ message: error?.message || 'Contact discovery failed' });
    }
  });

  app.get('/api/jobs/:id/contacts', requireAdmin, async (req: any, res) => {
    try {
      const { getContactsForJob } = await import('./jobs/contactDiscoveryService');
      res.json(await getContactsForJob(req.params.id));
    } catch (error: any) {
      res.status(500).json({ message: error?.message || 'Failed to load contacts' });
    }
  });

  app.get('/api/jobs/:id/cv.pdf', requireAdmin, async (req: any, res) => {
    try {
      const { getJobById } = await import('./jobs/jobMatchService');
      const job = await getJobById(req.params.id);
      if (!job) return res.status(404).json({ message: 'Job not found' });
      if (!job.tailoredCv) return res.status(404).json({ message: 'No tailored CV exists for this job yet. Generate one first.' });

      const { generateCvPdf } = await import('./jobs/cvPdfGenerator');
      const { checkCvParseable } = await import('./jobs/cvParseChecker');
      const pdfBuffer = await generateCvPdf(job.tailoredCv, job.title, job.company);

      // Safety-net parse check: catch any CV whose PDF became unparseable
      // after being stored (e.g. due to a renderer change or DB corruption).
      const parseResult = await checkCvParseable(pdfBuffer);
      if (parseResult.ok === false) {
        console.error(`[JOBS] PDF parse check failed for job ${job.id}: ${parseResult.reason}`);
        // Mark the stored CV as failed so the UI shows the correct state
        const { db } = await import('./db');
        const { jobMatches } = await import('../shared/schema.js');
        const { eq } = await import('drizzle-orm');
        await db.update(jobMatches).set({ status: 'cv_failed' }).where(eq(jobMatches.id, job.id)).catch(() => {});
        return res.status(422).json({ message: `CV failed ATS parse check: ${parseResult.reason}` });
      }

      const safeName = `CV_${job.company.replace(/[^a-z0-9]/gi, '_')}_${job.title.replace(/[^a-z0-9]/gi, '_')}.pdf`;
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
      res.setHeader('Content-Length', pdfBuffer.length);
      res.send(pdfBuffer);
    } catch (error: any) {
      console.error('[JOBS] PDF generation failed:', error);
      res.status(500).json({ message: error?.message || 'PDF generation failed' });
    }
  });

  // ── Auto-apply engine ──────────────────────────────────────────────────────

  app.get('/api/profile', requireAdmin, async (_req, res) => {
    try {
      const { getProfile } = await import('./jobs/applyService');
      res.json(await getProfile());
    } catch (error: any) {
      res.status(500).json({ message: error?.message || 'Failed to load profile' });
    }
  });

  app.put('/api/profile', requireAdmin, async (req: any, res) => {
    try {
      const { saveProfile } = await import('./jobs/applyService');
      res.json(await saveProfile(req.body || {}));
    } catch (error: any) {
      console.error('[PROFILE] Save failed:', error);
      res.status(500).json({ message: error?.message || 'Failed to save profile' });
    }
  });

  app.post('/api/profile/seed', requireAdmin, async (_req, res) => {
    try {
      const { seedProfileFromResume } = await import('./jobs/applyService');
      res.json(await seedProfileFromResume());
    } catch (error: any) {
      console.error('[PROFILE] Seed failed:', error);
      res.status(500).json({ message: error?.message || 'Failed to seed profile' });
    }
  });

  const applyRateLimit = rateLimit(20, 10 * 60 * 1000); // 20 apply preps / 10 min

  // Prepare (or retry) the application for one job: route → draft/packet → ready_for_review
  app.post('/api/jobs/:id/apply/prepare', requireAdmin, applyRateLimit, async (req: any, res) => {
    try {
      const { prepareApplication } = await import('./jobs/applyService');
      res.json(await prepareApplication(req.params.id));
    } catch (error: any) {
      console.error('[APPLY] Prepare failed:', error);
      res.status(500).json({ message: error?.message || 'Application preparation failed' });
    }
  });

  // Applications for a batch of jobs (UI list view)
  app.post('/api/applications/for-jobs', requireAdmin, async (req: any, res) => {
    try {
      const jobIds = Array.isArray(req.body?.jobIds) ? req.body.jobIds.map(String).slice(0, 100) : [];
      const { getApplicationsForJobs } = await import('./jobs/applyService');
      res.json(await getApplicationsForJobs(jobIds));
    } catch (error: any) {
      res.status(500).json({ message: error?.message || 'Failed to load applications' });
    }
  });

  // Approve a reviewed application (email: sends via Gmail; assisted: marks submitted)
  app.post('/api/applications/:id/approve', requireAdmin, applyRateLimit, async (req: any, res) => {
    try {
      const { approveApplication } = await import('./jobs/applyService');
      const edits = {
        emailSubject: typeof req.body?.emailSubject === 'string' ? req.body.emailSubject : undefined,
        emailBody: typeof req.body?.emailBody === 'string' ? req.body.emailBody : undefined,
      };
      res.json(await approveApplication(req.params.id, edits));
    } catch (error: any) {
      console.error('[APPLY] Approve failed:', error);
      res.status(500).json({ message: error?.message || 'Approval failed' });
    }
  });

  // Screenshots captured by the headless ATS submitter (list + image)
  app.get('/api/applications/:id/screenshots', requireAdmin, async (req: any, res) => {
    try {
      const { getScreenshotsMeta } = await import('./jobs/atsSubmitter/index.js');
      res.json(await getScreenshotsMeta(req.params.id));
    } catch (error: any) {
      res.status(500).json({ message: error?.message || 'Failed to load screenshots' });
    }
  });
  app.get('/api/applications/:id/screenshots/:shotId', requireAdmin, async (req: any, res) => {
    try {
      const { getScreenshot } = await import('./jobs/atsSubmitter/index.js');
      const shot = await getScreenshot(req.params.id, req.params.shotId);
      if (!shot) return res.status(404).json({ message: 'Screenshot not found' });
      res.setHeader('Content-Type', shot.mime);
      res.setHeader('Cache-Control', 'private, max-age=3600');
      res.send(Buffer.from(shot.dataBase64, 'base64'));
    } catch (error: any) {
      res.status(500).json({ message: error?.message || 'Failed to load screenshot' });
    }
  });

  // ── ATS credential vault (per-company accounts, encrypted at rest) ──
  app.get('/api/vault/credentials', requireAdmin, async (_req, res) => {
    try {
      const { listCredentials } = await import('./jobs/atsSubmitter/credentialVault.js');
      res.json(await listCredentials());
    } catch (error: any) {
      res.status(500).json({ message: error?.message || 'Failed to load credentials' });
    }
  });
  app.post('/api/vault/credentials/:id/reveal', requireAdmin, async (req: any, res) => {
    try {
      const { revealCredential } = await import('./jobs/atsSubmitter/credentialVault.js');
      const out = await revealCredential(req.params.id);
      if (!out) return res.status(404).json({ message: 'Credential not found' });
      res.setHeader('Cache-Control', 'no-store');
      res.json(out);
    } catch (error: any) {
      res.status(500).json({ message: error?.message || 'Failed to reveal credential' });
    }
  });
  app.delete('/api/vault/credentials/:id', requireAdmin, async (req: any, res) => {
    try {
      const { deleteCredential } = await import('./jobs/atsSubmitter/credentialVault.js');
      res.json({ deleted: await deleteCredential(req.params.id) });
    } catch (error: any) {
      res.status(500).json({ message: error?.message || 'Failed to delete credential' });
    }
  });

  // ── Domain guard-rails (cooldowns / downgrades, user-visible + resettable) ──
  app.get('/api/vault/domain-controls', requireAdmin, async (_req, res) => {
    try {
      const { listDomainControls } = await import('./jobs/atsSubmitter/guardrails.js');
      res.json(await listDomainControls());
    } catch (error: any) {
      res.status(500).json({ message: error?.message || 'Failed to load domain controls' });
    }
  });
  app.post('/api/vault/domain-controls/:domain/reset', requireAdmin, async (req: any, res) => {
    try {
      const { resetDomainControl } = await import('./jobs/atsSubmitter/guardrails.js');
      await resetDomainControl(String(req.params.domain));
      res.json({ reset: true });
    } catch (error: any) {
      res.status(500).json({ message: error?.message || 'Failed to reset domain' });
    }
  });

  // ── Live CAPTCHA hand-off (remote view + input forwarding) ──
  app.get('/api/handoffs', requireAdmin, async (_req, res) => {
    try {
      const { listHandoffs } = await import('./jobs/atsSubmitter/handoff.js');
      res.json(await listHandoffs());
    } catch (error: any) {
      res.status(500).json({ message: error?.message || 'Failed to list hand-offs' });
    }
  });
  app.get('/api/handoffs/:id/frame', requireAdmin, async (req: any, res) => {
    try {
      const { handoffFrame } = await import('./jobs/atsSubmitter/handoff.js');
      const frame = await handoffFrame(req.params.id);
      if (!frame) return res.status(404).json({ message: 'Hand-off not found or frame unavailable' });
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Cache-Control', 'no-store');
      res.send(frame);
    } catch (error: any) {
      res.status(500).json({ message: error?.message || 'Failed to capture frame' });
    }
  });
  app.post('/api/handoffs/:id/input', requireAdmin, async (req: any, res) => {
    try {
      const { handoffInput } = await import('./jobs/atsSubmitter/handoff.js');
      const ok = await handoffInput(req.params.id, req.body);
      res.json({ ok });
    } catch (error: any) {
      res.status(500).json({ message: error?.message || 'Input failed' });
    }
  });
  app.post('/api/handoffs/:id/resolve', requireAdmin, async (req: any, res) => {
    try {
      const { finishHandoff } = await import('./jobs/atsSubmitter/handoff.js');
      const resolution = req.body?.resolution === 'aborted' ? 'aborted' : 'solved';
      res.json({ ok: await finishHandoff(req.params.id, resolution) });
    } catch (error: any) {
      res.status(500).json({ message: error?.message || 'Failed to resolve hand-off' });
    }
  });

  // ── Email-verification link (manual paste fallback for portal signups) ──
  app.post('/api/applications/:id/verification-link', requireAdmin, async (req: any, res) => {
    try {
      const link = String(req.body?.link || '').trim();
      if (!link) return res.status(400).json({ message: 'link required' });
      const { setVerificationLink } = await import('./jobs/atsSubmitter/loginWalled.js');
      await setVerificationLink(req.params.id, link);
      res.json({ saved: true });
    } catch (error: any) {
      res.status(400).json({ message: error?.message || 'Failed to save verification link' });
    }
  });

  // Day-level apply summary for the dashboard / daily report
  app.get('/api/applications/summary', requireAdmin, async (req: any, res) => {
    try {
      const date = String(req.query.date || '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ message: 'date=YYYY-MM-DD required' });
      const { getApplySummary } = await import('./jobs/applyService');
      res.json(await getApplySummary(date));
    } catch (error: any) {
      res.status(500).json({ message: error?.message || 'Failed to load summary' });
    }
  });

  // Batch-prepare applications for a run date (also runs from the daily cron)
  const applyBatchRateLimit = rateLimit(3, 10 * 60 * 1000);
  app.post('/api/applications/prepare-batch', requireAdmin, applyBatchRateLimit, async (req: any, res) => {
    try {
      const date = String(req.body?.date || '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ message: 'date=YYYY-MM-DD required' });
      const { prepareApplicationsForDate } = await import('./jobs/applyService');
      // Long-running (sequential AI calls) — respond immediately, run in background
      res.json({ started: true, date });
      prepareApplicationsForDate(date).catch((e) => console.error('[APPLY] Batch preparation crashed:', e));
    } catch (error: any) {
      res.status(500).json({ message: error?.message || 'Batch preparation failed' });
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

  app.post('/api/register/email', authRateLimit, async (req: any, res) => {
    try {
      const { email, password, firstName, lastName } = req.body;
      if (!email || typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ message: "A valid email is required" });
      }
      if (!password || typeof password !== 'string' || password.length < 8) {
        return res.status(400).json({ message: "Password must be at least 8 characters" });
      }

      const existing = await storage.getUserByEmail(email);
      if (existing) {
        // Block registration for any existing account — including OAuth-only accounts
        // (no passwordHash). Allowing unauthenticated password attachment to an
        // OAuth account is an account-takeover vector: knowing the email is enough
        // to claim the session. A verified account-linking flow is needed if this
        // use-case is ever required.
        return res.status(409).json({ message: "An account with this email already exists. Please sign in." });
      }

      const passwordHash = await bcrypt.hash(password, 10);
      const ADMIN_EMAIL_ENV = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
      const isAdmin = ADMIN_EMAIL_ENV ? email.trim().toLowerCase() === ADMIN_EMAIL_ENV : false;

      const user = await storage.createUser({
        email: email.trim(),
        firstName: firstName || null,
        lastName: lastName || null,
        passwordHash,
        isAdmin,
      });

      req.session.user = { id: user.id, email: user.email, provider: 'email', isAdmin: !!user.isAdmin };
      req.session.save((err: any) => {
        if (err) {
          console.error('[EMAIL AUTH] Session save error:', err);
          return res.status(500).json({ message: "Failed to create session" });
        }
        res.json({ id: user.id, email: user.email, isAdmin: !!user.isAdmin });
      });
    } catch (error) {
      console.error("[EMAIL AUTH] Registration error:", error);
      res.status(500).json({ message: "Registration failed" });
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
