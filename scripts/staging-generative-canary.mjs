#!/usr/bin/env node
/**
 * Staging generative + fail-closed canary (anonymous widget JWT only).
 *
 * Usage:
 *   EXPECTED_COMMIT_SHA=<full-sha> node scripts/staging-generative-canary.mjs [apiBase] [origin]
 *
 * Exit 0 only when FAIL_COUNT=0.
 * Never prints tokens, keys, or raw provider payloads.
 *
 * Generative gate (when llm=configured):
 * - API commit SHA must match EXPECTED_COMMIT_SHA (required).
 * - EACH of the five staging tenants must have ≥1 accepted model-written reply
 *   (languageModel ∈ polished|answered|composed|repaired).
 * - discarded / none / model_exception are NOT generative success.
 * - Interpretation-only (modelInterpreted without accepted LM status) is NOT enough.
 * - Refuses production API hosts.
 */
const API = (process.argv[2] || 'https://staging-api.dialusnow.com').replace(
  /\/$/,
  '',
);
const ORIGIN = (process.argv[3] || 'https://staging-widget.dialusnow.com').replace(
  /\/$/,
  '',
);
const EXPECTED_SHA = (process.env.EXPECTED_COMMIT_SHA || '').trim().toLowerCase();
const TENANTS = [
  'jeep-of-chicago',
  'dial-nissan-of-chicago',
  'dial-chevy-of-chicago',
  'infiniti-of-chicago',
  'dial-cdjr-of-chicago',
];
/** Education turn first so each tenant has a reliable generative opportunity. */
const TURNS = [
  "What's the difference between 4WD and AWD?",
  'Hey — what can you help me with today?',
  'Do you have any Wranglers in stock under 45000?',
  'What is the monthly payment on that one?',
  'Can I book service Saturday at 3pm?',
  'I need a windshield wiper motor for a 2018 Jeep',
  'Can a manager call me?',
];
const BAD =
  /MSRP|0%\s*APR|you.?re approved|confirmed for Saturday|I (already )?notified|tekioncloud|(?:payment|monthly|only|priced at)\s*(?:is|of|at|:)?\s*\$[0-9]/i;
const DELAY_MS = Number(process.env.CANARY_DELAY_MS || 1200);
const ACCEPTED_LM = new Set(['polished', 'answered', 'composed', 'repaired']);

let pass = 0;
let fail = 0;
const ok = (m) => {
  console.log(`PASS  ${m}`);
  pass += 1;
};
const ko = (m) => {
  console.log(`FAIL  ${m}`);
  fail += 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function json(url, init) {
  const res = await fetch(url, init);
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text.slice(0, 300) };
  }
  return { status: res.status, body };
}

/** Accepted model-written reply that passed grounding (current source contract). */
function isAcceptedModelReply(p) {
  const lm = p?.languageModel;
  if (!ACCEPTED_LM.has(lm)) return false;
  // discarded retained as composed must never happen; belt-and-suspenders.
  if (p?.fallbackReason && /discard|model_exception|model_error/i.test(p.fallbackReason)) {
    return false;
  }
  return true;
}

function classifyProviderFailure(fallbackReason) {
  const r = String(fallbackReason || '');
  if (/spend_store|redis/i.test(r)) return 'redis_spend_store';
  if (/circuit/i.test(r)) return 'circuit_breaker';
  if (/timeout|abort/i.test(r)) return 'provider_timeout';
  if (/rate|429/i.test(r)) return 'rate_limit';
  if (/auth|401|403|credential|api[_-]?key/i.test(r)) return 'invalid_credentials';
  if (/model|unsupported|404/i.test(r)) return 'unsupported_or_unavailable_model';
  if (/ground|validat/i.test(r)) return 'grounding_or_validation_rejection';
  if (/model_exception|model_error|model_provider/i.test(r)) return 'provider_or_model_exception';
  if (!r) return 'unknown';
  return 'other_fallback';
}

function assertNotProduction(apiBase) {
  const host = apiBase.toLowerCase();
  if (
    host.includes('://api.dialusnow.com') ||
    host.includes('environment=production') ||
    /\/production(\/|$)/.test(host)
  ) {
    ko('refused: production API host is not allowed for generative canary');
    return false;
  }
  return true;
}

