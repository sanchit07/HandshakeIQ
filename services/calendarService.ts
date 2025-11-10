import { google } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID!;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET!;

interface CalendarAttendee {
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

export class CalendarService {
  private oauth2Client: OAuth2Client;

  constructor(accessToken: string, refreshToken?: string) {
    this.oauth2Client = new OAuth2Client(
      GOOGLE_CLIENT_ID,
      GOOGLE_CLIENT_SECRET
    );

    this.oauth2Client.setCredentials({
      access_token: accessToken,
      refresh_token: refreshToken,
    });
  }

  async getEvents(timeMin?: Date, timeMax?: Date, maxResults: number = 50): Promise<CalendarEvent[]> {
    try {
      const calendar = google.calendar({ version: 'v3', auth: this.oauth2Client });

      const response = await calendar.events.list({
        calendarId: 'primary',
        timeMin: (timeMin || new Date()).toISOString(),
        timeMax: timeMax?.toISOString(),
        maxResults,
        singleEvents: true,
        orderBy: 'startTime',
      });

      const events = response.data.items || [];

      return events.map((event) => ({
        id: event.id || '',
        summary: event.summary || 'Untitled Event',
        description: event.description,
        start: event.start?.dateTime || event.start?.date || '',
        end: event.end?.dateTime || event.end?.date || '',
        location: event.location,
        attendees: event.attendees?.map((attendee) => ({
          email: attendee.email,
          displayName: attendee.displayName,
          responseStatus: attendee.responseStatus,
          organizer: attendee.organizer,
          optional: attendee.optional,
          self: attendee.self,
        })) || [],
        organizer: event.organizer ? {
          email: event.organizer.email,
          displayName: event.organizer.displayName,
        } : undefined,
        status: event.status,
        htmlLink: event.htmlLink,
      }));
    } catch (error) {
      console.error('Error fetching calendar events:', error);
      throw new Error('Failed to fetch calendar events');
    }
  }

  async getTodayAndTomorrowEvents(): Promise<CalendarEvent[]> {
    const now = new Date();
    const endOfTomorrow = new Date();
    endOfTomorrow.setDate(endOfTomorrow.getDate() + 2);
    endOfTomorrow.setHours(0, 0, 0, 0);

    return this.getEvents(now, endOfTomorrow, 20);
  }

  async getUpcomingEvents(days: number = 30): Promise<CalendarEvent[]> {
    const now = new Date();
    const future = new Date();
    future.setDate(future.getDate() + days);

    return this.getEvents(now, future, 100);
  }
}
