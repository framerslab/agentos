const { basename, dirname, resolve } = require('node:path');
const { existsSync } = require('node:fs');

const DOC_SEARCH_SUBDIRS = [
  'getting-started',
  'architecture',
  'features',
  'memory',
  'safety',
  'observability',
  'extensions',
  'orchestration',
];

const SECTION_ORDER = [
  'Getting Started',
  'Concepts',
  'Architecture',
  'Cognitive Pipeline',
  'Memory',
  'RAG & Retrieval',
  'Personas',
  'Orchestration',
  'Tools & Capabilities',
  'Model Quality & Cost',
  'Voice & Speech',
  'Media Generation',
  'Channels & Social',
  'Guardrails & Safety',
  'Provenance',
  'Skills',
  'Extensions',
  'Benchmarks',
  'Paracosm',
  'Wunderland',
];

function entry(config) {
  return config;
}

function agentosDoc(sourcePath, dest, title, section, position, extra = {}) {
  return entry({
    sourceType: 'canonical-guide',
    sourcePath: `packages/agentos/docs/${sourcePath}`,
    dest,
    title,
    section,
    position,
    ...extra,
  });
}

function extensionDoc(sourcePath, dest, title, position, extra = {}) {
  return entry({
    sourceType: 'extension-guide',
    sourcePath: `packages/agentos-extensions/${sourcePath}`,
    dest,
    title,
    section: 'Extensions',
    position,
    ...extra,
  });
}

function builtInExtension(dir, dest, title, position, extra = {}) {
  const sourceType = extra.allowMissingSource ? 'generated-stub' : 'built-in-extension';
  return entry({
    sourceType,
    sourcePath: `packages/agentos-extensions/registry/curated/${dir}/README.md`,
    dest,
    title,
    section: 'Extensions',
    position,
    group: extra.group ?? 'Official Extensions',
    ...extra,
  });
}

function extraDoc(sourcePath, dest, title, section, position, extra = {}) {
  return entry({
    sourceType: 'repo-doc',
    sourcePath,
    dest,
    title,
    section,
    position,
    ...extra,
  });
}

function siteDoc(sourcePath, dest, title, section, position, extra = {}) {
  return entry({
    sourceType: 'live-doc',
    sourcePath: `apps/agentos-live-docs/docs/${sourcePath}`,
    dest,
    title,
    section,
    position,
    ...extra,
  });
}

function staticDoc(sourcePath, dest, title, section, position, extra = {}) {
  return entry({
    sourceType: 'static-doc',
    sourcePath: `apps/agentos-live-docs/static-docs/${sourcePath}`,
    dest,
    title,
    section,
    position,
    ...extra,
  });
}

