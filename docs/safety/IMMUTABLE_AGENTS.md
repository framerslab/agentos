# Immutable Agents (Sealed Mode)

This doc describes the recommended end-to-end design for **immutable after setup** agents built on AgentOS. AgentOS supplies the storage policies, the signed event ledger, revisions, tombstones and anchor providers ([Provenance & Immutability](./PROVENANCE_IMMUTABILITY.md)); the sealing flow on this page (the seal marker, the toolset manifest and hash, the blocked configuration endpoints, the credential vault and redaction-based forgetting) is built by the host. AgentOS has no seal API, toolset hasher or memory-redaction event.

The key idea is: **separate immutable identity/state from rotatable operational secrets**, then use **append-only storage + cryptographic provenance** to make tampering detectable.

## Goals

- After initial configuration, an agent can be **sealed** so its identity/spec/history become **immutable by policy**.
- Changes become **tamper-evident** (signed hash chain), with optional **external anchoring** for public verification.
- Tool/API keys can still be **rotated** without creating a new agent (restart picks up new keys is acceptable).
- Long-term memory can grow "infinitely" via RAG, while still supporting "forget" without hard deletes.

## Non-goals

- Preventing a privileged host from running a different binary is out-of-scope for "policy-only" immutability.
- Providing true deletion guarantees in sealed mode requires **crypto-shredding** (see "Forget/Delete").

## Terminology (Important)

- **Immutability (policy)**: what your runtime *allows* you to mutate.
- **Tamper-evidence (verifiability)**: what you can *prove* happened (signatures + hash links).
- **Anchoring**: publishing a checkpoint outside your database so third parties can independently verify timestamp/existence.

## Two-Phase Sealing (Recommended)

Avoid the trap of "immutable from birth" (no iteration). Instead, use a two-phase lifecycle:

1. **Setup phase** (editable)
   - You can iterate on: system prompt, mood/personality, security settings, toolset, memory policy.
2. **Sealed phase** (immutable)
   - You **seal** once, then block configuration mutations permanently (except explicit secret rotation flows).

In this design, sealing means:

- `storagePolicy = "sealed"`
- a `sealedAt` marker is set (so you can default storagePolicy to `sealed` while still allowing setup edits until seal)
- protected tables switch to **append-only** semantics

## What Becomes Immutable

For an "immutable agent" to be meaningful, you must freeze the full *behavior surface area*:

- **Spec/identity**
  - system prompt / base prompt / persona overlays
  - mood/personality profile
  - security policy and moderation settings
- **Tool surface area**
  - which tools/extensions are enabled
  - tool permission allowlists
- **History**
  - conversation and message history (append-only)
  - provenance/event ledger (append-only)

## What Stays Mutable (On Purpose)

Operational state must remain rotatable, otherwise "immutability" becomes operationally brittle:

- **Tool credentials / API keys / tokens**
- **Runtime configuration** not part of the agent spec (host URLs, rate limits, retries)
- **Deploy artifacts** (you can redeploy a new build; verification is handled via toolset pinning + anchors)

## Toolset Pinning (You Want This)

If the agent is sealed but you can silently add tools later, the agent is not actually immutable.

Recommended pattern:

- Choose tools/extensions during setup.
- On seal:
  - resolve each declared capability/tool against a registry (extension ID, slug, or tool ID)
  - build a canonical **toolset manifest**
  - compute a deterministic **SHA-256 toolset hash**
  - store `{manifestJson, toolsetHash}` as sealed metadata

Then you can:

- show the `toolsetHash` in UI and receipts
- (optional but recommended) verify at startup that the current resolved toolset still matches the stored hash

### Naming: capabilities vs tools

Pick one stable "capability ID" format and stick to it. Good options:

- tool ID (e.g. `web_search`)
- extension slug (e.g. `web-search`)
- extension fully qualified ID (e.g. `com.framers.research.web-search`)

