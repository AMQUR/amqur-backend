import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PaymentEngine } from './payment.engine';
import { PhotoEnrichmentService } from './photo-enrichment.service';

@Injectable()
export class InventoryEngine {
    constructor(
        private readonly prisma: PrismaService,
        private readonly paymentEngine: PaymentEngine,
        private readonly photoService: PhotoEnrichmentService,
    ) { }

    // ─────────────────────────────
    // INVENTORY SEARCH
    // ─────────────────────────────
    async searchVehicles(params: {
        tenantId: string;
        locationId?: string | null;
        query?: string;
        year?: number;
        maxPrice?: number;
        maxMonthlyPayment?: number;
    }) {
        const {
            tenantId,
            locationId,
            query,
            year,
            maxPrice,
            maxMonthlyPayment,
        } = params;

        const cleanedQuery = query
            ?.toLowerCase()
            .replace(/\b(under|below|less than|\$|usd)\b/g, '')
            .replace(/\b\d{4}\b/g, '')
            .replace(/\btrucks\b/g, 'truck')
            .replace(/\bsuvs\b/g, 'suv')
            .replace(/\bsedans\b/g, 'sedan')
            .trim();

        let vehicles = await this.prisma.vehicle.findMany({
            where: {
                tenantId,
                // Only show sellable inventory — never fabricate availability
                status: { in: ['AVAILABLE', 'IN_TRANSIT'] },
                ...(locationId
                    ? {
                        OR: [
                            { locationId },
                            { locationId: null },
                        ],
                    }
                    : {}),
                ...(year && { year }),
                ...(maxPrice && { price: { lte: maxPrice } }),
                ...(cleanedQuery && {
                    OR: [
                        {
                            model: {
                                contains: cleanedQuery,
                                mode: 'insensitive',
                            },
                        },
                        {
                            make: {
                                contains: cleanedQuery,
                                mode: 'insensitive',
                            },
                        },
                        {
                            trim: {
                                contains: cleanedQuery,
                                mode: 'insensitive',
                            },
                        },
                    ],
                }),
            },
            orderBy: { createdAt: 'desc' },
        });

        // PAYMENT FILTER
        if (maxMonthlyPayment) {
            vehicles = vehicles.filter(vehicle => {
                if (vehicle.price == null) return false;

                const payment =
                    this.paymentEngine.calculateMonthlyPayment({
                        price: vehicle.price,
                    });

                return payment <= maxMonthlyPayment;
            });
        }

        return vehicles
            .map(vehicle => {
                const estimatedPayment =
                    vehicle.price != null
                        ? this.paymentEngine.calculateMonthlyPayment({
                            price: vehicle.price,
                        })
                        : null;

                return {
                    id: vehicle.id,
                    vin: vehicle.vin,
                    stock: vehicle.stock,

                    year: vehicle.year,
                    make: vehicle.make,
                    model: vehicle.model,
                    trim: vehicle.trim,

                    price: vehicle.price,
                    msrp: vehicle.msrp,
                    mileage: vehicle.mileage,

                    color: vehicle.color,
                    drivetrain: vehicle.drivetrain,
                    bodyType: vehicle.bodyType,

                    transmission: vehicle.transmission,
                    fuelType: vehicle.fuelType,

                    photos: Array.isArray(vehicle.photos)
                        ? vehicle.photos
                        : [],

                    estimatedPayment,
                    status: vehicle.status,
                    locationId: vehicle.locationId,
                    lastSeenAt: vehicle.lastSeenAt
                        ? vehicle.lastSeenAt.toISOString()
                        : null,
                    source: vehicle.source ?? null,
                    freshnessState: vehicle.freshnessState ?? null,
                };
            })
            .map(vehicle => this.photoService.enrich(vehicle));
    }

    // ─────────────────────────────
    // VIN COMPARISON
    // ─────────────────────────────
    async getVehiclesByVin(
        tenantId: string,
        vins: string[],
    ) {
        const vehicles = await this.prisma.vehicle.findMany({
            where: {
                tenantId,
                vin: { in: vins },
            },
            orderBy: { createdAt: 'desc' },
        });

        return vehicles.map(vehicle => {
            const estimatedPayment =
                vehicle.price != null
                    ? this.paymentEngine.calculateMonthlyPayment({
                        price: vehicle.price,
                    })
                    : null;

            return this.photoService.enrich({
                id: vehicle.id,
                vin: vehicle.vin,
                stock: vehicle.stock,

                year: vehicle.year,
                make: vehicle.make,
                model: vehicle.model,
                trim: vehicle.trim,

                price: vehicle.price,
                msrp: vehicle.msrp,
                mileage: vehicle.mileage,

                color: vehicle.color,
                drivetrain: vehicle.drivetrain,
                bodyType: vehicle.bodyType,

                transmission: vehicle.transmission,
                fuelType: vehicle.fuelType,

                photos: Array.isArray(vehicle.photos)
                    ? vehicle.photos
                    : [],

                estimatedPayment,
                status: vehicle.status,
                locationId: vehicle.locationId,
                lastSeenAt: vehicle.lastSeenAt
                    ? vehicle.lastSeenAt.toISOString()
                    : null,
                source: vehicle.source ?? null,
                freshnessState: vehicle.freshnessState ?? null,
            });
        });
    }

    // ─────────────────────────────
    // GET SINGLE VEHICLE BY VIN ✅ FIX
    // ─────────────────────────────
    async getVehicleByVin(
        tenantId: string,
        vin: string,
    ) {
        const vehicle = await this.prisma.vehicle.findFirst({
            where: {
                tenantId,
                vin,
            },
        });

        if (!vehicle) return null;

        const estimatedPayment =
            vehicle.price != null
                ? this.paymentEngine.calculateMonthlyPayment({
                    price: vehicle.price,
                })
                : null;

        return this.photoService.enrich({
            id: vehicle.id,
            vin: vehicle.vin,
            stock: vehicle.stock,

            year: vehicle.year,
            make: vehicle.make,
            model: vehicle.model,
            trim: vehicle.trim,

            price: vehicle.price,
            msrp: vehicle.msrp,
            mileage: vehicle.mileage,

            color: vehicle.color,
            drivetrain: vehicle.drivetrain,
            bodyType: vehicle.bodyType,

            transmission: vehicle.transmission,
            fuelType: vehicle.fuelType,

            photos: Array.isArray(vehicle.photos)
                ? vehicle.photos
                : [],

            estimatedPayment,
            status: vehicle.status,
            locationId: vehicle.locationId,
            lastSeenAt: vehicle.lastSeenAt
                ? vehicle.lastSeenAt.toISOString()
                : null,
            source: vehicle.source ?? null,
            freshnessState: vehicle.freshnessState ?? null,
        });
    }

    // ─────────────────────────────
    // HOLD / RESERVE VEHICLE
    // ─────────────────────────────
    async holdVehicle(
        tenantId: string,
        vin: string,
    ) {
        // Multi-tenant safe: only hold vehicles belonging to this tenant
        await this.prisma.vehicle.updateMany({
            where: { tenantId, vin },
            data: { status: 'HOLD' },
        });
    }
}
