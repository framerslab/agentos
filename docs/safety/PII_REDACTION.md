---
title: PII Redaction (and PHI scrubbing)
description: Four-tier PII detection and redaction guardrail for AgentOS — regex, NER, optional LLM judge, and redaction engine — covering 18 entity types including SSN, payment information, dates of birth, names, locations, and clinical terminology. Designed to slot into HIPAA-PHI scrubbing pipelines without claiming HIPAA compliance itself.
keywords:
  - pii redaction
  - phi scrubbing
  - hipaa
  - medical pii
  - agent guardrail
  - regex ner llm judge
  - data redaction
  - entity recognition
  - protected health information
  - clinical terminology
  - allowlist denylist
  - audit logger
  - streaming redaction
  - placeholder mask hash
---

# PII Redaction (and PHI scrubbing)

`@framers/agentos-ext-pii-redaction` is the guardrail that scans every message flowing through an agent for personally identifiable information, redacts matches before the message reaches downstream tools, the LLM, or storage, and emits an audit record per redaction event. It ships as an optional npm package outside the core runtime so the BERT-based NER model never enters the dependency graph for agents that do not need it.

The package covers 18 entity categories including `SSN`, `CREDIT_CARD`, `EMAIL`, `PHONE`, `IBAN`, `PASSPORT`, `DRIVERS_LICENSE`, `GOV_ID`, `DATE_OF_BIRTH`, `API_KEY`, `AWS_KEY`, `CRYPTO_ADDRESS`, `PERSON`, `ORGANIZATION`, `LOCATION`, `MEDICAL_TERM`, and a catch-all `UNKNOWN_PII` bucket for spans the LLM judge or a custom denylist flag without a more specific label.