const publicationManifest = [
  agentosDoc('README.md', 'getting-started/documentation-index.md', 'Documentation Index', 'Getting Started', 1, {
    sidebar: false,
  }),
  agentosDoc('GETTING_STARTED.md', 'getting-started/index.md', 'Getting Started Guide', 'Getting Started', 2, {
    categoryIndex: true,
  }),
  agentosDoc('HIGH_LEVEL_API.md', 'getting-started/high-level-api.md', 'High-Level API', 'Getting Started', 3),
  agentosDoc('EXAMPLES.md', 'getting-started/examples.md', 'Examples Cookbook', 'Getting Started', 4),
  agentosDoc('ECOSYSTEM.md', 'getting-started/ecosystem.md', 'Ecosystem', 'Getting Started', 5),
  agentosDoc('RELEASING.md', 'getting-started/releasing.md', 'Releasing', 'Getting Started', 6),

  siteDoc('benchmarks/index.md', 'benchmarks/index.md', 'Memory Benchmarks', 'Benchmarks', 1, {
    categoryIndex: true,
  }),

  agentosDoc('ARCHITECTURE.md', 'architecture/system-architecture.md', 'System Architecture', 'Concepts', 1),
  agentosDoc('GMI.md', 'architecture/gmi.md', 'Generalized Mind Instances (GMIs)', 'Concepts', 1.5),
  agentosDoc('PLATFORM_SUPPORT.md', 'architecture/platform-support.md', 'Platform Support', 'Concepts', 2),
  extraDoc('docs/architecture/runtime-status-matrix.md', 'architecture/runtime-status-matrix.md', 'Runtime Status Matrix', 'Architecture', 3),
  extraDoc('docs/architecture/sandbox-security.md', 'architecture/sandbox-security.md', 'Sandbox Security', 'Guardrails & Safety', 4),
  extraDoc('docs/architecture/cli-subprocess.md', 'architecture/cli-subprocess.md', 'CLI Subprocess Bridge', 'Architecture', 5, {
    sidebar: false,
  }),
  extraDoc('docs/architecture/tool-permissions.md', 'architecture/tool-permissions.md', 'Tool Permissions & Security Tiers', 'Tools & Capabilities', 6),
  siteDoc('architecture/skills-vs-tools-vs-extensions.md', 'architecture/skills-vs-tools-vs-extensions.md', 'Skills vs Tools vs Extensions', 'Architecture', 8.5),
  agentosDoc('OBSERVABILITY.md', 'architecture/observability.md', 'Observability (OpenTelemetry)', 'Architecture', 9),
  agentosDoc('LOGGING.md', 'architecture/logging.md', 'Logging (Pino + OpenTelemetry)', 'Architecture', 10),
  agentosDoc('TOOL_CALLING_AND_LOADING.md', 'architecture/tool-calling-and-loading.md', 'Tool Calling & Lazy Loading', 'Tools & Capabilities', 11),
  agentosDoc('LLM_PROVIDERS.md', 'architecture/llm-providers.md', 'LLM Providers', 'Architecture', 12),
  agentosDoc('STREAMING_SEMANTICS.md', 'architecture/streaming-semantics.md', 'Streaming Semantics', 'Architecture', 13),
  agentosDoc('OAUTH_AUTH.md', 'architecture/oauth-auth.md', 'OAuth Auth', 'Architecture', 14),
  extraDoc('docs/BACKEND_API.md', 'architecture/backend-api.md', 'Backend API', 'Architecture', 16, {
    sidebar: false,
  }),
  extraDoc('apps/wunderland-sol/docs-site/docs/guides/http-streaming-api.md', 'architecture/http-streaming-api.md', 'HTTP Streaming API', 'Architecture', 18, {
    sidebar: false,
  }),
  extraDoc('apps/wunderland-sol/docs-site/docs/guides/chat-server.md', 'architecture/chat-server.md', 'Chat Server (HTTP API)', 'Architecture', 19, {
    sidebar: false,
  }),
  extraDoc('apps/wunderland-sol/docs-site/docs/guides/tools.md', 'architecture/tools.md', 'Tools', 'Architecture', 20, {
    sidebar: false,
  }),

  agentosDoc('ORCHESTRATION.md', 'features/orchestration-guide.md', 'Orchestration Guide', 'Orchestration', 1, {
    sidebar: false,
  }),
  agentosDoc('UNIFIED_ORCHESTRATION.md', 'features/unified-orchestration.md', 'Unified Orchestration Layer', 'Orchestration', 2),
  agentosDoc('MISSION_API.md', 'features/mission-api.md', 'mission() API', 'Orchestration', 3),
  agentosDoc('WORKFLOW_DSL.md', 'features/workflow-dsl.md', 'workflow() DSL', 'Orchestration', 4),
  agentosDoc('AGENT_GRAPH.md', 'features/agent-graph.md', 'AgentGraph', 'Orchestration', 5),
  agentosDoc('CHECKPOINTING.md', 'features/checkpointing.md', 'Checkpointing and Time-Travel', 'Orchestration', 6),
  agentosDoc('PLANNING_ENGINE.md', 'features/planning-engine.md', 'Planning Engine', 'Orchestration', 7),
  agentosDoc('COGNITIVE_PIPELINE.md', 'features/cognitive-pipeline.md', 'Cognitive Pipeline (Smart Per-Message Orchestration)', 'Cognitive Pipeline', 9),

  // Overview (start here)
  agentosDoc('MEMORY_SYSTEM_OVERVIEW.md', 'features/memory-system-overview.md', 'Memory System Overview', 'Memory', 1),

  // Cognitive deep-dive
  agentosDoc('COGNITIVE_MEMORY.md', 'features/cognitive-memory.md', 'Cognitive Memory', 'Memory', 3),
  agentosDoc('HEXACO_PERSONALITY.md', 'features/hexaco-personality.md', 'HEXACO Personality', 'Personas', 4),
  agentosDoc('SOUL_FILES.md', 'features/soul-files.md', 'Soul Files (per-agent identity in markdown)', 'Personas', 5),
  agentosDoc('WORKING_MEMORY.md', 'features/working-memory.md', 'Working Memory', 'Memory', 6),

  // How to use it — consolidated page (auto-ingest + agent tools + import/export)
  agentosDoc('MEMORY_OPERATIONS.md', 'features/memory-operations.md', 'Memory Operations', 'Memory', 8),

  // Scale & storage (consolidated SQL adapter quickstart + 4-tier scaling path)
  agentosDoc('SQL_STORAGE_QUICKSTART.md', 'features/sql-storage.md', 'Storage & Scaling', 'Memory', 12),
  // Hidden backend reference pages (linked from Scaling, not in nav)
  agentosDoc('CLIENT_SIDE_STORAGE.md', 'features/client-side-storage.md', 'Client-Side Storage', 'Memory', 13, {
    sidebar: false,
  }),
  agentosDoc('MEMORY_STORAGE.md', 'features/memory-storage.md', 'SQLite Brain Storage', 'Memory', 14, {
    sidebar: false,
  }),
  agentosDoc('POSTGRES_BACKEND.md', 'features/postgres-backend.md', 'Postgres + pgvector Backend', 'Memory', 15, {
    sidebar: false,
  }),
  agentosDoc('QDRANT_BACKEND.md', 'features/qdrant-backend.md', 'Qdrant Backend', 'Memory', 16, {
    sidebar: false,
  }),
  agentosDoc('PINECONE_BACKEND.md', 'features/pinecone-backend.md', 'Pinecone Backend', 'Memory', 17, {
    sidebar: false,
  }),
  extraDoc('packages/sql-storage-adapter/PLATFORM_STRATEGY.md', 'features/platform-strategy.md', 'Platform Strategy', 'Memory', 18, {
    sidebar: false,
  }),

  agentosDoc('RAG_MEMORY_CONFIGURATION.md', 'features/rag-memory.md', 'RAG Memory Configuration', 'RAG & Retrieval', 1),
  agentosDoc('HYDE_RETRIEVAL.md', 'features/hyde-retrieval.md', 'HyDE Retrieval', 'RAG & Retrieval', 2),
  agentosDoc('QUERY_ROUTER.md', 'features/query-routing.md', 'Query Router', 'Cognitive Pipeline', 4),
  agentosDoc('MEMORY_ROUTER.md', 'features/memory-router.md', 'Memory Router (Recall-Stage Smart Orchestration)', 'Cognitive Pipeline', 4.1),
  agentosDoc('INGEST_ROUTER.md', 'features/ingest-router.md', 'Ingest Router (Input-Stage Smart Orchestration)', 'Cognitive Pipeline', 4.2),
  agentosDoc('READ_ROUTER.md', 'features/read-router.md', 'Read Stage Routing (Read Strategy + Reader Model Dispatch)', 'Cognitive Pipeline', 4.3),
  agentosDoc('ADAPTIVE_MEMORY_ROUTER.md', 'features/adaptive-memory-router.md', 'Adaptive Memory Router (Self-Calibrating)', 'Cognitive Pipeline', 4.4),
  siteDoc('features/citation-verification.md', 'features/citation-verification.md', 'Citation Verification', 'RAG & Retrieval', 4.5),
  agentosDoc('MULTIMODAL_RAG.md', 'features/multimodal-rag.md', 'Multimodal RAG (Image + Audio)', 'RAG & Retrieval', 5),
  agentosDoc('MEMORY_DOCUMENT_INGESTION.md', 'features/memory-document-ingestion.md', 'Document Ingestion', 'RAG & Retrieval', 6),

  agentosDoc('GUARDRAILS_USAGE.md', 'features/guardrails.md', 'Guardrails', 'Guardrails & Safety', 1),
  staticDoc('features/guardrails-architecture.md', 'features/guardrails-architecture.md', 'Guardrails Architecture', 'Guardrails & Safety', 1.5),
  agentosDoc('HUMAN_IN_THE_LOOP.md', 'features/human-in-the-loop.md', 'Human-in-the-Loop (HITL)', 'Guardrails & Safety', 1.8),
  agentosDoc('CREATING_GUARDRAILS.md', 'features/creating-guardrails.md', 'Creating Custom Guardrails', 'Guardrails & Safety', 2),
  agentosDoc('SAFETY_PRIMITIVES.md', 'features/safety-primitives.md', 'Safety Primitives', 'Guardrails & Safety', 3),

  agentosDoc('VOICE_PIPELINE.md', 'features/voice-pipeline.md', 'Voice Pipeline', 'Voice & Speech', 1),
  agentosDoc('SPEECH_PROVIDERS.md', 'features/speech-providers.md', 'Speech Providers', 'Voice & Speech', 2),
  agentosDoc('TELEPHONY_PROVIDERS.md', 'features/telephony-providers.md', 'Telephony Providers', 'Voice & Speech', 3),

  agentosDoc('IMAGE_GENERATION.md', 'features/image-generation.md', 'Image Generation', 'Media Generation', 1),
  agentosDoc('IMAGE_EDITING.md', 'features/image-editing.md', 'Image Editing (Img2Img, Inpainting, Upscaling)', 'Media Generation', 2),
  agentosDoc('CHARACTER_CONSISTENCY.md', 'features/character-consistency.md', 'Character Consistency', 'Media Generation', 2.5),
  agentosDoc('STYLE_TRANSFER.md', 'features/style-transfer.md', 'Style Transfer', 'Media Generation', 2.6),
  agentosDoc('VISION_PIPELINE.md', 'features/vision-pipeline.md', 'Vision Pipeline (OCR & Image Understanding)', 'Media Generation', 3),
  staticDoc('features/audio-generation.md', 'features/audio-generation.md', 'Audio Generation', 'Media Generation', 4),
  staticDoc('features/provider-preferences.md', 'features/provider-preferences.md', 'Provider Preferences', 'Media Generation', 5),
  staticDoc('features/video-pipeline.md', 'features/video-pipeline.md', 'Video Pipeline', 'Media Generation', 6),

  agentosDoc('CHANNELS.md', 'features/channels.md', 'Channels', 'Channels & Social', 1),
  agentosDoc('SOCIAL_POSTING.md', 'features/social-posting.md', 'Social Posting', 'Channels & Social', 2),
  extraDoc('apps/wunderland-sol/docs-site/docs/guides/browser-automation.md', 'features/browser-automation.md', 'Browser Automation', 'Channels & Social', 3),

  agentosDoc('STRUCTURED_OUTPUT.md', 'features/structured-output.md', 'Structured Output', 'Tools & Capabilities', 1),
  siteDoc('features/llm-output-validation.md', 'features/llm-output-validation.md', 'LLM Output Validation', 'Model Quality & Cost', 1.5),
  agentosDoc('EVALUATION.md', 'features/evaluation-guide.md', 'Evaluation Guide', 'Model Quality & Cost', 2),
  agentosDoc('COST_OPTIMIZATION.md', 'features/cost-optimization.md', 'Cost Optimization', 'Model Quality & Cost', 3),
  agentosDoc('UNCENSORED_CONTENT.md', 'features/uncensored-content.md', 'Uncensored Content & Policy-Tier Routing', 'Model Quality & Cost', 3.5),
  agentosDoc('EVALUATION_FRAMEWORK.md', 'features/evaluation-framework.md', 'Evaluation Framework', 'Model Quality & Cost', 4, {
    sidebar: false,
  }),
  agentosDoc('STRUCTURED_OUTPUT_API.md', 'features/structured-output-api.md', 'Structured Output API (generateObject / streamObject)', 'Tools & Capabilities', 5, {
    sidebar: false,
  }),

  agentosDoc('CAPABILITY_DISCOVERY.md', 'features/capability-discovery.md', 'Capability Discovery', 'Tools & Capabilities', 1),
  agentosDoc('EMERGENT_CAPABILITIES.md', 'features/emergent-capabilities.md', 'Emergent Capabilities', 'Tools & Capabilities', 2),
  agentosDoc('PARACOSM.md', 'features/paracosm.md', 'Paracosm — Agent Swarm Simulation for Structured World Modeling with LLMs', 'Paracosm', 1),
  extensionDoc('AGENCY_COLLABORATION_EXAMPLE.md', 'features/agency-collaboration.md', 'Agency Collaboration', 3, {
    section: 'Orchestration',
  }),
  agentosDoc('AGENT_COMMUNICATION.md', 'features/agent-communication.md', 'Agent Communication', 'Orchestration', 4),
  agentosDoc('RECURSIVE_SELF_BUILDING_AGENTS.md', 'features/recursive-self-building.md', 'Recursive Self-Building Agents', 'Tools & Capabilities', 5),
  agentosDoc('MEMORY_CONSOLIDATION.md', 'features/memory-consolidation.md', 'Self-Improving Memory', 'Memory', 6, {
    sidebar: false,
  }),
  staticDoc('features/self-improving-agents.md', 'features/self-improving-agents.md', 'Self-Improving Agents', 'Tools & Capabilities', 6.5),
  agentosDoc('PROVENANCE_IMMUTABILITY.md', 'features/provenance-immutability.md', 'Provenance & Immutability', 'Provenance', 7),
  agentosDoc('IMMUTABLE_AGENTS.md', 'features/immutable-agents.md', 'Immutable Agents', 'Provenance', 8),
  agentosDoc('AGENT_CONFIG_EXPORT.md', 'features/agent-config-export.md', 'Agent Config Export & Import', 'Tools & Capabilities', 9),
  agentosDoc('DISCOVERY.md', 'features/discovery-guide.md', 'Capability Discovery Guide', 'Tools & Capabilities', 10, {
    sidebar: false,
  }),
  agentosDoc('PROVENANCE.md', 'features/provenance-guide.md', 'Provenance Guide', 'Provenance', 11, {
    sidebar: false,
  }),
  agentosDoc('AGENCY_API.md', 'features/agency-api.md', 'Multi-Agent Agency API', 'Orchestration', 12, {
    sidebar: false,
  }),
  agentosDoc('CLI_PROVIDERS.md', 'features/cli-providers.md', 'CLI Providers', 'Model Quality & Cost', 13, {
    sidebar: false,
  }),
  staticDoc('features/github-integration.md', 'features/github-integration.md', 'GitHub Integration', 'Channels & Social', 13.5),
  staticDoc('features/document-export.md', 'features/document-export.md', 'Document Export', 'Extensions', 13.6),

  entry({
    sourceType: 'canonical-guide',
    sourcePath: 'packages/agentos/docs/SKILLS_OVERVIEW.md',
    dest: 'skills/index.md',
    title: 'Skills Overview',
    section: 'Skills',
    position: 1,
    categoryIndex: true,
  }),
  entry({
    sourceType: 'canonical-guide',
    sourcePath: 'packages/agentos/docs/extensions/SKILLS.md',
    dest: 'skills/skill-format.md',
    title: 'Skills (SKILL.md)',
    section: 'Skills',
    position: 2,
  }),
  entry({
    sourceType: 'package-readme',
    sourcePath: 'packages/agentos-skills/README.md',
    dest: 'skills/agentos-skills.md',
    title: '@framers/agentos-skills',
    section: 'Skills',
    position: 3,
  }),
  entry({
    sourceType: 'package-readme',
    sourcePath: 'packages/agentos-skills-registry/README.md',
    dest: 'skills/agentos-skills-registry.md',
    title: '@framers/agentos-skills-registry',
    section: 'Skills',
    position: 4,
  }),

  extensionDoc('README.md', 'extensions/index.md', 'Extensions Overview', 1, {
    categoryIndex: true,
  }),
  extensionDoc('HOW_EXTENSIONS_WORK.md', 'extensions/how-extensions-work.md', 'How Extensions Work', 2),
  extensionDoc('EXTENSION_ARCHITECTURE.md', 'extensions/extension-architecture.md', 'Extension Architecture', 3),
  extensionDoc('AUTO_LOADING_EXTENSIONS.md', 'extensions/auto-loading.md', 'Auto-Loading Extensions', 4),
  agentosDoc('RFC_EXTENSION_STANDARDS.md', 'extensions/extension-standards.md', 'Extension Standards (RFC)', 'Extensions', 5),
  extensionDoc('CONTRIBUTING.md', 'extensions/contributing.md', 'Contributing', 6),
  extensionDoc('SELF_HOSTED_REGISTRIES.md', 'extensions/self-hosted-registries.md', 'Self-Hosted Registries', 7),
  extensionDoc('MIGRATION_GUIDE.md', 'extensions/migration-guide.md', 'Migration Guide', 8),
  extensionDoc('RELEASING.md', 'extensions/releasing.md', 'Releasing', 9),

  builtInExtension('research/web-search', 'extensions/built-in/web-search.md', 'Web Search', 1),
  builtInExtension('research/web-browser', 'extensions/built-in/web-browser.md', 'Web Browser', 2),
  builtInExtension('research/news-search', 'extensions/built-in/news-search.md', 'News Search', 3),
  builtInExtension('system/cli-executor', 'extensions/built-in/cli-executor.md', 'CLI Executor', 4),
  agentosDoc('features/CLI_REGISTRY.md', 'extensions/built-in/cli-registry.md', 'CLI Registry', 'Extensions', 5, {
    group: 'Official Extensions',
  }),
  builtInExtension('auth', 'extensions/built-in/auth.md', 'Auth', 6),
  builtInExtension('media/giphy', 'extensions/built-in/giphy.md', 'Giphy', 7),
  builtInExtension('media/image-search', 'extensions/built-in/image-search.md', 'Image Search', 8),
  builtInExtension('media/voice-synthesis', 'extensions/built-in/voice-synthesis.md', 'Voice Synthesis', 9),
  builtInExtension('integrations/telegram', 'extensions/built-in/telegram.md', 'Telegram', 10),
  builtInExtension('communications/telegram-bot', 'extensions/built-in/telegram-bot.md', 'Telegram Bot (Comms)', 11),
  builtInExtension('channels/discord', 'extensions/built-in/channel-discord.md', 'Channel: Discord', 12),
  builtInExtension('channels/slack', 'extensions/built-in/channel-slack.md', 'Channel: Slack', 13),
  builtInExtension('channels/telegram', 'extensions/built-in/channel-telegram.md', 'Channel: Telegram', 14),
  builtInExtension('channels/whatsapp', 'extensions/built-in/channel-whatsapp.md', 'Channel: WhatsApp', 15),
  builtInExtension('channels/webchat', 'extensions/built-in/channel-webchat.md', 'Channel: WebChat', 16),
  builtInExtension('research/citation-verifier', 'extensions/built-in/citation-verifier.md', 'Citation Verifier', 16.1),
  builtInExtension('tools/local-file-search', 'extensions/built-in/local-file-search.md', 'Local File Search', 16.2),
  builtInExtension('tools/send-file-to-channel', 'extensions/built-in/send-file-to-channel.md', 'Send File to Channel', 16.3),
  builtInExtension('research/trulia-search', 'extensions/built-in/trulia-search.md', 'Trulia Search', 16.4),
  builtInExtension('tools/zip-files', 'extensions/built-in/zip-files.md', 'Zip Files', 16.5),
  builtInExtension('security/pii-redaction', 'extensions/built-in/pii-redaction.md', 'PII Redaction', 17, {
    allowMissingSource: true,
    group: 'Guardrail Extensions',
  }),
  staticDoc('extensions/built-in/ml-classifiers.md', 'extensions/built-in/ml-classifiers.md', 'ML Content Classifiers', 'Extensions', 17.1, {
    group: 'Guardrail Extensions',
  }),
  staticDoc('extensions/built-in/topicality.md', 'extensions/built-in/topicality.md', 'Topicality', 'Extensions', 17.2, {
    group: 'Guardrail Extensions',
  }),
  staticDoc('extensions/built-in/code-safety.md', 'extensions/built-in/code-safety.md', 'Code Safety', 'Extensions', 17.3, {
    group: 'Guardrail Extensions',
  }),
  staticDoc('extensions/built-in/grounding-guard.md', 'extensions/built-in/grounding-guard.md', 'Grounding Guard', 'Extensions', 17.4, {
    group: 'Guardrail Extensions',
  }),
  builtInExtension('safety/content-policy-rewriter', 'extensions/built-in/content-policy-rewriter.md', 'Content Policy Rewriter', 17.5, {
    group: 'Guardrail Extensions',
  }),
  builtInExtension('provenance/anchor-providers', 'extensions/built-in/anchor-providers.md', 'Anchor Providers', 18, {
    group: 'Provenance Extensions',
  }),
  extraDoc('packages/agentos/CHANGELOG.md', 'getting-started/changelog.md', 'Changelog', 'Getting Started', 7),

  siteDoc('wunderland/index.md', 'wunderland/index.md', 'Wunderland — Getting Started', 'Wunderland', 1, {
    categoryIndex: true,
  }),
];

