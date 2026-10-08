# Provenance — Audit Trail and Tamper Evidence

> From a simple signed hash chain to publicly-timestamped Merkle roots — choose the proof level your deployment needs.

---

## Table of Contents

1. [Overview](#overview)
2. [Storage Policies](#storage-policies)
3. [HashChain and ChainVerifier](#hashchain-and-chainverifier)
4. [AgentKeyManager](#agentkeymanager)
5. [ProofLevels](#prooflevels)
6. [BundleExporter](#bundleexporter)
7. [External Anchors](#external-anchors)
8. [Toolset Pinning](#toolset-pinning)
9. [Soft-Forget (Redactions)](#soft-forget-redactions)
10. [Configuration](#configuration)

---

## Overview

AgentOS provenance is optional and additive — you can run without it for
development, then layer on as much tamper evidence as your use case requires.

The system has three concerns that are deliberately separated:

| Concern | Mechanism |
|---------|-----------|
| **What the runtime is allowed to do** | Storage policy (`mutable`, `revisioned`, `sealed`) |
| **What you can prove happened** | Signed hash chain (Ed25519 event ledger) |
| **Who can verify the proof** | Proof level (local → archived → publicly auditable) |

All three are independent. You can have a `sealed` policy with only local
verification, or a `mutable` policy with full public anchoring for analytics
purposes.

---

## Storage Policies

### `mutable` (default)

No restrictions. Updates and deletes are allowed. Suitable for development
and agents that users are expected to edit freely.

```typescript
import { AgentOS } from '@framers/agentos';

const agent = await AgentOS.create({
  provenance: { policy: 'mutable' },
});
```

### `revisioned`

Writes are allowed but fully audited. Updates append a new revision; deletes
create a tombstone. Each write produces a signed ledger event.

Use this when you need operational flexibility with a full audit trail.

```typescript
await agent.initialize({
  provenance: {
    policy: 'revisioned',
    keyPath: '~/.framers/agent-key.pem',  // Ed25519 private key
  },
});
```

With `revisioned`, the conversation history shows every version of every
message — nothing is truly overwritten.

### `sealed`

Append-only. `UPDATE` and `DELETE` are forbidden on protected tables.
The agent's identity, history, and configuration become immutable after
the seal is applied.

```typescript
await agent.initialize({
  provenance: {
    policy: 'sealed',
    keyPath: '~/.framers/agent-key.pem',
    protectedTables: ['conversations', 'conversation_messages', 'agent_events'],
    appendOnlyPersistence: true,
  },
});
```

To persist conversations correctly with `sealed`, set
`ConversationManagerConfig.appendOnlyPersistence = true` so the
conversation manager only inserts and never updates or deletes.

---

## HashChain and ChainVerifier

Every write in `revisioned` or `sealed` mode produces a signed ledger event
chained to the previous one. The hash chain provides tamper evidence:
modifying any past event breaks the chain.

```typescript
import { HashChain, ChainVerifier } from '@framers/agentos/provenance';

// The runtime maintains the chain — this is the low-level API for inspection
const chain = new HashChain({ keyPair: agentKeyPair });

// Each event is: hash(previousHash + eventData + timestamp)
const event = await chain.append({
  type: 'agent_response',
  sessionId: 'session-abc',
  turnId: 'turn-001',
  outputHash: sha256(responseText),
});

console.log(event.id);          // UUID
console.log(event.hash);        // SHA-256 of this event
console.log(event.signature);   // Ed25519 signature
console.log(event.prevHash);    // hash of the previous event
```

**Verify the chain:**

```typescript
const verifier = new ChainVerifier({ publicKey: agentPublicKey });

const result = await verifier.verify(events);

console.log(result.valid);        // true if all signatures and links check out
console.log(result.chainLength);  // number of events verified
console.log(result.brokenAt);     // index of first broken link, if any
console.log(result.errors);       // detailed error list
```

---

## AgentKeyManager

[`AgentKeyManager`](https://github.com/framerslab/agentos/blob/master/src/safety/provenance/crypto/AgentKeyManager.ts) generates and manages the Ed25519 keypair used to sign
ledger events. Keep the private key in your secure secret store; publish the
public key for third-party verification.

```typescript
import { AgentKeyManager } from '@framers/agentos/provenance';

const keyManager = new AgentKeyManager();

// Generate a new keypair (do once, store the private key securely)
const { privateKeyPem, publicKeyPem, fingerprint } = await keyManager.generateKeyPair();

console.log('Public key fingerprint:', fingerprint);
// Store privateKeyPem in your secret manager

// Load an existing key at runtime
await keyManager.loadKey(process.env.AGENT_PRIVATE_KEY_PEM!);

// Sign arbitrary data
const signature = await keyManager.sign(Buffer.from('payload'));

// Verify a signature with the public key
const isValid = await keyManager.verify(
  Buffer.from('payload'),
  signature,
  publicKeyPem,
);
```

---

## ProofLevels

Proof levels determine who can independently verify a claim about the agent's
history. Each level builds on the previous.

| Level | Description | Who can verify |
|-------|-------------|----------------|
| `verifiable` | Local signed hash chain only | Anyone with the public key |
| `externally-archived` | Chain root exported to WORM storage (S3 Object Lock, Glacier) | Anyone with storage access |
| `publicly-auditable` | Merkle root published to a transparency log | Anyone (no account required) |
| `publicly-timestamped` | Merkle root anchored to a blockchain | Anyone, with on-chain timestamp |

```typescript
await agent.initialize({
  provenance: {
    policy:     'sealed',
    proofLevel: 'publicly-auditable',
    keyPath:    '~/.framers/agent-key.pem',
    anchors: [
      {
        type:    'rekor',
        baseUrl: 'https://rekor.sigstore.dev',
      }
    ],
  },
});
```

---

## BundleExporter

Export a verifiable proof bundle for a time range — useful for audits,
compliance reports, and third-party verification:

```typescript
import { BundleExporter } from '@framers/agentos/provenance';

const exporter = new BundleExporter({
  keyManager: agentKeyManager,
  eventStore: agentEventStore,
});

const bundle = await exporter.export({
  from: '2026-01-01T00:00:00Z',
  to:   '2026-03-31T23:59:59Z',
});

// Bundle contains:
// - all events in the time range
// - the hash chain with signatures
// - the public key and its fingerprint
// - a Merkle proof if anchoring is configured

await bundle.save('./audit-bundle-Q1-2026.json');

// Verify a bundle without the runtime
const result = await BundleExporter.verifyBundle('./audit-bundle-Q1-2026.json');
console.log(result.valid);        // true
console.log(result.eventCount);   // e.g., 4821
console.log(result.anchorProof);  // Rekor log entry if publicly-auditable
```

---

## External Anchors

Configure one or more anchor providers to publish Merkle roots outside your
database, making tamper evidence verifiable by third parties.

### Sigstore Rekor (transparency log)

```typescript
anchors: [
  {
    type:     'rekor',
    baseUrl:  'https://rekor.sigstore.dev',
    schedule: '0 * * * *',   // hourly cron expression
  }
]
```

### Solana (on-chain timestamp)

```typescript
anchors: [
  {
    type:    'solana',
    network: 'mainnet-beta',
    rpcUrl:  process.env.SOLANA_RPC_URL,
    payer:   process.env.SOLANA_PAYER_KEYPAIR_JSON,
    schedule: '0 0 * * *',  // daily
  }
]
```

### Ethereum (on-chain timestamp)

```typescript
anchors: [
  {
    type:      'ethereum',
    rpcUrl:    process.env.ETH_RPC_URL,
    contractAddress: '0x...',
    privateKey: process.env.ETH_PRIVATE_KEY,
    schedule:  '0 0 * * 0',  // weekly
  }
]
```

### S3 Object Lock (WORM archive)

```typescript
anchors: [
  {
    type:   's3-object-lock',
    bucket: 'my-audit-bucket',
    region: 'us-east-1',
    retentionDays: 2555,   // 7 years
  }
]
```

---

## Toolset Pinning

For sealed agents, pin the toolset at seal time so any toolset drift is
detectable:

```typescript
import { computeToolsetHash } from '@framers/agentos/provenance';

// At seal time — record the hash
const hash = await computeToolsetHash(agent.listTools());
await sealedMetadataStore.set('toolset_manifest_hash', hash);
console.log('Toolset pinned:', hash);

// At startup — verify the toolset hasn't changed
const currentHash = await computeToolsetHash(agent.listTools());
const pinnedHash  = await sealedMetadataStore.get('toolset_manifest_hash');

if (currentHash !== pinnedHash) {
  throw new Error(`Toolset drift detected! Expected ${pinnedHash}, got ${currentHash}`);
}
```

---

## Soft-Forget (Redactions)

Sealed mode is append-only, so "forgetting" a memory is done by appending a
signed redaction event that retrievers filter on. The underlying data remains
for audit purposes; the model stops seeing it.

```typescript
import { RedactionManager } from '@framers/agentos/provenance';

const redaction = new RedactionManager({ hashChain, memoryStore });

// Soft-forget a memory trace
await redaction.redact({
  memoryId:  'trace-abc-123',
  reason:    'user-requested-deletion',
  requestedBy: 'user-456',
});

// Retriever automatically filters redacted traces
const memories = await memoryStore.retrieve({ query: '...', filterRedacted: true });
```

---

## Configuration

Full provenance configuration object:

```typescript
import { AgentOS } from '@framers/agentos';

const agent = await AgentOS.create({
  provenance: {
    // Storage policy
    policy: 'sealed',   // 'mutable' | 'revisioned' | 'sealed'

    // Signing key
    keyPath: '~/.framers/agent-key.pem',   // or:
    keyPem:  process.env.AGENT_PRIVATE_KEY_PEM,

    // Append-only conversation persistence (required for 'sealed')
    appendOnlyPersistence: true,

    // Tables to protect (default: conversations, messages, agent_events)
    protectedTables: ['conversations', 'conversation_messages', 'agent_events'],

    // Proof level
    proofLevel: 'publicly-auditable',

    // External anchor(s)
    anchors: [
      { type: 'rekor', baseUrl: 'https://rekor.sigstore.dev', schedule: '0 * * * *' },
    ],

    // Anchor batch size before forcing an anchor
    anchorBatchSize: 1000,
  },
});
```

---

## Related Guides

- [PROVENANCE_IMMUTABILITY.md](./PROVENANCE_IMMUTABILITY.md) — original full reference
- [IMMUTABLE_AGENTS.md](./IMMUTABLE_AGENTS.md) — toolset pinning, secret rotation, soft-forget
- [CHECKPOINTING.md](../orchestration/CHECKPOINTING.md) — checkpoint consistency and storage
- [OBSERVABILITY.md](../observability/OBSERVABILITY.md) — OpenTelemetry tracing alongside provenance