async function main() {
  if (!assertNotProduction(API)) {
    process.exit(1);
  }
  if (!EXPECTED_SHA || EXPECTED_SHA.length < 7) {
    ko('EXPECTED_COMMIT_SHA required (full or ≥7-char SHA of the deployed candidate)');
    process.exit(1);
  }

  const versionBefore = await json(`${API}/api/version`);
  const shaBefore = String(
    versionBefore.body?.data?.commitSha || '',
  ).toLowerCase();
  console.log(
    `INFO  version before sha=${shaBefore || 'n/a'} expected=${EXPECTED_SHA}`,
  );
  if (!shaBefore.startsWith(EXPECTED_SHA) && !EXPECTED_SHA.startsWith(shaBefore)) {
    ko(`sha-before mismatch got=${shaBefore || 'missing'} expected=${EXPECTED_SHA}`);
  } else {
    ok(`sha-before ${shaBefore.slice(0, 12)}`);
  }

  const health = await json(`${API}/api/health`);
  const llm = health.body?.data?.checks?.llm;
  const db = health.body?.data?.checks?.database;
  const redis = health.body?.data?.checks?.redis;
  console.log(
    `INFO  health llm=${llm} database=${db} redis=${redis} status=${health.body?.data?.status}`,
  );
  if (db !== 'up') ko('database not up');
  else ok('database up');
  if (redis !== 'up') ko('redis not up');
  else ok('redis up');

  if (llm !== 'configured') {
    console.log(
      'INFO  MODE=safety-only (llm not configured) — NOT generative verification',
    );
  }

  const perTenantModel = Object.fromEntries(TENANTS.map((t) => [t, 0]));
  let modelGeneratedTurns = 0;
  const failureCategories = new Set();

  for (const tenant of TENANTS) {
    console.log(`==== ${tenant} ====`);
    const tokRes = await json(`${API}/api/public/widget-token`, {
      method: 'POST',
      headers: {
        Origin: ORIGIN,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ tenantSlug: tenant, locationSlug: 'main' }),
    });
    const token = tokRes.body?.data?.token;
    if (!token) {
      ko(`${tenant} token (${tokRes.status})`);
      continue;
    }
    ok(`${tenant} token`);

    let conversationId = '';
    for (const message of TURNS) {
      const payload = {
        message,
        language: 'en',
        pageContext: { pageType: 'homepage' },
      };
      if (conversationId) payload.conversationId = conversationId;
      await sleep(DELAY_MS);
      const chat = await json(`${API}/api/chat`, {
        method: 'POST',
        headers: {
          Origin: ORIGIN,
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
      const data = chat.body?.data || chat.body || {};
      const reply = String(
        data.reply || data.message || chat.body?.message || '',
      );
      conversationId = data.conversationId || conversationId;
      const p = data.provenance || {};
      console.log(`  Q: ${message}`);
      console.log(`  A: ${reply.slice(0, 240)}`);
      console.log(
        `  model: lm=${p.languageModel ?? 'n/a'} interpreted=${Boolean(p.modelInterpreted)} fallback=${p.fallbackReason ?? 'n/a'} http=${chat.status}`,
      );

      if (
        chat.status === 429 ||
        /ThrottlerException|Too Many Requests/i.test(reply)
      ) {
        ko(`${tenant} throttled`);
        failureCategories.add('rate_limit');
        continue;
      }
      if (chat.status >= 400) {
        ko(`${tenant} http-${chat.status}`);
        continue;
      }
      const raw = JSON.stringify(chat.body);
      if (raw.includes('"simulated":true')) ko(`${tenant} simulated`);
      else ok(`${tenant} no-sim`);
      if (!reply) ko(`${tenant} empty-reply`);
      else if (BAD.test(reply)) ko(`${tenant} invented-claim`);
      else ok(`${tenant} no-invent`);
      if (reply.length > 0 && reply.length <= 520)
        ok(`${tenant} brevity(${reply.length})`);
      else ko(`${tenant} brevity(${reply.length})`);

      if (isAcceptedModelReply(p)) {
        modelGeneratedTurns += 1;
        perTenantModel[tenant] += 1;
        ok(`${tenant} model-generated(${p.languageModel})`);
      } else if (p.modelInterpreted && !isAcceptedModelReply(p)) {
        console.log(
          `INFO  ${tenant} interpretation-only (lm=${p.languageModel ?? 'n/a'}) — not generative success`,
        );
      }
      if (p.fallbackReason) {
        const cat = classifyProviderFailure(p.fallbackReason);
        if (
          /model_error|model_exception|model_provider_error|model_spend_cap_unpriced|model_all_circuits_open|spend_store/.test(
            p.fallbackReason,
          )
        ) {
          console.log(
            `INFO  ${tenant} model-fallback=${p.fallbackReason} category=${cat}`,
          );
          failureCategories.add(cat);
        }
      }
    }

    if (llm === 'configured' && perTenantModel[tenant] === 0) {
      ko(
        `${tenant} generative-gate: zero accepted model replies (polished|answered|composed|repaired)`,
      );
    } else if (llm === 'configured') {
      ok(`${tenant} generative-gate count=${perTenantModel[tenant]}`);
    }
  }

  for (const path of ['overview', 'queues', 'surveys', 'ai/status']) {
    const res = await json(`${API}/api/ops/${path}`);
    if (res.status === 401) ok(`ops/${path} 401`);
    else ko(`ops/${path} ${res.status}`);
  }

  if (llm === 'configured') {
    const missing = TENANTS.filter((t) => perTenantModel[t] === 0);
    if (missing.length) {
      ko(
        `generative-gate: tenants without model replies: ${missing.join(',')}`,
      );
    } else {
      ok(
        `generative-gate: all ${TENANTS.length} tenants have ≥1 accepted model reply (total=${modelGeneratedTurns})`,
      );
    }
  }

  const versionAfter = await json(`${API}/api/version`);
  const shaAfter = String(versionAfter.body?.data?.commitSha || '').toLowerCase();
  if (!shaAfter.startsWith(EXPECTED_SHA) && !EXPECTED_SHA.startsWith(shaAfter)) {
    ko(`sha-after mismatch got=${shaAfter || 'missing'} expected=${EXPECTED_SHA}`);
  } else if (shaAfter !== shaBefore) {
    ko(`sha changed during canary before=${shaBefore} after=${shaAfter}`);
  } else {
    ok(`sha-after stable ${shaAfter.slice(0, 12)}`);
  }

  if (failureCategories.size) {
    console.log(
      `INFO  failure_categories=${[...failureCategories].sort().join(',')}`,
    );
  }

  console.log(
    `SUMMARY pass=${pass} fail=${fail} modelGeneratedTurns=${modelGeneratedTurns} perTenant=${JSON.stringify(perTenantModel)}`,
  );
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err?.message || String(err));
  process.exit(2);
});
