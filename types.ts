export interface Person {
  id: string;
  name: string;
  title: string;
  company: string;
  photoUrl: string;
  email: string;
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