import { Injectable } from '@nestjs/common';
import { VinProfile } from './vin.types';

@Injectable()
export class VinExplainerService {
  explain(profile: VinProfile): string {
    const lines: string[] = [];

    // Trim explanation
    if (profile.trim) {
      if (/sport/i.test(profile.trim)) {
        lines.push(
          `This is the **Sport trim**, designed as the most affordable option with essential features.`,
        );
      } else if (/sahara/i.test(profile.trim)) {
        lines.push(
          `The **Sahara trim** adds comfort upgrades like larger wheels, premium interior, and advanced tech.`,
        );
      } else if (/rubicon/i.test(profile.trim)) {
        lines.push(
          `The **Rubicon trim** is built for serious off-road driving with locking differentials and heavy-duty suspension.`,
        );
      } else if (/limited/i.test(profile.trim)) {
        lines.push(
          `The **Limited trim** focuses on luxury with premium materials and advanced safety features.`,
        );
      } else {
        lines.push(`This vehicle comes in the **${profile.trim} trim**.`);
      }
    }

    // Drivetrain
    if (profile.drivetrain) {
      if (/4x4|awd/i.test(profile.drivetrain)) {
        lines.push(
          `It features **${profile.drivetrain}**, making it excellent for snow, rain, and rough conditions.`,
        );
      } else {
        lines.push(
          `It uses **${profile.drivetrain}**, ideal for everyday highway driving.`,
        );
      }
    }

    // Engine
    if (profile.engine) {
      lines.push(`Powered by a **${profile.engine}** engine.`);
    }

    // Fuel type
    if (profile.fuelType) {
      if (/hybrid|electric/i.test(profile.fuelType)) {
        lines.push(
          `This is a **${profile.fuelType}**, offering better fuel efficiency and lower fuel costs.`,
        );
      }
    }

    // Body style
    if (profile.bodyType) {
      lines.push(`Body style: **${profile.bodyType}**.`);
    }

    return lines.join(' ');
  }
}
