export interface Person {
  id: string;
  name: string;
  title: string;
  company: string;
  photoUrl: string;
  email: string;
  searchLinks?: SearchLink[];
  socialMediaLinks?: SocialMediaLink[];
}

export interface SearchLink {
  url: string;
  title: string;
  snippet: string;
  source: string;
}

export interface SocialMediaLink {
  platform: 'linkedin' | 'twitter' | 'facebook' | 'instagram' | 'github' | 'website' | 'other';
  url: string;
  label?: string;
}

export interface CalendarAttendee {
  email?: string;
  displayName?: string;
  responseStatus?: string;
  organizer?: boolean;
  optional?: boolean;
  self?: boolean;
}

export interface CalendarEvent {
  id: string;
  summary: string;
  description?: string;
  start: string;
  end: string;
  location?: string;
  attendees: CalendarAttendee[];
  organizer?: {
    email?: string;
    displayName?: string;
  };
  status?: string;
  htmlLink?: string;
}

export interface Meeting {
  id:string;
  title: string;
  time: string;
  attendees: Person[];
  source?: 'google' | 'zoho' | 'microsoft';
}

export interface Insight {
    category: string;
    points: {
        text: string;
        confidence: number;
        source_indices?: number[];
        timestamp?: string;
    }[];
}

export interface GroundingChunk {
    web?: {
        uri: string;
        title: string;
    };
}

export interface SourceInfo {
    url: string;
    title: string;
    favicon?: string;
}

export interface IntelligenceReport {
    summary: string;
    professionalBackground: Insight;
    recentActivities: Insight;
    personalInterests: Insight;
    discussionPoints: Insight;
    rawText?: string;
}

export interface SearchResult {
  query: string;
  people: PersonSearchResult[];
}

export interface PersonSearchResult {
  name: string;
  title?: string;
  company?: string;
  email?: string;
  photoUrl?: string;
  links: SearchLink[];
  socialMediaLinks: SocialMediaLink[];
  snippet?: string;
}

export interface Note {
  id: string;
  dossierId: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}

export interface Dossier {
  id: string;
  userId: string;
  personName: string;
  personTitle?: string;
  personCompany?: string;
  personEmail?: string;
  personPhotoUrl?: string;
  intelligenceReport?: IntelligenceReport;
  sources?: GroundingChunk[];
  socialMediaLinks?: SocialMediaLink[];
  searchQuery?: string;
  createdAt: string;
  updatedAt: string;
}