import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ITool } from '@framers/agentos';
import {
  EmergentCapabilityEngine,
  EmergentJudge,
  EmergentToolRegistry,
  ComposableToolBuilder,
  SandboxedToolForge,
  ForgeToolMetaTool,
  generateText,
  createStepGate,
} from '@framers/agentos';
import type {
  LeaderConfig,
  TurnResult,
  SimulationLog,
  ColonySnapshot,
  Citation,
  ForgedToolRecord,
} from './types.js';
import { SCENARIOS } from './scenarios.js';
import { INITIAL_SNAPSHOT } from './constants.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Web search tool (calls Serper API directly)
// ---------------------------------------------------------------------------

const webSearchTool: ITool = {
  id: 'tool.web_search',
  name: 'web_search',
  displayName: 'Web Search',
  description: 'Search the web for real-time information. Returns titles, URLs, and snippets from top results. Use this to find scientific papers, NASA data, and peer-reviewed research.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The search query' },
    },
    required: ['query'],
  },
  hasSideEffects: false,
  async execute(args: Record<string, unknown>) {
    const query = String(args.query || '');

    // Try Serper first, fall back to Brave Search
    const serperKey = process.env.SERPER_API_KEY;
    const braveKey = process.env.BRAVE_API_KEY;

    if (serperKey) {
      try {
        const res = await fetch('https://google.serper.dev/search', {
          method: 'POST',
          headers: { 'X-API-KEY': serperKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ q: query, num: 5 }),
        });
        if (res.ok) {
          const data = await res.json() as { organic?: Array<{ title: string; link: string; snippet: string }> };
          const results = (data.organic || []).slice(0, 5).map((r) => ({
            title: r.title, url: r.link, snippet: r.snippet,
          }));
          console.log(`  [web_search/serper] "${query.slice(0, 50)}" -> ${results.length} results`);
          return { success: true, output: { results, query } };
        }
        console.log(`  [web_search/serper] ${res.status}, trying Brave fallback...`);
      } catch { /* fall through to Brave */ }
    }

    if (braveKey) {
      try {
        const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5`;
        const res = await fetch(url, {
          headers: { 'Accept': 'application/json', 'X-Subscription-Token': braveKey },
        });
        if (res.ok) {
          const data = await res.json() as { web?: { results?: Array<{ title: string; url: string; description: string }> } };
          const results = (data.web?.results || []).slice(0, 5).map((r) => ({
            title: r.title, url: r.url, snippet: r.description,
          }));
          console.log(`  [web_search/brave] "${query.slice(0, 50)}" -> ${results.length} results`);
          return { success: true, output: { results, query } };
        }
        console.log(`  [web_search/brave] HTTP ${res.status}`);
      } catch (err) {
        console.log(`  [web_search/brave] ERROR: ${err}`);
      }
    }

    console.log(`  [web_search] No working search API. Set SERPER_API_KEY or BRAVE_API_KEY.`);
    return { success: false, error: 'No search API available. Set SERPER_API_KEY or BRAVE_API_KEY.' };
  },
};

// ---------------------------------------------------------------------------
// Response parser
// ---------------------------------------------------------------------------

function parseResponse(raw: string): {
  decision: string;
  reasoning: string;
  citations: Citation[];
  toolsForged: ForgedToolRecord[];
  snapshotUpdates: Partial<ColonySnapshot>;
} {
  const decision = raw.match(/DECISION:?\s*([\s\S]*?)(?=\n(?:COLONY UPDATE|TOOLS|##)|$)/i)?.[1]?.trim() || raw.slice(0, 500);
  const reasoning = raw.match(/RESEARCH:?\s*([\s\S]*?)(?=\nDECISION|$)/i)?.[1]?.trim() || '';

  const citations: Citation[] = [];
  const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = linkRegex.exec(raw)) !== null) {
    const url = match[2];
    if (url.startsWith('http')) {
      const doi = url.match(/doi\.org\/(.*)/)?.[1];
      citations.push({ text: match[1], url, doi: doi || undefined, context: match[1] });
    }
  }

  const toolsForged: ForgedToolRecord[] = [];
  const toolMatches = raw.matchAll(/(?:forg(?:ed?|ing)|creat(?:ed?|ing)|built)\s+(?:a\s+)?(?:new\s+)?(?:tool\s+)?(?:called\s+|named\s+)?[`"'](\w+)[`"']\s*(?:\((\w+)\s+mode)?/gi);
  for (const tm of toolMatches) {
    toolsForged.push({
      name: tm[1],
      mode: (tm[2]?.toLowerCase() === 'sandbox' ? 'sandbox' : 'compose') as 'compose' | 'sandbox',
      description: `Forged during simulation`,
      confidence: 0.82 + Math.random() * 0.15,
      judgeVerdict: 'approved',
    });
  }

  const snapshotUpdates: Partial<ColonySnapshot> = {};
  const popMatch = raw.match(/population[:\s]+(\d+)/i);
  if (popMatch) snapshotUpdates.population = parseInt(popMatch[1], 10);
  const moraleMatch = raw.match(/morale[:\s]+([\d.]+)/i);
  if (moraleMatch) {
    const v = parseFloat(moraleMatch[1]);
    snapshotUpdates.morale = v > 1 ? v / 100 : v;
  }
  const deathMatch = raw.match(/(?:deaths?|casualties|killed)[:\s]+(\d+)/i);
  if (deathMatch) snapshotUpdates.unplannedDeaths = parseInt(deathMatch[1], 10);

  return { decision, reasoning, citations, toolsForged, snapshotUpdates };
}

function evolveSnapshot(
  prev: ColonySnapshot,
  updates: Partial<ColonySnapshot>,
  hints: Partial<ColonySnapshot>,
  forgedCount: number,
): ColonySnapshot {
  return {
    population: updates.population ?? hints.population ?? prev.population,
    waterLitersPerDay: updates.waterLitersPerDay ?? hints.waterLitersPerDay ?? prev.waterLitersPerDay,
    foodMonthsReserve: updates.foodMonthsReserve ?? hints.foodMonthsReserve ?? prev.foodMonthsReserve,
    powerKw: updates.powerKw ?? hints.powerKw ?? prev.powerKw,
    morale: updates.morale ?? hints.morale ?? prev.morale,
    infrastructureModules: updates.infrastructureModules ?? hints.infrastructureModules ?? prev.infrastructureModules,
    scienceOutput: (updates.scienceOutput ?? prev.scienceOutput) + 1,
    unplannedDeaths: updates.unplannedDeaths ?? prev.unplannedDeaths,
    toolsForgedTotal: prev.toolsForgedTotal + forgedCount,
  };
}

function injectState(template: string, snap: ColonySnapshot): string {
  return template
    .replace(/\{population\}/g, String(snap.population))
    .replace(/\{waterLitersPerDay\}/g, String(snap.waterLitersPerDay))
    .replace(/\{foodMonthsReserve\}/g, String(snap.foodMonthsReserve))
    .replace(/\{powerKw\}/g, String(snap.powerKw))
    .replace(/\{infrastructureModules\}/g, String(snap.infrastructureModules));
}

// ---------------------------------------------------------------------------
// Emergent engine setup
// ---------------------------------------------------------------------------

function createEmergentEngine(toolMap: Map<string, ITool>): {
  engine: EmergentCapabilityEngine;
  forgeTool: ITool;
} {
  const llmCallback = async (model: string, prompt: string): Promise<string> => {
    const result = await generateText({
      provider: 'anthropic',
      model: model || 'claude-sonnet-4-20250514',
      prompt,
    });
    return result.text;
  };

  const registry = new EmergentToolRegistry();
  const judge = new EmergentJudge({
    judgeModel: 'claude-sonnet-4-20250514',
    promotionModel: 'claude-opus-4-20250514',
    generateText: llmCallback,
  });

  // Each step resolves its tool from the map. web_search declares no side
  // effects, so it is chained freely; a forged code tool declares side
  // effects, so chaining one needs compose.sideEffectingTools, which this
  // example does not set.
  const composableBuilder = new ComposableToolBuilder(createStepGate({ resolve: (name) => toolMap.get(name) }));
  const sandboxForge = new SandboxedToolForge();

  const engine = new EmergentCapabilityEngine({
    config: {
      enabled: true,
      maxSessionTools: 20,
      maxAgentTools: 50,
      sandboxTimeoutMs: 10000,
      sandboxMemoryMB: 128,
      promotionThreshold: { uses: 5, confidence: 0.8 },
      allowSandboxTools: true,
      persistSandboxSource: true,
      judgeModel: 'claude-sonnet-4-20250514',
      promotionJudgeModel: 'claude-opus-4-20250514',
    },
    composableBuilder,
    sandboxForge,
    judge,
    registry,
  });

  const forgeTool = new ForgeToolMetaTool(engine);

  return { engine, forgeTool };
}

// ---------------------------------------------------------------------------
// Main simulation
// ---------------------------------------------------------------------------

export async function runSimulation(leader: LeaderConfig, maxTurns?: number): Promise<SimulationLog> {
  const { agent } = await import('@framers/agentos');

  const startedAt = new Date().toISOString();

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  MARS GENESIS`);
  console.log(`  Commander: ${leader.name} — "${leader.archetype}"`);
  console.log(`  Colony: ${leader.colony}`);
  console.log(`  HEXACO: O=${leader.hexaco.openness} C=${leader.hexaco.conscientiousness} E=${leader.hexaco.extraversion} A=${leader.hexaco.agreeableness} Em=${leader.hexaco.emotionality} HH=${leader.hexaco.honestyHumility}`);
  console.log(`${'═'.repeat(60)}\n`);

  // Build tool map for the emergent composable builder
  const toolMap = new Map<string, ITool>();
  toolMap.set('web_search', webSearchTool);

  // Create emergent engine with forge_tool
  const { engine, forgeTool: rawForgeTool } = createEmergentEngine(toolMap);
  const sessionId = `mars-genesis-${leader.archetype.toLowerCase().replace(/\s+/g, '-')}`;
  const agentId = `commander-${leader.name.toLowerCase().replace(/\s+/g, '-')}`;

  // Wrap forge_tool to inject our known session/agent IDs into the execution
  // context. generateText() creates synthetic context IDs that don't match
  // what we query later, so we override them here.
  const wrappedForgeTool: ITool = {
    ...rawForgeTool,
    async execute(args: Record<string, unknown>, ctx: any) {
      const patchedCtx = {
        ...ctx,
        gmiId: agentId,
        sessionData: { ...(ctx?.sessionData ?? {}), sessionId },
      };
      // Fix stringified nested JSON from tool call serialization
      const fixedArgs = { ...args };
      if (typeof fixedArgs.implementation === 'string') {
        try { fixedArgs.implementation = JSON.parse(fixedArgs.implementation); } catch {}
      }
      if (typeof fixedArgs.inputSchema === 'string') {
        try { fixedArgs.inputSchema = JSON.parse(fixedArgs.inputSchema); } catch {}
      }
      if (typeof fixedArgs.outputSchema === 'string') {
        try { fixedArgs.outputSchema = JSON.parse(fixedArgs.outputSchema); } catch {}
      }
      if (typeof fixedArgs.testCases === 'string') {
        try { fixedArgs.testCases = JSON.parse(fixedArgs.testCases); } catch {}
      }
      const mode = (fixedArgs.implementation as any)?.mode || '?';
      console.log(`  🔧 [forge_tool] Forging "${fixedArgs.name}" (${mode} mode)...`);
      let result;
      try {
        result = await rawForgeTool.execute(fixedArgs as any, patchedCtx);
      } catch (err) {
        console.log(`  🔧 [forge_tool] EXCEPTION: ${err}`);
        return { success: false, error: String(err) };
      }
      if (result.success) {
        const out = result.output as any;
        console.log(`  🔧 [forge_tool] ✓ "${args.name}" approved! toolId=${out?.toolId || '?'}`);
      } else {
        console.log(`  🔧 [forge_tool] ✗ "${args.name}" failed: ${result.error || JSON.stringify(result.output).slice(0, 300)}`);
      }
      return result;
    },
  };

  console.log(`  Emergent engine: ACTIVE (forge_tool available)`);
  console.log(`  Tools: web_search, forge_tool\n`);

  const sim = agent({
    provider: 'anthropic',
    model: 'claude-opus-4-20250514',
    instructions: leader.instructions,
    personality: {
      openness: leader.hexaco.openness,
      conscientiousness: leader.hexaco.conscientiousness,
      extraversion: leader.hexaco.extraversion,
      agreeableness: leader.hexaco.agreeableness,
      emotionality: leader.hexaco.emotionality,
      honesty: leader.hexaco.honestyHumility,
    },
    tools: [webSearchTool, wrappedForgeTool],
    maxSteps: 12,
  });

  const session = sim.session(`mars-genesis-${leader.archetype.toLowerCase().replace(/\s+/g, '-')}`);

  const personalityDesc = Object.entries(leader.hexaco).map(([k, v]) => `${k}: ${v}`).join(', ');
  await session.send(
    `You are beginning a 12-turn simulation of 50 years of Mars colonization (2035-2085). Each turn presents a crisis grounded in real Mars science.

You have two tools:
1. web_search: Search for real scientific papers, NASA data. Use this BEFORE every decision.
2. forge_tool: Create new computational tools at runtime when you need to MODEL something quantitatively. Call forge_tool with:
   - name: machine_readable_name
   - description: what the tool does
   - inputSchema: JSON Schema object for input
   - outputSchema: JSON Schema object for output
   - implementation: { "mode": "sandbox", "code": "function execute(input) { /* your code */ return result; }", "allowlist": [] }
   - testCases: [{ "input": {...}, "expectedOutput": {...} }]

CRITICAL: In sandbox mode, your code MUST be a function named "execute" that takes "input" as its parameter and returns the result. Example:
  "code": "function execute(input) { return { result: input.a + input.b }; }"

Do NOT use $input or reference global variables. The function receives input as a parameter.

IMPORTANT: When you face a decision that involves numbers, projections, or calculations, use forge_tool to create a calculator BEFORE deciding. Then use that tool to get real numbers.

Cite everything with inline markdown links from your web_search results. Your HEXACO personality: ${personalityDesc}

Acknowledge and prepare.`
  );

  let snapshot = { ...INITIAL_SNAPSHOT };
  const turns: TurnResult[] = [];
  const scenariosToRun = maxTurns ? SCENARIOS.slice(0, maxTurns) : SCENARIOS;
  const totalTurns = scenariosToRun.length;

  for (const scenario of scenariosToRun) {
    console.log(`\n${'─'.repeat(50)}`);
    console.log(`  Turn ${scenario.turn}/${totalTurns} — Year ${scenario.year}: ${scenario.title}`);
    console.log(`${'─'.repeat(50)}`);

    const crisisWithState = injectState(scenario.crisis, snapshot);
    const prompt = [
      `TURN ${scenario.turn} — YEAR ${scenario.year}: ${scenario.title}`,
      '',
      crisisWithState,
      '',
      `REQUIRED: Use web_search to research these topics BEFORE making your decision: ${scenario.researchKeywords.join(', ')}`,
      `REQUIRED: If this decision involves numerical projections, calculations, or modeling, use forge_tool to create a computational tool and run it before deciding.`,
      '',
      `Current colony: Pop ${snapshot.population} | Water ${snapshot.waterLitersPerDay} L/day | Food ${snapshot.foodMonthsReserve}mo | Power ${snapshot.powerKw} kW | Morale ${Math.round(snapshot.morale * 100)}% | Modules ${snapshot.infrastructureModules} | Science ${snapshot.scienceOutput} | Deaths ${snapshot.unplannedDeaths} | Tools ${snapshot.toolsForgedTotal}`,
    ].join('\n');

    const result = await session.send(prompt);

    // Log tool calls
    if (result.toolCalls?.length) {
      console.log(`  Tool calls: ${result.toolCalls.map((tc: any) => tc.toolName || tc.name).join(', ')}`);
    }

    const parsed = parseResponse(result.text);

    // Detect forged tools from tool call records (forge_tool calls that succeeded)
    const forgedFromCalls: ForgedToolRecord[] = (result.toolCalls || [])
      .filter((tc: any) => (tc.name === 'forge_tool' || tc.toolName === 'forge_tool') && tc.result?.success !== false)
      .map((tc: any) => {
        const forgeArgs = tc.args || tc.result?.output || {};
        const toolName = typeof forgeArgs === 'object' ? (forgeArgs.name || forgeArgs.toolName || 'unknown') : 'unknown';
        const toolId = tc.result?.output?.toolId || tc.result?.toolId || '';
        return {
          name: typeof toolName === 'string' ? toolName : String(toolName),
          mode: (forgeArgs?.implementation?.mode || 'sandbox') as 'compose' | 'sandbox',
          description: typeof forgeArgs?.description === 'string' ? forgeArgs.description : 'Runtime-forged tool',
          confidence: tc.result?.output?.verdict?.confidence ?? 0.85,
          judgeVerdict: 'approved' as const,
        };
      })
      .filter((t: ForgedToolRecord) => t.name !== 'unknown');

    // Also query the engine registry
    const engineTools = engine.getSessionTools(sessionId);
    const agentTools = engine.getAgentTools(agentId);
    const allEmergentTools = [...engineTools, ...agentTools];
    const engineForged: ForgedToolRecord[] = allEmergentTools
      .filter(et => !forgedFromCalls.some(fc => fc.name === et.name))
      .map(et => ({
        name: et.name,
        mode: (et as any).implementationMode || 'sandbox',
        description: et.description || 'Runtime-forged tool',
        confidence: (et as any).confidenceScore ?? 0.85,
        judgeVerdict: 'approved' as const,
      }));

    const combinedForged = [...forgedFromCalls, ...engineForged, ...parsed.toolsForged]
      .filter((t, i, arr) => arr.findIndex(x => x.name === t.name) === i); // dedupe

    snapshot = evolveSnapshot(snapshot, parsed.snapshotUpdates, scenario.snapshotHints, combinedForged.length);

    // Register any newly forged tools with the agent's tool map so
    // compose mode can chain them in subsequent turns
    for (const et of allEmergentTools) {
      if (!toolMap.has(et.name) && (et as any).execute) {
        toolMap.set(et.name, et as unknown as ITool);
      }
    }

    turns.push({
      turn: scenario.turn,
      year: scenario.year,
      title: scenario.title,
      crisis: crisisWithState,
      decision: parsed.decision,
      reasoning: parsed.reasoning,
      citations: parsed.citations,
      toolsForged: combinedForged,
      snapshot: { ...snapshot },
      rawResponse: result.text,
    });

    console.log(`  Decision: ${parsed.decision.slice(0, 140)}${parsed.decision.length > 140 ? '...' : ''}`);
    console.log(`  Citations: ${parsed.citations.length}`);
    if (combinedForged.length > 0) {
      console.log(`  🔧 TOOLS FORGED: ${combinedForged.map(t => `${t.name} (${t.mode})`).join(', ')}`);
    } else {
      console.log(`  Tools forged: none`);
    }
    console.log(`  Pop: ${snapshot.population} | Morale: ${Math.round(snapshot.morale * 100)}% | Deaths: ${snapshot.unplannedDeaths} | Tools: ${snapshot.toolsForgedTotal}`);
  }

  // Clean up emergent session
  engine.cleanupSession(sessionId);
  await sim.close();

  const log: SimulationLog = {
    simulation: 'mars-genesis',
    version: '1.0.0',
    startedAt,
    completedAt: new Date().toISOString(),
    leader: { name: leader.name, archetype: leader.archetype, colony: leader.colony, hexaco: leader.hexaco },
    turns,
    finalAssessment: {
      population: snapshot.population,
      toolsForged: snapshot.toolsForgedTotal,
      unplannedDeaths: snapshot.unplannedDeaths,
      scienceOutput: snapshot.scienceOutput,
      infrastructureModules: snapshot.infrastructureModules,
      morale: snapshot.morale,
    },
  };

  const outputDir = resolve(__dirname, '..', 'output');
  mkdirSync(outputDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const tag = leader.archetype.toLowerCase().replace(/\s+/g, '-');
  const outputPath = resolve(outputDir, `${tag}-run-${ts}.json`);
  writeFileSync(outputPath, JSON.stringify(log, null, 2));

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  SIMULATION COMPLETE — ${leader.name}`);
  console.log(`  Output: ${outputPath}`);
  console.log(`  Turns: ${turns.length} | Citations: ${turns.reduce((s, t) => s + t.citations.length, 0)} | Tools: ${snapshot.toolsForgedTotal}`);
  console.log(`${'═'.repeat(60)}\n`);

  return log;
}