function resolvePublicationSourcePath(monoRoot, entryConfig) {
  const sourcePath = entryConfig.sourcePath;
  if (!sourcePath) return null;

  const absolutePath = resolve(monoRoot, sourcePath);
  if (existsSync(absolutePath)) return absolutePath;

  const fileName = basename(absolutePath);
  const searchRoot = dirname(absolutePath);
  if (existsSync(searchRoot)) {
    for (const subdir of DOC_SEARCH_SUBDIRS) {
      const candidate = resolve(searchRoot, subdir, fileName);
      if (existsSync(candidate)) return candidate;
    }
  }

  const vendoredPath = resolve(
    monoRoot,
    'apps/agentos-live-docs/vendored-docs',
    sourcePath,
  );
  if (existsSync(vendoredPath)) return vendoredPath;

  return null;
}

function buildPublicationInventory(monoRoot) {
  const seen = new Map();
  const duplicates = [];
  const missingSources = [];
  const stubbedDestinations = [];

  for (const manifestEntry of publicationManifest) {
    if (seen.has(manifestEntry.dest) && !duplicates.includes(manifestEntry.dest)) {
      duplicates.push(manifestEntry.dest);
    }
    seen.set(manifestEntry.dest, manifestEntry);

    const resolvedSource = resolvePublicationSourcePath(monoRoot, manifestEntry);
    if (resolvedSource) continue;

    if (manifestEntry.allowMissingSource || manifestEntry.sourceType === 'generated-stub') {
      stubbedDestinations.push(manifestEntry.dest);
      continue;
    }

    missingSources.push(manifestEntry.sourcePath);
  }

  return {
    duplicates: duplicates.sort(),
    missingSources: missingSources.sort(),
    generatedDestinations: publicationManifest.map((item) => item.dest).sort(),
    stubbedDestinations: stubbedDestinations.sort(),
  };
}

