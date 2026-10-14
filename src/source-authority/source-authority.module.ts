import { Global, Module } from '@nestjs/common';
import { SourceAuthorityService } from './source-authority.service';
import { TruthResolverService } from './truth-resolver.service';
import { ProvenanceService } from './provenance.service';
import { FreshnessService } from './freshness.service';
import { GroundingGuardService } from './grounding-guard.service';
import { ClaimEvidenceService } from './claim-evidence';

@Global()
@Module({
  providers: [
    SourceAuthorityService,
    TruthResolverService,
    ProvenanceService,
    FreshnessService,
    GroundingGuardService,
    ClaimEvidenceService,
  ],
  exports: [
    SourceAuthorityService,
    TruthResolverService,
    ProvenanceService,
    FreshnessService,
    GroundingGuardService,
    ClaimEvidenceService,
  ],
})
export class SourceAuthorityModule {}
