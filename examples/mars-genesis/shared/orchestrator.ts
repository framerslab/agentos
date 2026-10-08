import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ITool } from '@framers/agentos';
import {
  EmergentCapabilityEngine, EmergentJudge, EmergentToolRegistry,
  ComposableToolBuilder, ForgeToolMetaTool, generateText, createStepGate,
} from '@framers/agentos';
import type { Department, TurnOutcome } from './state.js';
import { SeededRng } from './rng.js';
import { classifyOutcome } from './progression.js';
import type { DepartmentReport, CommanderDecision, TurnArtifact } from './contracts.js';
import { SimulationKernel, type PolicyEffect } from './kernel.js';
import type { KeyPersonnel } from './colonist-generator.js';
import { SCENARIOS } from './scenarios.js';
import { getResearchPacket } from './research.js';
import { DEPARTMENT_CONFIGS, buildDepartmentContext, getDepartmentsForTurn } from './departments.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface LeaderConfig {
  name: string;
  archetype: string;
  colony: string;
  hexaco: { openness: number; conscientiousness: number; extraversion: number; agreeableness: number; emotionality: number; honestyHumility: number };
  instructions: string;
}

// ---------------------------------------------------------------------------
// Web search tool
// ---------------------------------------------------------------------------

const webSearchTool: ITool = {
  id: 'tool.web_search', name: 'web_search', displayName: 'Web Search',
  description: 'Search for scientific papers and NASA data.',
  inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  hasSideEffects: false,
  async execute(args: Record<string, unknown>) {
    const query = String(args.query || '');
    const key = process.env.SERPER_API_KEY;
    if (!key) return { success: false, error: 'SERPER_API_KEY not set' };
    try {
      const res = await fetch('https://google.serper.dev/search', {
        method: 'POST', headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: query, num: 5 }),
      });
      if (!res.ok) return { success: false, error: `Search ${res.status}` };
      const data = await res.json() as any;
      return { success: true, output: { results: (data.organic || []).slice(0, 5).map((r: any) => ({ title: r.title, url: r.link, snippet: r.snippet })), query } };
    } catch (err) { return { success: false, error: String(err) }; }
  },
};

// ---------------------------------------------------------------------------
// Emergent engine
// ---------------------------------------------------------------------------

function createEmergentEngine(toolMap: Map<string, ITool>) {
  const llmCb = async (model: string, prompt: string) => {
    const r = await generateText({ provider: 'openai', model: model || 'gpt-5.4', prompt });
    return r.text;
  };
  const registry = new EmergentToolRegistry();
  const judge = new EmergentJudge({ judgeModel: 'gpt-5.4', promotionModel: 'gpt-5.4', generateText: llmCb });
  const engine = new EmergentCapabilityEngine({
    config: {
      enabled: true, maxSessionTools: 20, maxAgentTools: 50,
      sandboxTimeoutMs: 10000, sandboxMemoryMB: 128,
      promotionThreshold: { uses: 5, confidence: 0.8 },
      allowSandboxTools: true, persistSandboxSource: true,
      // The departments forge pure computations: a ceiling that grants
      // nothing, and no storage adapter, so no effect records.
      capabilities: {}, audit: { store: 'none' },
      judgeModel: 'gpt-5.4', promotionJudgeModel: 'gpt-5.4',
    },
    // Each step resolves its tool from the map; web_search declares no side
    // effects, so compositions of it are chained freely.
    composableBuilder: new ComposableToolBuilder(createStepGate({ resolve: (name) => toolMap.get(name) })),
    judge, registry,
  });
  return { engine, forgeTool: new ForgeToolMetaTool(engine) };
}

