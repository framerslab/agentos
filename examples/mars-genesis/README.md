# Mars Genesis: Two Leaders, One Colony

The same 50-year Mars colony simulation (12 crises, 2035-2085), run once under each of two commanders. A deterministic kernel holds the colony and its 100 colonists as data; agents built with `agent()` read the kernel's state and decide; the kernel applies their decisions, rolls the outcomes and drifts the personalities of the people the commander promoted.

## Commanders

**Aria Chen, "The Visionary"** (Openness 0.95, Conscientiousness 0.35). Her instructions favour the option with the higher upside when departments disagree.

**Dietrich Voss, "The Engineer"** (Conscientiousness 0.97, Openness 0.25). His instructions favour the option with the lower risk.

A commander's HEXACO traits reach three places: `agent({ personality })` writes them into the commander's system prompt, the commander's openness seeds the kernel (seed = openness × 1000), and each turn the promoted department heads' traits are pulled toward the commander's.

## What a run does

1. **Turn 0.** The commander (`gpt-5.4`) picks a head for medical, engineering, agriculture and psychology from the five colonists the kernel ranks highest for each role. A department the reply leaves unfilled gets its top-ranked candidate.
2. **Department agents.** Each head gets an `agent()` session on `gpt-5.4-mini` with the `forge_tool` meta-tool (and `web_search` with `--live`). The department instructions require forging at least one sandboxed calculation tool per turn; forged code runs under a capability ceiling that grants nothing, and a `gpt-5.4` judge reviews each forged tool.
3. **Each turn.** The kernel advances the colony (aging, deaths, births, careers, resources). The departments consulted that turn report as JSON from the crisis text, the turn's research packet and their head's current HEXACO profile. The commander decides from the reports. The kernel applies the departments' proposed patches, classifies the outcome (a risky or conservative choice, judged by whether the decision names the scenario's risky option, succeeding or failing on a seeded draw) and drifts the heads' traits.
4. **Governance** joins the schedule at turn 9, but nobody is promoted to head it, so it never reports.

The output is `examples/mars-genesis/output/v3-<archetype>-<timestamp>.json`: each turn's reports and decision, the final state, the forged tools per department, the heads' trait trajectories, the outcome of each turn, and the citation and forged-tool counts.

[docs/MARS_GENESIS.md](../../docs/MARS_GENESIS.md) describes the drift model, the promotion system and the output in full.

## Run

From the agentos repository root, after `pnpm run build` (the scripts import `@framers/agentos`, which resolves to `dist/`):

```bash
# All 12 turns
OPENAI_API_KEY=... npx tsx examples/mars-genesis/mars-genesis-visionary.ts

# The first 3 turns
OPENAI_API_KEY=... npx tsx examples/mars-genesis/mars-genesis-engineer.ts 3

# The first 3 turns, with web search for the departments
OPENAI_API_KEY=... SERPER_API_KEY=... npx tsx examples/mars-genesis/mars-genesis-visionary.ts 3 --live
```

Every model call goes to OpenAI. Without `--live`, the departments work from the curated research packets in `shared/research.ts`, whose sources carry links and DOIs; with `--live` they also get a `web_search` tool backed by Serper.

## The 12 Crises

| Turn | Year | Crisis | Research packet |
|------|------|--------|-------------|
| 1 | 2035 | Landfall: choose a landing site | HiRISE terrain, Curiosity RAD radiation |
| 2 | 2037 | Water extraction shortfall | MARSIS ice radar, MOXIE ISRU |
| 3 | 2040 | Perchlorate poisoning | Phoenix lander soil chemistry |
| 4 | 2043 | Population pressure from Earth | NASA ECLSS life support scaling |
| 5 | 2046 | Solar particle event | Mars magnetosphere loss, radiation dosimetry |
| 6 | 2049 | Mars-born children: bone density | ISS bone loss studies, 0.38g |
| 7 | 2053 | Communication blackout | Solar conjunction, autonomous operations |
| 8 | 2058 | Colony-wide depression | Mars-500 isolation study |
| 9 | 2063 | Independence movement | Space governance, communication delay |
| 10 | 2068 | Terraforming proposal | Jakosky & Edwards 2018 vs Zubrin & McKay 1993 |
| 11 | 2075 | Consequence cascade | Path dependence |
| 12 | 2085 | Legacy assessment | None |

## What to Compare Between the Two Runs

- Which colonists each commander promotes from the same ranked candidates
- How the heads' traits drift toward their commander over 50 years
- The tools each department forges, and the decisions on the same crises
- How the outcomes compound: morale, food and population feed the odds of later turns

## Files

| File | Contents |
|---|---|
| `mars-genesis-visionary.ts`, `mars-genesis-engineer.ts` | The commander and the five key personnel; call `runSimulation()` |
| `shared/orchestrator.ts` | The agents, the emergent engine, the turn loop and the output |
| `shared/kernel.ts`, `shared/progression.ts`, `shared/colonist-generator.ts`, `shared/state.ts`, `shared/rng.ts` | The deterministic simulation |
| `shared/scenarios.ts`, `shared/research.ts`, `shared/departments.ts`, `shared/contracts.ts` | The crises, the research packets, the department prompts and the report shapes |
| `shared/runner.ts`, `shared/constants.ts` | An earlier single-agent runner on Anthropic models, which no script calls |

## Requirements

- Node.js 22 or later
- `OPENAI_API_KEY`
- `SERPER_API_KEY`, with `--live`
