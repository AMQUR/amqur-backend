/**
 * Prints the five-rooftop readiness scorecard as Markdown from the registry + the database
 * DATABASE_URL points at (read-only). Usage: npm run readiness:scorecard > docs/FIVE_STORE_SCORECARD.md
 */
import { PrismaClient } from '@prisma/client';
import {
  RooftopReadinessService,
  ROW_LABELS,
  RowKey,
} from '../src/operations/rooftop-readiness';
import { CreditApplicationService } from '../src/finance/credit-application.service';
import { SecretVaultService } from '../src/integrations/core/secret-vault.service';

async function main() {
  const prisma = new PrismaClient();
  const config = { get: (k: string) => process.env[k] };
  const vault = new SecretVaultService(config as never);
  const credit = new CreditApplicationService(
    prisma as never,
    config as never,
    { trackEvent: async () => undefined } as never,
    vault,
  );
  const svc = new RooftopReadinessService(prisma as never, credit);
  const sc = await svc.scorecard();
  const host = new URL(process.env.DATABASE_URL ?? 'postgres://x@unknown/x')
    .hostname;
  const lines = [
    '# Five-rooftop readiness scorecard',
    '',
    `Generated ${sc.generatedAt} from \`config/rooftops/registry.json\` (updated ${sc.registryUpdatedAt}) and the database at \`${['127.0.0.1', 'localhost'].includes(host) ? 'local test stack' : host}\`.`,
    '',
    "PASS = evidence on record. BLOCKED = waiting on a dealership/vendor/approval artifact. FAIL = in our control, not done. NOT_TESTED = needs a per-store acceptance run that has not happened. Platform test suites ran on simulated fixtures, so per-store test rows stay NOT_TESTED until run against that store's own configuration.",
    '',
    `| Row | ${sc.stores.map((s) => s.displayName).join(' | ')} |`,
    `|---|${sc.stores.map(() => '---').join('|')}|`,
    ...(Object.keys(ROW_LABELS) as RowKey[]).map(
      (k) =>
        `| ${ROW_LABELS[k]} | ${sc.stores.map((s) => s.cells[k]).join(' | ')} |`,
    ),
    `| **Verdict** | ${sc.stores.map((s) => `**${s.verdict}**`).join(' | ')} |`,
    '',
  ];
  process.stdout.write(lines.join('\n'));
  await prisma.$disconnect();
}
main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
