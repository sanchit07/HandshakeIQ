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

  // Real Zoho OAuth - Redirect to Zoho authorization
  app.get('/api/login/zoho', (req, res) => {
    const ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID;
    const ZOHO_REDIRECT_URI = process.env.REPLIT_DEV_DOMAIN 
      ? `https://${process.env.REPLIT_DEV_DOMAIN}/auth/zoho/callback`
      : 'http://localhost:5000/auth/zoho/callback';
    
    if (!ZOHO_CLIENT_ID) {
      return res.status(500).send('Zoho OAuth not configured');
    }
    
    const authUrl = `https://accounts.zoho.com/oauth/v2/auth?` +
      `response_type=code&` +
      `client_id=${ZOHO_CLIENT_ID}&` +
      `redirect_uri=${encodeURIComponent(ZOHO_REDIRECT_URI)}&` +
      `scope=AaaServer.profile.READ&` +
      `access_type=offline&` +
      `prompt=consent`;
    
    res.redirect(authUrl);
  });

  // Real Zoho OAuth callback - exchange code for tokens
  app.get('/auth/zoho/callback', async (req: any, res) => {
    const { code } = req.query;
    
    console.log('[ZOHO CALLBACK] Received authorization code');
    
    if (!code || typeof code !== 'string') {
      console.error('[ZOHO CALLBACK] Missing authorization code');
      return res.status(400).send('Authorization code missing');
    }
    
    const ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID;
    const ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET;
    const ZOHO_REDIRECT_URI = process.env.REPLIT_DEV_DOMAIN 
      ? `https://${process.env.REPLIT_DEV_DOMAIN}/auth/zoho/callback`
      : 'http://localhost:5000/auth/zoho/callback';
    
    console.log('[ZOHO CALLBACK] Redirect URI:', ZOHO_REDIRECT_URI);
    
    if (!ZOHO_CLIENT_ID || !ZOHO_CLIENT_SECRET) {
      console.error('[ZOHO CALLBACK] Missing client credentials');
      return res.status(500).send('Zoho OAuth not configured');
    }
    
    try {
      const axios = require('axios');
      
      console.log('[ZOHO CALLBACK] Exchanging code for tokens...');
      const tokenResponse = await axios.post('https://accounts.zoho.com/oauth/v2/token', null, {
        params: {
          grant_type: 'authorization_code',
          client_id: ZOHO_CLIENT_ID,
          client_secret: ZOHO_CLIENT_SECRET,
          redirect_uri: ZOHO_REDIRECT_URI,
          code: code
        }
      });
      
      console.log('[ZOHO CALLBACK] Token exchange successful');
      const { access_token, refresh_token, api_domain, expires_in } = tokenResponse.data;
      
      console.log('[ZOHO CALLBACK] Fetching user profile from:', api_domain);
      const userResponse = await axios.get(`${api_domain}/oauth/user/info`, {
        headers: {
          'Authorization': `Zoho-oauthtoken ${access_token}`
        }
      });
      
      const zohoUser = userResponse.data;
      console.log('[ZOHO CALLBACK] User profile retrieved:', zohoUser.Email);
      
      const user = await storage.upsertUser({
        id: `zoho_${zohoUser.ZUID}`,
        email: zohoUser.Email || null,
        firstName: zohoUser.First_Name || null,
        lastName: zohoUser.Last_Name || null,
        profileImageUrl: null,
      });

      console.log('[ZOHO CALLBACK] User saved to database:', user.id);

      (req.session as any).user = {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        profileImageUrl: user.profileImageUrl,
        accessToken: access_token,
        refreshToken: refresh_token,
        expiresAt: Date.now() + (expires_in * 1000),
        provider: 'zoho',
        apiDomain: api_domain
      };

      console.log('[ZOHO CALLBACK] Session user set, saving session...');

      // Save session and close popup (same as Google OAuth)
      (req.session as any).save((err: any) => {
        if (err) {
          console.error('[ZOHO CALLBACK] Session save error:', err);
          return res.status(500).send('Failed to save session');
        }

        console.log('[ZOHO CALLBACK] Session saved successfully, closing popup');

        // Close popup and notify parent window (same as Google OAuth)
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
              <p>Authorization successful! This window will close automatically...</p>
            </body>
          </html>
        `);
      });
      
    } catch (error: any) {
      console.error('[ZOHO CALLBACK] Error during authentication:', error.response?.data || error.message);
      res.status(500).send(`Authentication failed: ${error.message}`);
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
        // Refresh token based on provider
        if (user.provider === 'zoho') {
          // Zoho token refresh
          const axios = require('axios');
          const ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID;
          const ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET;
          
          const refreshResponse = await axios.post('https://accounts.zoho.com/oauth/v2/token', null, {
            params: {
              grant_type: 'refresh_token',
              client_id: ZOHO_CLIENT_ID,
              client_secret: ZOHO_CLIENT_SECRET,
              refresh_token: user.refreshToken
            }
          });
          
          user.accessToken = refreshResponse.data.access_token;
          user.expiresAt = Date.now() + (refreshResponse.data.expires_in * 1000);
          (req.session as any).user = user;
          
          await new Promise<void>((resolve, reject) => {
            req.session.save((err) => {
              if (err) reject(err);
              else resolve();
            });
          });
          
          (req as any).user = user;
          return next();
        } else {
          // Google token refresh
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
        }
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
  
  // Note: Zoho users can only access Google-specific features (like Calendar) if they sign in with Google
  // For now, we allow both providers for non-calendar features
  
  // Check if token is expired
  const now = Date.now();
  if (user.expiresAt && now >= user.expiresAt) {
    // Try to refresh token
    if (user.refreshToken) {
      try {
        if (user.provider === 'zoho') {
          // Zoho token refresh
          const axios = require('axios');
          const ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID;
          const ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET;
          
          const refreshResponse = await axios.post('https://accounts.zoho.com/oauth/v2/token', null, {
            params: {
              grant_type: 'refresh_token',
              client_id: ZOHO_CLIENT_ID,
              client_secret: ZOHO_CLIENT_SECRET,
              refresh_token: user.refreshToken
            }
          });
          
          user.accessToken = refreshResponse.data.access_token;
          user.expiresAt = Date.now() + (refreshResponse.data.expires_in * 1000);
          
          return next();
        } else {
          // Google token refresh
          oauth2Client.setCredentials({
            refresh_token: user.refreshToken,
          });
          const { credentials } = await oauth2Client.refreshAccessToken();
          
          // Update session with new tokens
          user.accessToken = credentials.access_token;
          user.expiresAt = credentials.expiry_date;
          
          return next();
        }
      } catch (error) {
        console.error('Token refresh failed:', error);
        return res.status(401).json({ message: 'Authentication required' });
      }
    }
    return res.status(401).json({ message: 'Authentication required' });
  }

  next();
};
