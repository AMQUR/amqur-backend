import { Injectable } from '@nestjs/common';
import * as googleapis from 'googleapis';

const { google } = googleapis;

@Injectable()
export class GoogleCalendarService {
  private calendar;

  constructor() {
    const auth = new google.auth.GoogleAuth({
      credentials: {
        client_email: process.env.GOOGLE_CLIENT_EMAIL,
        private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      },
      scopes: ['https://www.googleapis.com/auth/calendar'],
    });

    this.calendar = google.calendar({
      version: 'v3',
      auth,
    });
  }

  async createEvent(params: {
    title: string;
    description?: string;
    startISO: string;
    endISO: string;
    attendeeEmail?: string;
  }) {
    await this.calendar.events.insert({
      calendarId: 'primary',
      requestBody: {
        summary: params.title,
        description: params.description,
        start: { dateTime: params.startISO },
        end: { dateTime: params.endISO },
        attendees: params.attendeeEmail
          ? [{ email: params.attendeeEmail }]
          : undefined,
      },
    });
  }
}
