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

## Recent Changes

### 2025-11-10: Critical UX Fixes - Search Dropdown Layering, CardScanner Preview & Error Handling
- **Search Dropdown Z-Index Fix (CRITICAL)**:
  - Increased search results dropdown from z-50 to z-[100]
  - Search results now appear above all dashboard content (calendar events, transmissions boxes)
  - Fixed critical issue where users couldn't click on search results
  - Proper layering: Dashboard content < SideMenu (z-[55]/z-[60]) < Modals (z-70) < Search dropdown (z-[100])
  
- **CardScanner UX Overhaul**:
  - Now shows extracted data (name, company) in a form before searching
  - Users can review and edit extracted information
  - Press Enter or click "Search Intelligence" button to initiate search
  - Added "Scan Again" button for re-scanning if extraction was incorrect
  - Camera view → Extraction → Review/Edit → Search workflow
  
- **Comprehensive Error Handling**:
  - **Search errors**: Detects network errors, 500 server errors, empty results with specific messages
  - **CardScanner errors**: 
    - "No business card detected" when image doesn't contain a card
    - "Incomplete data extracted" when name or company is missing
    - Camera access permission errors
    - Image analysis failure handling
  - All error messages include user-friendly guidance and retry options
  
- **Architecture Notes**:
  - Z-index scale documented: Dashboard (default) < SideMenu (55-60) < Modals (70) < Dropdowns (100)
  - Future full-screen modals should use z-[110]+ if they need to cover dropdowns

### 2025-11-10: Fixed Z-Index Layering, LinkedIn Logo Filtering & Enhanced Deduplication
- **Z-Index Hierarchy Fix**:
  - Fixed SideMenu using invalid Tailwind classes (z-55, z-60)
  - Changed to valid arbitrary value syntax: z-[55] for overlay, z-[60] for panel
  - Proper layering: Dashboard < Search dropdown (z-50) < SideMenu (z-[55]/z-[60]) < Modals (z-70)
  - SideMenu now properly appears above dashboard content while staying below modals
  
- **LinkedIn Logo Placeholder Filter**:
  - Added intelligent filtering to prevent LinkedIn placeholder logos from displaying as profile pictures
  - Filters out: linkedin-bug-color.png, linkedin.com/scds/common/u/images/email, /logos/linkedin, default-avatar, placeholder
  - Falls back to UI Avatars when no valid profile photo found
  
- **Improved Person Deduplication**:
  - Enhanced deduplication key from `${name}_${company}` to `${name}_${company}_${urlHost}`
  - Creates separate search result cards for same person on different platforms
  - Example: "Sanchit Neema" now shows distinct cards for LinkedIn, Twitter, personal blog, etc.
  - Allows users to see all unique profiles across web with proper scrolling
  
- **Architecture Notes**:
  - Tailwind arbitrary values (e.g., z-[55]) required for custom z-index not in default scale
  - Default Tailwind scale: z-0, z-10, z-20, z-30, z-40, z-50
  - Custom layering above z-50 requires bracket notation: z-[60], z-[70], etc.

### 2025-11-10: Enhanced Search UX - Progressive Guidance, Keyword Locking & Sci-Fi Loader
- **Opaque Search Dropdown**:
  - Changed from semi-transparent `bg-gray-900/95` to solid `bg-gray-900`
  - Improved readability and visual hierarchy
  
- **Progressive Guidance Messages**:
  - **< 3 characters**: Shows character count and "Type at least 3 characters"
  - **3+ characters**: Displays "Press Enter to search" with keyboard visual
  - **Helpful tip**: "💡 Tip: Add company name for better accuracy"
  - Smart, context-aware messaging guides users through search flow
  
- **Locked Keyword During Search**:
  - Search query "locks" when API call is in progress
  - Displays locked keyword in animated badge: `Locked: "query"`
  - Pulsing cyan dot indicator shows active state
  - Input field disabled with visual feedback (reduced opacity, cursor-not-allowed)
  - Prevents query modification during search execution
  
- **Sci-Fi Dual-Spinner Loader**:
  - Outer spinner rotates clockwise (cyan border-top)
  - Inner spinner rotates counter-clockwise (cyan border-bottom)
  - Animated text: "Scanning the web..." with pulse effect
  - Subtitle: "Searching LinkedIn, Twitter, GitHub & more"
  - Locked keyword badge appears below loader
  - Added `animate-spin-reverse` CSS animation
  
- **Improved Profile Cards**:
  - **Thumbnail**: Left-aligned circular photo (12x12/14x14 responsive)
  - **Name**: Bold, white, larger font with bottom margin for separation
  - **Designation**: Cyan color on separate line
  - **Company**: Gray text with 📍 icon, clearly separated on new line
  - **Social Links**: Bottom row with platform-specific icons
  - Proper visual hierarchy with clear segregation between elements
  
- **Google Search API Key Fix**:
  - Resolved invalid API key issue
  - Updated to working key: `AIzaSyCOxY-Zkt6WhikSHR3prwCZz4hUxLME4MQ`
  - Search functionality now fully operational
  - Comprehensive results from LinkedIn, Twitter, Instagram, Wikipedia, GitHub, etc.

### 2024-11-10: Search UX Improvements - Enter Key Search & Menu Overlay Fix
- **Z-Index Hierarchy Overhaul**:
  - Fixed menu overlapping with search results dropdown
  - Modals and CardScanner elevated to z-70 (top layer for blocking overlays)
  - Header elevated to z-60 (above in-page content)
  - Search dropdown set to z-50 (above side menu)
  - Side menu remains at z-40 (no longer overlaps search results)
  - Proper stacking order ensures all UI elements layer correctly
  
- **Enter Key Search Implementation**:
  - Removed auto-search on typing (500ms debounce removed)
  - Search now triggers exclusively when user presses Enter key
  - Added keyboard event handler to input field
  - Prevents accidental API calls while user is still typing
  
- **Enhanced UX Cues**:
  - Updated placeholder text: "Type a name and press Enter to search..."
  - Clear instruction tells users exactly how to trigger search
  - Reduced confusion about when search will execute
  
- **Input Disabled State During Search**:
  - Input field disabled while search is in progress
  - Visual feedback: reduced opacity (70%), cursor-not-allowed
  - Background darkens slightly to indicate inactive state
  - aria-busy attribute for accessibility
  - Prevents user from modifying query during API call
  
- **Search Results in Dropdown**:
  - Results appear in dropdown menu anchored to search input
  - Proper z-index ensures dropdown appears above all other content except modals
  - Loading spinner remains visible during search
  - Person selection cards with preview info (name, title, company, social links)
  - Smooth transitions and animations maintained
  
- Architect review passed: All UX requirements met, proper layering confirmed