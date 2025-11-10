import { OAuth2Client } from 'google-auth-library';
import session from 'express-session';
import type { Express, RequestHandler } from 'express';
import connectPg from 'connect-pg-simple';
import { storage } from './storage';

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID!;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET!;
const REDIRECT_URI = process.env.REPLIT_DEV_DOMAIN 
  ? `https://${process.env.REPLIT_DEV_DOMAIN}/auth/google/callback`
  : 'http://localhost:5000/auth/google/callback';

const oauth2Client = new OAuth2Client(
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  REDIRECT_URI
);

export function getSession() {
  const sessionTtl = 7 * 24 * 60 * 60 * 1000; // 1 week
  const pgStore = connectPg(session);
  const sessionStore = new pgStore({
    conString: process.env.DATABASE_URL,
    createTableIfMissing: false,
    ttl: sessionTtl,
    tableName: 'sessions',
  });
  return session({
    secret: process.env.SESSION_SECRET || 'your-secret-key-here',
    store: sessionStore,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: true,
      maxAge: sessionTtl,
    },
  });
}

export async function setupGoogleAuth(app: Express) {
  app.set('trust proxy', 1);
  app.use(getSession());

  // Redirect to Google OAuth
  app.get('/api/login', (req, res) => {
    const authUrl = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: [
        'https://www.googleapis.com/auth/userinfo.profile',
        'https://www.googleapis.com/auth/userinfo.email',
        'https://www.googleapis.com/auth/calendar.readonly'  // Add Calendar read access
      ],
      prompt: 'consent'
    });
    res.redirect(authUrl);
  });

  // Google OAuth callback
  app.get('/auth/google/callback', async (req, res) => {
    const { code } = req.query;

    if (!code || typeof code !== 'string') {
      return res.status(400).send('Authorization code missing');
    }

    try {
      // Exchange code for tokens
      const { tokens } = await oauth2Client.getToken(code);
      oauth2Client.setCredentials(tokens);

      // Verify ID token and get user info
      const ticket = await oauth2Client.verifyIdToken({
        idToken: tokens.id_token!,
        audience: GOOGLE_CLIENT_ID,
      });

      const payload = ticket.getPayload();
      
      if (!payload) {
        return res.status(401).send('Invalid token');
      }

      // Store user in database
      const user = await storage.upsertUser({
        id: payload.sub,
        email: payload.email || null,
        firstName: payload.given_name || null,
        lastName: payload.family_name || null,
        profileImageUrl: payload.picture || null,
      });

      // Store user session
      (req.session as any).user = {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        profileImageUrl: user.profileImageUrl,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresAt: tokens.expiry_date,
      };

      // Close popup and redirect parent
      res.send(`
        <html>
          <body>
            <script>
              if (window.opener) {
                window.opener.postMessage({ type: 'auth_success' }, '*');
                window.close();
              } else {
                window.location.href = '/';
              }
            </script>
          </body>
        </html>
      `);
    } catch (error) {
      console.error('Error during Google OAuth:', error);
      res.status(500).send('Authentication failed');
    }
  });

  // Test Zoho login - creates a session for test user
  app.get('/api/login/zoho', async (req, res) => {
    try {
      // Test user credentials
      const testUser = {
        id: 'zoho-test-user-001',
        email: 'sanchit@movingwalls.com',
        firstName: 'Sanchit',
        lastName: 'Neema',
        profileImageUrl: null,
      };

      // Store user in database
      const user = await storage.upsertUser(testUser);

      // Create session for test user
      (req.session as any).user = {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        profileImageUrl: user.profileImageUrl,
        // Mock tokens for testing (not real Zoho tokens)
        accessToken: 'test-access-token',
        refreshToken: 'test-refresh-token',
        expiresAt: Date.now() + (7 * 24 * 60 * 60 * 1000), // 7 days from now
      };

      // Redirect back to home page
      res.redirect('/');
    } catch (error) {
      console.error('Error during test Zoho login:', error);
      res.status(500).send('Test login failed');
    }
  });

  // Logout
  app.get('/api/logout', (req, res) => {
    req.session.destroy((err) => {
      if (err) {
        console.error('Session destruction error:', err);
      }
      res.redirect('/');
    });
  });
}

// Middleware that attaches session user if present, but doesn't block request
export const attachSessionIfPresent: RequestHandler = async (req, res, next) => {
  const user = (req.session as any)?.user;

  if (!user) {
    // No session, continue as guest
    return next();
  }

  // Check if token is expired
  const now = Date.now();
  if (user.expiresAt && now >= user.expiresAt) {
    // Try to refresh token
    if (user.refreshToken) {
      try {
        oauth2Client.setCredentials({
          refresh_token: user.refreshToken,
        });
        const { credentials } = await oauth2Client.refreshAccessToken();
        
        // Update session with new tokens and persist back to session
        user.accessToken = credentials.access_token;
        user.expiresAt = credentials.expiry_date;
        (req.session as any).user = user;
        
        // Save the session to persist changes
        try {
          await new Promise<void>((resolve, reject) => {
            req.session.save((err) => {
              if (err) reject(err);
              else resolve();
            });
          });
        } catch (saveError) {
          console.error('Session save failed after token refresh:', saveError);
          // Continue anyway - the in-memory session is updated for this request
        }
        
        (req as any).user = user;
        return next();
      } catch (error) {
        console.error('Token refresh failed:', error);
        // Continue as guest if refresh fails
        return next();
      }
    }
    // Token expired and no refresh token, continue as guest
    return next();
  }

  // Attach authenticated user to request
  (req as any).user = user;
  next();
};

// Middleware that requires authentication (blocks request if not authenticated)
export const requireAuth: RequestHandler = async (req, res, next) => {
  const user = (req.session as any)?.user;

  if (!user) {
    return res.status(401).json({ message: 'Authentication required' });
  }

  // Check if token is expired
  const now = Date.now();
  if (user.expiresAt && now >= user.expiresAt) {
    // Try to refresh token
    if (user.refreshToken) {
      try {
        oauth2Client.setCredentials({
          refresh_token: user.refreshToken,
        });
        const { credentials } = await oauth2Client.refreshAccessToken();
        
        // Update session with new tokens
        user.accessToken = credentials.access_token;
        user.expiresAt = credentials.expiry_date;
        
        return next();
      } catch (error) {
        console.error('Token refresh failed:', error);
        return res.status(401).json({ message: 'Authentication required' });
      }
    }
    return res.status(401).json({ message: 'Authentication required' });
  }

  next();
};
