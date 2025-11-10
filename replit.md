# HandshakeIQ

## Overview
HandshakeIQ is an AI-powered professional intelligence platform that helps users prepare for meetings by generating detailed reports about individuals. The application uses Google's Gemini AI with web search capabilities to gather professional background, recent activities, personal interests, and potential discussion points.

## Tech Stack
- **Frontend**: React 19 with TypeScript
- **Build Tool**: Vite 6
- **Backend**: Express.js with TypeScript
- **Database**: PostgreSQL (Replit-managed) with Drizzle ORM
- **Authentication**: Direct Google OAuth 2.0 (google-auth-library) with guest mode support
- **State Management**: React Query (@tanstack/react-query)
- **Styling**: Tailwind CSS (via CDN)
- **AI Service**: Google Gemini API (@google/genai)
- **Features**: Guest mode access, business card scanning, intelligent report generation, conditional authentication

## Project Structure
```
├── client/              # Frontend utilities
│   ├── hooks/          # React hooks (useAuth, useCalendar)
│   └── lib/            # Client libraries (React Query)
├── components/          # React components
│   ├── icons/          # Icon components (brand and UI)
│   ├── modals/         # Modal dialogs
│   ├── CardScanner.tsx
│   ├── Dashboard.tsx
│   ├── LoginScreen.tsx # Real authentication UI
│   ├── PersonProfile.tsx
│   ├── SettingsScreen.tsx
│   ├── SideMenu.tsx
│   └── UpcomingMeetings.tsx  # Calendar view
├── server/              # Express backend
│   ├── db.ts           # Drizzle database connection
│   ├── index.ts        # Express server setup
│   ├── googleAuth.ts   # Google OAuth 2.0 configuration
│   ├── routes.ts       # API route handlers
│   └── storage.ts      # User data operations
├── services/
│   ├── geminiService.ts
│   └── calendarService.ts  # Google Calendar API
├── shared/
│   └── schema.ts       # Database schema (users, sessions)
├── App.tsx
├── index.tsx
├── types.ts
├── constants.ts
└── vite.config.ts
```

## Environment Setup
- **Frontend Port**: 5000 (Vite dev server, webview enabled)
- **Backend Port**: 3000 (Express API server)
- **Host**: 0.0.0.0 (allows Replit proxy access)
- **Required Secrets**: 
  - `GEMINI_API_KEY` - Google Gemini API key
  - `GOOGLE_CLIENT_ID` - Google OAuth client ID
  - `GOOGLE_CLIENT_SECRET` - Google OAuth client secret
  - `DATABASE_URL` - Auto-configured by Replit
  - `SESSION_SECRET` - Session encryption key

## Key Features
1. **Guest Mode**: Access core features (search, AI reports) without authentication
2. **Conditional Authentication**: Login only required for advanced features (save insights, calendar sync)
3. **Google OAuth**: Direct Google Sign-In with secure session management
4. **Session Management**: PostgreSQL-backed sessions with automatic token refresh
5. **Dashboard**: View today/tomorrow's meetings and search for people
6. **Google Calendar Integration**: Real-time calendar sync showing meetings with clickable participants (authenticated users only)
7. **Upcoming Meetings Page**: Dedicated view showing next 30 days of calendar events with full participant lists
8. **AI Intelligence Reports**: Generate comprehensive profiles using Gemini with web search (no auth required)
9. **Business Card Scanner**: Extract contact info from business card images using Gemini vision (no auth required)
10. **Person Profiles**: Detailed view with professional background, activities, interests, and discussion points
11. **Protected Features**: Save dossiers and calendar sync require authentication
12. **Clickable Meeting Participants**: Click any attendee from calendar meetings to generate AI insights about them

## Authentication Flow

### Guest Mode
1. User clicks "Continue as Guest" on login screen
2. Full access to search, dashboard, and AI intelligence reports
3. Attempting to save insights prompts for authentication

### Authenticated Mode
1. User clicks "Sign in with Google"
2. Popup window opens → Google OAuth consent screen
3. After authorization → `/auth/google/callback` creates session
4. User data stored in PostgreSQL, popup closes, main window reloads
5. Frontend checks `/api/auth/user` via React Query (returns user or null)
6. Protected routes use `requireAuth` middleware to block unauthenticated requests
7. Logout via `/api/logout` destroys session

### Middleware Layers
- `attachSessionIfPresent`: Optionally attaches session, doesn't block (used for optional auth)
- `requireAuth`: Blocks requests without valid session (used for save/calendar features)

## API Integration
The app requires a **GEMINI_API_KEY** environment variable to function. This key enables:
- Intelligence report generation with web search grounding
- Business card image text extraction
- Source citation for all generated insights

## Database Schema
- **users**: Stores authenticated user profiles (id, email, name, profile picture)
- **sessions**: Manages active user sessions (connect-pg-simple)

## Recent Changes
- **2024-11-10 (Latest Update)**: Fixed header mobile responsiveness and loader animation consistency
  - **Header Mobile Fixes**:
    - Logo scales from h-8 (mobile) to h-10 (desktop)
    - "HandshakeIQ" text scales from text-sm to text-2xl across breakpoints
    - "MOVINGWALLS" text scales from text-xs to text-lg
    - Reduced spacing on mobile (space-x-1.5 → space-x-3 on larger screens)
    - Added whitespace-nowrap to prevent text wrapping and overlap
    - Added flex-shrink properties for proper element sizing
  - **Loading Animation Consistency**:
    - Implemented minimum 2-second loader duration at UI layer (PersonProfile)
    - Ensures smooth animation display regardless of API response speed
    - Both guest and authenticated modes now show consistent loading visuals
    - Delay only affects UI state transition, not actual data fetching
  - Architect review passed: No performance regressions, proper UI-layer implementation
  
