/**
 * SIMULATED local-demo dataset shared by scripts/seed-local-demo.ts and the golden
 * conversation e2e suite. Synthetic figures only — never a real dealership's inventory,
 * prices or hours. VINs contain the letter O, which real VINs never contain.
 */
export type DemoVehicle = {
  vin: string;
  stock: string;
  year: number;
  make: string;
  model: string;
  trim: string;
  bodyType: string;
  drivetrain: string;
  fuelType: string;
  color: string;
  interiorColor?: string;
  price: number;
  msrp?: number;
  mileage: number;
  condition: 'new' | 'used' | 'certified';
  status?: 'AVAILABLE' | 'IN_TRANSIT';
  features: string[];
};

// Synthetic figures for demonstration only — not advertised prices of any real dealership.
export const DEMO_VEHICLES: DemoVehicle[] = [
  {
    vin: 'DEMOGW25S2OOOOO01',
    stock: 'DEMO-GW1',
    year: 2025,
    make: 'Jeep',
    model: 'Grand Wagoneer',
    trim: 'Series II 4x4',
    bodyType: 'SUV',
    drivetrain: '4WD',
    fuelType: 'Gasoline',
    color: 'Silver Zynith',
    interiorColor: 'Global Black',
    price: 92480,
    msrp: 96115,
    mileage: 9,
    condition: 'new',
    features: [
      'leather seats',
      'heated seats',
      'ventilated seats',
      'panoramic sunroof',
      'navigation',
      'third row',
      'adaptive cruise control',
      'tow package',
    ],
  },
  {
    vin: 'DEMOGW25S3OOOOO02',
    stock: 'DEMO-GW2',
    year: 2025,
    make: 'Jeep',
    model: 'Grand Wagoneer',
    trim: 'Series III Obsidian 4x4',
    bodyType: 'SUV',
    drivetrain: '4WD',
    fuelType: 'Gasoline',
    color: 'Diamond Black',
    interiorColor: 'Global Black',
    price: 106950,
    msrp: 110330,
    mileage: 14,
    condition: 'new',
    features: [
      'leather seats',
      'heated seats',
      'ventilated seats',
      'massaging seats',
      'panoramic sunroof',
      'navigation',
      'third row',
      'night vision',
      'rear seat entertainment',
      'tow package',
    ],
  },
  {
    vin: 'DEMOGW24L1OOOOO03',
    stock: 'DEMO-GW3',
    year: 2024,
    make: 'Jeep',
    model: 'Grand Wagoneer L',
    trim: 'Series I 4x4',
    bodyType: 'SUV',
    drivetrain: '4WD',
    fuelType: 'Gasoline',
    color: 'Bright White',
    interiorColor: 'Tupelo',
    price: 78900,
    mileage: 11240,
    condition: 'used',
    features: [
      'leather seats',
      'heated seats',
      'navigation',
      'third row',
      'adaptive cruise control',
    ],
  },
  {
    vin: 'DEMOWR25SSOOOOO04',
    stock: 'DEMO-WR1',
    year: 2025,
    make: 'Jeep',
    model: 'Wrangler',
    trim: 'Sport S 4x4',
    bodyType: 'SUV',
    drivetrain: '4WD',
    fuelType: 'Gasoline',
    color: 'Firecracker Red',
    price: 41890,
    msrp: 43185,
    mileage: 6,
    condition: 'new',
    features: ['apple carplay', 'android auto', 'removable top', 'tow package'],
  },
  {
    vin: 'DEMOWR24RXOOOOO05',
    stock: 'DEMO-WR2',
    year: 2024,
    make: 'Jeep',
    model: 'Wrangler',
    trim: 'Rubicon 4xe',
    bodyType: 'SUV',
    drivetrain: '4WD',
    fuelType: 'Plug-in Hybrid',
    color: 'Earl',
    price: 51995,
    mileage: 6830,
    condition: 'certified',
    features: [
      'leather seats',
      'heated seats',
      'navigation',
      'apple carplay',
      'removable top',
      'tow package',
    ],
  },
  {
    vin: 'DEMOCP25LTOOOOO06',
    stock: 'DEMO-CP1',
    year: 2025,
    make: 'Jeep',
    model: 'Compass',
    trim: 'Latitude 4x4',
    bodyType: 'SUV',
    drivetrain: '4WD',
    fuelType: 'Gasoline',
    color: 'Sting-Gray',
    price: 30980,
    msrp: 32480,
    mileage: 11,
    condition: 'new',
    features: [
      'apple carplay',
      'android auto',
      'heated seats',
      'blind spot monitoring',
    ],
  },
  {
    vin: 'DEMOGC25LMOOOOO07',
    stock: 'DEMO-GC1',
    year: 2025,
    make: 'Jeep',
    model: 'Grand Cherokee',
    trim: 'Limited 4x4',
    bodyType: 'SUV',
    drivetrain: '4WD',
    fuelType: 'Gasoline',
    color: 'Velvet Red',
    price: 49870,
    msrp: 52010,
    mileage: 8,
    condition: 'new',
    status: 'IN_TRANSIT',
    features: [
      'leather seats',
      'heated seats',
      'navigation',
      'adaptive cruise control',
      'tow package',
    ],
  },
  {
    vin: 'DEMOGL24MJOOOOO08',
    stock: 'DEMO-GL1',
    year: 2024,
    make: 'Jeep',
    model: 'Gladiator',
    trim: 'Mojave 4x4',
    bodyType: 'Truck',
    drivetrain: '4WD',
    fuelType: 'Gasoline',
    color: 'Hydro Blue',
    price: 48450,
    mileage: 4120,
    condition: 'used',
    features: ['heated seats', 'navigation', 'tow package', 'removable top'],
  },
];

// Synthetic hours — labeled "demo hours" to customers; never real store hours.
export const DEMO_HOURS = {
  storeHours: {
    mon: { open: '09:00', close: '20:00' },
    tue: { open: '09:00', close: '20:00' },
    wed: { open: '09:00', close: '20:00' },
    thu: { open: '09:00', close: '20:00' },
    fri: { open: '09:00', close: '20:00' },
    sat: { open: '09:00', close: '18:00' },
    sun: null,
  },
  departmentHours: {
    service: {
      mon: { open: '07:00', close: '18:00' },
      tue: { open: '07:00', close: '18:00' },
      wed: { open: '07:00', close: '18:00' },
      thu: { open: '07:00', close: '18:00' },
      fri: { open: '07:00', close: '18:00' },
      sat: { open: '08:00', close: '14:00' },
      sun: null,
    },
    parts: {
      mon: { open: '07:30', close: '17:30' },
      tue: { open: '07:30', close: '17:30' },
      wed: { open: '07:30', close: '17:30' },
      thu: { open: '07:30', close: '17:30' },
      fri: { open: '07:30', close: '17:30' },
      sat: { open: '08:00', close: '13:00' },
      sun: null,
    },
  },
};
