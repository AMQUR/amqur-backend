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
};
