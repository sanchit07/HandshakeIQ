import type { Express } from "express";
import axios from "axios";
import { storage } from "./storage";

const ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID;
const ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET;

if (!ZOHO_CLIENT_ID || !ZOHO_CLIENT_SECRET) {
  console.warn('Zoho OAuth credentials not configured. Zoho sign-in will not be available.');
}

// Get the redirect URI - always use production domain
function getZohoRedirectUri(): string {
  return 'https://handshake.movingwalls.com/auth/zoho/callback';
}

export function setupZohoAuth(app: Express) {
  // Initiate Zoho OAuth flow
  app.get('/auth/zoho', (req, res) => {
    if (!ZOHO_CLIENT_ID) {
      return res.status(500).json({ error: 'Zoho OAuth not configured' });
    }

    const redirect_uri = getZohoRedirectUri();
    const scope = 'openid email profile';
    const auth_url = `https://accounts.zoho.com/oauth/v2/auth?response_type=code&client_id=${ZOHO_CLIENT_ID}&scope=${encodeURIComponent(scope)}&redirect_uri=${encodeURIComponent(redirect_uri)}&access_type=offline&prompt=consent`;
    
    res.redirect(auth_url);
  });

  // Handle Zoho OAuth callback
  app.get('/auth/zoho/callback', async (req, res) => {
    const code = req.query.code as string;

    if (!code) {
      return res.status(400).send('Authorization code not provided');
    }

    if (!ZOHO_CLIENT_ID || !ZOHO_CLIENT_SECRET) {
      return res.status(500).send('Zoho OAuth not configured');
    }

    try {
      const redirect_uri = getZohoRedirectUri();
      const token_url = 'https://accounts.zoho.com/oauth/v2/token';

      // Exchange authorization code for tokens
      const tokenResponse = await axios.post(token_url, null, {
        params: {
          client_id: ZOHO_CLIENT_ID,
          client_secret: ZOHO_CLIENT_SECRET,
          redirect_uri: redirect_uri,
          grant_type: 'authorization_code',
          code: code,
        },
      });

      const { access_token, refresh_token, id_token } = tokenResponse.data;

      // Decode the ID token to get user info (basic JWT decode without verification for demo)
      // In production, you should verify the JWT signature
      const idTokenPayload = JSON.parse(
        Buffer.from(id_token.split('.')[1], 'base64').toString()
      );

      const email = idTokenPayload.email;
      const firstName = idTokenPayload.given_name || '';
      const lastName = idTokenPayload.family_name || '';
      const picture = idTokenPayload.picture || '';

      // Store or update user in database
      const user = await storage.upsertUser({
        email,
        firstName,
        lastName,
        profileImageUrl: picture,
      });

      // Store tokens and user info in session
      if (req.session) {
        req.session.user = {
          id: user.id,
          email: user.email!,
          name: `${firstName} ${lastName}`.trim(),
          picture: picture,
          accessToken: access_token,
          refreshToken: refresh_token,
        };

        await new Promise<void>((resolve, reject) => {
          req.session!.save((err) => {
            if (err) reject(err);
            else resolve();
          });
        });
      }

      // Redirect to close the popup window and refresh parent
      res.send(`
        <html>
          <head>
            <title>Zoho Sign-In Successful</title>
          </head>
          <body>
            <script>
              if (window.opener) {
                window.opener.postMessage({ type: 'zoho-auth-success' }, '*');
                window.close();
              } else {
                window.location.href = '/';
              }
            </script>
            <p>Signing in... This window should close automatically.</p>
          </body>
        </html>
      `);
    } catch (error) {
      console.error('Zoho OAuth error:', error);
      res.status(400).send(`
        <html>
          <head>
            <title>Zoho Sign-In Failed</title>
          </head>
          <body>
            <h1>Authentication Failed</h1>
            <p>There was an error signing in with Zoho. Please try again.</p>
            <script>
              if (window.opener) {
                window.opener.postMessage({ type: 'zoho-auth-error' }, '*');
                setTimeout(() => window.close(), 3000);
              }
            </script>
          </body>
        </html>
      `);
    }
  });

  // Refresh Zoho access token using refresh token
  app.post('/auth/zoho/refresh', async (req, res) => {
    try {
      const user = req.session?.user;
      if (!user?.refreshToken) {
        return res.status(401).json({ error: 'No refresh token available' });
      }

      if (!ZOHO_CLIENT_ID || !ZOHO_CLIENT_SECRET) {
        return res.status(500).json({ error: 'Zoho OAuth not configured' });
      }

      const response = await axios.post('https://accounts.zoho.com/oauth/v2/token', null, {
        params: {
          client_id: ZOHO_CLIENT_ID,
          client_secret: ZOHO_CLIENT_SECRET,
          grant_type: 'refresh_token',
          refresh_token: user.refreshToken,
        },
      });

      const { access_token } = response.data;

      // Update session with new access token
      req.session.user.accessToken = access_token;

      await new Promise<void>((resolve, reject) => {
        req.session!.save((err) => {
          if (err) reject(err);
          else resolve();
        });
      });

      res.json({ success: true });
    } catch (error) {
      console.error('Zoho token refresh error:', error);
      res.status(500).json({ error: 'Failed to refresh token' });
    }
  });
}