This page is the source-verified walk-through. Every class, entity type, redaction style, and config field below corresponds to a real surface in [`packages/agentos-ext-pii-redaction/src/`](https://github.com/framersai/agentos-ext-pii-redaction/tree/master/src). It also covers, with deliberate care, what this guardrail does and does not contribute to a HIPAA-compliant healthcare deployment.

## What it actually is

A four-tier detection pipeline, plus an optional fifth LLM-judge tier, feeding into a single redaction engine that applies one of four masking strategies per matched span:

| Tier | What it does | Cost |
|---|---|---|
| **Tier 0 — Regex recognizer** | 500+ curated patterns for structured PII: phone numbers, emails, SSNs, payment cards (Luhn-validated), IBAN, passport numbers, US state driver's licenses, API tokens, AWS keys, crypto wallet addresses, IP addresses, and date-of-birth heuristics. | Deterministic, no LLM, no model load. |
| **Tier 1a — NLP prefilter** | `compromise.js`-based lightweight NLP that flags candidate spans for the heavier model. Catches obvious person names and locations without instantiating the NER model. | ~5-10ms per chunk on a laptop. |
| **Tier 1b — NER model recognizer** | BERT-based local model for `PERSON`, `ORGANIZATION`, `LOCATION`, `MEDICAL_TERM`. Loaded lazily on first scan; subsequent scans share the same instance via the SharedServiceRegistry. | First load: ~110MB and ~1-2s startup. Inference: ~30-80ms per chunk. |
| **Tier 2 — Entity merger** | Deduplicates overlapping spans across recognizers, resolves conflicts by confidence score, returns a non-overlapping sorted entity list. | In-process, microsecond-scale. |
| **Tier 3 — LLM judge (optional)** | A second LLM call (typically `gpt-4o-mini` or `claude-haiku`) that re-examines candidate spans flagged by earlier tiers and catches context-dependent PII — like a name embedded in a free-form complaint that NER missed, or a medical condition referenced by colloquial phrasing. Disabled by default. | One small LLM call per chunk when enabled. Cached via LRU (default 256 entries). |
| **Redaction engine** | Applies one of four masking strategies to the final entity list and returns the redacted text. | In-process, microsecond-scale. |

The streaming guardrail registers with `config.canSanitize = true` and `config.evaluateStreamingChunks = true`, so it runs in Phase 1 of the two-phase guardrail dispatcher. Sanitize results chain sequentially through other Phase 1 sanitizers, then the redacted text feeds Phase 2 classifiers in parallel.

## The shortest useful example

```typescript
import { AgentOS } from '@framers/agentos';
import { createPiiRedactionGuardrail } from '@framers/agentos-ext-pii-redaction';

const agentos = new AgentOS();
await agentos.initialize({
  extensionManifest: {
    packs: [
      {
        factory: () =>
          createPiiRedactionGuardrail({
            entityTypes: ['EMAIL', 'PHONE', 'SSN', 'CREDIT_CARD', 'PERSON', 'MEDICAL_TERM'],
            redactionStyle: 'placeholder',
            enableNerModel: true,
            guardrailScope: 'both',
            confidenceThreshold: 0.6,
          }),
        enabled: true,
      },
    ],
  },
});
```

Three things are happening on every turn:

1. **Inbound user messages and outbound assistant messages are both scanned** (`guardrailScope: 'both'`).
2. **Regex runs first**, then the NER model, then the entity merger collapses overlaps.
3. **Detected spans are replaced** with `[EMAIL]`, `[SSN]`, `[MEDICAL_TERM]`, etc., before the redacted text reaches the LLM, storage, or any tool.

Without `enableNerModel: true`, only regex runs. The model file enters the module graph only on the first scan that needs it — so an agent that only redacts emails and credit cards never pays the 110MB cost.

## The eighteen entity types

Defined in [`packages/agentos-ext-pii-redaction/src/types.ts:29-68`](https://github.com/framersai/agentos-ext-pii-redaction/blob/master/src/types.ts):

| Entity | Tier that detects it | Notes |
|---|---|---|
| `SSN` | Regex | US Social Security Numbers, NNN-NN-NNNN. Excludes known invalid prefixes (000, 666, 9xx). |
| `CREDIT_CARD` | Regex | 13-19 digits, Luhn-validated to suppress false positives like phone numbers. |
| `EMAIL` | Regex | RFC 5321 addresses. |
| `PHONE` | Regex | E.164 plus common local formats. |
| `IP_ADDRESS` | Regex | IPv4 and IPv6. |
| `IBAN` | Regex | ISO 13616 international bank accounts. |
| `PASSPORT` | Regex | Multi-country passport patterns. |
| `DRIVERS_LICENSE` | Regex | US state patterns and common international formats. |
| `GOV_ID` | Regex | Generic government IDs not covered above. |
| `DATE_OF_BIRTH` | Regex + NLP prefilter | Detected only when contextual signals confirm a birthday (e.g. "DOB:", "born on", parent of "year old"). |
| `API_KEY` | Regex | Bearer tokens, `sk-…`, `gh…`, etc. |
| `AWS_KEY` | Regex | `AKIA…` access key IDs and secret access keys. |
| `CRYPTO_ADDRESS` | Regex | Bitcoin, Ethereum, and major altcoin wallet patterns. |
| `PERSON` | NER model | Personal names. |
| `ORGANIZATION` | NER model | Company, agency, or institution names. |
| `LOCATION` | NER model | Cities, countries, addresses. |
| `MEDICAL_TERM` | NER model + LLM judge | Clinical terminology, diagnoses, medications, health conditions. |
| `UNKNOWN_PII` | LLM judge / denylist | Catch-all for spans flagged by the judge or by a custom denylist rule that does not map to a more specific type. |

Narrow the `entityTypes` array in the pack options to skip irrelevant patterns. Performance improves measurably when you do — the regex engine compiles only the patterns for selected types.

## Redaction styles

[`RedactionStyle`](https://github.com/framersai/agentos-ext-pii-redaction/blob/master/src/types.ts):

| Style | Example output | Use when |
|---|---|---|
| `'placeholder'` (default) | `[EMAIL]`, `[SSN]`, `[MEDICAL_TERM]` | Human-readable logs, prompts where the LLM should know that *something* was there but not what. |
| `'mask'` | `***` | The downstream consumer must not even learn the category. |
| `'hash'` | `a3f2c1d8` (SHA-256 truncated to 8 hex chars) | The same input should produce the same redacted token across runs — useful for analytics that need stable identifiers without recovering the original. |
| `'category-tag'` | `<PII type="EMAIL"/>` | Downstream consumer is another machine and needs structured tagging. |

## Allowlist and denylist

Two escape hatches:

```typescript
createPiiRedactionGuardrail({
  // Strings or regexes that should NEVER be redacted, even if a recognizer flags them.
  allowlist: ['support@example.com', /\b192\.168\.\d+\.\d+\b/],

  // Strings or regexes that should ALWAYS be redacted as UNKNOWN_PII,
  // regardless of whether any recognizer flagged them.
  denylist: ['ACME-INTERNAL-SECRET', /employee_id:\s*\d{6}/],
});
```

The allowlist resolves before the entity merger; allowlisted spans never enter the redaction engine. The denylist runs as a final pass with `source: 'denylist'` and entity type `UNKNOWN_PII`. Both accept either exact strings or `RegExp`.

## Streaming evaluation

For streaming completions, set `evaluateStreamingChunks: true` to redact PII as SSE deltas arrive rather than only at message-finalize time. This reduces the window during which PII could leak through a UI but increases CPU overhead.

```typescript
createPiiRedactionGuardrail({
  evaluateStreamingChunks: true,
  maxStreamingEvaluations: 50, // bound memory growth on long streams
});
```

The `SentenceBoundaryBuffer` collaborator inside the core runtime ([`packages/agentos/src/safety/guardrails/SentenceBoundaryBuffer.ts`](https://github.com/framersai/agentos/blob/master/src/safety/guardrails/SentenceBoundaryBuffer.ts)) coalesces partial tokens into sentence-shaped fragments before the guardrail runs, so the redactor never sees a `j` followed by `ohn` from two separate SSE chunks.

## Audit logging

Every redaction event is structured and emitted through the `agentos:pii:audit-logger` service registered in `SharedServiceRegistry`. The default implementation writes to stdout in JSON; production deployments swap in a SIEM sink (Splunk, Datadog, custom Kafka producer).

```typescript
import { PII_SERVICE_IDS } from '@framers/agentos-ext-pii-redaction';

const auditLogger = registry.get(PII_SERVICE_IDS.AUDIT_LOGGER);
auditLogger.log({
  timestamp: '2026-05-11T18:42:00Z',
  agentId: 'support-bot-prod-7',
  scope: 'output',
  entitiesDetected: [
    { entityType: 'MEDICAL_TERM', source: 'ner-model', score: 0.91 },
    { entityType: 'EMAIL', source: 'regex', score: 1.0 },
  ],
  redactionStyle: 'placeholder',
});
```

Every entry contains the entity types and detection sources but never the matched text itself. The redacted text and the original input both stay inside the runtime; only the metadata leaves.

## HIPAA, PHI, and what this guardrail is and is not

HIPAA compliance is a regulatory regime that applies to a *deploying organization*, not to a piece of software. A library cannot be "HIPAA compliant" on its own. The framework or guardrail you choose is a component; what makes a system HIPAA-conformant is the organizational wrapper around it: a Business Associate Agreement with every vendor that touches PHI, audit log retention policies, encryption at rest and in transit, access controls, breach notification protocols, periodic third-party assessments (HITRUST is common), and a designated privacy officer. None of that ships in an npm package.

What this guardrail does is provide one of the technical building blocks a HIPAA-conformant healthcare deployment commonly needs: **automatic detection and redaction of Protected Health Information categories from agent inputs and outputs**, with an audit trail of every redaction event.

The HIPAA Privacy Rule's "Safe Harbor" de-identification standard at [45 CFR §164.514(b)(2)](https://www.ecfr.gov/current/title-45/section-164.514) enumerates 18 identifier categories that must be removed for a dataset to be considered de-identified. This guardrail's recognizers cover the categories that map cleanly to text-extractable identifiers:

| 45 CFR §164.514(b)(2) identifier | Covered by which recognizer |
|---|---|
| (A) Names | `PERSON` (NER model) |
| (B) Geographic subdivisions smaller than a state | `LOCATION` (NER model) |
| (C) All elements of dates except year (DOB, admission/discharge, death) | `DATE_OF_BIRTH` (regex + NLP prefilter); other date contexts require custom recognizers or LLM-judge prompts |
| (D) Telephone numbers | `PHONE` (regex) |
| (E) Fax numbers | `PHONE` (regex, when used as fax) |
| (F) Email addresses | `EMAIL` (regex) |
| (G) Social Security Numbers | `SSN` (regex) |
| (H) Medical record numbers | `GOV_ID` (regex) + custom `denylist` patterns |
| (I) Health plan beneficiary numbers | `GOV_ID` (regex) + custom `denylist` patterns |
| (J) Account numbers | `CREDIT_CARD`, `IBAN`, custom `denylist` |
| (K) Certificate / license numbers | `DRIVERS_LICENSE`, `PASSPORT`, `GOV_ID` (regex) |
| (L) Vehicle identifiers (VINs, license plates) | Not covered out of the box; use the `denylist` |
| (M) Device identifiers and serial numbers | Not covered out of the box; use the `denylist` |
| (N) Web URLs | Not covered out of the box; add a regex pattern via custom recognizer |
| (O) IP addresses | `IP_ADDRESS` (regex) |
| (P) Biometric identifiers | Not applicable to text |
| (Q) Full-face photographs | Not applicable to text |
| (R) Any other unique identifying number, characteristic, or code | `UNKNOWN_PII` via LLM judge; custom `denylist` for known internal IDs |

Plus the `MEDICAL_TERM` recognizer covers clinical terminology that isn't in the Safe Harbor list but is often scrubbed alongside it: diagnoses, medications, condition names, procedure references.

### What this means in practice

If you are building a healthcare deployment on AgentOS:

1. **Use this guardrail in `guardrailScope: 'both'` mode** so PHI is scrubbed from inbound user messages before it reaches the LLM and from outbound assistant messages before it reaches any downstream tool or log.
2. **Enable the NER model and the LLM judge** for the strongest recall on `PERSON`, `LOCATION`, and `MEDICAL_TERM` categories.
3. **Add organization-specific `denylist` patterns** for medical record numbers, internal patient identifiers, vehicle and device serial numbers, and any other Safe Harbor categories not covered out of the box.
4. **Pipe the audit logger to your SIEM** and retain redaction events for the period your compliance program requires (commonly 6+ years for HIPAA).
5. **Use [Human-in-the-Loop](/features/human-in-the-loop)** to gate any agent action that touches PHI through a human approver until your usage patterns are validated.
6. **Sign Business Associate Agreements** with your LLM provider, your hosting platform, and any third-party tool the agent calls. AgentOS itself does not transmit data anywhere; the BAA chain is about the inference and infrastructure vendors.

This guardrail is a building block. It does not, and cannot, make a deployment HIPAA-compliant on its own. Any documentation, sales material, or compliance review claim that conflates "uses AgentOS PII redaction" with "is HIPAA-compliant" is incorrect on both directions: the guardrail covers more than HIPAA requires (financial PII, API keys), and HIPAA requires more than the guardrail provides (BAAs, audits, retention policies, encryption controls, organizational governance).

## Operational notes

**Latency.** Regex tier: microseconds per chunk. NLP prefilter: ~5-10ms. NER model first-call: ~1-2s for model load, ~30-80ms per inference after that. LLM judge: full provider round-trip (~300-800ms typical for `gpt-4o-mini`). The judge runs in parallel with other Phase 2 guardrails so it does not stack linearly with classification latency.

**Memory.** The NER model is ~110MB on disk and ~150MB resident. It loads lazily on first scan. Subsequent scans, the streaming guardrail, and the `pii_scan`/`pii_redact` tools all share the same instance through `SharedServiceRegistry`.

**Cost.** Regex and NER tiers are free at inference time after the model load. The LLM judge is the only paid surface — one small completion per scan, typically 200-500 tokens in and 50-100 tokens out. A 256-entry LRU cache reduces this further when the same text repeats across turns.

**False positives.** Phone-shaped numbers in product codes, credit-card-shaped numbers in ISBN listings, and email-shaped strings in URLs are the most common false positives. Use the `allowlist` for known safe patterns rather than disabling the recognizer category entirely.

**False negatives.** The regex tier cannot infer context: it will not flag a name as PERSON, and it will not detect a medical condition referenced colloquially ("my arthritis is acting up"). The NER model improves recall on names and locations. The LLM judge is the recall safety net for context-dependent PII.

**Streaming pitfalls.** A name split across two SSE chunks (`"Jo"` then `"hn"`) will be missed by a naive per-chunk regex. The `SentenceBoundaryBuffer` upstream of this guardrail handles fragment coalescing, so the redactor always sees sentence-shaped windows.

## Where things live

| Concern | Source |
|---|---|
| Package root | [`packages/agentos-ext-pii-redaction/`](https://github.com/framersai/agentos-ext-pii-redaction) |
| Entity type union, redaction styles, pack options | [`src/types.ts`](https://github.com/framersai/agentos-ext-pii-redaction/blob/master/src/types.ts) |
| Regex recognizer (500+ patterns) | [`src/recognizers/RegexRecognizer.ts`](https://github.com/framersai/agentos-ext-pii-redaction/blob/master/src/recognizers/RegexRecognizer.ts) |
| NER model recognizer | [`src/recognizers/NerModelRecognizer.ts`](https://github.com/framersai/agentos-ext-pii-redaction/blob/master/src/recognizers/NerModelRecognizer.ts) |
| NLP prefilter | [`src/recognizers/NlpPrefilterRecognizer.ts`](https://github.com/framersai/agentos-ext-pii-redaction/blob/master/src/recognizers/NlpPrefilterRecognizer.ts) |
| LLM judge recognizer (optional Tier 2) | [`src/recognizers/LlmJudgeRecognizer.ts`](https://github.com/framersai/agentos-ext-pii-redaction/blob/master/src/recognizers/LlmJudgeRecognizer.ts) |
| Detection pipeline orchestrator | [`src/PiiDetectionPipeline.ts`](https://github.com/framersai/agentos-ext-pii-redaction/blob/master/src/PiiDetectionPipeline.ts) |
| Redaction engine | [`src/RedactionEngine.ts`](https://github.com/framersai/agentos-ext-pii-redaction/blob/master/src/RedactionEngine.ts) |
| Service IDs for DI lookup | `PII_SERVICE_IDS` in [`src/types.ts`](https://github.com/framersai/agentos-ext-pii-redaction/blob/master/src/types.ts) |
| Streaming sentence buffer (in core) | [`packages/agentos/src/safety/guardrails/SentenceBoundaryBuffer.ts`](https://github.com/framersai/agentos/blob/master/src/safety/guardrails/SentenceBoundaryBuffer.ts) |

## Further reading

- [Guardrails Usage](/features/guardrails) for the broader guardrail dispatcher (two-phase Phase 1 sanitizers + Phase 2 classifiers) that this pack plugs into.
- [Creating Custom Guardrails](/features/creating-guardrails) for writing a custom recognizer or sanitizer.
- [Human-in-the-Loop (HITL)](/features/human-in-the-loop) for gating PHI-touching actions through human approval.
- [Safety Primitives](/features/safety-primitives) for the broader catalog of safety surfaces (cost guards, circuit breakers, tool execution guards, action deduplicators).
- [Provenance](/features/provenance) for the immutability surface that records every memory write with cryptographic chaining, useful for audit retention.

---

## References

### HIPAA reference text

- US Department of Health and Human Services. [*HIPAA Privacy Rule, 45 CFR §164.514 — De-identification of protected health information.*](https://www.ecfr.gov/current/title-45/section-164.514) The "Safe Harbor" method enumerates 18 identifier categories that must be removed for a dataset to be considered de-identified.
- US Department of Health and Human Services. [*Guidance Regarding Methods for De-identification of Protected Health Information in Accordance with the HIPAA Privacy Rule.*](https://www.hhs.gov/hipaa/for-professionals/privacy/special-topics/de-identification/index.html) The official guidance document covering both Safe Harbor and Expert Determination paths.

### NER and PII detection research

- Mansfield, C., Paullada, A., & Howell, K. (2022). [*Behind the Mask: Demographic bias in name detection for PII masking.*](https://aclanthology.org/2022.ltedi-1.10/) *Proceedings of the Second Workshop on Language Technology for Equality, Diversity and Inclusion*. Demonstrates that off-the-shelf NER models systematically under-recognize names from underrepresented demographics, leading to PII leakage gaps that the LLM-judge tier helps close.
- Nakayama, H., Kubo, T., Kamura, J., Taniguchi, Y., & Liang, X. (2018). [*doccano: Text Annotation Tool for Human.*](https://github.com/doccano/doccano) Tooling reference used for the NER training corpora that the bundled model derives from.
