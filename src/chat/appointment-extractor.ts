import { Injectable } from '@nestjs/common';

@Injectable()
export class AppointmentExtractor {
  wantsScheduling(text: string) {
    const m = text.toLowerCase();
    return (
      m.includes('schedule') ||
      m.includes('test drive') ||
      m.includes('test-drive') ||
      m.includes('book') ||
      m.includes('appointment') ||
      m.includes('come in') ||
      m.includes('visit')
    );
  }

  extractDate(text: string): string | undefined {
    // YYYY-MM-DD
    const iso = text.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
    if (iso) return iso[0];

    // MM/DD/YYYY or MM/DD/YY
    const us = text.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})\b/);
    if (us) {
      const mm = us[1].padStart(2, '0');
      const dd = us[2].padStart(2, '0');
      let yy = us[3];
      if (yy.length === 2) yy = `20${yy}`;
      return `${yy}-${mm}-${dd}`;
    }

    return undefined;
  }

  extractTime(text: string): string | undefined {
    // 3pm, 3:30pm, 15:30
    const m = text.toLowerCase();

    const ampm = m.match(/\b(\d{1,2})(?::(\d{2}))?\s?(am|pm)\b/);
    if (ampm) {
      const h = Number(ampm[1]);
      const min = ampm[2] ?? '00';
      const suffix = ampm[3].toUpperCase();
      return `${h}:${min} ${suffix}`;
    }

    const military = m.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
    if (military) {
      let hour = Number(military[1]);
      const min = military[2];
      const suffix = hour >= 12 ? 'PM' : 'AM';
      hour = hour % 12;
      if (hour === 0) hour = 12;
      return `${hour}:${min} ${suffix}`;
    }

    return undefined;
  }
}
