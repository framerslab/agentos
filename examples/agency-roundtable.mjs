#!/usr/bin/env node
// Example: hedge-fund "round table" — a multi-provider agency() panel with
// per-seat reasoning effort and graceful degradation when providers are absent.
//
// Seats span four providers so no single vendor's failure mode dominates the
// panel. A seat whose provider has no API key (or whose call fails) is skipped
// with a visible warning — the table proceeds on a quorum of two seats.
//
// Usage (any subset of keys works; two or more providers recommended):
//   export OPENAI_API_KEY="sk-..."      # aggressive PM + devil's advocate (gpt-5.6 @ xhigh)
//   export ANTHROPIC_API_KEY="sk-..."   # risk-averse PM + risk officer (opus @ max) + chair
//   export GEMINI_API_KEY="..."         # macro analyst
//   export XAI_API_KEY="..."            # flow analyst (grok)
//   node examples/agency-roundtable.mjs "BTC funding flipped negative while spot holds the range."

import { agency } from '../dist/index.js';

const BRIEF =
  process.argv[2] ??
  'Derived aggregates only: 24h new-launch detections +38% vs baseline; paper would-execute rate 12% (down from 19%); whale net flow +420 SOL into fresh mints; realized slippage on exits 18-25%. Desk question: add exposure, hold, or de-risk?';

// --- provider availability (key presence only; calls may still fail) --------
const available = {
  openai: !!process.env.OPENAI_API_KEY,
  anthropic: !!process.env.ANTHROPIC_API_KEY,
  gemini: !!(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY),
  xai: !!process.env.XAI_API_KEY,
};

// --- the round table ---------------------------------------------------------
// Every seat answers in the same shape so the chair can weigh them:
//   STANCE: add | hold | de-risk, CONVICTION: 0-100, then 3 bullets of why,
//   then the single biggest risk to its own view (forced self-skepticism).
const SEAT_FORMAT =
  'Answer in exactly this shape: STANCE: <add|hold|de-risk> | CONVICTION: <0-100>. ' +
  'Then three one-line bullets of reasoning. Then one line "SELF-RISK:" naming the ' +
  'single strongest argument against your own stance. Derived aggregates only — ' +
  'never invent trades, prices, or news.';

const SEATS = {
  risk_averse_pm: {
    provider: 'anthropic',
    effort: 'max',
    instructions:
      `Capital-preservation portfolio manager. You care about drawdown, tail risk, and position sizing before upside. Default to the smallest exposure that keeps optionality. ${SEAT_FORMAT}`,
  },
  aggressive_pm: {
    provider: 'openai',
    model: 'gpt-5.6',
    effort: 'max', // clamps to xhigh — OpenAI's ceiling (probe-verified for the 5.6 family)
    instructions:
      `Aggressive momentum portfolio manager hunting asymmetric upside. You size up when velocity and flow agree, but you must name your invalidation level. ${SEAT_FORMAT}`,
  },
  macro_analyst: {
    provider: 'gemini',
    effort: 'high',
    instructions:
      `Macro and regime analyst. Frame the aggregates against liquidity conditions, correlation regime, and crowding. You do not pick trades; you set the weather. ${SEAT_FORMAT}`,
  },
  flow_analyst: {
    provider: 'xai',
    effort: 'high',
    instructions:
      `Market-microstructure and flow analyst. Volumes, slippage, participation, who is on the other side. Flag when measured slippage makes the trade uneconomic. ${SEAT_FORMAT}`,
  },
  risk_officer: {
    provider: 'anthropic',
    effort: 'max',
    instructions:
      `Chief risk officer with veto power. Check every seat's stance against exposure limits and the fail-closed doctrine: missing or stale inputs mean NO new risk. State explicitly whether you veto. ${SEAT_FORMAT}`,
  },
  devils_advocate: {
    provider: 'openai',
    model: 'gpt-5.6',
    effort: 'xhigh',
    instructions:
      `Red team. Attack the emerging consensus of the other seats — the strongest steel-manned case that they are wrong. If the panel agrees too easily, that is itself a finding. ${SEAT_FORMAT}`,
  },
};

async function main() {
  const seated = Object.fromEntries(
    Object.entries(SEATS).filter(([name, cfg]) => {
      if (available[cfg.provider]) return true;
      console.warn(`⚠️  seat "${name}" ABSENT — no ${cfg.provider} key configured (graceful degradation)`);
      return false;
    }),
  );

  const providersSeated = new Set(Object.values(seated).map((s) => s.provider));
  if (Object.keys(seated).length < 2) {
    console.error('❌ quorum not met: fewer than two seats have configured providers. Set more API keys.');
    process.exit(1);
  }
  if (providersSeated.size < 2) {
    console.warn('⚠️  single-provider table — panel diversity is degraded; verdict carries a monoculture caveat.');
  }

  // Chair (synthesis) prefers Anthropic at max effort; falls back to OpenAI.
  const chair = available.anthropic
    ? { provider: 'anthropic', model: 'claude-opus-4-8', effort: 'max' }
    : { provider: 'openai', model: 'gpt-5.6', effort: 'max' };

  const table = agency({
    ...chair,
    strategy: 'parallel', // all seats answer independently; chair synthesizes
    agents: seated,
    controls: { maxTotalTokens: 120_000, onLimitReached: 'warn' },
    on: {
      agentStart: (e) => console.log(`— ${e.agent} deliberating…`),
      agentEnd: (e) => console.log(`— ${e.agent} done (${e.durationMs}ms)`),
    },
  });

  const result = await table.generate(
    `ROUND TABLE BRIEF:\n${BRIEF}\n\nChair: weigh every seated view (quote each seat's stance + conviction), give the table's verdict (add/hold/de-risk with sizing discipline), preserve the strongest dissent verbatim, and list absent seats as reduced-confidence caveats: absent=${
      Object.keys(SEATS).filter((n) => !seated[n]).join(',') || 'none'
    }.`,
  );

  console.log('\n================ TABLE VERDICT ================\n');
  console.log(result.text);
  await table.close?.();
}

main().catch((err) => {
  console.error('round-table run failed:', err?.message ?? err);
  process.exit(1);
});