function docIdFromDest(dest) {
  return dest.replace(/\.md$/, '');
}

function publicRouteFromDest(dest) {
  return `/${docIdFromDest(dest).replace(/\/index$/, '')}`;
}

function buildFilenameRewriteMap() {
  const rewrites = {};

  for (const manifestEntry of publicationManifest) {
    if (!manifestEntry.sourcePath?.endsWith('.md')) continue;
    const fileName = basename(manifestEntry.sourcePath);
    if (rewrites[fileName]) continue;
    rewrites[fileName] = publicRouteFromDest(manifestEntry.dest);
  }

  return rewrites;
}

function buildGuideSidebar() {
  const sectionEntries = new Map();

  for (const manifestEntry of publicationManifest) {
    if (manifestEntry.sidebar === false) continue;
    if (!sectionEntries.has(manifestEntry.section)) {
      sectionEntries.set(manifestEntry.section, []);
    }
    sectionEntries.get(manifestEntry.section).push(manifestEntry);
  }

  return SECTION_ORDER
    .filter((section) => sectionEntries.has(section))
    .map((section) => {
      const entries = sectionEntries
        .get(section)
        .slice()
        .sort((left, right) => left.position - right.position);
      const categoryIndex = entries.find((item) => item.categoryIndex);
      const directItems = entries
        .filter((item) => !item.categoryIndex && !item.group)
        .map((item) => docIdFromDest(item.dest));
      const groupedItems = Array.from(
        entries
          .filter((item) => item.group)
          .reduce((groups, item) => {
            if (!groups.has(item.group)) groups.set(item.group, []);
            groups.get(item.group).push(item);
            return groups;
          }, new Map()),
      ).map(([group, items]) => ({
        type: 'category',
        label: group,
        collapsed: false,
        items: items
          .slice()
          .sort((left, right) => left.position - right.position)
          .map((item) => docIdFromDest(item.dest)),
      }));

      const category = {
        type: 'category',
        label: section,
        collapsed: section === 'Getting Started' ? false : undefined,
        items: directItems.concat(groupedItems),
      };

      if (categoryIndex) {
        category.link = { type: 'doc', id: docIdFromDest(categoryIndex.dest) };
      } else {
        // Fall back to a generated section index so the breadcrumb for
        // pages inside this category is a clickable landing page rather
        // than inert text.
        category.link = {
          type: 'generated-index',
          slug: `/category/${section
            .toLowerCase()
            .replace(/&/g, 'and')
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/(^-|-$)/g, '')}`,
          title: section,
          description: `All ${section} pages in the AgentOS documentation.`,
        };
      }

      return category;
    });
}

module.exports = {
  publicationManifest,
  buildPublicationInventory,
  buildGuideSidebar,
  buildFilenameRewriteMap,
  resolvePublicationSourcePath,
};
