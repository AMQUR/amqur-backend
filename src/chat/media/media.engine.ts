import { Injectable } from '@nestjs/common';
import { MediaAdapter } from './media.adapter';
import { StellantisAdapter } from './stellantis.adapter';
import { ImaginAdapter } from './imagin.adapter';

@Injectable()
export class MediaEngine {
  private adapters: MediaAdapter[] = [
    new StellantisAdapter(),
    new ImaginAdapter(),
  ];

  async enrich(make: string, vin: string) {
    const adapter =
      this.adapters.find((a) => a.supports(make)) ??
      this.adapters[this.adapters.length - 1];

    return adapter.fetch(vin);
  }
}
