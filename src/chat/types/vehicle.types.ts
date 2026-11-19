export type InventoryVehicle = {
  id?: string;
  vin: string;
  stock?: string | null;

  year?: number;
  make?: string;
  model?: string;
  trim?: string;

  engine?: string;

  price?: number;
  msrp?: number;
  mileage?: number;

  color?: string;
  drivetrain?: string;
  bodyType?: string;

  transmission?: string;
  fuelType?: string;

  doors?: number;

  photos?: string[];

  estimatedPayment?: number;
  paymentExplanation?: string;
  windowStickerUrl?: string;

  status?: string;
  locationId?: string | null;

  /** Feed freshness — ISO timestamp when last seen in inventory sync */
  lastSeenAt?: string | null;
  source?: string | null;
  /** True for synthetic local-demo fixtures (never present in production reads). */
  simulated?: boolean;
  freshnessState?: 'FRESH' | 'DEGRADED' | 'STALE' | 'UNAVAILABLE' | null;

  // ── Sales-desk fields (flag `salesDeskCards`); absent when the flag is off ──
  /**
   * The vehicle's page on the OWNING rooftop's own website. Only a verified https URL from
   * the feed record on that rooftop's host — otherwise null. Never constructed.
   */
  vdpUrl?: string | null;
  /** Display name of the rooftop (location) that holds the vehicle. */
  rooftopName?: string | null;
  /**
   * Group site only: opaque, conversation-bound reference to the rooftop that holds the
   * vehicle, for the widget to echo back with it. Never a tenant or location id.
   */
  rooftopRef?: string;
  /** true/false only when the dealer-configured pricing policy states it; null = unknown. */
  priceIncludesDealerFees?: boolean | null;
};
