# Agent Config Export & Import

> Export an agent's or an agency's configuration as an object, JSON or YAML
> with its secrets redacted, then import it into a working agent with the
> secrets supplied by the importing process.

---

## Table of Contents

1. [Overview](#overview)
2. [Quick Start](#quick-start)
3. [Programmatic API](#programmatic-api)
4. [Export Document](#export-document)
5. [Secret Redaction](#secret-redaction)
6. [Import](#import)
7. [Validation](#validation)
8. [Round-Trip Workflow](#round-trip-workflow)
9. [Examples](#examples)
10. [Related Documentation](#related-documentation)

---

## Overview

An agent's configuration is the options object passed to `agent()` or
`agency()`: provider and model, instructions, personality, tools, memory,
RAG, guardrails, channels, limits, and for an agency the roster of
sub-agents. Export writes that object into a versioned document, and import
builds a new agent or agency from the document. Use them to:

- **Share** a configuration with teammates
- **Version** configurations in Git beside application code
- **Move** an agent between environments (dev, staging, prod)
- **Back up** a configuration and restore it
- **Template** new agents from one that works

Export works on a copy of the configuration and redacts secrets by default:
API keys, tokens, passwords, and credentials inside URLs become
`<<REDACTED>>`. A class instance, such as a router or a memory provider,
becomes an `<<instance>>` marker, and functions are left out of JSON and
YAML. Import takes the missing values back through two maps keyed by JSON
Pointer: `secrets` for redacted strings and `values` for objects. A redacted
provider key needs no entry: it resolves from the importing process's
default provider or environment. Sessions, conversation history and usage
totals are not part of the export.

---

## Quick Start

### Export an Agent

```typescript
import { agent, exportAgentConfigYAML } from '@framers/agentos';
import { writeFileSync } from 'node:fs';

const assistant = agent({
  provider: 'openai',
  model: 'gpt-4o',
  apiKey: process.env.OPENAI_API_KEY,
  instructions: 'Answer with sources.',
});

writeFileSync('./assistant.yaml', exportAgentConfigYAML(assistant));
```

`assistant.yaml`:

```yaml
version: 1.0.0
exportedAt: 2026-10-07T12:00:00.000Z
type: agent
config:
  provider: openai
  model: gpt-4o
  apiKey: <<REDACTED>>
  instructions: Answer with sources.
```

### Import an Agent

```typescript
import { importAgentFromYAML } from '@framers/agentos';
import { readFileSync } from 'node:fs';

// Import drops the redacted key. Each call resolves it in this process: a
// setDefaultProvider() default first, then OPENAI_API_KEY.
const assistant = importAgentFromYAML(readFileSync('./assistant.yaml', 'utf8'));
await assistant.generate('What changed in the latest release?');
```

---

## Programmatic API

The export, import and validation functions below are exported from
`@framers/agentos`, together with the types `AgentExportConfig`,
`ExportAgentConfigOptions`, `ImportAgentOptions` and `PrebuiltSeatMarker`;
`export()` and `exportJSON()` are methods of an agent. All of them are
synchronous. Source:
[`agentExport.ts`](https://github.com/framerslab/agentos/blob/master/src/api/agentExport.ts),
[`agentExportCore.ts`](https://github.com/framerslab/agentos/blob/master/src/api/agentExportCore.ts),
[`agentExportRedact.ts`](https://github.com/framerslab/agentos/blob/master/src/api/agentExportRedact.ts)
and [`url-secrets.ts`](https://github.com/framerslab/agentos/blob/master/src/core/llm/providers/url-secrets.ts).

| Call | Returns |
| --- | --- |
| `exportAgentConfig(agent, metadata?, options?)` | `AgentExportConfig`: the export document as an object |
| `exportAgentConfigJSON(agent, metadata?, options?)` | `string`: the document as JSON, indented two spaces |
| `exportAgentConfigYAML(agent, metadata?, options?)` | `string`: the document as YAML |
| `agent.export(metadata?, options?)` | the object `exportAgentConfig(agent, metadata, options)` returns |
| `agent.exportJSON(metadata?, options?)` | the string `exportAgentConfigJSON(agent, metadata, options)` returns |
| `importAgent(config, options?)` | a new agent or agency |
| `importAgentFromJSON(json, options?)` | `importAgent()` on the parsed JSON |
| `importAgentFromYAML(yaml, options?)` | `importAgent()` on the parsed YAML |
| `validateAgentExport(config)` | `{ valid: boolean; errors: string[] }` |

For every export call `options` is `{ redactSecrets? }`; for every import
call it is `{ secrets?, values? }`.

### exportAgentConfig()

- `agent`: an instance returned by `agent()`, `agency()` or `importAgent()`.
- `metadata`: `{ name?, description?, author?, tags? }`, written to the
  document's `metadata` field as given. Redaction does not apply to it. The
  field is absent when no metadata is passed.
- `options.redactSecrets`: `true` unless set to `false`. See
  [Secret Redaction](#secret-redaction).

It returns the document as an object, built on a copy of the agent's
config: its plain objects and arrays are new, so editing them does not
change the agent. In this object form, functions stay in place by
reference.

```typescript
import { agent, exportAgentConfig } from '@framers/agentos';

const assistant = agent({ provider: 'openai', model: 'gpt-4o', instructions: 'Answer with sources.' });
const doc = exportAgentConfig(assistant, { name: 'Research Assistant', tags: ['research'] });

console.log(doc.type, doc.config.model); // agent gpt-4o
```

### exportAgentConfigJSON() and exportAgentConfigYAML()

Both take the same arguments as `exportAgentConfig()` and build the same
document in its serialized form, written with
`JSON.stringify(document, null, 2)` and `YAML.stringify(document)` from the
[`yaml`](https://www.npmjs.com/package/yaml) package. Functions are left
out, and a class instance is written as an `<<instance>>` marker even with
`redactSecrets: false`, since an instance cannot be serialized.

### agent.export() and agent.exportJSON()

The instance returned by `agent()` has two export methods.
`export(metadata?, options?)` returns what
`exportAgentConfig(agent, metadata, options)` returns, and
`exportJSON(metadata?, options?)` returns what
`exportAgentConfigJSON(agent, metadata, options)` returns. There is no YAML
method: call `exportAgentConfigYAML(agent)`.

An agency has the same two methods with the same behaviour. `agency()` and
`importAgent()` return the `Agency` type, which declares `export` and
`exportJSON` as optional members and types the result of `export()` as
`unknown`. Call `exportAgentConfig(team)` and `exportAgentConfigJSON(team)`
for a typed result.

```typescript
import { agency, agent, exportAgentConfig } from '@framers/agentos';
import { writeFileSync } from 'node:fs';

const assistant = agent({ provider: 'openai', model: 'gpt-4o', instructions: 'Answer with sources.' });
writeFileSync('./assistant.json', assistant.exportJSON({ name: 'Research Assistant' }));

const team = agency({
  provider: 'openai',
  model: 'gpt-4o',
  agents: {
    researcher: { instructions: 'Find sources.' },
    writer: { instructions: 'Write the brief.' },
  },
});
const teamDoc = exportAgentConfig(team); // AgentExportConfig; team.export?.() is typed unknown
console.log(Object.keys(teamDoc.agents ?? {})); // [ 'researcher', 'writer' ]
```

### importAgent()

`importAgent(config, options?)` takes an `AgentExportConfig` and an
`ImportAgentOptions` (`{ secrets?, values? }`) and runs these steps in order:

1. Validates the document with `validateAgentExport()`. When that fails it
   throws `Invalid agent export config: ` followed by the errors joined with
   `; `.
2. Copies the document through JSON. The document you pass is not changed.
3. Drops `config.agents`: an agency is built from the `agents` copy of the
   roster.
4. Puts each `values` entry at its path.
5. Throws if a roster seat still reads `{ prebuilt: true }`.
6. Fills each redacted string that has a `secrets` entry, drops a redacted
   provider key, and drops a redacted provider `baseUrl` when the importing
   process supplies a URL of its own. It collects every value it cannot
   restore and, if any remain, throws one error that lists every path.
7. Calls `agency()` with the config plus `agents`, `strategy`, `adaptive` and
   `maxRounds` when `type` is `'agency'`, or `agent()` with the config.

The new instance holds the restored config, so a later export writes it,
without the provider key and URL that import dropped. [Import](#import)
gives the rules for each step.

### importAgentFromJSON() and importAgentFromYAML()

`importAgentFromJSON(json, options?)` parses the string with `JSON.parse`,
which throws a `SyntaxError` on malformed JSON, and calls `importAgent()`.
`importAgentFromYAML(yaml, options?)` parses it with the `yaml` package,
which throws on malformed YAML, and calls `importAgent()`.

### validateAgentExport()

`validateAgentExport(config)` takes any value, checks the document's
structure without importing it, and returns `{ valid, errors }`.
[Validation](#validation) lists the checks.

### Types

| Type | Shape |
| --- | --- |
| `AgentExportConfig` | The export document. [Export Document](#export-document) lists its fields. |
| `ExportAgentConfigOptions` | `{ redactSecrets?: boolean }`, `true` by default |
| `ImportAgentOptions` | `{ secrets?: Record<string, string>; values?: Record<string, unknown> }`, both keyed by JSON Pointer |
| `PrebuiltSeatMarker` | `{ prebuilt: true }`: the roster entry written for a pre-built `Agent` |

---

## Export Document

### Fields

| Field | Present | Value |
| --- | --- | --- |
| `version` | always | `"1.0.0"`. Validation and import reject any other value. |
| `exportedAt` | always | The time of the export as an ISO 8601 string (`new Date().toISOString()`). |
| `type` | always | `"agency"` for an instance built by `agency()` or imported from an agency export, `"agent"` otherwise. |
| `config` | always | A copy of the options object given to `agent()` or `agency()`, redacted unless `redactSecrets` is `false`. An agency's copy holds its roster too, under `config.agents`. |
| `agents` | agency | The roster again, keyed by seat name: each seat's config, redacted the same way, or `{ prebuilt: true }` for an `Agent` instance placed in the roster. Import builds the agency from this copy. |
| `strategy` | agency | As given to `agency()`. JSON and YAML omit it when it was not set. |
| `adaptive` | agency | As given to `agency()`. JSON and YAML omit it when it was not set. |
| `maxRounds` | agency | As given to `agency()`. JSON and YAML omit it when it was not set. |
| `metadata` | when passed | The `metadata` argument as given: `name`, `description`, `author`, `tags`. |

### A Single Agent in YAML

This agent carries a provider key, two channel tokens, a Slack webhook, a
signed document URL and a memory provider built from a class:

```typescript
import { agent, exportAgentConfigYAML, type AgentMemoryProvider } from '@framers/agentos';
import { writeFileSync } from 'node:fs';

class NotesMemory implements AgentMemoryProvider {
  notes: string[] = [];
  async getContext() {
    return { contextText: this.notes.join('\n') };
  }
}

const assistant = agent({
  name: 'Research Assistant',
  provider: 'openai',
  model: 'gpt-4o',
  apiKey: process.env.OPENAI_API_KEY,
  instructions: 'Answer with sources.',
  personality: { conscientiousness: 0.9, openness: 0.8 },
  maxTokens: 2048,
  memoryProvider: new NotesMemory(),
  rag: {
    documents: [{ url: 'https://docs.example.com/handbook.pdf?sp=r&sig=abc123', loader: 'pdf' }],
  },
  channels: {
    slack: { botToken: process.env.SLACK_BOT_TOKEN, webhookUrl: process.env.SLACK_WEBHOOK_URL },
    discord: { botToken: process.env.DISCORD_BOT_TOKEN, publicKey: 'a1b2c3d4e5f6' },
  },
});

writeFileSync(
  './research-assistant.yaml',
  exportAgentConfigYAML(assistant, { name: 'Research Assistant', author: 'research-team', tags: ['research'] }),
);
```

With the four variables set (`SLACK_WEBHOOK_URL` to a
`https://hooks.slack.com/services/...` URL), the file reads:

```yaml
version: 1.0.0
exportedAt: 2026-10-07T12:00:00.000Z
type: agent
config:
  name: Research Assistant
  provider: openai
  model: gpt-4o
  apiKey: <<REDACTED>>
  instructions: Answer with sources.
  personality:
    conscientiousness: 0.9
    openness: 0.8
  maxTokens: 2048
  memoryProvider:
    <<instance>>: NotesMemory
  rag:
    documents:
      - url: https://docs.example.com/handbook.pdf?sp=r&sig=<<REDACTED>>
        loader: pdf
  channels:
    slack:
      botToken: <<REDACTED>>
      webhookUrl: https://hooks.slack.com/<<REDACTED>>
    discord:
      botToken: <<REDACTED>>
      publicKey: a1b2c3d4e5f6
metadata:
  name: Research Assistant
  author: research-team
  tags:
    - research
```

- `apiKey` and both `botToken` values are secrets by name.
- `webhookUrl` keeps its origin, and its path becomes `/<<REDACTED>>`.
- The document URL keeps `sp=r` and loses the value of `sig`.
- `memoryProvider` is a class instance, written as a marker that names its
  constructor.
- `name`, `instructions`, `personality`, `maxTokens` and `publicKey` are not
  secrets and are unchanged.

A variable that is not set leaves its property `undefined`, and JSON and
YAML omit it.

### An Agency in JSON

An agency writes its roster twice: inside `config` as part of the options
object, and as `agents`. This one places a pre-built agent in the roster:

```typescript
import { agency, agent, exportAgentConfigJSON } from '@framers/agentos';
import { writeFileSync } from 'node:fs';

const reviewer = agent({ provider: 'openai', model: 'gpt-4o-mini', instructions: 'Check every claim against its source.' });

const team = agency({
  provider: 'openai',
  model: 'gpt-4o',
  apiKey: process.env.OPENAI_API_KEY,
  strategy: 'review-loop',
  maxRounds: 3,
  agents: {
    writer: { instructions: 'Write the brief.', apiKey: process.env.WRITER_API_KEY },
    reviewer,
  },
});

writeFileSync('./brief-team.json', exportAgentConfigJSON(team, { name: 'Brief Team' }));
```

```json
{
  "version": "1.0.0",
  "exportedAt": "2026-10-07T12:00:00.000Z",
  "type": "agency",
  "config": {
    "provider": "openai",
    "model": "gpt-4o",
    "apiKey": "<<REDACTED>>",
    "strategy": "review-loop",
    "maxRounds": 3,
    "agents": {
      "writer": {
        "instructions": "Write the brief.",
        "apiKey": "<<REDACTED>>"
      },
      "reviewer": {}
    }
  },
  "agents": {
    "writer": {
      "instructions": "Write the brief.",
      "apiKey": "<<REDACTED>>"
    },
    "reviewer": {
      "prebuilt": true
    }
  },
  "strategy": "review-loop",
  "maxRounds": 3,
  "metadata": {
    "name": "Brief Team"
  }
}
```

- Both copies of the roster are redacted.
- In `agents`, the pre-built `reviewer` is `{ "prebuilt": true }`. In
  `config.agents` it is a copy of the agent object: its methods in the
  object form, `{}` in JSON and YAML. Import never reads `config.agents`.
- `strategy` and `maxRounds` appear at the top level and inside `config`.
  `adaptive` was not set, so the JSON omits it.

---

## Secret Redaction

Redaction is on unless `redactSecrets` is `false`. It runs on a copy of the
config: the agent keeps its own values and keeps sending its key. It covers
`config` and `agents`, so both copies of an agency's roster;
`metadata`, `strategy`, `adaptive` and `maxRounds` are written as given.
Every secret string becomes `<<REDACTED>>`.

### Secret Property Names

A string is a secret when the name of its property, read as words, ends
with one of eight words or five word pairs:

| Words | Pairs |
| --- | --- |
| `token`, `secret`, `password`, `passwd`, `credential`, `credentials`, `authorization`, `cookie` | `api key`, `private key`, `secret key`, `access key`, `auth key` |

A name is split into words at camelCase humps, underscores, hyphens, dots
and spaces, and read in lower case. These names are secrets: `apiKey`,
`api_key`, `x-api-key`, `ANTHROPIC_API_KEY`, `botToken`, `signing_secret`,
`secretKey`, `aws_secret_access_key`, `credential`, `Authorization`,
`dbPassword`, `Cookie`.

Plurals:

- The plural of a pair counts at the end of any name: `apiKeys`,
  `providerApiKeys`, `privateKeys`.
- The plural of a single word counts only as the whole name: `tokens`,
  `secrets`, `passwords`, `cookies`. A longer name that ends in such a plural
  is a setting: `maxTokens`, `promptTokens` and `stopTokens` stay, and so do
  `botTokens` and `sessionCookies`.
- `credentials` is one of the eight words, so it counts at the end of any
  name: `awsCredentials`.

A name with no word break is also compared with the joined forms of the
pairs (`apikey`, `privatekey`, `secretkey`, `accesskey`, `authkey`) and with
the eight words, plurals included. The comparison reads the end of the name:
`apikey`, `APIKEY`, `xapikey`, `accesstoken` and `clientsecret` are secrets,
and so is a one-word lower-case `stoptokens`, where `stopTokens` is not.

Only strings are redacted. A number, a boolean or `null` stays whatever its
name.

### Secret Containers

Every string inside an object or an array whose own name is exactly one of
the words or pairs, singular or plural, is a secret whatever its own key, at
any depth, apart from the [kept setting values](#kept-setting-values). The
container's name is read in lower case without separators:
`secrets`, `credentials`, `tokens`, `apiKey`, `apiKeys`, `api_keys`,
`authorization`. A name that only ends with a secret word does not make a
container.

| In the config | Exported as |
| --- | --- |
| `secrets: { openai: 'sk-1', region: 'us-east-1' }` | `secrets: { openai: '<<REDACTED>>', region: '<<REDACTED>>' }` |
| `apiKey: ['sk-1', 'sk-2']` (a key pool) | `apiKey: ['<<REDACTED>>', '<<REDACTED>>']` |
| `tokens: ['t1']` | `tokens: ['<<REDACTED>>']` |
| `credentials: { slack: 'xoxb-1' }` | `credentials: { slack: '<<REDACTED>>' }` |
| `stopTokens: ['###']` | unchanged |

### Kept Setting Values

Four of the words also name settings: `credential`, `credentials`,
`authorization` and `cookie`. Under them, nine values are kept, compared in
lower case: fetch's `credentials` modes `include`, `same-origin` and `omit`,
and the mode words `none`, `oauth`, `bearer`, `basic`, `strict` and `lax`.
A value is kept when it belongs to a property whose name is a secret by one
of the four words, or when the nearest container around it is named by one
of them. Any other value under those words is redacted, and under the other
words and pairs no value is kept.

| In the config | Exported as |
| --- | --- |
| `credentials: 'include'` | unchanged |
| `authorization: 'Bearer'` | unchanged |
| `sessionCookie: 'lax'` | unchanged |
| `authorization: { type: 'bearer', token: 'abc' }` | `authorization: { type: 'bearer', token: '<<REDACTED>>' }` |
| `authorization: 'Bearer sk-1'` | `authorization: '<<REDACTED>>'` |
| `token: 'none'` | `token: '<<REDACTED>>'` |

### What Is Not a Secret

The rule reads property names, not values. These names are not secrets:
`maxTokens`, `promptTokens`, `stopTokens`, `tokenLimit`, `envKey`,
`promptCacheKey`, `primaryKey`, `publicKey`, `sessionKey`. Neither are:

- `key`, `auth` and `passphrase`;
- a longer name whose last word is a joined form, such as `x-apikey` or
  `myApikey`, since the joined forms are compared only for a one-word name;
- a name that ends with a digit (`apiKey2` ends with the word `key2`);
- a longer name that ends with the plural of a single word (`botTokens`).

A secret placed under a name that is not a secret, such as a key pasted
into `instructions`, is written as it is. Read an export before you share
it.

### URLs

Every other string that starts with a scheme and `://` is read as a URL.
Export rewrites it in place, splicing the placeholder into the original
text, so a URL with nothing to remove comes back byte for byte:

| Rule | In the config | Exported as |
| --- | --- | --- |
| Userinfo | `postgres://app:pw@db.internal:5432/agents` | `postgres://<<REDACTED>>@db.internal:5432/agents` |
| Secret query parameter | `https://vec.local/x?api_key=abc&publicKey=pk1` | `https://vec.local/x?api_key=<<REDACTED>>&publicKey=pk1` |
| Secret fragment parameter | `https://app.example/cb#access_token=abc&state=s1` | `https://app.example/cb#access_token=<<REDACTED>>&state=s1` |
| Webhook URL, under `webhookUrl` | `https://hooks.slack.com/services/T000/B000/XXXX` | `https://hooks.slack.com/<<REDACTED>>` |
| Nothing to remove | `https://proxy.local/v1?publicKey=abc` | `https://proxy.local/v1?publicKey=abc` |

- The userinfo is everything in the authority before its last `@`, and it
  becomes `<<REDACTED>>@`.
- A query or fragment parameter is a secret when its name is a secret by the
  property rule (`api_key`, `apikey`, `access_token`, `token`,
  `client_secret`) or is `key`, `sig`, `signature`, `auth` or `password` in
  any case. `key`, `sig`, `signature` and `auth` count only as the whole
  parameter name, so `X-Amz-Signature` and `cacheKey` stay.
- A URL under a property whose name ends with the words `webhook url`
  (`webhookUrl`, `slackWebhookUrl`, `WEBHOOK_URL`) carries its secret in the
  path. It keeps its origin, its path and query become `/<<REDACTED>>`, and
  its secret fragment parameters are replaced as on any other URL. A webhook
  URL with no path and no query
  (`https://hooks.example` or `https://hooks.example/`) stays as it is.
- A string under a secret name or inside a secret container is replaced
  whole, URL or not. A URL anywhere else is never blanked whole.
- A string with no scheme (`hooks.slack.com/services/T000`) is not read as
  a URL.

### Class Instances and Functions

An object that is neither a plain object nor an array (a class instance, a
`Map`, a `Date`, a Zod schema) becomes
`{ "<<instance>>": "<constructor name>" }`, since what it holds cannot be
redacted by name. That holds in JSON and YAML always, and in the object
form unless `redactSecrets` is `false`. A router, a memory provider built
from a class and a `responseSchema` all export this way. Import throws on a
marker until `values` supplies the object.

A function stays in the object form (`exportAgentConfig()`,
`agent.export()`) and is left out of JSON and YAML. There, a function inside
an array is removed, so the items after it move up one index.

### Exporting Without Redaction

`{ redactSecrets: false }` writes every string as it is: keys, tokens, and
URLs with their credentials. Treat the output as a secret, for example in an
encrypted backup pipeline.

- The object form copies plain objects and arrays, keeps functions, and
  keeps class instances by reference: `doc.config.router` is the agent's own
  router.
- JSON and YAML leave functions out and still write each class instance as
  an `<<instance>>` marker, since an instance cannot be serialized.

```typescript
import { agent, exportAgentConfigJSON } from '@framers/agentos';
import { writeFileSync } from 'node:fs';

const assistant = agent({ provider: 'openai', model: 'gpt-4o', apiKey: process.env.OPENAI_API_KEY });

// The file holds the live key.
writeFileSync('./assistant.secret.json', exportAgentConfigJSON(assistant, undefined, { redactSecrets: false }), {
  mode: 0o600,
});
```

---

## Import

`importAgent(config, { secrets, values })` builds a new agent or agency from
the document and takes back what export removed. `secrets` maps the JSON
Pointer of each redacted string to its value. `values` maps the JSON Pointer
of each `<<instance>>` marker, or of a function that export dropped, to the
object to put there. `importAgentFromJSON()` and `importAgentFromYAML()`
take the same options.

### JSON Pointer Paths

Paths are JSON Pointers (RFC 6901) into the export document: each starts at
the document root, so with `/config` or `/agents`; array items are addressed
by index; a `/` inside a key is written `~1`, and a `~` is written `~0`.

| Value in the document | Path |
| --- | --- |
| `config.channels.slack.botToken` | `/config/channels/slack/botToken` |
| `config.rag.documents[0].url` | `/config/rag/documents/0/url` |
| `config.memoryProvider` (a marker) | `/config/memoryProvider` |
| `agents.writer.apiKey` | `/agents/writer/apiKey` |
| `agents.support.channels.slack.credential` | `/agents/support/channels/slack/credential` |
| key `x/api-key` in `config.customModelParams.headers` | `/config/customModelParams/headers/x~1api-key` |

- An agency's roster is read from `agents`, so a seat's paths begin with
  `/agents/<seat>`. Paths into `config.agents` are never read.
- A `secrets` entry is the whole value: for a redacted URL, the whole URL.
  `secrets` fills only strings that hold the placeholder; an entry for any
  other path, or for a path the document does not have, is ignored.
- A `values` entry is put at its path as it is (a function, a class
  instance, any value), and missing parents are created. A `values` path
  must start with `/`, or import throws.

### Provider Keys

An `apiKey` that reads exactly `<<REDACTED>>` in an object that also has a
string `provider` or `model` is a provider key. With no `secrets` entry,
import deletes it, and the key resolves on each call as an unset key does:
from the `apiKey` of the `setDefaultProvider()` default when that default
names no provider or this provider, then from the provider's key variable
in the importing process's environment (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
`OPENROUTER_API_KEY` and so on; see
[Provider Resolution](./HIGH_LEVEL_API.md#provider-resolution)). Import does
not check that a key resolves; a call that finds none fails when the
provider needs one. Import never writes the environment's key into the
config, so a later export of the imported agent has no `apiKey` there.

The rule applies to any object in the document with a string `provider` or
`model`, such as the top-level config or a roster seat that names its own:
in a seat with `provider: 'anthropic'`, a redacted
`/agents/researcher/apiKey` resolves from `ANTHROPIC_API_KEY`. A seat with
no `provider` or `model` of its own has no provider key by this rule: its
redacted `apiKey` needs a `secrets` entry, or import throws.

### Provider Base URLs

A `baseUrl` that holds the placeholder (its userinfo or a secret parameter
was redacted) in an object with a string `provider` or `model` is a provider
URL. Its provider is `provider`, or else the part of `model` before the
first `:`. With no `secrets` entry, import deletes it when the importing
process supplies a URL of its own for that provider:

- a `setDefaultProvider()` default that names the provider and carries a
  non-empty `baseUrl`, or
- the provider's URL variable, set to a non-empty value. Six providers have
  one:

| Provider | URL variable |
| --- | --- |
| `openai` | `OPENAI_BASE_URL` |
| `openrouter` | `OPENROUTER_BASE_URL` |
| `stability` | `STABILITY_BASE_URL` |
| `replicate` | `REPLICATE_BASE_URL` |
| `ollama` | `OLLAMA_BASE_URL` |
| `stable-diffusion-local` | `STABLE_DIFFUSION_LOCAL_BASE_URL` |

The deleted URL then resolves as an unset one does: the applicable default's
`baseUrl` first, then the variable. With neither, import throws and lists
the path, because dropping the URL would send the call, with the importer's
key, to the provider's public endpoint in place of the configured one. For
any other provider a redacted `baseUrl` needs a `secrets` entry or a default
that names the provider, and for a `model` with no `provider:` prefix and no
`provider` beside it, it needs a `secrets` entry.

```typescript
import { importAgentFromYAML, setDefaultProvider } from '@framers/agentos';
import { readFileSync } from 'node:fs';

// The exported baseUrl lost its credentials. This process sends openai calls to its own proxy.
setDefaultProvider({ provider: 'openai', baseUrl: 'https://llm-proxy.internal/v1' });
const assistant = importAgentFromYAML(readFileSync('./proxied-assistant.yaml', 'utf8'));
await assistant.generate('Summarize the open incidents.');
```

### Every Other Redacted Value

Nothing else has a fallback. Import collects every other string that still
holds `<<REDACTED>>`, or its percent-encoded form `%3C%3CREDACTED%3E%3E` in
any letter case, with no `secrets` entry, and every `<<instance>>` marker
with no `values` entry. Then it throws one error that lists every path, a
marker's path with its class. Importing the
[single-agent YAML](#a-single-agent-in-yaml) with no options throws:

```text
Cannot import: 5 value(s) were redacted or replaced on export and have no entry in secrets or values: /config/memoryProvider (instance NotesMemory), /config/rag/documents/0/url, /config/channels/slack/botToken, /config/channels/slack/webhookUrl, /config/channels/discord/botToken
```

`/config/apiKey` is not in the list: it sits beside `provider: openai`, so
import drops it. With the entries supplied:

```typescript
import { importAgentFromYAML, type AgentMemoryProvider } from '@framers/agentos';
import { readFileSync } from 'node:fs';

class NotesMemory implements AgentMemoryProvider {
  notes: string[] = [];
  async getContext() {
    return { contextText: this.notes.join('\n') };
  }
}

const assistant = importAgentFromYAML(readFileSync('./research-assistant.yaml', 'utf8'), {
  secrets: {
    '/config/rag/documents/0/url': process.env.HANDBOOK_URL!,
    '/config/channels/slack/botToken': process.env.SLACK_BOT_TOKEN!,
    '/config/channels/slack/webhookUrl': process.env.SLACK_WEBHOOK_URL!,
    '/config/channels/discord/botToken': process.env.DISCORD_BOT_TOKEN!,
  },
  values: { '/config/memoryProvider': new NotesMemory() },
});
```

### Pre-built Seats

An `Agent` instance placed in a roster carries no config the export can
read, so `agents` holds `{ prebuilt: true }` for it. Import checks the
roster after it applies `values` and before it reads `secrets`. A seat that
still reads `{ prebuilt: true }` makes it throw, naming the first such seat:

```text
Cannot import pre-built seat "reviewer": the agent it stood for cannot be rebuilt from the file. Rebuild the agency in code and place the agent in the roster.
```

A `values` entry at the seat's path replaces the marker before the check,
with the agent itself or with a config for the seat. An export of the
imported agency writes a seat filled with an agent object as
`{ prebuilt: true }` again, so the next import asks for it the same way.

The [agency JSON](#an-agency-in-json) needs two entries: the `writer` seat has
no `provider` or `model` of its own, so its key needs a `secrets` entry, and
the `reviewer` seat is pre-built. `/config/apiKey` sits beside a
`provider` and resolves from `OPENAI_API_KEY`.

```typescript
import { agent, importAgentFromJSON } from '@framers/agentos';
import { readFileSync } from 'node:fs';

const reviewer = agent({ provider: 'openai', model: 'gpt-4o-mini', instructions: 'Check every claim against its source.' });

const team = importAgentFromJSON(readFileSync('./brief-team.json', 'utf8'), {
  secrets: { '/agents/writer/apiKey': process.env.WRITER_API_KEY! },
  values: { '/agents/reviewer': reviewer },
});
```

To find the pre-built seats in a file before importing it:

```typescript
import { readFileSync } from 'node:fs';
import type { AgentExportConfig, PrebuiltSeatMarker } from '@framers/agentos';

const doc = JSON.parse(readFileSync('./brief-team.json', 'utf8')) as AgentExportConfig;
const prebuilt = Object.entries(doc.agents ?? {})
  .filter(([, seat]) => (seat as Partial<PrebuiltSeatMarker>).prebuilt === true)
  .map(([name]) => name);

console.log(prebuilt); // [ 'reviewer' ]
```

### Functions and Unredacted Objects

Import copies the document through JSON before it reads it:

- Every function is lost, whichever form you pass, and leaves no marker, so
  import does not report it. Put each handler, hook or tool function back
  through `values` at the path where it stood.
- In the object form of an unredacted export, a class instance is the live
  object. The JSON copy turns it into a plain object of its own fields with
  no marker, and import does not report that either. Pass instances through
  `values` too.

```typescript
import { agent, exportAgentConfig, importAgent } from '@framers/agentos';

const onFallback = (error: Error, provider: string) => {
  console.warn(`Falling back to ${provider}: ${error.message}`);
};
const primary = agent({ provider: 'openai', model: 'gpt-4o', onFallback });

const doc = exportAgentConfig(primary, undefined, { redactSecrets: false });
const copy = importAgent(doc, { values: { '/config/onFallback': onFallback } });
await copy.generate('Draft the weekly status update.');
```

---

## Validation

`validateAgentExport(config)` checks the document's structure and returns
`{ valid, errors }`:

```typescript
import { validateAgentExport } from '@framers/agentos';
import { readFileSync } from 'node:fs';

const result = validateAgentExport(JSON.parse(readFileSync('./brief-team.json', 'utf8')));
if (!result.valid) {
  for (const error of result.errors) console.error(error);
}
```

| Check | Error |
| --- | --- |
| The value is a non-null object | `Config must be a non-null object` (returned alone) |
| `version` is `"1.0.0"` | `Unsupported version: <value>. Expected "1.0.0".` |
| `type` is `"agent"` or `"agency"` | `Invalid type: <value>. Expected "agent" or "agency".` |
| `exportedAt` is a string | `Missing or invalid "exportedAt" field. Expected an ISO 8601 string.` |
| `config` is an object | `Missing or invalid "config" field. Expected an object.` |
| For an agency, `agents` is a non-empty object | `Agency export requires a non-empty "agents" roster.` |
| For an agency, `strategy`, when present, is `sequential`, `parallel`, `debate`, `review-loop`, `hierarchical` or `graph` | `Invalid strategy: <value>. Expected one of: sequential, parallel, debate, review-loop, hierarchical, graph.` |
| `metadata`, when present, is an object | `"metadata" must be an object when present.` |

Validation does not look inside `config` or `agents`: a valid document can
still hold placeholders, markers or pre-built seats that make import throw,
and model names are not checked. `importAgent()` runs these checks first.

---

## Round-Trip Workflow

Moving an agent from development to production:

```typescript
// 1. Export where the agent is defined (a developer machine or a CI job).
import { agent, exportAgentConfigYAML } from '@framers/agentos';
import { writeFileSync } from 'node:fs';

const researchBot = agent({
  name: 'Research Bot',
  provider: 'anthropic',
  model: 'claude-sonnet-5-5',
  apiKey: process.env.ANTHROPIC_API_KEY,
  instructions: 'Answer with sources.',
  channels: { slack: { botToken: process.env.SLACK_BOT_TOKEN } },
});

writeFileSync('./agent-config.yaml', exportAgentConfigYAML(researchBot, { name: 'Research Bot' }));
```

```bash
# 2. Commit the redacted file.
git add agent-config.yaml
git commit -m "Export research-bot config"
git push
```

```typescript
// 3. Import on the production server, from its deploy script.
import { importAgentFromYAML } from '@framers/agentos';
import { readFileSync } from 'node:fs';

// ANTHROPIC_API_KEY is set on the server; the Slack token comes from its secret store.
const researchBot = importAgentFromYAML(readFileSync('./agent-config.yaml', 'utf8'), {
  secrets: { '/config/channels/slack/botToken': process.env.SLACK_BOT_TOKEN! },
});
```

### Team Sharing

A redacted file holds nobody's keys, so each developer imports the same file
with their own. A developer whose key is not in the environment sets a
default provider before importing:

```typescript
import { importAgentFromYAML, setDefaultProvider } from '@framers/agentos';
import { readFileSync } from 'node:fs';

setDefaultProvider({ provider: 'anthropic', apiKey: process.env.MY_ANTHROPIC_KEY });

const researchBot = importAgentFromYAML(readFileSync('./agent-config.yaml', 'utf8'), {
  secrets: { '/config/channels/slack/botToken': process.env.MY_SLACK_BOT_TOKEN! },
});
await researchBot.generate('Summarize this week of retrieval papers.');
```

---

## Examples

### Export for CI/CD

CI exports the agency as JSON, validates the file and hands it to the deploy
step. Both keys sit beside a `provider`, so the deploy step supplies them
from its own environment and passes no options:

```typescript
// ci/export-agent.ts
import { agency, exportAgentConfigJSON, validateAgentExport } from '@framers/agentos';
import { writeFileSync } from 'node:fs';

const supportTeam = agency({
  provider: 'openai',
  model: 'gpt-4o',
  apiKey: process.env.OPENAI_API_KEY,
  strategy: 'sequential',
  agents: {
    triage: { instructions: 'Sort the ticket by product and urgency.' },
    responder: {
      provider: 'anthropic',
      model: 'claude-sonnet-5-5',
      apiKey: process.env.ANTHROPIC_API_KEY,
      instructions: 'Draft the reply.',
    },
  },
});

const json = exportAgentConfigJSON(supportTeam);
const check = validateAgentExport(JSON.parse(json));
if (!check.valid) throw new Error(check.errors.join('; '));
writeFileSync('./deploy/support-team.json', json);
```

```typescript
// deploy/start-agent.ts: OPENAI_API_KEY and ANTHROPIC_API_KEY are CI secrets on this job.
import { importAgentFromJSON } from '@framers/agentos';
import { readFileSync } from 'node:fs';

const supportTeam = importAgentFromJSON(readFileSync('./deploy/support-team.json', 'utf8'));
await supportTeam.generate('Customer reports a failed card payment on checkout.');
```

### Clone an Agent

```typescript
import { agent, exportAgentConfig, importAgent } from '@framers/agentos';

const original = agent({
  name: 'Research Assistant',
  provider: 'anthropic',
  model: 'claude-sonnet-5-5',
  apiKey: process.env.ANTHROPIC_API_KEY,
  instructions: 'Answer with sources.',
});

// Same process: the document holds the live key in memory and is never written out.
const doc = exportAgentConfig(original, undefined, { redactSecrets: false });
doc.config.name = 'Research Assistant v2';
doc.config.model = 'claude-opus-5-5';

const v2 = importAgent(doc);
await v2.generate('Compare the two latest model releases.');
```

Editing `doc` leaves `original` unchanged, since export copies plain objects
and arrays. An agent with functions or class instances needs them in
`values`; see [Functions and Unredacted Objects](#functions-and-unredacted-objects).

### Diff Two Configs

```typescript
import { agent, exportAgentConfigJSON } from '@framers/agentos';
import { writeFileSync } from 'node:fs';

const current = agent({ provider: 'openai', model: 'gpt-4o', instructions: 'Answer with sources.' });
const candidate = agent({ provider: 'openai', model: 'gpt-4o-mini', instructions: 'Answer with sources. Be brief.' });

writeFileSync('./current.json', exportAgentConfigJSON(current));
writeFileSync('./candidate.json', exportAgentConfigJSON(candidate));
```

```bash
diff current.json candidate.json
```

Both files are redacted, so the diff carries no keys. The `exportedAt`
lines differ on every export.

---

## Related Documentation

- [Getting Started](./GETTING_STARTED.md): initial agent setup
- [High-Level API](./HIGH_LEVEL_API.md#provider-resolution): how an unset
  provider key and base URL resolve
- [Architecture](../architecture/ARCHITECTURE.md): system architecture
  overview
- [Skills](../extensions/SKILLS.md): skill format and discovery
- [Ecosystem](../architecture/ECOSYSTEM.md): AgentOS ecosystem overview
