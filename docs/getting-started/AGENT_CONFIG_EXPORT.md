# Agent Config Export & Import

> Round-trip agent configurations between environments via the
> programmatic API — secret redaction and schema validation included.

> **CLI coming soon.** A first-party `agentos` command-line wrapper for
> these APIs is planned alongside the [Wunderland](https://wunderland.sh)
> control plane. Until it ships, every operation below is available as a
> TypeScript import from `@framers/agentos`.

---

## Table of Contents

1. [Overview](#overview)
2. [Quick Start](#quick-start)
3. [Programmatic API](#programmatic-api)
4. [Export Formats](#export-formats)
5. [Secret Redaction](#secret-redaction)
6. [Schema Validation](#schema-validation)
7. [Round-Trip Workflow](#round-trip-workflow)
8. [Portable Agent Bundles](#portable-agent-bundles)
9. [Examples](#examples)
10. [Related Documentation](#related-documentation)

---

## Overview

Agent configurations contain everything needed to reproduce an agent:
personality, security tier, LLM provider settings, skills, channels,
extensions, and tool permissions. The export/import system lets you:

- **Share** agent configurations between team members
- **Version** agent configs in Git alongside application code
- **Migrate** agents between environments (dev/staging/prod)
- **Backup** and restore agent state
- **Template** new agents from proven configurations

Secrets (API keys, tokens) are automatically redacted on export and must be
re-supplied on import.

---

## Quick Start

### Export an Agent

```typescript
import { exportAgentConfig } from '@framers/agentos';
import { writeFileSync } from 'node:fs';

const exported = await exportAgentConfig({
  configDir: '~/.agentos',   // Config directory to read
  format: 'yaml',            // 'yaml' | 'json' (yaml is default)
  redactSecrets: true,       // Replace secrets with <<REDACTED>> placeholders
});

writeFileSync('./my-agent.yaml', exported.content);
```

### Import an Agent

```typescript
import { importAgent } from '@framers/agentos';

await importAgent({
  source: './my-agent.yaml',     // File path or string content
  targetDir: '~/.agentos',       // Where to write the config
  secrets: {                     // Re-supply redacted secrets
    OPENAI_API_KEY: process.env.OPENAI_API_KEY!,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY!,
  },
});
```

---

## Programmatic API

### exportAgentConfig()

```typescript
import { exportAgentConfig } from '@framers/agentos';

const exported = await exportAgentConfig({
  configDir: '~/.agentos',        // Config directory to read
  format: 'yaml',                     // 'yaml' | 'json'
  includeSkills: false,               // Include resolved SKILL.md content
  includeWorkflows: false,            // Include workflow definitions
  redactSecrets: true,                // Replace secrets with placeholders
});

console.log(exported.content);        // YAML/JSON string
console.log(exported.format);         // 'yaml'
console.log(exported.redactedKeys);   // ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', ...]
console.log(exported.warnings);       // Any validation warnings
```

### importAgent()

```typescript
import { importAgent } from '@framers/agentos';

const result = await importAgent({
  source: './my-agent.yaml',           // File path or string content
  targetDir: '~/.agentos',          // Where to write the config
  merge: false,                         // Replace (false) or merge (true)
  secrets: {                            // Supply redacted secrets
    OPENAI_API_KEY: 'sk-...',
    ANTHROPIC_API_KEY: 'sk-ant-...',
  },
});

console.log(result.configDir);         // Resolved target directory
console.log(result.changes);           // List of files written
console.log(result.warnings);          // Any import warnings
```

### agent.export() / agent.exportJSON()

Export from an instantiated agent. The factory is the lowercase [`agent`](https://github.com/framerslab/agentos/blob/master/src/api/agent.ts)
export (synchronous):

```typescript
import { agent } from '@framers/agentos';

const myAgent = agent({ /* AgentOptions */ });

// Export as YAML string
const yaml = await myAgent.export();

// Export as parsed JSON object
const json = await myAgent.exportJSON();
console.log(json.personality);          // { hexaco: { ... } }
console.log(json.llmProvider);          // "openai"
console.log(json.skills);               // ["research-assistant", "web-search"]
```

---

## Export Formats

### YAML Format (Default)

```yaml
# AgentOS Agent Configuration Export
# Exported: 2026-03-26T12:00:00Z
# Version: 1.0.0

meta:
  exportVersion: "1.0.0"
  agentosVersion: "0.48.0"
  exportedAt: "2026-03-26T12:00:00Z"

agent:
  name: "Research Assistant"
  description: "A research-focused agent with web search and deep analysis"

personality:
  hexaco:
    honestyHumility: 0.85
    emotionality: 0.40
    extraversion: 0.60
    agreeableness: 0.75
    conscientiousness: 0.90
    opennessToExperience: 0.95

llm:
  provider: "anthropic"
  model: "claude-sonnet-4-5-20250929"
  fallback:
    - "openrouter"

security:
  tier: "balanced"
  executionMode: "deny-side-effects"
  approvedTools:
    - "web-search"
    - "web-browser"
    - "news-search"

skills:
  - "research-assistant"
  - "deep-research"
  - "web-search"

channels:
  - platform: "webchat"
    enabled: true
  - platform: "slack"
    enabled: true

extensions:
  - "web-search"
  - "web-browser"
  - "news-search"

memory:
  type: "cognitive"
  ragEnabled: true
  vectorStore: "hnsw"

secrets:
  ANTHROPIC_API_KEY: "<<REDACTED>>"
  OPENROUTER_API_KEY: "<<REDACTED>>"
  DEEPGRAM_API_KEY: "<<REDACTED>>"
```

### JSON Format

```json
{
  "meta": {
    "exportVersion": "1.0.0",
    "agentosVersion": "0.48.0",
    "exportedAt": "2026-03-26T12:00:00Z"
  },
  "agent": {
    "name": "Research Assistant",
    "description": "A research-focused agent with web search and deep analysis"
  },
  "personality": {
    "hexaco": {
      "honestyHumility": 0.85,
      "emotionality": 0.40,
      "extraversion": 0.60,
      "agreeableness": 0.75,
      "conscientiousness": 0.90,
      "opennessToExperience": 0.95
    }
  },
  "llm": {
    "provider": "anthropic",
    "model": "claude-sonnet-4-5-20250929",
    "fallback": ["openrouter"]
  },
  "security": {
    "tier": "balanced",
    "executionMode": "deny-side-effects",
    "approvedTools": ["web-search", "web-browser", "news-search"]
  },
  "skills": ["research-assistant", "deep-research", "web-search"],
  "channels": [
    { "platform": "webchat", "enabled": true },
    { "platform": "slack", "enabled": true }
  ],
  "extensions": ["web-search", "web-browser", "news-search"],
  "memory": {
    "type": "cognitive",
    "ragEnabled": true,
    "vectorStore": "hnsw"
  },
  "secrets": {
    "ANTHROPIC_API_KEY": "<<REDACTED>>",
    "OPENROUTER_API_KEY": "<<REDACTED>>",
    "DEEPGRAM_API_KEY": "<<REDACTED>>"
  }
}
```

---

## Secret Redaction

By default, all known secret patterns are replaced with `<<REDACTED>>` on
export. The list of redacted keys includes:

| Pattern | Examples |
|---------|---------|
| `*_API_KEY` | `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `STABILITY_API_KEY` |
| `*_API_TOKEN` | `REPLICATE_API_TOKEN`, `TELEGRAM_BOT_TOKEN` |
| `*_SECRET` | `SLACK_OAUTH_CLIENT_SECRET`, `APP_INTERNAL_API_SECRET` |
| `*_AUTH_TOKEN` | `TWILIO_AUTH_TOKEN`, `APP_AUTH_TOKEN` |
| `*_PASSWORD` | Database passwords, SMTP passwords |
| `*_PRIVATE_KEY` | Solana private keys, SSH keys |

### Exporting Without Redaction

Pass `redactSecrets: false` for trusted environments (e.g. an encrypted
backup pipeline). The output will contain raw API keys — handle the
return value as a secret.

```typescript
const exported = await exportAgentConfig({
  configDir: '~/.agentos',
  format: 'yaml',
  redactSecrets: false,   // WARNING: raw API keys in exported.content
});
```

### Supplying Secrets on Import

```typescript
// Supply secrets programmatically (typical CI / server case)
await importAgent({
  source: './my-agent.yaml',
  secrets: {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY!,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY!,
  },
});

// Or read from a `.env` file before importing
import 'dotenv/config';
await importAgent({
  source: './my-agent.yaml',
  secrets: Object.fromEntries(
    Object.entries(process.env).filter(([k]) => k.endsWith('_API_KEY')),
  ),
});
```

---

## Schema Validation

Exported configurations are validated against a JSON Schema on both export
and import:

```typescript
import { validateAgentExport } from '@framers/agentos';
import { readFileSync } from 'node:fs';
import yaml from 'yaml';

const config = yaml.parse(readFileSync('./my-agent.yaml', 'utf8'));
const result = validateAgentExport(config);

if (result.valid) {
  console.log('Config is valid');
} else {
  for (const error of result.errors) {
    console.error(`${error.path}: ${error.message}`);
  }
}
```

A successful validation surfaces the same shape the importer would log:

```
✓ Schema version: 1.0.0
✓ Required fields: present
✓ LLM provider: valid (anthropic)
✓ Security tier: valid (balanced)
✓ Skills: 3 referenced, all resolvable
⚠ Secrets: 3 redacted keys (supply on import)
```

---

## Round-Trip Workflow

A typical workflow for migrating an agent between environments — the
script lives wherever your deployment automation already runs (CI job,
deploy step, post-merge hook):

```typescript
// 1. Export from development (run once locally or in CI)
import { exportAgentConfig } from '@framers/agentos';
import { writeFileSync } from 'node:fs';

const exported = await exportAgentConfig({
  configDir: '~/.agentos/dev-agent',
  format: 'yaml',
});
writeFileSync('./agent-config.yaml', exported.content);
```

```bash
# 2. Commit to version control
git add agent-config.yaml
git commit -m "Export research-assistant config"
git push
```

```typescript
// 3. Import on the production server (run from your deploy script)
import { importAgent } from '@framers/agentos';

await importAgent({
  source: './agent-config.yaml',
  targetDir: '/opt/agents/research-bot',
  secrets: {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY!,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY!,
  },
});
```

### Team Sharing

```typescript
// Developer A: export with skills bundled in, then commit team-agent.yaml
const exported = await exportAgentConfig({
  configDir: '~/.agentos/team-agent',
  format: 'yaml',
  includeSkills: true,
});
writeFileSync('./team-agent.yaml', exported.content);

// Developer B: merge into local config, supplying their own secrets
await importAgent({
  source: './team-agent.yaml',
  targetDir: '~/.agentos',
  merge: true,                          // Preserve local overrides
  secrets: { /* developer B's keys */ },
});
```

---

## Portable Agent Bundles

For sharing agents with all dependencies (skills, workflows, custom tools),
pass `format: 'bundle'` to produce a single `.tar.gz`:

```typescript
import { exportAgentConfig } from '@framers/agentos';
import { writeFileSync } from 'node:fs';

const exported = await exportAgentConfig({
  configDir: '~/.agentos/research-agent',
  format: 'bundle',
  includeSkills: true,
  includeWorkflows: true,
});

writeFileSync('./my-agent-bundle.tar.gz', exported.buffer);
```

The bundle contains:

```
agent-config.yaml        — Main configuration
skills/                  — Resolved SKILL.md files
workflows/               — Workflow definitions
tools/                   — Custom tool definitions
MANIFEST.json            — Bundle metadata and checksums
```

### Import a Bundle

```typescript
await importAgent({
  source: './my-agent-bundle.tar.gz',
  targetDir: '~/.agentos/agents/imported',
});
```

---

## Examples

### Export for CI/CD

```typescript
import { exportAgentConfig } from '@framers/agentos';
import { writeFileSync } from 'node:fs';

// Export without secrets for CI
const exported = await exportAgentConfig({
  configDir: './agent-config',
  format: 'json',
  redactSecrets: true,
});

writeFileSync('./deploy/agent-config.json', exported.content);

// In CI, secrets come from environment variables — set OPENAI_API_KEY,
// ANTHROPIC_API_KEY, etc. as CI secrets and pass them to importAgent on
// the deploy step.
```

### Clone an Agent

```typescript
import { exportAgentConfig, importAgent } from '@framers/agentos';

// Export current agent
const exported = await exportAgentConfig({
  configDir: '~/.agentos/agents/original',
  format: 'json',
  redactSecrets: false, // Same machine, no need to redact
});

// Import as a new agent with modified settings
const config = JSON.parse(exported.content);
config.agent.name = 'Research Assistant v2';
config.llm.model = 'claude-opus-5-5';

await importAgent({
  source: JSON.stringify(config),
  targetDir: '~/.agentos/agents/research-v2',
});
```

### Diff Two Configs

```typescript
import { exportAgentConfig } from '@framers/agentos';
import { writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

// Export both configs as JSON
for (const dir of ['./agent-a', './agent-b']) {
  const exported = await exportAgentConfig({ configDir: dir, format: 'json' });
  writeFileSync(`/tmp/${dir.replace(/\W/g, '_')}.json`, exported.content);
}

// Diff with whatever you already use
console.log(execSync('diff /tmp/_agent_a.json /tmp/_agent_b.json').toString());
```

---

## Related Documentation

- [Getting Started](./GETTING_STARTED.md) — Initial agent setup
- [Architecture](./ARCHITECTURE.md) — System architecture overview
- [Skills](./SKILLS.md) — Skill format and discovery
- [Ecosystem](./ECOSYSTEM.md) — AgentOS ecosystem overview
- [Wunderland](https://wunderland.sh) — Companion control plane (CLI ships from here)
