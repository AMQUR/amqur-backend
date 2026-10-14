import { Global, Module } from '@nestjs/common';
import { FinanceRequestService } from './finance-request.service';
import { FinancialAssumptionPolicyService } from './financial-assumption-policy';
import { CreditApplicationService } from './credit-application.service';
import { CreditLinkController } from './credit-link.controller';
import { PriceQuoteService } from './price-quote.service';
import { CreditDestinationAdminService } from './credit-destination-admin.service';
import { SecretVaultService } from '../integrations/core/secret-vault.service';

@Global()
@Module({
  controllers: [CreditLinkController],
  providers: [
    FinanceRequestService,
    FinancialAssumptionPolicyService,
    CreditApplicationService,
    SecretVaultService,
    PriceQuoteService,
    CreditDestinationAdminService,
  ],
  exports: [
    FinanceRequestService,
    FinancialAssumptionPolicyService,
    CreditApplicationService,
    PriceQuoteService,
    CreditDestinationAdminService,
  ],
})
export class FinanceModule {}
