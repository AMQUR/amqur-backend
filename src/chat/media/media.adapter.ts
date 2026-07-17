export type VehicleMedia = {
  photos?: string[];
  windowStickerUrl?: string;
  msrp?: number;
  packages?: string[];
};

export interface MediaAdapter {
  supports(make: string): boolean;
  fetch(vin: string): Promise<VehicleMedia>;
}
