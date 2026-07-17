import { Injectable } from '@nestjs/common';

export type LeadExtractResult = {
  firstName?: string;
  lastName?: string;
  phone?: string;
  email?: string;
};

@Injectable()
export class LeadExtractor {
  extract(text: string): LeadExtractResult {
    const result: LeadExtractResult = {};

    // phone detection
    const phoneMatch = text.match(
      /(\+1)?\s?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/,
    );

    if (phoneMatch) {
      result.phone = phoneMatch[0].replace(/[^\d]/g, '');
    }

    // email detection
    const emailMatch = text.match(/[^\s]+@[^\s]+\.[^\s]+/);

    if (emailMatch) {
      result.email = emailMatch[0];
    }

    // name detection
    const clean = text.trim();

    if (
      !phoneMatch &&
      !emailMatch &&
      clean.split(' ').length <= 3 &&
      /^[a-zA-Z\s]+$/.test(clean)
    ) {
      const parts = clean.split(' ');

      result.firstName = capitalize(parts[0]);

      if (parts.length > 1) {
        result.lastName = capitalize(parts.slice(1).join(' '));
      }
    }

    return result;
  }
}

function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}
