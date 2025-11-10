# HandshakeIQ

## Overview
HandshakeIQ is an AI-powered professional intelligence platform designed to enhance meeting preparation. It generates detailed reports on individuals by leveraging Google's Gemini AI with web search capabilities, covering professional backgrounds, recent activities, personal interests, and potential discussion points. The platform supports guest access for core features and requires authentication for advanced functionalities like saving dossiers and calendar synchronization.

## User Preferences
None documented yet.

## System Architecture
HandshakeIQ utilizes a full-stack architecture with a React 19 (TypeScript) frontend built with Vite 6 and an Express.js (TypeScript) backend. Data persistence is handled by PostgreSQL with Drizzle ORM. Authentication is managed via direct Google OAuth 2.0, supporting both guest and authenticated modes with conditional access to features.

**Key Technical Implementations:**
- **Real Google Search Integration**: Utilizes Google Custom Search API for comprehensive person searches across various platforms (LinkedIn, Twitter, etc.).
- **Person Disambiguation**: Identifies unique individuals from common names, presenting multiple profiles for user selection.
- **AI Intelligence Reports**: Generates detailed profiles using Google Gemini, incorporating web search grounding, source attribution, and timestamps for recent activities.
- **Business Card Scanning**: Extracts contact information from images using Gemini Vision.
- **Google Calendar Integration**: Syncs with Google Calendar to display upcoming meetings and participant information.
- **Session Management**: PostgreSQL-backed sessions with automatic token refresh for authenticated users.
- **Conditional Authentication**: Allows access to core search and AI features as a guest, prompting for full authentication only when saving data or accessing calendar.
- **Responsive UI/UX**: Designed with Tailwind CSS for mobile responsiveness across all components (Dashboard, PersonProfile, CardScanner, etc.) and enhanced with sci-fi themed animations and loaders (NeonLoader, DataStreamLoader, ProfileBuildingLoader).

**Core Features:**
- Guest mode access with conditional authentication for saving and calendar sync.
- Real-time person search and disambiguation.
- Comprehensive AI intelligence reports with sources and timestamps.
- Business card scanning for contact extraction.
- Interactive person profiles with notes, social media links, and confidence scores.
- Google Calendar integration for upcoming meetings and participant details.
- Persistent storage of intelligence reports (dossiers) and personal notes.
- Animated save confirmation for dossiers.

## External Dependencies
- **Google Gemini API**: For AI intelligence report generation, web search grounding, and business card scanning (vision capabilities).
- **Google OAuth 2.0**: For user authentication and authorization.
- **Google Custom Search API**: For real-time person search across the web.
- **Google Calendar API**: For syncing and displaying user's calendar events.
- **PostgreSQL**: Primary database for user data, sessions, dossiers, and notes.
- **Tailwind CSS (via CDN)**: For styling and responsive design.
- **React Query (@tanstack/react-query)**: For state management and data fetching in the frontend.
- **Drizzle ORM**: For database interaction with PostgreSQL.
- **`connect-pg-simple`**: For PostgreSQL-backed session management.
- **`google-auth-library`**: For Google OAuth 2.0 integration.
- **`googleapis`**: For Google Calendar API access.