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
- **Google Gemini API**: For AI intelligence report generation, web search grounding, and business card scanning.
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