# Mars Genesis v3: Emergent Society with Dynamic Leadership and Personality Evolution

## Core Principle (unchanged from v2)

**The host runtime owns truth. The agents own interpretation.**

v3 addition: the host runtime also owns **personality drift**. Trait evolution is computed deterministically by the kernel, not by the agents. Agents observe the effects of drift through their own changing behavior (updated personality in system prompt), but they don't control or even know about the drift mechanics.

## What Changes from v2

| Aspect | v2 | v3 |
|---|---|---|
| Department heads | Pre-assigned at startup | Commander promotes from colony roster |
| HEXACO per agent | Fixed for entire run | Drifts each turn (kernel-computed) |
| Agent lifecycle | Created once at startup | Sessions updated with new personality each turn |
| Commander Turn 0 | Receives crisis immediately | Evaluates roster, makes first promotions |
| Colonist data model | No personal HEXACO | Every colonist has HEXACO + drift history |
| Outcome tracking | Not tracked | Kernel classifies outcome for drift feedback |
| Dashboard highlight | Tool registries | Trait trajectory radar charts + tool registries |

## What Does NOT Change from v2

- Deterministic kernel with seeded RNG
- 100 colonists as structured data (not LLM agents)
- 12 crisis turns over 50 years
- Forged tools for analysis, not state mutation
- Typed DepartmentReport and CommanderDecision contracts
- Curated research packets for demo mode
- Tiered model strategy (gpt-5.4-mini departments, gpt-5.4 commander, gpt-5.4 judge)
- Manual orchestration for deterministic control
- State ownership rules (departments propose patches in authorized fields only)
- Run tiers (smoke/demo/compare)

## The Science of Personality Drift

Grounded in four bodies of research:

1. **Leader-follower alignment**: followers' traits converge toward leaders' traits over extended relationships. [Van Iddekinge et al. 2023, EJWOP](https://www.tandfonline.com/doi/full/10.1080/1359432X.2023.2250085)
2. **Trait activation theory**: work environments activate specific traits through situational relevance. [Tett & Burnett 2003, JAP](https://doi.org/10.1037/0021-9010.88.3.500)
3. **Social investment principle**: role commitment increases conscientiousness, agreeableness, emotional stability. [Roberts et al. 2005](https://pmc.ncbi.nlm.nih.gov/articles/PMC3398702/)
4. **Role acquisition drives trait change**: taking on leadership demands reshapes trait expression. [Hudson et al. 2020, Journal of Personality](https://www.ovid.com/00005203-202012000-00012)

## Personality Drift Model

### Drift is kernel-owned and deterministic

Computed after each turn for all promoted colonists. Same seed + same policy sequence = same trait trajectories. No LLM involvement in drift computation.

### Three forces

```
trait_new = clamp(trait_old + total_pull * year_delta, 0.05, 0.95)
total_pull = leader_pull + role_pull + outcome_pull
rate cap: |total_pull| <= 0.05/year
```

**1. Leader pull** (dominant force, 0.02/year max):
```
leader_pull[trait] = (commander[trait] - colonist[trait]) * 0.02
```
Traits converge toward the commander's profile. Decelerates naturally as the gap shrinks.

**2. Role pull** (secondary, 0.01/year max):
```typescript
const ROLE_ACTIVATIONS: Record<Department, Partial<HexacoProfile>> = {
  medical:     { conscientiousness: 0.7, emotionality: 0.6, agreeableness: 0.6 },
  engineering: { conscientiousness: 0.9, openness: 0.3 },
  agriculture: { conscientiousness: 0.6, agreeableness: 0.7, openness: 0.5 },
  psychology:  { agreeableness: 0.8, emotionality: 0.7, openness: 0.6 },
  governance:  { extraversion: 0.7, honestyHumility: 0.6 },
};
role_pull[trait] = (activation[trait] - colonist[trait]) * 0.01
```
Only applies for traits the role activates. Other traits have zero role pull.

**3. Outcome pull** (event-driven, per turn):

The kernel classifies each turn outcome deterministically:

```typescript
type TurnOutcome = 'risky_success' | 'risky_failure' | 'conservative_success' | 'conservative_failure';
```

Classification: each crisis in `scenarios.ts` has a `riskyOption` field. If the commander's decision text matches the risky option (keyword match), the kernel classifies it as risky. Success/failure is determined by seeded RNG with probability influenced by colony state (high morale + resources = higher success chance).

| Outcome | openness | conscientiousness |
|---|---|---|
| risky_success | +0.03 | 0 |
| risky_failure | -0.04 | +0.03 |
| conservative_success | 0 | +0.02 |
| conservative_failure | +0.02 | 0 |

### Expected trajectories (50 years)

Under Visionary (openness 0.95, conscientiousness 0.35):
- Medical officer: openness 0.52 -> ~0.72, conscientiousness 0.78 -> ~0.62
- Forged tools shift from precise scorers to speculative models

Under Engineer (openness 0.25, conscientiousness 0.97):
- Same medical officer: openness 0.52 -> ~0.38, conscientiousness 0.78 -> ~0.88
- Forged tools stay precise and become more conservative

## State Model Changes

### Additions to Colonist (in state.ts)

```typescript
export interface HexacoProfile {
  openness: number;
  conscientiousness: number;
  extraversion: number;
  agreeableness: number;
  emotionality: number;
  honestyHumility: number;
}

export interface PromotionRecord {
  department: Department;
  role: string;
  turnPromoted: number;
  promotedBy: string;
}

export interface HexacoSnapshot {
  turn: number;
  year: number;
  hexaco: HexacoProfile;
}

// Updated Colonist interface
export interface Colonist {
  core: ColonistCore;
  health: ColonistHealth;
  career: ColonistCareer;
  social: ColonistSocial;
  narrative: ColonistNarrative;
  hexaco: HexacoProfile;
  promotion?: PromotionRecord;
  hexacoHistory: HexacoSnapshot[];
}
```

### Colonist generator changes

Initial HEXACO is randomized from seed. Each colonist gets a personality:

```typescript
function randomHexaco(rng: SeededRng): HexacoProfile {
  return {
    openness: 0.2 + rng.next() * 0.6,          // [0.2, 0.8]
    conscientiousness: 0.2 + rng.next() * 0.6,
    extraversion: 0.2 + rng.next() * 0.6,
    agreeableness: 0.2 + rng.next() * 0.6,
    emotionality: 0.2 + rng.next() * 0.6,
    honestyHumility: 0.2 + rng.next() * 0.6,
  };
}
```

Children inherit a blend of parents' traits with slight noise:
```
child[trait] = (parent1[trait] + parent2[trait]) / 2 + rng.next() * 0.1 - 0.05
```

### Scenario additions

Each crisis definition gains a `riskyOption` keyword for outcome classification:

```typescript
export interface Scenario {
  // ...existing fields...
  riskyOption: string;         // keyword that signals the risky choice, e.g. "Valles Marineris"
  riskSuccessProbability: number; // base probability the risky option succeeds (0-1)
}
```

## Promotion System

### Turn 0: Commander evaluates roster

Before the first crisis, the commander receives a shortlist of candidates per department. The kernel pre-filters the top 5 candidates per department by trait relevance:

```typescript
function getCandidates(colonists: Colonist[], dept: Department, topN: number): Colonist[] {
  const activation = ROLE_ACTIVATIONS[dept];
  return colonists
    .filter(c => c.health.alive && !c.promotion)
    .map(c => ({
      colonist: c,
      score: Object.entries(activation).reduce((s, [trait, target]) => 
        s + (1 - Math.abs(c.hexaco[trait as keyof HexacoProfile] - (target as number))), 0),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topN)
    .map(x => x.colonist);
}
```

The commander receives candidate summaries (name, age, specialization, HEXACO profile, relevant experience) and returns:

```typescript
interface PromotionDecision {
  promotions: Array<{
    colonistId: string;
    department: Department;
    role: string;
    reason: string;
  }>;
}
```

### Agent sessions

Department agents are NOT recreated each turn. Instead, the orchestrator injects the current HEXACO values into each turn's prompt:

```
Your current personality profile (this evolves over time):
Openness: 0.61 | Conscientiousness: 0.72 | Extraversion: 0.45
Agreeableness: 0.58 | Emotionality: 0.52 | Honesty-Humility: 0.68

This shapes your analysis style. Higher openness means you consider novel solutions.
Higher conscientiousness means you demand more evidence before recommending action.
```

This is cheaper than recreating agents and lets the model naturally shift its behavior.

### Subsequent promotions

The commander can promote new colonists at Turn 9 (governance) or whenever a department head dies. The kernel flags when a promotion is needed.

## Outcome Classification

Deterministic from seed + commander decision:

```typescript
function classifyOutcome(
  decision: CommanderDecision,
  scenario: Scenario,
  colonyState: ColonySystems,
  rng: SeededRng,
): TurnOutcome {
  const isRisky = decision.decision.toLowerCase().includes(scenario.riskyOption.toLowerCase());
  
  // Success probability modified by colony state
  let successProb = scenario.riskSuccessProbability;
  if (colonyState.morale > 0.7) successProb += 0.1;
  if (colonyState.foodMonthsReserve > 12) successProb += 0.05;
  if (colonyState.population > 150) successProb -= 0.05; // larger colony = harder to manage
  successProb = Math.max(0.1, Math.min(0.9, successProb));
  
  const success = rng.chance(successProb);
  
  if (isRisky && success) return 'risky_success';
  if (isRisky && !success) return 'risky_failure';
  if (!isRisky && success) return 'conservative_success';
  return 'conservative_failure';
}
```

## Output Additions

```json
{
  "colonistTrajectories": {
    "col-yuki-tanaka": {
      "name": "Dr. Yuki Tanaka",
      "promotedTurn": 1,
      "promotedAs": "Chief Medical Officer",
      "promotedBy": "Aria Chen",
      "hexacoTrajectory": [
        { "turn": 0, "year": 2035, "openness": 0.52, "conscientiousness": 0.78, "extraversion": 0.45, "agreeableness": 0.61, "emotionality": 0.55, "honestyHumility": 0.68 },
        { "turn": 6, "year": 2049, "openness": 0.61, "conscientiousness": 0.72, "extraversion": 0.52, "agreeableness": 0.59, "emotionality": 0.51, "honestyHumility": 0.67 },
        { "turn": 12, "year": 2085, "openness": 0.71, "conscientiousness": 0.65, "extraversion": 0.58, "agreeableness": 0.57, "emotionality": 0.48, "honestyHumility": 0.66 }
      ]
    }
  },
  "outcomeClassifications": [
    { "turn": 1, "year": 2035, "outcome": "risky_success", "riskyOption": "Valles Marineris", "commanderChoseRisky": true }
  ]
}
```

## File Changes from v2

| File | Change |
|---|---|
| `state.ts` | Add HexacoProfile, PromotionRecord, HexacoSnapshot to Colonist |
| `colonist-generator.ts` | Add randomHexaco() per colonist, trait inheritance for children |
| `progression.ts` | Add applyPersonalityDrift() in between-turn progression |
| `kernel.ts` | Add classifyOutcome(), getCandidates(), applyDrift() |
| `contracts.ts` | Add PromotionDecision type |
| `orchestrator.ts` | Add Turn 0 promotion flow, inject HEXACO into turn prompts, track trajectories |
| `departments.ts` | Update context builder to include current HEXACO in prompt |
| `scenarios.ts` | Add riskyOption and riskSuccessProbability to each crisis |
| Entry points | Same interface, no changes needed |

## Implementation Order

1. Update `state.ts` with new types (HexacoProfile, PromotionRecord, etc.)
2. Update `colonist-generator.ts` to randomize HEXACO per colonist
3. Update `scenarios.ts` with riskyOption fields
4. Add drift + outcome classification to `progression.ts`
5. Update `kernel.ts` with getCandidates(), classifyOutcome(), drift in advanceTurn()
6. Add PromotionDecision to `contracts.ts`
7. Update `departments.ts` to inject HEXACO into context
8. Update `orchestrator.ts` with Turn 0 promotion flow and trajectory tracking
9. Smoke test: 3 turns, verify drift is visible in output JSON

## Success Criteria

- Commander autonomously evaluates roster and promotes with personality-aligned reasoning
- Same colonist under two commanders develops measurably different HEXACO profiles by Turn 12
- Drift is deterministic: same seed + same policy sequence = same trajectories
- Trait trajectories are tracked per turn in the output JSON
- Department agents' LLM behavior shifts as personality values update in prompts
- Tool registries differ between runs as a consequence of personality drift
- Forged tool names/types correlate with the leader's personality pull direction
- Promotion events logged with commander reasoning
- All existing v2 tests and behaviors still work

## Explicit Non-Goals

- Colonists do not become LLM agents unless promoted
- Demotion is not implemented
- Drift for non-promoted colonists is not computed
- Commander's own personality does not drift (fixed reference point)
- Dashboard is built separately after v3 kernel works
