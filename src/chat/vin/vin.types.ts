export type VinProfile = {
  vin: string;

  year?: number;
  make?: string;
  model?: string;
  trim?: string;

  engine?: string;
  transmission?: string;
  drivetrain?: string;
  fuelType?: string;

  bodyType?: string;
  doors?: number;

  packages?: string[];
  options?: string[];

  msrp?: number;

  photos?: string[];
};
