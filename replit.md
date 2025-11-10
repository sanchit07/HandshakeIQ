# HandshakeIQ

## Overview
HandshakeIQ is an AI-powered professional intelligence platform that helps users prepare for meetings by generating detailed reports about individuals. The application uses Google's Gemini AI with web search capabilities to gather professional background, recent activities, personal interests, and potential discussion points.

## Tech Stack
- **Frontend**: React 19 with TypeScript
- **Build Tool**: Vite 6
- **Styling**: Tailwind CSS (via CDN)
- **AI Service**: Google Gemini API (@google/genai)
- **Features**: Business card scanning, intelligent report generation, calendar integration mockup

## Project Structure
```
├── components/           # React components
│   ├── icons/           # Icon components (brand and UI)
│   ├── modals/          # Modal dialogs (e.g., CalendarSyncModal)
│   ├── CardScanner.tsx  # Business card OCR component
│   ├── Dashboard.tsx    # Main dashboard view
│   ├── LoginScreen.tsx  # Authentication screen
│   ├── PersonProfile.tsx # Individual profile view
│   ├── SettingsScreen.tsx
│   └── SideMenu.tsx     # Navigation menu
├── services/            # External service integrations
│   └── geminiService.ts # Gemini AI API integration
├── App.tsx             # Main application component
├── index.tsx           # Application entry point
├── types.ts            # TypeScript type definitions
├── constants.ts        # Mock data and constants
└── vite.config.ts      # Vite configuration
```

## Environment Setup
- **Port**: 5000 (configured for Replit webview)
- **Host**: 0.0.0.0 (allows Replit proxy access)
- **Required API Key**: GEMINI_API_KEY (Google Gemini API key)

## Key Features
1. **Login & Authentication**: Basic email-based login with calendar sync prompt
2. **Dashboard**: View upcoming meetings and search for people
3. **AI Intelligence Reports**: Generate comprehensive profiles using Gemini with web search
4. **Business Card Scanner**: Extract contact info from business card images using Gemini vision
5. **Person Profiles**: Detailed view with professional background, activities, interests, and discussion points
6. **Search History & Dossiers**: Track viewed profiles and save important contacts

## API Integration
The app requires a **GEMINI_API_KEY** environment variable to function. This key enables:
- Intelligence report generation with web search grounding
- Business card image text extraction
- Source citation for all generated insights

## Recent Changes
- **2024-11-10**: Initial setup for Replit environment
  - Configured Vite to use port 5000 for Replit webview compatibility
  - Added HMR configuration for proper hot reload in Replit proxy
  - Installed all npm dependencies
  - Created workflow for dev server

## User Preferences
None documented yet.

## Notes
- The application currently uses mock data for meetings and people (see constants.ts)
- Calendar sync is a UI mockup without actual integration
- All Gemini API calls include proper error handling with fallback messages
