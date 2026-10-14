/**
 * Operator script: manage a rooftop's secure credit-application destination on a LOCAL
 * database (production/staging admins use the Command Center / ops API instead).
 *
 *   npm run credit:destination -- status    --tenant <slug> --location <slug>
 *   npm run credit:destination -- configure --tenant <slug> --location <slug> --operator <email>
 *        [--link-type UNVERIFIED|PUBLIC_REUSABLE|DEALER_REUSABLE|PER_CUSTOMER] [--demo-preview]
 *        (the URL is read from a hidden prompt or stdin — never from argv, so it does not land
 *         in shell history or process listings)
 *   npm run credit:destination -- authorize --tenant <slug> --location <slug> --operator <email>
 *        --link-type DEALER_REUSABLE --evidence "<ticket/email reference>"
 *   npm run credit:destination -- disable   --tenant <slug> --location <slug> --operator <email>
 *
 * Output never contains the URL or its token — only host, fingerprint and state.
 * Never navigates to the destination.
 */
import { PrismaClient } from '@prisma/client';
import * as readline from 'readline';
import { SecretVaultService } from '../src/integrations/core/secret-vault.service';
import { CreditApplicationService } from '../src/finance/credit-application.service';
import { CreditDestinationAdminService } from '../src/finance/credit-destination-admin.service';
import type { CreditLinkType } from '../src/finance/credit-destination';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

async function readSecretLine(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString('utf8').trim();
  }
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });
    const out = rl as unknown as {
      _writeToOutput: (s: string) => void;
      output: NodeJS.WriteStream;
    };
    process.stdout.write(prompt);
    out._writeToOutput = () => undefined; // hide typed/pasted characters
    rl.question('', (v) => {
      rl.close();
      process.stdout.write('\n');
      resolve(v.trim());
    });
  });
}

async function main() {
  const cmd = process.argv[2];
  const tenantSlug = arg('tenant');
  const locationSlug = arg('location');
  if (!cmd || !tenantSlug || !locationSlug) {
    console.error(
      'usage: credit-destination <status|configure|authorize|disable> --tenant <slug> --location <slug> [...]',
    );
    process.exit(2);
  }
  const dbHost = new URL(process.env.DATABASE_URL ?? 'postgres://x@invalid/x')
    .hostname;
  if (!['127.0.0.1', 'localhost'].includes(dbHost)) {
    console.error(
      `Refusing: DATABASE_URL host '${dbHost}' is not local. Use the Command Center / ops API for shared environments.`,
    );
    process.exit(1);
  }
  const prisma = new PrismaClient();
  const config = { get: (k: string) => process.env[k] };
  const vault = new SecretVaultService(config as never);
  const credit = new CreditApplicationService(
    prisma as never,
    config as never,
    { trackEvent: async () => undefined } as never,
    vault,
  );
  const admin = new CreditDestinationAdminService(
    prisma as never,
    vault,
    credit,
  );
  try {
    const tenant = await prisma.tenant.findUnique({
      where: { slug: tenantSlug },
      select: { id: true },
    });
    if (!tenant) throw new Error(`tenant ${tenantSlug} not found`);
    const loc = await prisma.location.findFirst({
      where: { tenantId: tenant.id, slug: locationSlug },
      select: { id: true },
    });
    if (!loc) throw new Error(`location ${locationSlug} not found`);
    const operator = arg('operator');
    const actor = operator ? `cli:${operator}` : '';
    let out: unknown;
    if (cmd === 'status') out = await admin.status(tenant.id, loc.id);
    else {
      if (!operator)
        throw new Error(
          '--operator <email> is required for changes (audit trail)',
        );
      if (cmd === 'configure') {
        const url = await readSecretLine(
          'Paste the destination URL (input hidden): ',
        );
        out = await admin.configure(tenant.id, loc.id, actor, {
          url,
          linkType: (arg('link-type') as CreditLinkType) ?? 'UNVERIFIED',
          demoPreview: flag('demo-preview'),
          providerName: arg('provider'),
        });
      } else if (cmd === 'authorize') {
        out = await admin.authorize(tenant.id, loc.id, actor, {
          linkType: arg('link-type') as CreditLinkType,
          evidenceRef: arg('evidence') ?? '',
        });
      } else if (cmd === 'disable')
        out = await admin.disable(tenant.id, loc.id, actor);
      else throw new Error(`unknown command ${cmd}`);
    }
    console.log(JSON.stringify(out, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e: unknown) => {
  // Error messages from the services never include the URL.
  console.error(e instanceof Error ? e.message : 'failed');
  process.exit(1);
});
