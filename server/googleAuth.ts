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

  // Mock Zoho authorization page
  app.get('/api/login/zoho', (req, res) => {
    const htmlContent = `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Zoho Authorization</title>
        <style>
          body {
            margin: 0;
            padding: 0;
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            display: flex;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
          }
          .auth-container {
            background: white;
            border-radius: 12px;
            padding: 40px;
            max-width: 400px;
            width: 90%;
            box-shadow: 0 10px 40px rgba(0,0,0,0.2);
            text-align: center;
          }
          .zoho-logo {
            width: 120px;
            height: 40px;
            background: #E42527;
            color: white;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 24px;
            font-weight: bold;
            margin: 0 auto 30px;
            border-radius: 4px;
          }
          h1 {
            color: #333;
            font-size: 24px;
            margin-bottom: 10px;
          }
          .app-name {
            color: #667eea;
            font-weight: bold;
          }
          p {
            color: #666;
            line-height: 1.6;
            margin-bottom: 30px;
          }
          .permissions {
            background: #f5f5f5;
            border-radius: 8px;
            padding: 20px;
            margin-bottom: 30px;
            text-align: left;
          }
          .permissions h3 {
            font-size: 14px;
            color: #333;
            margin-bottom: 15px;
          }
          .permission-item {
            display: flex;
            align-items: center;
            margin-bottom: 10px;
            color: #666;
            font-size: 14px;
          }
          .permission-item::before {
            content: '✓';
            color: #4CAF50;
            font-weight: bold;
            margin-right: 10px;
          }
          .authorize-btn {
            background: #E42527;
            color: white;
            border: none;
            padding: 14px 40px;
            font-size: 16px;
            font-weight: 600;
            border-radius: 6px;
            cursor: pointer;
            width: 100%;
            transition: background 0.3s;
          }
          .authorize-btn:hover {
            background: #c01f21;
          }
          .cancel-btn {
            background: transparent;
            color: #666;
            border: none;
            padding: 10px;
            font-size: 14px;
            cursor: pointer;
            margin-top: 15px;
          }
          .cancel-btn:hover {
            color: #333;
            text-decoration: underline;
          }
        </style>
      </head>
      <body>
        <div class="auth-container">
          <div class="zoho-logo">Zoho</div>
          <h1>Authorize <span class="app-name">HandshakeIQ</span></h1>
          <p>HandshakeIQ would like to access your Zoho account to provide you with professional intelligence insights.</p>
          
          <div class="permissions">
            <h3>This app will be able to:</h3>
            <div class="permission-item">View your basic profile information</div>
            <div class="permission-item">Access your email address</div>
            <div class="permission-item">Read your calendar events</div>
          </div>

          <form id="authForm" method="POST" action="/api/zoho/callback">
            <button type="submit" class="authorize-btn">Authorize HandshakeIQ</button>
          </form>
          <button class="cancel-btn" onclick="window.close()">Cancel</button>
        </div>
      </body>
      </html>
    `;
    
    res.setHeader('Content-Type', 'text/html');
    res.send(htmlContent);
  });

  // Mock Zoho callback - create session and close popup
  app.post('/api/zoho/callback', async (req: any, res) => {
    try {
      // Create a deterministic mock Zoho user
      const mockZohoUser = {
        id: 'zoho_mock_user_12345',
        email: 'demo@zoho.com',
        firstName: 'Zoho',
        lastName: 'Demo',
        profileImageUrl: 'https://ui-avatars.com/api/?name=Zoho+Demo&background=E42527&color=fff&size=200',
      };

      // Store mock user in database
      const user = await storage.upsertUser(mockZohoUser);

      // Create session (same pattern as Google OAuth)
      (req.session as any).user = {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        profileImageUrl: user.profileImageUrl,
        accessToken: 'mock_zoho_access_token',
        refreshToken: 'mock_zoho_refresh_token',
        expiresAt: Date.now() + 3600000, // 1 hour from now
      };

      // Save session and close popup
      (req.session as any).save((err: any) => {
        if (err) {
          console.error('Session save error:', err);
          return res.status(500).send('Failed to save session');
        }

        // Close popup and notify parent window (same as Google OAuth)
        // Add delay to ensure session cookie is fully written to browser
        res.send(`
          <!DOCTYPE html>
          <html>
          <head>
            <title>Authorization Successful</title>
          </head>
          <body>
            <script>
              // Wait a moment for session cookie to be set before closing
              setTimeout(function() {
                if (window.opener) {
                  window.opener.postMessage({ type: 'auth_success' }, '*');
                  window.close();
                } else {
                  window.location.href = '/';
                }
              }, 500);
            </script>
            <p>Authorization successful! This window will close automatically...</p>
          </body>
          </html>
        `);
      });
    } catch (error) {
      console.error('Error in Zoho mock callback:', error);
      res.status(500).send('Authentication failed');
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
