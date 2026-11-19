#!/usr/bin/env node
/**
 * Phase 1 staging conversation probe — genuine multi-turn + provenance.
 * Usage: node scripts/phase1-staging-conversation-probe.mjs [apiBase] [origin]
 * Never prints tokens or secrets. Exit 0 when critical checks pass.
 */
const API = process.argv[2] || 'https://staging-api.dialusnow.com';
const ORIGIN = process.argv[3] || 'https://staging-widget.dialusnow.com';
const TENANT = process.env.PHASE1_TENANT || 'jeep-of-chicago';
const LOCATION = process.env.PHASE1_LOCATION || 'main';
const DELAY_MS = Number(process.env.CANARY_DELAY_MS || 1500);

const BAD =
  /\$[0-9]{2,}|MSRP|0%\s*APR|you.?re approved|I (already )?notified|tekioncloud|SSN|social security/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function json(url, init) {
  const res = await fetch(url, init);
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text.slice(0, 400) };
  }
  return { status: res.status, body };
}

async function chat(token, message, conversationId) {
  const payload = {
    message,
    language: 'en',
    pageContext: { pageType: 'homepage' },
  };
  if (conversationId) payload.conversationId = conversationId;
  await sleep(DELAY_MS);
  const res = await json(`${API}/api/chat`, {
    method: 'POST',
    headers: {
      Origin: ORIGIN,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const data = res.body?.data || res.body || {};
  return {
    status: res.status,
    reply: String(data.reply || data.message || res.body?.message || ''),
    conversationId: data.conversationId || conversationId || '',
    provenance: data.provenance || {},
    cards: data.cards || [],
  };
}

function printTurn(label, t) {
  const p = t.provenance || {};
  console.log(`--- ${label} ---`);
  console.log(`http=${t.status}`);
  console.log(`reply=${t.reply.slice(0, 320)}`);
  console.log(
    `provenance languageModel=${p.languageModel ?? 'n/a'} modelInterpreted=${Boolean(p.modelInterpreted)} verifiedFactsOnly=${p.verifiedFactsOnly ?? 'n/a'} fallback=${p.fallbackReason ?? 'n/a'} sources=${JSON.stringify(p.sources ?? [])}`,
  );
}

async function main() {
  const health = await json(`${API}/api/health`);
  const version = await json(`${API}/api/version`);
  console.log(
    `INFO health=${JSON.stringify(health.body?.data)} version=${JSON.stringify(version.body?.data)}`,
  );

  const tok = await json(`${API}/api/public/widget-token`, {
    method: 'POST',
    headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ tenantSlug: TENANT, locationSlug: LOCATION }),
  });
  const token = tok.body?.data?.token;
  if (!token) {
    console.error(`FAIL token ${tok.status}`);
    process.exit(1);
  }
  console.log(`PASS token (${TENANT}/${LOCATION})`);

  let cid = '';
  let fails = 0;
  const check = (ok, msg) => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`);
    if (!ok) fails += 1;
  };

  const turns = [
    ['smalltalk-typo', 'how are yu today'],
    ['specials', 'what are the specials'],
    ['ack-typo', 'oAY'],
    ['inventory-context', 'do you have any Wranglers?'],
    ['memory-ref', 'tell me more about that one'],
    ['auto-edu', "What's the difference between 4WD and AWD?"],
    [
      'missing-hours-detail',
      'what time does the detail shop close on Sundays?',
    ],
    [
      'lead-soft',
      'can someone from the team email me about financing options?',
    ],
    ['ending', 'thanks that helps for now'],
  ];

  let modelGeneratedTurns = 0;
  let lastReply = '';
  for (const [label, message] of turns) {
    const t = await chat(token, message, cid);
    cid = t.conversationId || cid;
    printTurn(`${label}: ${message}`, t);
    lastReply = t.reply;
    check(t.status < 400 && !!t.reply, `${label} got reply`);
    check(!BAD.test(t.reply), `${label} no invented money/approval claims`);
    const lm = t.provenance?.languageModel;
    // Only polished/answered count — discarded/none are not generative success.
    if (lm === 'polished' || lm === 'answered') modelGeneratedTurns += 1;
    if (label === 'specials') {
      check(
        /don'?t have any verified|won'?t invent|no verified|cannot verify|not on file|team confirm/i.test(
          t.reply,
        ) ||
          /disclaimer|location-specific|see dealer|verified on current offers/i.test(
            t.reply,
          ),
        `${label} honest/verified framing`,
      );
    }
    if (label === 'smalltalk-typo') {
      check(
        !/cannot verify from dealership|dealership information/i.test(t.reply),
        `${label} not dealership-fact fallback`,
      );
    }
    if (label === 'ack-typo') {
      check(
        !/saved your OK to text|consent|credit application|notified the team/i.test(
          t.reply,
        ),
        `${label} did not authorize consequential write`,
      );
    }
  }

  check(!!cid, 'conversation continuity id present');
  check(lastReply.length > 0, 'final turn non-empty');
  if (health.body?.data?.checks?.llm === 'configured') {
    check(
      modelGeneratedTurns > 0,
      `generative-gate: llm=configured requires ≥1 languageModel=polished|answered (got ${modelGeneratedTurns}; discarded/model_exception is FAIL)`,
    );
  } else {
    console.log('WARN  llm not configured — generative gate cannot pass');
    fails += 1;
  }

  console.log(
    `SUMMARY fails=${fails} modelGeneratedTurns=${modelGeneratedTurns} conversationId=${cid ? 'set' : 'missing'}`,
  );
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
