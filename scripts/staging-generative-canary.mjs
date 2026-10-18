#!/usr/bin/env node
/**
 * Staging generative + fail-closed canary (anonymous widget JWT only).
 * Usage: node scripts/staging-generative-canary.mjs [apiBase] [origin]
 * Never prints tokens. Exit 0 only when FAIL_COUNT=0.
 */
const API = process.argv[2] || 'https://staging-api.dialusnow.com';
const ORIGIN = process.argv[3] || 'https://staging-widget.dialusnow.com';
const TENANTS = [
  'jeep-of-chicago',
  'dial-nissan-of-chicago',
  'dial-chevy-of-chicago',
  'infiniti-of-chicago',
  'dial-cdjr-of-chicago',
];
const TURNS = [
  'Hey — what can you help me with today?',
  'Do you have any Wranglers in stock under 45000?',
  'What is the monthly payment on that one?',
  'Can I book service Saturday at 3pm?',
  'I need a windshield wiper motor for a 2018 Jeep',
  'Can a manager call me?',
];
const BAD =
  /\$[0-9]|MSRP|0%\s*APR|you.?re approved|confirmed for Saturday|I (already )?notified|tekioncloud/i;
const DELAY_MS = Number(process.env.CANARY_DELAY_MS || 1200);

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

async function main() {
  const health = await json(`${API}/api/health`);
  const llm = health.body?.data?.checks?.llm;
  console.log(`INFO  health llm=${llm} status=${health.body?.data?.status}`);
  if (llm !== 'configured') {
    console.log('INFO  generative path may be deterministic-only');
  }

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
      const reply = String(data.reply || data.message || chat.body?.message || '');
      conversationId = data.conversationId || conversationId;
      const p = data.provenance || {};
      console.log(`  Q: ${message}`);
      console.log(`  A: ${reply.slice(0, 240)}`);
      console.log(
        `  model: lm=${p.languageModel ?? 'n/a'} interpreted=${Boolean(p.modelInterpreted)} fallback=${p.fallbackReason ?? 'n/a'} http=${chat.status}`,
      );

      if (chat.status === 429 || /ThrottlerException|Too Many Requests/i.test(reply)) {
        ko(`${tenant} throttled`);
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
      if (reply.length > 0 && reply.length <= 520) ok(`${tenant} brevity(${reply.length})`);
      else ko(`${tenant} brevity(${reply.length})`);
      // Fail-closed is OK; silent model exceptions are an ops signal (non-fatal for truth).
      if (p.fallbackReason && /model_error|model_exception|model_provider_error|model_spend_cap_unpriced|model_all_circuits_open/.test(p.fallbackReason)) {
        console.log(`INFO  ${tenant} model-fallback=${p.fallbackReason}`);
      }
    }
  }

  for (const path of ['overview', 'queues', 'surveys', 'ai/status']) {
    const res = await json(`${API}/api/ops/${path}`);
    if (res.status === 401) ok(`ops/${path} 401`);
    else ko(`ops/${path} ${res.status}`);
  }

  console.log(`SUMMARY pass=${pass} fail=${fail}`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