- **2024-11-10 (Earlier)**: Complete mobile responsiveness and enhanced sci-fi effects
  - **New Animated Loaders Suite** (components/loaders/NeonLoader.tsx):
    - NeonLoader: Spinning neon rings with customizable sizes (default, small, large)
    - DataStreamLoader: Scanning lines effect for data processing states
    - ProfileBuildingLoader: Step-by-step progress with shimmer animations
    - ScanningLoader: Radar-style scanning animation for business card processing
  - **Mobile Responsive Layouts** (Tailwind breakpoints: sm:640px, md:768px, lg:1024px):
    - Dashboard: Responsive search bar, cards stack on mobile, proper padding adjustments
    - PersonProfile: All sections (background, activities, interests) scale properly on mobile
    - CardScanner: Camera view and controls adapt to screen size
    - UpcomingMeetings: Meeting cards stack on small screens with proper attendee wrapping
    - SideMenu: Width adjusts (280px desktop, 240px mobile) with responsive overlay
    - LoginScreen: Padding, text sizes, and button layouts responsive
    - App.tsx: Header logo/text/spacing adapts to mobile (text-base sm:text-xl md:text-2xl)
  - **Enhanced Sci-Fi Animations** (index.html keyframes):
    - Neon glow effects with pulsing animations
    - Pulse-glow for interactive elements (0-100% opacity cycle)
    - Scan-line animations for loaders (translateY with fade)
    - Shimmer effects for loading states (linear gradient sweep)
    - Float animations for enhanced sci-fi aesthetics
    - Slide-down-fade for header entrance
  - **Search Experience Enhancements**:
    - Animated cyan border when actively searching
    - Staggered fade-in for search results (50ms delay between items)
    - Hover effects with scale transforms and glow
    - Results counter with proper formatting ("X results found")
  - Architect review passed: All integrations clean, no breaking changes, mobile usability preserved
  - Performance note: Monitor on low-powered devices for animation performance
  
- **2024-11-10 (Earlier)**: Branding and visual enhancements
  - Replaced text logo with actual Moving Walls logo image
  - Added professional meeting intelligence background to login screen
  - Generated custom background image with blurred office/meeting room aesthetic
  - Configured Vite to serve assets from attached_assets directory
  - All logos and images maintain proper aspect ratios
  
- **2024-11-10 (Earlier)**: Google Calendar integration complete
  - Added `calendar.readonly` scope to Google OAuth
  - Installed googleapis package for Calendar API access
  - Created CalendarService to fetch real meetings from Google Calendar
  - Added two API endpoints: `/api/calendar/today-tomorrow` and `/api/calendar/upcoming`
  - Updated Dashboard to show today/tomorrow's meetings (authenticated users only)
  - Created UpcomingMeetings component for dedicated calendar view (next 30 days)
  - Added "Upcoming Meetings" option to side menu
  - Implemented clickable meeting participants with AI insight generation
  - Meeting attendees convert to Person objects for seamless profile viewing
  - Calendar events include meeting title, time, location, and all participants
  - Test Zoho login route added for testing authenticated features (mock user: Sanchit Neema)
  
- **2024-11-10 (Earlier)**: Implemented guest mode with conditional authentication
  - Added "Continue as Guest" button for immediate access to core features
  - Removed authentication requirement from intelligence reports and card scanning
  - Implemented two-tier middleware: `attachSessionIfPresent` (optional) and `requireAuth` (strict)
  - Updated `useAuth` hook to properly distinguish guest mode from errors
  - Added proper session persistence for token refresh
  - Protected save/calendar features now prompt for authentication
  - Improved error handling (network errors vs. guest mode)
  
- **2024-11-10 (Earlier)**: Google OAuth integration
  - Migrated from Replit Auth to direct Google OAuth 2.0
  - Implemented popup-based OAuth flow to work around iframe restrictions
  - Created `googleAuth.ts` with OAuth 2.0 client setup
  - Added automatic token refresh with session persistence
  - Redirect URI configured for Replit deployment (uses REPLIT_DEV_DOMAIN)
  
- **2024-11-10 (Initial)**: Full-stack transformation
  - Migrated from Google AI Studio to Replit environment
  - Removed AI Studio importmap, fixed Vite config for Replit proxy
  - Implemented Express backend server (port 3000)
  - Added PostgreSQL database with Drizzle ORM
  - Set up session management with PostgreSQL backing
  - Updated React frontend with React Query for auth state
  - Configured two workflows: backend (console) and frontend (webview)
  - Fixed module resolution for @shared imports

## User Preferences
None documented yet.

## Workflows
- **backend**: Runs Express server on port 3000 (`npm run dev:server`)
- **frontend**: Runs Vite dev server on port 5000 (`npm run dev`)
- Vite proxies `/api` requests to backend server

## Notes
- The application currently uses mock data for meetings and people (see constants.ts)
- **Guest Mode**: Users can search people and generate AI reports without signing in
- **Protected Features**: Saving insights and calendar sync require Google Sign-In
- Authentication uses direct Google OAuth 2.0 with secure session management
- All Gemini API calls include proper error handling with fallback messages
- Redirect URI for Google OAuth must be configured in Google Cloud Console after deployment

## Production Deployment
Before deploying:
1. Ensure database migrations are pushed (`npm run db:push`)
2. Verify environment variables are set (DATABASE_URL, GEMINI_API_KEY, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, SESSION_SECRET)
3. **Configure Google OAuth Redirect URI**: Add your published app's callback URL to Google Cloud Console
   - Format: `https://[your-published-domain]/auth/google/callback`
   - Go to Google Cloud Console → Credentials → OAuth 2.0 Client ID → Add authorized redirect URI
4. Test the complete authentication flow after deployment
