import { MediaAdapter, VehicleMedia } from './media.adapter';

export class ImaginAdapter implements MediaAdapter {
  supports(): boolean {
    return true;
  }

  async fetch(vin: string): Promise<VehicleMedia> {
    return {
      photos: [
        `https://cdn.imagin.studio/getimage?customer=demo&vin=${vin}&angle=01`,
        `https://cdn.imagin.studio/getimage?customer=demo&vin=${vin}&angle=05`,
        `https://cdn.imagin.studio/getimage?customer=demo&vin=${vin}&angle=09`,
      ],
      windowStickerUrl: `https://windowstickerlookup.com/sticker/${vin}`,
    };
  }
}
