export interface Person {
  id: string;
  name: string;
  title: string;
  company: string;
  photoUrl: string;
  email: string;
  allLinks?: string[];
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
    }[];
}

export interface GroundingChunk {
    web?: {
        uri: string;
        title: string;
    };
}

export interface IntelligenceReport {
    summary: string;
    professionalBackground: Insight;
    recentActivities: Insight;
    personalInterests: Insight;
    discussionPoints: Insight;
    rawText?: string;
}