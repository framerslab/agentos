# Provenance — Audit Trail and Tamper Evidence

> A storage policy over the runtime's database writes, a signed hash chain of those writes, and Merkle roots anchored outside the database.

---

## Table of Contents

1. [Overview](#overview)
2. [Enabling provenance](#enabling-provenance)
3. [Storage policies](#storage-policies)
4. [The signed event ledger](#the-signed-event-ledger)
5. [Verifying a chain](#verifying-a-chain)
6. [AgentKeyManager](#agentkeymanager)
7. [Proof levels and anchors](#proof-levels-and-anchors)
8. [Verification bundles](#verification-bundles)
9. [What the pack does not do](#what-the-pack-does-not-do)

---

## Overview

Provenance is an extension pack. [`createProvenancePack()`](https://github.com/framerslab/agentos/blob/master/src/extensions/packs/provenance-pack.ts) takes a [`ProvenanceSystemConfig`](https://github.com/framerslab/agentos/blob/master/src/safety/provenance/types.ts), a storage adapter, an agent id and an optional table prefix. When the runtime that loads the pack has a `storageAdapter`, AgentOS wraps that adapter with the pack's write hooks and hands the wrapped adapter to conversation persistence, RAG, emergent tools and the self-improvement tools. The wrapper hooks `run()` and `batch()`, inside `transaction()` too: a write through those calls passes the storage policy and, with signing on, lands in a signed ledger. `exec()` and `prepare()` pass through without the hooks, so a write through either skips the policy and the ledger; a host that needs every write covered keeps its writes on `run()` and `batch()`. A workflow store (`AgentOSConfig.workflowStore`) is the host's own and is not wrapped. `AgentOSConfig` has no `provenance` key.

The configuration has three parts that vary independently:

| Concern | Field |
|---------|-------|
| **What a write may do** | `storagePolicy.mode`: `mutable`, `revisioned` or `sealed` |
| **What you can prove happened** | `provenance`: the signed hash chain of write events (Ed25519) |
| **Who can check the proof** | `provenance.anchorTarget`: where Merkle roots of the chain are published |

---

## Enabling provenance

```typescript
import { AgentOS, profiles } from '@framers/agentos';
import { createProvenancePack } from '@framers/agentos/extensions/packs/provenance-pack';

// storageAdapter: a @framers/sql-storage-adapter instance
const config = profiles.revisionedVerified(); // or mutableDev(), sealedAutonomous(), sealedAuditable(rekorUrl)
const pack = createProvenancePack(config, storageAdapter, 'agent-001');

const agentos = await AgentOS.create({
  storageAdapter,
  extensionManifest: { packs: [{ factory: () => pack }] },
});

// The components the pack built when it activated
const { ledger, keyManager, anchorManager, revisionManager, tombstoneManager } = pack.getResult()!;
```

On activation the pack makes or imports the Ed25519 key pair, creates its tables (`signed_events`, `revisions`, `tombstones`, `anchors`, `agent_keys`, each under the prefix), stores the public key, starts the ledger, builds the write hooks and the anchor manager, starts periodic anchoring when `anchorIntervalMs` is above 0, and, in `sealed` mode, appends a `genesis` event.

The four presets ([`PolicyProfiles.ts`](https://github.com/framerslab/agentos/blob/master/src/safety/provenance/config/PolicyProfiles.ts)):

| Profile | Mode | Signing | Anchoring |
|---|---|---|---|
| `mutableDev()` | `mutable` | off | none |
| `revisionedVerified()` | `revisioned` | every event | every 5 minutes, batches of 100 events, no provider set |
| `sealedAutonomous()` | `sealed` on `conversations`, `conversation_messages`, `messages` | every event | every minute, batches of 50 events, no provider set |
| `sealedAuditable(rekorUrl?)` | as `sealedAutonomous()` | every event | Rekor (`https://rekor.sigstore.dev` by default) |

`profiles.custom(base, overrides)` merges overrides into a preset.

---

## Storage policies

The write hooks read each statement's operation and table. `CREATE`, `ALTER` and `DROP` always pass, as do writes to the pack's own tables. `storagePolicy.protectedTables` limits the policy to the tables it names; without it every other table is protected, less those in `exemptTables`.

### `mutable`

No enforcement. With signing on, writes are still recorded in the ledger.

### `revisioned`

An `UPDATE` on a protected table first stores a snapshot of the rows its `WHERE` clause matches in the `revisions` table, then runs; an `UPDATE` with no `WHERE` clause runs and saves no snapshot. A `DELETE` writes a tombstone for the rows its `WHERE` clause matches to the `tombstones` table and does not run: the row stays. A `DELETE` with no `WHERE` clause does not run either, and leaves no tombstone. The table itself holds the latest version; earlier versions are read with `revisionManager.getRevisions(table, recordId)`, and deletions with `tombstoneManager.getTombstones(table?)`.

### `sealed`

`UPDATE`, `DELETE` and upsert-style statements (`REPLACE`, `INSERT OR REPLACE`, `ON CONFLICT ... DO UPDATE`) on a protected table throw a `ProvenanceViolationError` with the code `SEALED_MUTATION_BLOCKED`. Inserts pass.

The built-in `ConversationManager` updates and deletes rows unless `ConversationManagerConfig.appendOnlyPersistence` is `true`; a host that seals conversation tables sets it ([Provenance & Immutability](./PROVENANCE_IMMUTABILITY.md#append-only-conversation-persistence)).

---

## The signed event ledger

With `provenance.enabled`, each write that changes rows appends one event to [`SignedEventLedger`](https://github.com/framerslab/agentos/blob/master/src/safety/provenance/ledger/SignedEventLedger.ts). The event's payload is the table, the operation, the number of rows changed and the write's operation id; the row contents are not in it. Its type follows the table: `message.created`, `message.revised` and `message.tombstoned` for a table whose name contains `message`, `conversation.*` for one that contains `conversation`, and `memory.stored`, `memory.revised` and `memory.tombstoned` for the rest.

Each event carries a sequence number, the previous event's hash, the SHA-256 of its canonical-JSON payload, and its own hash over `sequence|type|timestamp|agentId|prevHash|payloadHash`. With `signatureMode: 'every-event'` the key signs that hash; with `'anchor-only'` events are unsigned and only anchors are signed. A host can append its own events:

```typescript
const event = await ledger.appendEvent('tool.invoked', { tool: 'send_email', callId: 'c-17' });

event.sequence;     // position in the chain, from 1
event.prevHash;     // hash of the previous event
event.payloadHash;  // SHA-256 of the canonical JSON payload
event.hash;         // hash of this event
event.signature;    // Ed25519 signature of the hash, base64
```

The ledger reads events back with `getAllEvents()`, `getEventsByRange(from, to)`, `getEventsByType(type)`, `getEvent(id)` and `getLatestEvent()`.

---

## Verifying a chain

[`ChainVerifier`](https://github.com/framerslab/agentos/blob/master/src/safety/provenance/verification/ChainVerifier.ts) has static methods. It checks sequence continuity, timestamp order, each `prevHash` link, each payload hash, each event hash, and each signature, with the given public key or, without one, each event's `signerPublicKey`:

```typescript
import { ChainVerifier } from '@framers/agentos';

const events = await ledger.getAllEvents();
// No key argument: each event is checked against its own signerPublicKey.
const result = await ChainVerifier.verify(events);
// With one imported key across restarts, pin it instead:
// await ChainVerifier.verify(events, keyManager.getPublicKeyBase64());

result.valid;           // true when no check failed
result.eventsVerified;  // events checked
result.errors;          // [{ eventId, sequence, code, message }]: SEQUENCE_GAP, TIMESTAMP_REGRESSION, HASH_CHAIN_BROKEN,
                        // PAYLOAD_HASH_MISMATCH, EVENT_HASH_MISMATCH, SIGNATURE_INVALID
result.warnings;        // e.g. a chain that does not start at sequence 1
```

A key argument applies to every event. A chain signed by a preset's generated keys spans one key per activation (see [AgentKeyManager](#agentkeymanager)), so after a restart the current key reports `SIGNATURE_INVALID` for the events signed before it: verify such a chain without the key argument, and read the `Multiple signer public keys found` warning as the sign of more than one key. Without a key argument the check proves each event matches the key it names, not whose key that is; a host that needs the signer pinned signs with one imported key and passes it.

`ChainVerifier.isValid(events, publicKey?)` returns the boolean alone, and `verifySubChain()` checks a slice.

---

## AgentKeyManager

[`AgentKeyManager`](https://github.com/framerslab/agentos/blob/master/src/safety/provenance/crypto/AgentKeyManager.ts) holds the Ed25519 key pair. Keys travel as base64 (PKCS#8 and SPKI DER under Node).

```typescript
import { AgentKeyManager } from '@framers/agentos';

const keys = await AgentKeyManager.generate('agent-001');
const source = keys.toKeySource();        // { type: 'import', privateKeyBase64, publicKeyBase64 }: store it as a secret

const same = await AgentKeyManager.fromKeySource('agent-001', source);
const signature = await same.sign('payload');                  // base64
const ok = await same.verify('payload', signature);            // true
const okWithKey = await same.verify('payload', signature, keys.getPublicKeyBase64());
```

Every preset uses `keySource: { type: 'generate' }`, which makes a new key pair each time the pack activates and keeps the private key in memory only: after a restart, new events carry the new public key and earlier ones the old. To sign with one key across restarts, put `{ type: 'import', privateKeyBase64, publicKeyBase64 }` in `provenance.keySource`. `AgentKeySource.keyStorePath` is declared and not read.

---

## Proof levels and anchors

[`AnchorManager`](https://github.com/framerslab/agentos/blob/master/src/safety/provenance/anchoring/AnchorManager.ts) builds a Merkle root over a range of events, signs it, stores it in the `anchors` table and hands it to the anchor provider. Every `anchorIntervalMs` it anchors the events since the last anchor once there are at least `anchorBatchSize` of them; `createAnchor(from, to)` anchors a range on demand and `verifyAnchor(anchorId)` checks one.

The provider comes from `provenance.anchorTarget`. AgentOS itself has two: `none` (the default; the anchor is stored locally) and `composite` (several targets). The others live in [`@framers/agentos-ext-anchor-providers`](https://www.npmjs.com/package/@framers/agentos-ext-anchor-providers), which registers them once its `registerExtensionProviders()` has run; an unregistered type logs a warning and falls back to `none`.

| Proof level | Meaning | Provider types |
|---|---|---|
| `verifiable` | Local signed hash chain only | `none` |
| `externally-archived` | The anchor is copied to write-once storage | `worm-snapshot` |
| `publicly-auditable` | The anchor is logged in a transparency log | `rekor` |
| `publicly-timestamped` | The anchor is timestamped on a blockchain | `opentimestamps`, `ethereum`, `solana` |

```typescript
import { profiles } from '@framers/agentos';
import { registerExtensionProviders } from '@framers/agentos-ext-anchor-providers';

registerExtensionProviders(); // before the pack activates

const config = profiles.custom(profiles.sealedAutonomous(), {
  provenance: {
    enabled: true,
    signatureMode: 'every-event',
    hashAlgorithm: 'sha256',
    keySource: { type: 'import', privateKeyBase64, publicKeyBase64 },
    anchorTarget: { type: 'rekor', options: { serverUrl: 'https://rekor.sigstore.dev' /* and the provider's signing options */ } },
  },
});
```

Each provider reads its own `options`; see the package for them.

---

## Verification bundles

[`BundleExporter`](https://github.com/framerslab/agentos/blob/master/src/safety/provenance/verification/BundleExporter.ts) packs a range of events, the anchors and the public key into one signed bundle that a third party can check without the runtime:

```typescript
import { BundleExporter } from '@framers/agentos';

const exporter = new BundleExporter(ledger, keyManager, storageAdapter /* the anchors' store, or null */);
const bundle = await exporter.exportBundle(1, 500);      // sequences 1-500; no arguments exports every event
const jsonl = await exporter.exportAsJSONL();            // the same as JSON Lines

// Elsewhere, with only the bundle
const result = await BundleExporter.importAndVerify(bundle);  // or BundleExporter.parseJSONL(jsonl) first
result.valid;
```

The bundle carries one public key, the exporter's current one, and `importAndVerify()` checks every event's signature with it. A bundle of events signed by a preset's generated keys across a restart therefore fails on the events signed before it; bundles verify end to end when the ledger is signed with one imported key (`provenance.keySource: { type: 'import', ... }`).

---

## What the pack does not do

- **Seal a toolset or redact memory.** AgentOS has no toolset hash or redaction API; [Immutable Agents](./IMMUTABLE_AGENTS.md) describes how a host builds them from these parts.
- **Enforce autonomy rules.** The pack builds an [`AutonomyGuard`](https://github.com/framerslab/agentos/blob/master/src/safety/provenance/enforcement/AutonomyGuard.ts) from `config.autonomy`, and nothing in AgentOS calls its `checkHumanAction()`; a host that wants those rules enforced calls it.
- **Record row contents.** Ledger events name the table and operation; the rows stay in their tables, and a revisioned update's earlier version stays in `revisions`.

---

## Related Guides

- [PROVENANCE_IMMUTABILITY.md](./PROVENANCE_IMMUTABILITY.md) — the modes, append-only persistence and the pack
- [IMMUTABLE_AGENTS.md](./IMMUTABLE_AGENTS.md) — toolset pinning, secret rotation, soft-forget
- [CHECKPOINTING.md](../orchestration/CHECKPOINTING.md) — checkpoint consistency and storage
- [OBSERVABILITY.md](../observability/OBSERVABILITY.md) — OpenTelemetry tracing alongside provenance
