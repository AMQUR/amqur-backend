import type { DemoVehicle } from '../../scripts/lib/local-demo-data';
import { DEMO_VEHICLES } from '../../scripts/lib/local-demo-data';

/**
 * Five SIMULATED stores mirroring the Dial rooftops' brands (fixture data only — never real
 * inventory, prices or VINs; every VIN contains the letter O, impossible in a real VIN).
 * Each store has: one model with 2+ units incl. a red one (`multi`, used for compare and
 * "the red one"), and single-unit models (`singles`) for payment/OTD/credit flows.
 */
export type StoreVocab = {
  key: string;
  make: string;
  multi: string;
  singles: string[];
  say: Record<string, string[]>;
  ownVehicles: string[];
  partsLines: string[];
  notCarried: string[];
  vehicles: DemoVehicle[];
};

const v = (
  vin: string,
  make: string,
  model: string,
  trim: string,
  color: string,
  price: number,
  body = 'SUV',
): DemoVehicle => ({
  vin,
  stock: vin.slice(-5),
  year: 2025,
  make,
  model,
  trim,
  bodyType: body,
  drivetrain: 'AWD',
  fuelType: 'Gasoline',
  color,
  price,
  mileage: 12,
  condition: 'new',
  features: ['heated seats', 'apple carplay'],
});

