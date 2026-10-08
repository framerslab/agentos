# Provenance & Immutability

AgentOS can optionally run with a provenance system that provides:

- **Storage policy enforcement**: `mutable`, `revisioned`, or `sealed`
- **Signed event ledger**: a hash chain of events signed with an Ed25519 keypair
- **Optional external anchoring**: periodically anchor a Merkle root to external systems for stronger tamper evidence

This is designed to support both centralized deployments (policy + audit trail) and decentralized / trust-minimized verification (public anchors).

For a complete "immutable after setup" agent design (toolset pinning, secret rotation, soft-forget memory), see [Immutable Agents](./IMMUTABLE_AGENTS.md).

## Terminology

- **Policy (immutability)**: what the runtime is *allowed* to do.
- **Tamper evidence (verifiability)**: what you can *prove* happened by verifying signatures/hashes.
- **Anchoring**: publishing a Merkle root outside your database so third parties can independently timestamp or audit state.

## Modes

### 1) `mutable`

Normal app semantics. Writes are allowed; provenance may be disabled or used only for diagnostics.

Use this for development or agents that humans/programs are expected to edit freely.

### 2) `revisioned`

Updates and deletes are allowed, but the system records:

- **revisions** for updates
- **tombstones** for deletes
- **signed ledger events** for each write

Use this when you want *operational flexibility* while preserving an auditable history.

### 3) `sealed`

Append-only semantics on protected tables.

- `UPDATE`/`DELETE` are forbidden on protected tables
- upsert-style mutations should be avoided on protected tables
- ledger events are signed and can be externally anchored

Use this for "immutable after setup" agents where identity/history should not be editable.

## Append-Only Conversation Persistence

If you enable `sealed` storage policy and persist conversations, your persistence layer must avoid `UPDATE`/`DELETE` and upsert-style mutations on protected tables.

`ConversationManagerConfig.appendOnlyPersistence=true` makes the built-in [`ConversationManager`](https://github.com/framerslab/agentos/blob/master/src/core/conversation/ConversationManager.ts) insert-only for `conversations` + `conversation_messages` and disables deletion. AgentOS does not turn it on for you: a host that runs a sealed profile sets it.

## Toolset Pinning (Recommended)

If an agent is "immutable after setup", the **tool surface area** should be immutable too.

Recommended pattern:

- choose tools/extensions during setup
- **disable dynamic tool registration** in sealed mode
- compute a **canonical toolset manifest hash** at seal time (tool IDs + package versions)
- store the manifest + hash as sealed metadata (and optionally verify it on startup)

This makes it detectable if a "sealed" agent is running against a different toolset after a deploy/upgrade.

## Key Rotation (Tool API Keys)

**Do not store tool API keys inside the immutable spec.** Instead:

- store secrets in environment variables or a secret manager (preferred), or
- store secrets in a separate credential vault that is explicitly treated as rotatable operational state

With this separation:

- the agent's *identity/spec/history* can remain sealed and verifiable
- keys can be rotated without changing the sealed agent spec

## "Forget/Delete" Semantics For Sealed Agents

Sealed mode is append-only. Hard deletes make history unverifiable.

Recommended "forget" mechanism: **soft-forget via redactions**:

- memory items have stable IDs/hashes
- "forget" appends a **redaction event** referencing the memory hash
- retrievers filter redacted hashes so the model stops seeing them
- the underlying data may remain stored (auditability). If you need real deletion later, add **crypto-shredding** (encrypt-at-rest and delete the key).

If you want humans *not* to control memory deletion, avoid admin delete endpoints/UI. Optionally expose an **agent-only** tool that can redact its own memory.

## External Anchors (Optional)

AgentOS supports external anchor providers (via extensions) with increasing proof levels:

- `verifiable`: local signed hash chain only
- `externally-archived`: WORM retention snapshot (e.g., S3 Object Lock)
- `publicly-auditable`: transparency log (e.g., Sigstore Rekor)
- `publicly-timestamped`: blockchain timestamp (OpenTimestamps/Bitcoin, Ethereum, Solana)

See `@framers/agentos-ext-anchor-providers` for provider implementations.

## Enabling Provenance In Code

The provenance system is typically wired via an extension pack:

```ts
import { profiles } from '@framers/agentos/provenance';
import { createProvenancePack } from '@framers/agentos/extensions/packs/provenance-pack';

const config = profiles.revisionedVerified(); // or mutableDev(), sealedAutonomous(), sealedAuditable(rekorEndpoint)

const pack = createProvenancePack(config, storageAdapter, 'agent-001', 'agentos_');

// Add `pack` to your extension manifest, then initialize AgentOS.
```