Avoid ambiguous or human-facing labels in the sealed spec.

## Key Rotation (Without Breaking Immutability)

**Never store API keys inside the immutable agent spec.**

Instead, store keys in one of:

- environment variables (simple, works for local dev)
- a secret manager (preferred in production)
- a credential vault table/service explicitly treated as rotatable operational state

Operational rule for sealed agents:

- rotation is allowed (update the secret value)
- restart is allowed (agent picks up new key)
- adding *new* tools/credential types after sealing is disallowed (because that changes the tool surface area)

## Memory: Infinite Context via RAG (And Still Sealed)

"Infinite context" is achieved by:

- persisting atomic memory items (facts, preferences, decisions) to a knowledge store
- retrieving relevant subsets at inference time (RAG)
- keeping the canonical history append-only

Sealed mode mainly changes **who can edit/delete** memory:

- humans/admins should not be able to rewrite the agent's memory
- memory should grow append-only

### "Forget/Delete" in Sealed Mode

Hard deletes break verifiability.

Recommended sealed-mode behavior:

- memory items have stable IDs/hashes
- "forget" appends a **redaction event** referencing that hash
- retrievers filter redacted hashes so the model stops seeing them

This is "soft-forget" (tombstoning). If you require real deletion later:

- encrypt memory at rest per-tenant or per-agent
- delete the key ("crypto-shredding")

### Who Is Allowed to Forget?

Recommended policy:

- **agent-only** forget: the agent can redact its own memories (as a tool call / internal capability)
- no human/UI delete for sealed agents (to avoid covert memory editing)

If you want "human forget", treat it as a governance action and make it explicit/auditable (and accept that it changes behavior).

## Tamper-Evidence and Anchoring Options

There are three practical levels:

1. **Local verifiable (signed chain)**
   - best default for centralized deployments
   - you can verify integrity, but you're trusting the operator for availability/retention
2. **Public transparency log**
   - e.g. **Sigstore Rekor**
   - strong public auditability without choosing a specific chain
3. **Public timestamping / blockchain anchors**
   - e.g. **OpenTimestamps** (Bitcoin proofs), Ethereum, Solana
   - useful when you want ecosystem-native proofs or on-chain consumption

### Rekor vs OpenTimestamps (Pros/Cons)

- **Rekor (transparency log)**
  - Pros: public audit log, inclusion proofs, easier "anyone can verify" story
  - Cons: you're trusting the log operator for availability (still auditable), different threat model than a blockchain
- **OpenTimestamps**
  - Pros: cheap, chain-agnostic client flow, ultimately anchored to Bitcoin
  - Cons: verification UX is more specialized; not a general "transparency log"

Practical recommendation:

- Start with **local signed chain** for all sealed agents.
- For "decentralized / public verification" deployments, add **Rekor** and/or **OpenTimestamps** as optional anchors.
- Add Solana/Ethereum anchors only when you need chain-native proofs or integration with on-chain workflows.

## Admin Overrides (Break-Glass)

If an admin can silently edit a sealed agent, it's not immutable.

If you *must* support break-glass:

- implement it as a separate, explicit, irreversible event in the ledger
- treat the agent as "modified" (verification should reflect this)
- consider requiring a new agent identity/spec for any behavioral change

## Building It on AgentOS

- The storage policy, the ledger and anchoring: `profiles.sealedAutonomous()` or `profiles.sealedAuditable(rekorEndpoint)` with `createProvenancePack()` ([Provenance & Immutability](./PROVENANCE_IMMUTABILITY.md)).
- Append-only conversations: `ConversationManagerConfig.appendOnlyPersistence: true`.
- The seal marker, the toolset manifest and its hash, the blocked configuration endpoints, the credential vault and the redaction events: host code.

See:

- [Provenance & Immutability](./PROVENANCE_IMMUTABILITY.md)
- [RAG Memory Configuration](../memory/RAG_MEMORY_CONFIGURATION.md)
