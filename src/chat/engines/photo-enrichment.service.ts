import { Injectable } from '@nestjs/common';

@Injectable()
export class PhotoEnrichmentService {
  enrich(vehicle: any) {
    // If real photos exist → keep them
    if (Array.isArray(vehicle.photos) && vehicle.photos.length > 0) {
      return vehicle;
    }

    // Fallback placeholder images
    const base = 'https://cdn.imagin.studio/getimage';

    const params = new URLSearchParams({
      customer: 'usdemo',
      make: vehicle.make,
      model: vehicle.model,
      angle: '01',
      width: '800',
    });

    return {
      ...vehicle,
      photos: [
        `${base}?${params.toString()}`,
        `${base}?${params.toString()}&angle=02`,
        `${base}?${params.toString()}&angle=03`,
      ],
    };
  }
}
