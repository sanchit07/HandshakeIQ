# HandshakeIQ

## Overview
HandshakeIQ is an AI-powered professional intelligence platform designed to enhance meeting preparation. It leverages Google's Gemini AI with web search capabilities to generate detailed reports on individuals, covering professional backgrounds, recent activities, personal interests, and potential discussion points. The platform supports guest access for core features, while requiring authentication for advanced functionalities like saving dossiers and calendar synchronization.

## User Preferences
None documented yet.

## System Architecture
HandshakeIQ utilizes a full-stack architecture with a React (TypeScript) frontend built with Vite and an Express.js (TypeScript) backend. Data persistence is handled by PostgreSQL with Drizzle ORM. Authentication is managed via direct Google OAuth 2.0, supporting both guest and authenticated modes with conditional access to features.

**Key Features:**
- Guest mode access with conditional authentication for saving and calendar synchronization.
- Real-time person search and disambiguation using Google Custom Search API.
- Comprehensive AI intelligence reports with web search grounding, source attribution, and timestamps.
- Business card scanning for contact extraction using Gemini Vision.
- Interactive person profiles with notes, social media links, and confidence scores.
- Google Calendar integration for upcoming meetings and participant details.
- Persistent storage of intelligence reports (dossiers) and personal notes.
- Animated save confirmation for dossiers.

**UI/UX Decisions:**
- Responsive design using Tailwind CSS for all components.
- Sci-fi themed animations and loaders (NeonLoader, DataStreamLoader, ProfileBuildingLoader).
- Progressive search guidance and locked keyword display during active searches.
- Enhanced card scanner UX with review and edit functionality before search.
- Comprehensive error handling with user-friendly messages.
- Carefully managed z-index layering for optimal UI element stacking.
- Filtering of generic LinkedIn placeholder logos for profile pictures.
- Improved person deduplication for distinct profiles across platforms.

## External Dependencies
- **Google Gemini API** (`@google/genai`): For AI intelligence report generation, web search grounding, and business card scanning using gemini-2.5-flash model.
- **Google OAuth 2.0**: For user authentication and authorization.
- **Google Custom Search API**: For real-time person search across the web.
- **Google Calendar API**: For syncing and displaying user's calendar events.
- **PostgreSQL**: Primary database for user data, sessions, dossiers, and notes.
- **Tailwind CSS**: For styling and responsive design.
- **React Query (@tanstack/react-query)**: For frontend state management and data fetching.
- **Drizzle ORM**: For database interaction with PostgreSQL.
- **`connect-pg-simple`**: For PostgreSQL-backed session management.
- **`google-auth-library`**: For Google OAuth 2.0 integration.
- **`googleapis`**: For Google Calendar API access.

## Recent Changes

### November 17, 2025 - Search History & Caching System
- **Database schema**: Added `search_history` table to track all person searches with full intelligence reports and metadata.
- **Smart caching**: Intelligence report endpoint now checks for exact matches (name + company) and returns cached results instantly instead of calling Gemini API again.
- **API endpoints**: 
  - `GET /api/search-history` - Retrieve all search history (supports guest and authenticated users)
  - `GET /api/search-history/recent?limit=N` - Get recent searches
  - `POST /api/search-history/find-match` - Find exact match for person
- **Automatic saving**: Every intelligence report generation is automatically saved to search history for future reference.
- **Guest support**: Search history works for both authenticated users and guests (using userId null for guests).
- **Performance**: Exact match queries use indexed lookups for fast retrieval.
- **Verified functionality**: Successfully tested caching - duplicate searches return instant results with `fromCache: true`.

### November 17, 2025 - Gemini API Integration Fix
- **Fixed TypeScript errors**: Updated Gemini API calls to use correct syntax for `@google/genai` library (tools parameter moved to config object).
- **Improved error handling**: Added specific error detection for rate limits (429), authentication (401/403), server errors (500), and network issues.
- **Enhanced logging**: Added comprehensive logging with `[GEMINI API]` prefix to track API requests, responses, and data flow through both search and structuring steps.
- **Response validation**: Added validation before JSON parsing to detect empty responses and missing required fields.
- **API call structure**: 
  - Step 1: Uses `googleSearch` tool for web-grounded information retrieval.
  - Step 2: Uses `responseSchema` with structured JSON output for consistent intelligence reports.
- **Verified functionality**: Successfully tested with real-world data (retrieved 26 sources for test query with detailed intelligence reports).