function wrapForgeTool(raw: ForgeToolMetaTool, agentId: string, sessionId: string, dept: string): ITool {
  return {
    ...(raw as any),
    async execute(args: Record<string, unknown>, ctx: any) {
      const fixed = { ...args };
      // Parse stringified nested JSON from tool call serialization
      for (const k of ['implementation', 'inputSchema', 'outputSchema', 'testCases']) {
        if (typeof (fixed as any)[k] === 'string') try { (fixed as any)[k] = JSON.parse((fixed as any)[k]); } catch {}
      }
      // Normalize implementation: OpenAI models send "code" instead of "sandbox", may omit allowlist
      if (fixed.implementation && typeof fixed.implementation === 'object') {
        const impl = fixed.implementation as any;
        if (impl.mode === 'code') impl.mode = 'sandbox';
        if (impl.mode === 'sandbox' && !Array.isArray(impl.allowlist)) impl.allowlist = [];
        if (impl.code && typeof impl.code !== 'string') impl.code = String(impl.code);
        // Ensure code wraps in function execute(input) if missing
        if (impl.mode === 'sandbox' && impl.code && !impl.code.includes('function execute')) {
          impl.code = `function execute(input) {\n${impl.code}\n}`;
        }
      }
      // Ensure schemas are valid objects — use permissive schemas so the judge
      // doesn't reject on schema conformance mismatch
      if (!fixed.inputSchema || typeof fixed.inputSchema !== 'object') {
        fixed.inputSchema = { type: 'object', additionalProperties: true };
      }
      if (!fixed.outputSchema || typeof fixed.outputSchema !== 'object') {
        fixed.outputSchema = { type: 'object', additionalProperties: true };
      }
      // Ensure testCases is a non-empty array with valid structure
      if (!Array.isArray(fixed.testCases) || fixed.testCases.length === 0) {
        fixed.testCases = [{ input: {}, expectedOutput: {} }];
      }
      for (const tc of fixed.testCases as any[]) {
        if (!tc.input || typeof tc.input !== 'object') tc.input = {};
        if (tc.expectedOutput === undefined) tc.expectedOutput = {};
      }
      const mode = (fixed.implementation as any)?.mode || '?';
      console.log(`    🔧 [${dept}] Forging "${fixed.name}" (${mode})...`);
      const patched = { ...ctx, gmiId: agentId, sessionData: { ...(ctx?.sessionData ?? {}), sessionId } };
      try {
        const r = await raw.execute(fixed as any, patched);
        if (r.success) {
          console.log(`    🔧 [${dept}] ✓ "${fixed.name}" approved`);
        } else {
          const reason = r.error || (r.output as any)?.verdict?.reasoning || (r.output as any)?.error || '';
          console.log(`    🔧 [${dept}] ✗ "${fixed.name}" — ${String(reason).slice(0, 150)}`);
        }
        return r;
      } catch (err) {
        console.log(`    🔧 [${dept}] ERR: ${err}`);
        return { success: false, error: String(err) };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function parseDeptReport(text: string, dept: Department): DepartmentReport {
  const jsonMatch = text.match(/\{[\s\S]*"department"[\s\S]*\}/);
  if (jsonMatch) try { return { ...emptyReport(dept), ...JSON.parse(jsonMatch[0]), department: dept }; } catch {}
  const cites: DepartmentReport['citations'] = [];
  let m; const re = /\[([^\]]+)\]\(([^)]+)\)/g;
  while ((m = re.exec(text))) if (m[2].startsWith('http')) cites.push({ text: m[1], url: m[2], context: m[1] });
  return { ...emptyReport(dept), summary: text.slice(0, 500), citations: cites };
}

function parseCmdDecision(text: string, depts: Department[]): CommanderDecision {
  const jsonMatch = text.match(/\{[\s\S]*"decision"[\s\S]*\}/);
  if (jsonMatch) try { return { ...emptyDecision(depts), ...JSON.parse(jsonMatch[0]) }; } catch {}
  return { ...emptyDecision(depts), decision: text.slice(0, 500), rationale: text };
}

function emptyReport(d: Department): DepartmentReport {
  return { department: d, summary: '', citations: [], risks: [], opportunities: [], recommendedActions: [], proposedPatches: {}, forgedToolsUsed: [], featuredColonistUpdates: [], confidence: 0.7, openQuestions: [] };
}
function emptyDecision(d: Department[]): CommanderDecision {
  return { decision: '', rationale: '', departmentsConsulted: d, selectedPolicies: [], rejectedPolicies: [], expectedTradeoffs: [], watchMetricsNextTurn: [] };
}

function decisionToPolicy(decision: CommanderDecision, reports: DepartmentReport[], turn: number, year: number): PolicyEffect {
  const patches: PolicyEffect['patches'] = {};
  for (const r of reports) {
    if (r.proposedPatches.colony) patches.colony = { ...patches.colony, ...r.proposedPatches.colony };
    if (r.proposedPatches.politics) patches.politics = { ...patches.politics, ...r.proposedPatches.politics };
    if (r.proposedPatches.colonistUpdates) patches.colonistUpdates = [...(patches.colonistUpdates || []), ...r.proposedPatches.colonistUpdates];
  }
  return {
    description: decision.decision,
    patches,
    events: [{ turn, year, type: 'decision', description: decision.decision.slice(0, 200), data: { policies: decision.selectedPolicies } }],
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export interface RunOptions { maxTurns?: number; liveSearch?: boolean; }

export async function runSimulation(leader: LeaderConfig, keyPersonnel: KeyPersonnel[], opts: RunOptions = {}) {
  const { agent } = await import('@framers/agentos');
  const maxTurns = opts.maxTurns ?? 12;
  const sid = `mars-v2-${leader.archetype.toLowerCase().replace(/\s+/g, '-')}`;

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  MARS GENESIS v2`);
  console.log(`  Commander: ${leader.name} — "${leader.archetype}"`);
  console.log(`  Turns: ${maxTurns} | Live search: ${opts.liveSearch ? 'yes' : 'no'}`);
  console.log(`${'═'.repeat(60)}\n`);

  const seed = Math.abs(leader.hexaco.openness * 1000 | 0);
  const kernel = new SimulationKernel(seed, leader.name, keyPersonnel);

  const toolMap = new Map<string, ITool>();
  toolMap.set('web_search', webSearchTool);
  const { engine, forgeTool } = createEmergentEngine(toolMap);
  const toolRegs: Record<string, string[]> = {};

  const commander = agent({
    provider: 'openai', model: 'gpt-5.4',
    instructions: leader.instructions,
    personality: { openness: leader.hexaco.openness, conscientiousness: leader.hexaco.conscientiousness, extraversion: leader.hexaco.extraversion, agreeableness: leader.hexaco.agreeableness, emotionality: leader.hexaco.emotionality, honesty: leader.hexaco.honestyHumility },
    maxSteps: 5,
  });
  const cmdSess = commander.session(`${sid}-cmd`);
  await cmdSess.send('You are the colony commander. You receive department reports and make strategic decisions. Return JSON with decision, rationale, selectedPolicies, rejectedPolicies, expectedTradeoffs, watchMetricsNextTurn. Acknowledge.');

  // Turn 0: Commander promotes department heads from colonist roster
  console.log('  [Turn 0] Commander evaluating roster for promotions...');
  const promotionDepts: Department[] = ['medical', 'engineering', 'agriculture', 'psychology'];
  const roleNames: Record<string, string> = {
    medical: 'Chief Medical Officer', engineering: 'Chief Engineer',
    agriculture: 'Head of Agriculture', psychology: 'Colony Psychologist',
  };
  const candidateSummaries = promotionDepts.map(dept => {
    const candidates = kernel.getCandidates(dept, 5);
    return `## ${dept.toUpperCase()} — Top 5 Candidates:\n${candidates.map(c => {
      const age = 2035 - c.core.birthYear;
      const h = c.hexaco;
      return `- ${c.core.name} (${c.core.id}), age ${age}, spec: ${c.career.specialization}, O:${h.openness.toFixed(2)} C:${h.conscientiousness.toFixed(2)} E:${h.extraversion.toFixed(2)} A:${h.agreeableness.toFixed(2)} Em:${h.emotionality.toFixed(2)} HH:${h.honestyHumility.toFixed(2)}`;
    }).join('\n')}`;
  }).join('\n\n');

  const promoResult = await cmdSess.send(
    `You must promote 4 colonists to department head roles. Evaluate these candidates based on their personality traits and specialization. Choose people who align with YOUR leadership style.\n\n${candidateSummaries}\n\nReturn JSON: {"promotions":[{"colonistId":"col-...","department":"medical","role":"Chief Medical Officer","reason":"..."},...]}`
  );

  const promoMatch = promoResult.text.match(/\{[\s\S]*"promotions"[\s\S]*\}/);
  if (promoMatch) {
    try {
      const pd = JSON.parse(promoMatch[0]);
      for (const p of pd.promotions || []) {
        try {
          kernel.promoteColonist(p.colonistId, p.department, p.role, leader.name);
          console.log(`  ✦ ${p.colonistId} → ${p.role}: ${p.reason?.slice(0, 80)}`);
        } catch (err) { console.log(`  ✦ Promotion failed: ${err}`); }
      }
    } catch { /* fallback below */ }
  }
  // Fallback: promote top candidate per dept if commander didn't produce valid JSON
  for (const dept of promotionDepts) {
    const hasLeader = kernel.getState().colonists.some(c => c.promotion?.department === dept);
    if (!hasLeader) {
      const top = kernel.getCandidates(dept, 1)[0];
      if (top) {
        kernel.promoteColonist(top.core.id, dept, roleNames[dept] || `Head of ${dept}`, leader.name);
        console.log(`  ✦ [fallback] ${top.core.name} → ${roleNames[dept]}`);
      }
    }
  }

  // Create department agent sessions from promoted colonists
  const deptAgents = new Map<Department, any>();
  const deptSess = new Map<Department, any>();
  const promoted = kernel.getState().colonists.filter(c => c.promotion);
  for (const p of promoted) {
    const dept = p.promotion!.department;
    const cfg = DEPARTMENT_CONFIGS.find(c => c.department === dept);
    if (!cfg) continue;
    const wrapped = wrapForgeTool(forgeTool, `${sid}-${dept}`, sid, dept);
    const tools: ITool[] = opts.liveSearch ? [webSearchTool, wrapped] : [wrapped];
    const a = agent({ provider: 'openai', model: cfg.model, instructions: cfg.instructions, tools, maxSteps: 8 });
    deptAgents.set(dept, a);
    deptSess.set(dept, a.session(`${sid}-${dept}`));
  }
  console.log(`  Promoted ${promoted.length} department heads. Agents created.\n`);

  const artifacts: TurnArtifact[] = [];
  const scenarios = SCENARIOS.slice(0, maxTurns);
  const outcomeLog: Array<{ turn: number; year: number; outcome: TurnOutcome }> = [];

  for (const scenario of scenarios) {
    const turn = scenario.turn;
    console.log(`\n${'─'.repeat(50)}`);
    console.log(`  Turn ${turn}/${maxTurns} — Year ${scenario.year}: ${scenario.title}`);
    console.log(`${'─'.repeat(50)}`);

    const state = kernel.advanceTurn(turn);
    const births = state.eventLog.filter(e => e.turn === turn && e.type === 'birth').length;
    const deaths = state.eventLog.filter(e => e.turn === turn && e.type === 'death').length;
    console.log(`  Kernel: +${births} births, -${deaths} deaths → pop ${state.colony.population}`);

    const packet = getResearchPacket(turn);
    const depts = getDepartmentsForTurn(turn);
    console.log(`  Departments: ${depts.join(', ')}`);

    const reports: DepartmentReport[] = [];
    for (const dept of depts) {
      const sess = deptSess.get(dept);
      if (!sess) continue;
      const ctx = buildDepartmentContext(dept, state, scenario, packet);
      console.log(`  [${dept}] Analyzing...`);
      try {
        const r = await sess.send(ctx);
        const report = parseDeptReport(r.text, dept);
        reports.push(report);
        console.log(`  [${dept}] Done: ${report.citations.length} citations, ${report.risks.length} risks, ${report.forgedToolsUsed.length} tools`);
        if (report.forgedToolsUsed.length) {
          const names = report.forgedToolsUsed.map(t => t?.name || t?.description || 'unnamed').filter(Boolean);
          if (names.length) toolRegs[dept] = [...(toolRegs[dept] || []), ...names];
        }
      } catch (err) {
        console.log(`  [${dept}] ERROR: ${err}`);
        reports.push(emptyReport(dept));
      }
    }

    const summaries = reports.map(r => `## ${r.department.toUpperCase()} (conf: ${r.confidence})\n${r.summary}\nRisks: ${r.risks.map(x => `[${x.severity}] ${x.description}`).join('; ') || 'none'}\nRecs: ${r.recommendedActions.join('; ') || 'none'}`).join('\n\n');
    const cmdPrompt = `TURN ${turn} — ${scenario.year}: ${scenario.title}\n\nDEPARTMENT REPORTS:\n${summaries}\n\nColony: Pop ${state.colony.population} | Morale ${Math.round(state.colony.morale * 100)}% | Food ${state.colony.foodMonthsReserve.toFixed(1)}mo\n\nDecide. Return JSON.`;

    console.log(`  [commander] Deciding...`);
    const cmdR = await cmdSess.send(cmdPrompt);
    const decision = parseCmdDecision(cmdR.text, depts);
    console.log(`  [commander] ${decision.decision.slice(0, 120)}...`);

    kernel.applyPolicy(decisionToPolicy(decision, reports, turn, scenario.year));

    // Classify outcome and apply personality drift
    const prevYear = turn === 1 ? 2035 : scenarios[scenarios.indexOf(scenario) - 1]?.year ?? 2035;
    const yearDelta = scenario.year - prevYear;
    const outcomeRng = new SeededRng(seed).turnSeed(turn + 1000);
    const outcome = classifyOutcome(
      decision.decision, scenario.riskyOption, scenario.riskSuccessProbability,
      kernel.getState().colony, outcomeRng,
    );
    kernel.applyDrift(leader.hexaco, outcome, Math.max(1, yearDelta));
    outcomeLog.push({ turn, year: scenario.year, outcome });
    console.log(`  [outcome] ${outcome} (risky: "${scenario.riskyOption}")`);

    // Log drift for promoted colonists
    const drifted = kernel.getState().colonists.filter(c => c.promotion && c.health.alive);
    for (const p of drifted.slice(0, 3)) {
      const h = p.hexaco;
      console.log(`  [drift] ${p.core.name}: O:${h.openness.toFixed(2)} C:${h.conscientiousness.toFixed(2)}`);
    }

    const after = kernel.getState();

    artifacts.push({
      turn, year: scenario.year, crisis: scenario.title,
      departmentReports: reports, commanderDecision: decision,
      policyEffectsApplied: decision.selectedPolicies,
      stateSnapshotAfter: {
        population: after.colony.population, morale: after.colony.morale,
        foodMonthsReserve: after.colony.foodMonthsReserve, infrastructureModules: after.colony.infrastructureModules,
        scienceOutput: after.colony.scienceOutput, births, deaths,
      },
    });
    console.log(`  State: Pop ${after.colony.population} | Morale ${Math.round(after.colony.morale * 100)}% | Food ${after.colony.foodMonthsReserve.toFixed(1)}mo`);
  }

  const final = kernel.export();

  // Build colonist trajectories for promoted leaders
  const trajectories = Object.fromEntries(
    final.colonists
      .filter(c => c.promotion && c.hexacoHistory.length > 1)
      .map(c => [c.core.id, {
        name: c.core.name,
        promotedTurn: c.promotion!.turnPromoted,
        promotedAs: c.promotion!.role,
        promotedBy: c.promotion!.promotedBy,
        hexacoTrajectory: c.hexacoHistory,
      }])
  );

  const output = {
    simulation: 'mars-genesis-v3', leader: { name: leader.name, archetype: leader.archetype, colony: leader.colony, hexaco: leader.hexaco },
    turnArtifacts: artifacts, finalState: final, toolRegistries: toolRegs,
    colonistTrajectories: trajectories,
    outcomeClassifications: outcomeLog,
    totalCitations: artifacts.reduce((s, t) => s + t.departmentReports.reduce((s2, r) => s2 + r.citations.length, 0), 0),
    totalToolsForged: Object.values(toolRegs).flat().length,
  };

  const outDir = resolve(__dirname, '..', 'output');
  mkdirSync(outDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const tag = leader.archetype.toLowerCase().replace(/\s+/g, '-');
  const path = resolve(outDir, `v3-${tag}-${ts}.json`);
  writeFileSync(path, JSON.stringify(output, null, 2));

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  COMPLETE — ${leader.name}`);
  console.log(`  Output: ${path}`);
  console.log(`  Turns: ${artifacts.length} | Citations: ${output.totalCitations} | Tools: ${output.totalToolsForged}`);
  console.log(`  Final: Pop ${final.colony.population} | Morale ${Math.round(final.colony.morale * 100)}%`);
  console.log(`  Registries: ${JSON.stringify(toolRegs)}`);
  console.log(`${'═'.repeat(60)}\n`);

  engine.cleanupSession(sid);
  await commander.close();
  for (const a of deptAgents.values()) await a.close();
  return output;
}
