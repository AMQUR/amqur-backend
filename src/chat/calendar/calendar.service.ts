export type CalendarEventInput = {
  title: string;
  description?: string;
  startISO: string;
  endISO: string;
  location?: string;
  attendeeEmail?: string;
};

export interface CalendarService {
  createEvent(input: CalendarEventInput): Promise<void>;
}
