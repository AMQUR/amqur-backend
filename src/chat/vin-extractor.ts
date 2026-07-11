import { Injectable } from '@nestjs/common';
import { extractVinCandidates, isValidVinFormat } from '../common/vin/vin.util';

@Injectable()
export class VinExtractor {

    extract(text: string, visibleVins: string[]) {
        const lower = text.toLowerCase();

        const candidates = extractVinCandidates(text);
        if (candidates.length > 0) {
            return candidates.find(isValidVinFormat) ?? candidates[0];
        }

        // 2️⃣ Ordinal selection
        if (lower.includes('first')) return visibleVins[0];
        if (lower.includes('second')) return visibleVins[1];
        if (lower.includes('third')) return visibleVins[2];

        // 3️⃣ Generic reference
        if (
            lower.includes('this one') ||
            lower.includes('that one')
        ) {
            return visibleVins[0];
        }

        return null;
    }
}
