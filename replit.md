# HandshakeIQ

## Overview
HandshakeIQ is an AI-powered professional intelligence platform that helps users prepare for meetings by generating detailed reports about individuals. The application uses Google's Gemini AI with web search capabilities to gather professional background, recent activities, personal interests, and potential discussion points.

## Tech Stack
- **Frontend**: React 19 with TypeScript
- **Build Tool**: Vite 6
- **Backend**: Express.js with TypeScript
- **Database**: PostgreSQL (Replit-managed) with Drizzle ORM
- **Authentication**: Replit Auth (Google, GitHub, Email/Password, Apple, X)
- **State Management**: React Query (@tanstack/react-query)
- **Styling**: Tailwind CSS (via CDN)
- **AI Service**: Google Gemini API (@google/genai)
- **Features**: Business card scanning, intelligent report generation, real authentication

## Project Structure
```
├── client/              # Frontend utilities
│   ├── hooks/          # React hooks (useAuth)
│   └── lib/            # Client libraries (React Query)
├── components/          # React components
│   ├── icons/          # Icon components (brand and UI)
│   ├── modals/         # Modal dialogs
│   ├── CardScanner.tsx
│   ├── Dashboard.tsx
│   ├── LoginScreen.tsx # Real authentication UI
│   ├── PersonProfile.tsx
│   ├── SettingsScreen.tsx
│   └── SideMenu.tsx
├── server/              # Express backend
│   ├── db.ts           # Drizzle database connection
│   ├── index.ts        # Express server setup
│   ├── replitAuth.ts   # Replit Auth configuration
│   └── storage.ts      # User data operations
├── services/
│   └── geminiService.ts
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
  - `DATABASE_URL` - Auto-configured by Replit
  - Session secrets - Auto-managed by Replit Auth

## Key Features
1. **Real Authentication**: Replit Auth with Google Sign-In, GitHub, Email/Password, Apple, and X
2. **Session Management**: Secure PostgreSQL-backed sessions with automatic token refresh
3. **Dashboard**: View upcoming meetings and search for people
4. **AI Intelligence Reports**: Generate comprehensive profiles using Gemini with web search
5. **Business Card Scanner**: Extract contact info from business card images using Gemini vision
6. **Person Profiles**: Detailed view with professional background, activities, interests, and discussion points
7. **Search History & Dossiers**: Track viewed profiles and save important contacts

## Authentication Flow
1. User clicks "Sign in with Google" (or other providers)
2. Redirects to `/api/login` → Replit Auth OAuth flow
3. Returns to `/api/callback` → Creates session and stores user in PostgreSQL
4. Frontend checks `/api/auth/user` via React Query hook
5. Protected routes verify authentication via middleware
6. Logout via `/api/logout` destroys session

## API Integration
The app requires a **GEMINI_API_KEY** environment variable to function. This key enables:
- Intelligence report generation with web search grounding
- Business card image text extraction
- Source citation for all generated insights

## Database Schema
- **users**: Stores authenticated user profiles (id, email, name, profile picture)
- **sessions**: Manages active user sessions (connect-pg-simple)

## Recent Changes
- **2024-11-10**: Full-stack transformation with real authentication
  - Migrated from Google AI Studio to Replit environment
  - Removed AI Studio importmap, fixed Vite config for Replit proxy
  - Implemented Express backend server (port 3000)
  - Added PostgreSQL database with Drizzle ORM
  - Integrated Replit Auth blueprint with Google Sign-In support
  - Created full authentication flow (login, callback, logout routes)
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
- Authentication is fully functional with real user sessions stored in PostgreSQL
- All Gemini API calls include proper error handling with fallback messages

## Production Deployment
Before deploying:
1. Ensure database migrations are pushed (`npm run db:push`)
2. Verify environment variables are set (DATABASE_URL, GEMINI_API_KEY)
3. Replit Auth automatically configures REPL_ID and session secrets
