import { MediaAdapter, VehicleMedia } from './media.adapter';

export class StellantisAdapter implements MediaAdapter {
  supports(make: string) {
    return ['jeep', 'ram', 'dodge', 'chrysler'].includes(make.toLowerCase());
  }

  async fetch(vin: string): Promise<VehicleMedia> {
    return {
      windowStickerUrl: `https://www.jeep.com/hostd/windowsticker/getWindowStickerPdf.do?vin=${vin}`,
    };
  }
}
