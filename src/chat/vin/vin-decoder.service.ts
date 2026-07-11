import axios from 'axios';
import { Injectable, Logger } from '@nestjs/common';
import { VinProfile } from './vin.types';

/** Timeout for NHTSA API requests (ms). */
const NHTSA_TIMEOUT_MS = 6000;

@Injectable()
export class VinDecoderService {
    private readonly logger = new Logger(VinDecoderService.name);

    async decode(vin: string): Promise<VinProfile> {
        const url =
            `https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVin/${vin}?format=json`;

        try {
            const res = await axios.get(url, { timeout: NHTSA_TIMEOUT_MS });

            const map: Record<string, string> = {};

            for (const row of (res.data?.Results ?? [])) {
                if (row.Variable && row.Value && row.Value !== 'Not Applicable') {
                    map[row.Variable] = row.Value;
                }
            }

            return {
                vin,
                year: Number(map['Model Year']) || undefined,
                make: map['Make'],
                model: map['Model'],
                trim: map['Trim'],

                bodyType: map['Body Class'],
                doors: Number(map['Doors']) || undefined,

                engine: map['Engine Model'] || map['Engine Configuration'],
                transmission: map['Transmission Style'],
                drivetrain: map['Drive Type'],
                fuelType: map['Fuel Type - Primary'],
            };
        } catch (e) {
            this.logger.warn(
                `NHTSA VIN decode failed for ${vin}: ${e instanceof Error ? e.message : e}`,
            );
            // Return a minimal profile so the flow doesn't crash
            return { vin };
        }
    }
}
