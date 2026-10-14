import { Global, Module } from '@nestjs/common';
import { FinanceRequestService } from './finance-request.service';
import { FinancialAssumptionPolicyService } from './financial-assumption-policy';
import { CreditApplicationService } from './credit-application.service';
import { CreditLinkController } from './credit-link.controller';

@Global()
@Module({
  controllers: [CreditLinkController],
  providers: [
    FinanceRequestService,
    FinancialAssumptionPolicyService,
    CreditApplicationService,
  ],
  exports: [
    FinanceRequestService,
    FinancialAssumptionPolicyService,
    CreditApplicationService,
  ],
})
export class FinanceModule {}