export const STORES: StoreVocab[] = [
  {
    key: 'jeep-north',
    make: 'Jeep',
    multi: 'Wrangler',
    singles: ['Compass', 'Grand Cherokee', 'Gladiator'],
    say: {
      Wrangler: ['Wrangler', 'wrangler', 'a jeep wrangler', 'wranglers'],
      Compass: ['Compass', 'jeep compass', 'a compass'],
      'Grand Cherokee': ['Grand Cherokee', 'a grand cherokee'],
      Gladiator: ['Gladiator', 'a gladiator truck'],
      'Grand Wagoneer': ['Grand Wagoneer', 'grand wagoneers'],
    },
    ownVehicles: ['2019 Jeep Cherokee', '2018 Jeep Compass'],
    partsLines: [
      'I need brake pads',
      'Do you have wiper blades for a 2019 Cherokee?',
    ],
    notCarried: ['Ford Bronco', 'Porsche 911', 'Toyota Tacoma'],
    vehicles: DEMO_VEHICLES,
  },
  {
    key: 'chevy',
    make: 'Chevrolet',
    multi: 'Tahoe',
    singles: ['Equinox', 'Traverse', 'Colorado'],
    say: {
      Tahoe: ['Tahoe', 'a chevy tahoe', 'tahoes'],
      Equinox: ['Equinox', 'chevy equinox', 'an equinox'],
      Traverse: ['Traverse', 'a chevy traverse'],
      Colorado: ['Colorado', 'a colorado truck'],
    },
    ownVehicles: ['2019 Chevy Equinox', '2017 Chevrolet Malibu'],
    partsLines: ['I need brake pads for my equinox', 'need an air filter'],
    notCarried: ['Ford Bronco', 'Honda Civic', 'Toyota Tacoma'],
    vehicles: [
      v(
        'SIMCHVTHOOOOOO001',
        'Chevrolet',
        'Tahoe',
        'LT 4WD',
        'Radiant Red Metallic',
        64995,
      ),
      v(
        'SIMCHVTHOOOOOO002',
        'Chevrolet',
        'Tahoe',
        'High Country 4WD',
        'Black',
        78450,
      ),
      v(
        'SIMCHVEQOOOOOO003',
        'Chevrolet',
        'Equinox',
        'RS AWD',
        'Summit White',
        34210,
      ),
      v(
        'SIMCHVTROOOOOO004',
        'Chevrolet',
        'Traverse',
        'LT AWD',
        'Sterling Gray',
        44380,
      ),
      v(
        'SIMCHVCOOOOOOO005',
        'Chevrolet',
        'Colorado',
        'Z71',
        'Cacti Green',
        43995,
        'Truck',
      ),
    ],
  },
  {
    key: 'nissan',
    make: 'Nissan',
    multi: 'Rogue',
    singles: ['Altima', 'Frontier', 'Kicks'],
    say: {
      Rogue: ['Rogue', 'a nissan rogue', 'rogues'],
      Altima: ['Altima', 'nissan altima', 'an altima'],
      Frontier: ['Frontier', 'a frontier pickup'],
      Kicks: ['Kicks', 'nissan kicks'],
    },
    ownVehicles: ['2018 Nissan Altima', '2020 Nissan Sentra'],
    partsLines: ['I need brake pads for my altima', 'need wiper blades'],
    notCarried: ['Ford Bronco', 'Tesla Model Y', 'Honda Civic'],
    vehicles: [
      v(
        'SIMNSNRGOOOOOO001',
        'Nissan',
        'Rogue',
        'SV AWD',
        'Scarlet Ember Red',
        33480,
      ),
      v(
        'SIMNSNRGOOOOOO002',
        'Nissan',
        'Rogue',
        'Platinum AWD',
        'Gun Metallic',
        41990,
      ),
      v(
        'SIMNSNALOOOOOO003',
        'Nissan',
        'Altima',
        'SR',
        'Super Black',
        29360,
        'Sedan',
      ),
      v(
        'SIMNSNFROOOOOO004',
        'Nissan',
        'Frontier',
        'PRO-4X',
        'Baja Storm',
        42750,
        'Truck',
      ),
      v('SIMNSNKCOOOOOO005', 'Nissan', 'Kicks', 'SR', 'Boulder Gray', 25120),
    ],
  },
  {
    key: 'infiniti',
    make: 'INFINITI',
    multi: 'QX60',
    singles: ['QX50', 'QX80', 'Q50'],
    say: {
      QX60: ['QX60', 'an infiniti qx60', 'qx60s'],
      QX50: ['QX50', 'infiniti qx50'],
      QX80: ['QX80', 'a qx80'],
      Q50: ['Q50', 'infiniti q50 sedan'],
    },
    ownVehicles: ['2018 INFINITI QX50', '2016 Infiniti Q50'],
    partsLines: ['I need brake pads for my q50', 'need an air filter'],
    notCarried: ['Lexus RX', 'Porsche 911', 'Ford Bronco'],
    vehicles: [
      v(
        'SIMINFQ6OOOOOO001',
        'INFINITI',
        'QX60',
        'LUXE AWD',
        'Dynamic Sunstone Red',
        58760,
      ),
      v(
        'SIMINFQ6OOOOOO002',
        'INFINITI',
        'QX60',
        'AUTOGRAPH AWD',
        'Moonbow Blue',
        67320,
      ),
      v(
        'SIMINFQ5OOOOOO003',
        'INFINITI',
        'QX50',
        'SPORT AWD',
        'Majestic White',
        50210,
      ),
      v(
        'SIMINFQ8OOOOOO004',
        'INFINITI',
        'QX80',
        'SENSORY 4WD',
        'Black Obsidian',
        96450,
      ),
      v(
        'SIMINFQZOOOOOO005',
        'INFINITI',
        'Q50',
        'LUXE',
        'Graphite Shadow',
        46780,
        'Sedan',
      ),
    ],
  },
  {
    key: 'cdjr-south',
    make: 'Dodge',
    multi: 'Durango',
    singles: ['Pacifica', 'Charger', 'Hornet'],
    say: {
      Durango: ['Durango', 'a dodge durango', 'durangos'],
      Pacifica: ['Pacifica', 'chrysler pacifica', 'a pacifica minivan'],
      Charger: ['Charger', 'a dodge charger'],
      Hornet: ['Hornet', 'dodge hornet'],
    },
    ownVehicles: ['2019 Dodge Journey', '2017 Chrysler 300'],
    partsLines: ['I need brake pads for my journey', 'need wiper blades'],
    notCarried: ['Ford Bronco', 'Toyota Tacoma', 'Honda Civic'],
    vehicles: [
      v(
        'SIMCDJDUOOOOOO001',
        'Dodge',
        'Durango',
        'GT AWD',
        'Redline Red',
        47990,
      ),
      v(
        'SIMCDJDUOOOOOO002',
        'Dodge',
        'Durango',
        'SRT 392',
        'Destroyer Gray',
        79680,
      ),
      v(
        'SIMCDJPAOOOOOO003',
        'Chrysler',
        'Pacifica',
        'Limited',
        'Bright White',
        51280,
        'Van',
      ),
      v(
        'SIMCDJCHOOOOOO004',
        'Dodge',
        'Charger',
        'Scat Pack',
        'Pitch Black',
        61990,
        'Sedan',
      ),
      v(
        'SIMCDJHOOOOOOO005',
        'Dodge',
        'Hornet',
        'GT Plus',
        'Acapulco Gold',
        37690,
      ),
    ],
  },
];
