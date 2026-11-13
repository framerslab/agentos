# Guardrails Usage Guide

:::tip See also
For creating custom guardrails, see [Creating Custom Guardrails](./CREATING_GUARDRAILS.md). For the underlying safety primitives, see [Safety Primitives](./SAFETY_PRIMITIVES.md).
:::

Guardrails are safety mechanisms that intercept and evaluate content before it enters or exits the AgentOS pipeline. They enable content filtering, PII redaction, policy enforcement, and mid-stream decision overrides.

## Overview

Guardrails intercept content at two points:

1. **Input Guardrails** - Evaluate user messages before orchestration
2. **Output Guardrails** - Evaluate agent responses before streaming to client

```
User Input → [Input Guardrails] → Orchestration → [Output Guardrails] → Client
```

When multiple guardrails are active, AgentOS uses a **two-phase dispatcher**:

1. **Phase 1 (sequential sanitizers)** - Guardrails with `config.canSanitize === true` run in registration order so each sanitizer sees the cumulative sanitized text; so do screens with `config.sequential === true`, whose BLOCK ends the evaluation before Phase 2 starts
2. **Phase 2 (parallel classifiers)** - All remaining guardrails run concurrently via `Promise.allSettled`, with worst-action aggregation (`BLOCK > FLAG > ALLOW`)

This keeps redaction deterministic while still allowing heavyweight classifiers and grounding checks to run in parallel.

## Built-in Guardrail Packs

The extensions registry has six guardrail packs, each a standalone package:

| Pack | Package | What It Does |
|------|---------|-------------|
| **PII Redaction** | `@framers/agentos-ext-pii-redaction` | Four-tier PII detection (regex patterns from `openredaction`, an NLP prefilter, an NER model, an LLM judge) on input and output; a Phase 1 sanitizer. Tools: `pii_scan`, `pii_redact` |
| **ML Classifiers** | `@framers/agentos-ext-ml-classifiers` | Toxicity, prompt injection, NSFW and threat classification (ONNX models, with LLM and keyword fallbacks). Tool: `classify_content` |
| **Topicality** | `@framers/agentos-ext-topicality` | Embedding-based topic enforcement on user input, with LLM and keyword fallbacks; output passes unevaluated. Tool: `check_topic` |
| **Code Safety** | `@framers/agentos-ext-code-safety` | OWASP Top 10 code scanning (25 regex rules). Tool: `scan_code` |
| **Grounding Guard** | `@framers/agentos-ext-grounding-guard` | RAG-grounded hallucination detection via NLI. Tool: `check_grounding` |
| **Content Policy Rewriter** | `@framers/agentos-ext-content-policy-rewriter` | Opt-in content policy: a keyword pre-filter on streamed text and an LLM judge on the final response that blocks or rewrites it |

## Quick Start

```typescript
import { AgentOS, AgentOSResponseChunkType } from '@framers/agentos';
import { createTestAgentOSConfig } from '@framers/agentos';
import {
  IGuardrailService,
  GuardrailAction,
  type GuardrailInputPayload,
  type GuardrailOutputPayload,
  type GuardrailEvaluationResult,
} from '@framers/agentos/safety/guardrails';

// Simple content filter
class ContentFilter implements IGuardrailService {
  async evaluateInput({ input }: GuardrailInputPayload): Promise<GuardrailEvaluationResult | null> {
    if (input.textInput?.toLowerCase().includes('prohibited')) {
      return {
        action: GuardrailAction.BLOCK,
        reason: 'Content violates usage policy',
        reasonCode: 'CONTENT_POLICY_001',
      };
    }
    return null; // Allow
  }
}

// Initialize with guardrail
const agent = new AgentOS();
const base = await createTestAgentOSConfig();
await agent.initialize({
  ...base,
  guardrailService: new ContentFilter(), // Optional config-scoped guardrail
});
```

## Guardrail Actions

| Action | Effect |
|--------|--------|
| `ALLOW` | Pass content unchanged |
| `FLAG` | Pass content, record metadata for audit |
| `SANITIZE` | Replace content with modified version |
| `BLOCK` | Reject/terminate the interaction |

A `BLOCK` can also carry `hold: { reviewCode }`: the content is kept back for a person's review instead of refused. See [Holding Content for Review](#holding-content-for-review).

## Holding Content for Review

A guard that cannot decide alone keeps the content back for a person to look at. It answers a `BLOCK` with `hold`, or builds the same answer with `holdResult()`:

```typescript
import { GuardrailAction, holdResult, type IGuardrailService } from '@framers/agentos/safety/guardrails';

const reviewer: IGuardrailService = {
  id: 'needs-review',
  config: { reasonCodes: ['NEEDS_REVIEW', 'REVIEW_LINKS'] },
  async evaluateInput({ input }) {
    if (!/https?:\/\//.test(input.textInput ?? '')) return null;
    return holdResult('REVIEW_LINKS', { reasonCode: 'NEEDS_REVIEW' });
    // the same as { action: GuardrailAction.BLOCK, reasonCode: 'NEEDS_REVIEW', hold: { reviewCode: 'REVIEW_LINKS' } }
  },
};
```

- **A hold is a BLOCK everywhere.** Every enforcement point (input, a streamed delta, the final reply, a tool call) treats it as the `BLOCK` it is, so nothing it keeps back is delivered and a held tool call never runs.
- **A refusal outranks a hold.** When one guard holds and another refuses in the same phase, the refusal decides, whichever was registered first; the hold stays in `evaluations`. A sanitizer (`canSanitize: true`) runs before the others, one at a time, and any `BLOCK` it answers, a hold included, ends the evaluation before the later guards run. A hold outranks a `FLAG`, a `SANITIZE` and an `ALLOW`. Cross-agent guards stop at the first `BLOCK`, a hold included.
- **Which it was.** `GuardrailInputOutcome.outcome` is always set: `'allow'`, `'flag'`, `'sanitize'`, `'hold'` or `'block'`. `guardrailOutcomeOf(evaluations)` gives the same answer for any list, and `isGuardrailHold(evaluation)` says whether one evaluation is a hold.
- **What the caller receives.** Under `processRequest()` a held input ends the turn as a block does: one ERROR chunk, with the hold in `details.hold` (`{ reviewCode }`) beside `details.action`. A held reply ends the stream the same way, and `onVerdict` receives `hold` on its verdict; so does a hold on the text before an actionable tool call in hold mode, whose verdict also names the withheld calls in `toolCallIds`. A hold on output that carries a `replacementText` (`holdResult('REVIEW', { replacementText: 'Waiting for review' })`) is delivered as that fixed reply, a FINAL_RESPONSE chunk and not an ERROR, with the hold in its `metadata.guardrail.output`; a host that queues held replies reads both places. The serialised evaluation in chunk metadata carries `hold` too.
- **The host does the rest.** It stores the content, tells the sender it is waiting for review and puts it in its review queue under `reviewCode`. The library keeps nothing.
- **Where a host gets a held reply.** A held input is the host's own input. A held reply is not in what the caller receives: the ERROR chunk and a fixed reply carry the hold and no text, and under `processRequest()` the `onVerdict` callback is AgentOS's own, used to drop withheld tool calls and rewrite the stored reply. A host that queues held replies keeps the text where the hold is decided and queues it only once the caller receives that hold: the guard that holds gets the reply in its `evaluateOutput()` payload and stages it under the stream id and its own id; the host queues it when the stream ends in that guard's hold (`details.hold` with the guard's id in `details.metadata`, or a fixed reply whose `metadata.guardrail.output` names it) and discards it otherwise, since in phase 2 another guard's refusal outranks the hold. A guard on streamed deltas sees a delta, not the whole reply; a host that needs the whole reply decides holds on the final reply, with hold mode on. A host that drives a stream itself with `wrapOutputGuardrails()` passes its own `onVerdict`, whose `originalText` is the reply as the guards judged it on a final reply, and null on a verdict for a streamed delta.
- **A release goes through the guards again.** A held message may not have been judged by every guard: a sanitizer's hold ends phase 1, so no phase 2 guard read it. A host that releases a held message after a person's review runs the guards on it again before delivering it.
- **A hold on another action is ignored.** `hold` counts only with `BLOCK`. On a `FLAG` or a `SANITIZE` the dispatcher ignores it and writes `guardrail.hold_ignored` once for that guard; a `SANITIZE` of a tool call is applied as a `BLOCK` that is a refusal, not a hold.
- **Codes.** A `reviewCode` is letters, digits and underscores, at most 64. `toModerationEvaluation()` reports an evaluation without its `reason` and `details`, and writes a code outside its shape as `INVALID_CODE`.

A guard's failure is a typed event, not a console line: a throw or a timeout writes `guardrail.failed` with the guard's id, the stage, the posture (`open` or `closed`), the cause and the error's listed type and code, never its message (see [Logging](../observability/LOGGING.md)). Under `processRequest()` a guard with no `failClosed` is still skipped when it throws.

## Content Between People: `moderateContent()`

One call judges a message, a post or an upload that one person sends another, before the host delivers it:

```typescript
import { moderateContent, PhraseListGuardrail } from '@framers/agentos/safety/guardrails';

const hardBan = await PhraseListGuardrail.create({ id: 'hard-ban', sequential: true, source: reviewedList });

const decision = await moderateContent(
  { text: message.text, images: message.images },
  {
    guards: [hardBan, vendorClassifier, reviewer],
    context: {
      userId: sender.id,
      sessionId: room.id,
      moderation: { surface: 'public_room', roomId: room.id, rating: 'standard', messageId: message.id },
    },
    stopVendorsOn: ['MINOR_SAFETY'],
  },
);

if (decision.outcome === 'refuse' && decision.unavailable) tellSenderToRetry();
else if (decision.outcome === 'refuse') refuse(decision.deciding?.reasonCode);
else if (decision.outcome === 'hold') queueForReview(decision.hold?.reviewCode);
else deliver(decision.sanitizedText ?? message.text);
```

- **Four outcomes.** `allow`, `flag`, `refuse` and `hold`. A `refuse` with `unavailable: true` means nothing but a guard that threw, ran late or answered no recognised action, or an image the [image guard](#images-imageguardrail) could not have checked, kept the content back: no rule refused it and no guard held it. A host tells the sender and does not count it as a policy refusal.
- **Every guard runs closed** unless its config says `failClosed: false`, with a deadline of 8 seconds when neither its config nor the call's `timeoutMs` names one. A closed guard that throws, runs late or answers no recognised action (`undefined` included; `null` is an allow) becomes a `BLOCK` with `metadata.failClosed: true` and `metadata.cause` (`error`, `timeout` or `malformed`), and writes one `guardrail.failed` line with `posture: closed`. The library marks that `BLOCK` outside the answer: a guard that writes `failClosed`, `cause` or a library code into its own answer gives a rule's refusal, never an outage. A guard with `failClosed: false` is skipped and writes the same line with `posture: open`.
- **What decides,** in this order: the first `BLOCK` a rule gave (not a hold, not a closed guard's failure); else the first hold; else the first closed guard's failure; else the first `FLAG`; else nothing. So among the guards that ran, one guard's outage never hides another guard's refusal or hold. A screen with `sequential: true` that fails ends the evaluation as its `BLOCK` would, so no phase 2 guard sees that text: a screen that is down cannot say the text is not one it refuses. `deciding` is that evaluation, `evaluations` holds every evaluation in registration order, and `hold` is set when the outcome (or `wouldBe`) is `hold`. `guardrailOutcomeOf()` keeps the plainer order of the older entry points, where any refusal comes first.
- **No content in the decision but two fields.** It carries codes, ids and scores: each evaluation as `toModerationEvaluation()` reports it, without the guard's `reason` and `details`. Two fields can hold a person's text: `sanitizedText`, and an evaluation's `metadata`, which is the guard's own and passes through as the guard wrote it. A guard keeps the text out of its `metadata`, and a host keeps `sanitizedText` out of its logs.
- **`sanitizedText`.** In `enforce`, the text as the guards with `canSanitize` left it, when one changed it, whatever the outcome; `''` when one removed it (`modifiedText: null`), so `sanitizedText ?? message.text` never brings the text back. A rewrite alone is an `allow` with `sanitizedText`.
- **Dry run.** With `mode: 'dryRun'` every guard runs as it would in enforcement, and a screen's `BLOCK` still ends the evaluation. `outcome` is always `allow`, `wouldBe` is the outcome enforcement would have given, `enforced` is false, `unavailable` says what enforcement would have reported, and `sanitizedText` is never set. A `mode` other than `enforce` or `dryRun` throws a `TypeError` before any guard runs.
- **Stopping vendor requests.** `stopVendorsOn` lists reason codes and review codes. Every guard of the call receives the same `context.vendorSignal`, and it is aborted the moment a guard answers one of those codes, while the other guards are still running. A guard that reads it starts no new vendor request. A request already sent is still answered.
- **A guard that cannot judge input** is a configuration error: the call throws a `TypeError` naming a guard that has no `evaluateInput`, or declares `stages` without `input`. A guard with no `id` is reported as `guard_<its index>`.
- **One line per decision.** A decision other than `allow` writes one `guardrail.verdict` line, and so does an `allow` whose text a guard rewrote (with `action: sanitize`); any other allow writes none (see [Logging](../observability/LOGGING.md#guardrail-events)).

The closed default belongs to `moderateContent()`. Under `processRequest()`, `evaluateInputGuardrails()` and `wrapOutputGuardrails()` a guard with no `failClosed` is still skipped when it throws. `withModerationPosture(guard)` returns a guard wrapped the way `moderateContent()` wraps it, for a host that calls the dispatcher itself.

## Screens That Run First

A guard with `config.sequential: true` runs in phase 1, one at a time in registration order with the guards that can sanitize, though it does not rewrite. Its `BLOCK` ends the evaluation before any phase 2 guard is called, so text a local list refuses never reaches a phase 2 guard that calls a vendor, in enforcement and in a dry run. A phase 1 guard registered before the list still runs before it: register the list ahead of any sanitizer that calls a vendor. On a tool call the guards with `sequential` answer before the other guards that set `evaluateToolCalls`, and a `BLOCK` among them is the verdict before those are called. A `SANITIZE` from it is applied only when `canSanitize` is also true; otherwise it becomes a `FLAG` and writes `guardrail.sanitize_downgraded`. The phrase-list guard takes the option:

```typescript
const hardBan = await PhraseListGuardrail.create({
  id: 'hard-ban',
  sequential: true,
  source: new StaticPhraseListSource({
    version: '3', reviewedAt: '2026-11-10', reviewedBy: 'trust-and-safety',
    entries: [{ phrase: 'a banned phrase', match: 'word', onMatch: 'block', ruleId: 'BAN_1' }],
  }),
});
```

A screen is local only when its list is. `sequential` orders guards; it does not stop one from calling out. A list with `judge` entries sends a matched text to its judge's model from inside the screen, so a host that wants no network call before its vendor guards keeps `block` entries alone in the screen and its `judge` entries in a second list without `sequential`.

## Typed Context

`context.moderation` tells a guard where the content appears and who wrote it:

| Field | Shape | Meaning |
|---|---|---|
| `surface` | a word, required | `public_room`, `private_chat`, `group_chat`, `discussion_page`, `agent_turn`, `generated_media`, `upload`, `report_evidence`, or a word of the host's own |
| `roomId` | an id | The place the content appears in: a room, a thread, a page |
| `rating` | a word | The place's content rating, in the host's own words (`safe`, `standard`, ...) |
| `messageId` | an id | The content's own id in the host's store |
| `sender` | `{ id, kind? }` | Who wrote it, when that is not the call's `userId`; `id` is an id, `kind` is `account`, `guest` or `agent` |

A word is letters, digits and `_ . : -`, at most 64 characters; an id is letters, digits and `_ . : / -`, at most 128. `moderateContent()` checks the field with `assertModerationContext()` before any guard runs and throws a `TypeError` that names the field and never its value. A host whose ids hold other characters (an email address, a provider's `auth|id`) passes a surrogate key of its own. Guards read `context.moderation?.rating` and its siblings; `context.metadata` stays as it is for everything else.

### Text a person wrote, framed as data

A guard or an agent that hands a person's text to a model frames it with `frameUntrustedEvidence()` and puts `UNTRUSTED_EVIDENCE_NOTICE` in the system prompt:

```typescript
import { UNTRUSTED_EVIDENCE_NOTICE, frameUntrustedEvidence } from '@framers/agentos/safety/guardrails';

const { text } = frameUntrustedEvidence(message.text, { label: `message:${message.id}` });
// [message:m1]
// <<evidence:9f2c41d07ab3e855>>
// ...the text...
// <<end:9f2c41d07ab3e855>>
```

The two markers share a random boundary of 16 hexadecimal characters, new on every call. Any copy of it in the text is removed, null bytes are dropped, and chat-template tokens (`<|...|>`, `[INST]`, `[/INST]`, `<s>`, `</s>`) are broken with a space, in the text and in the label's line (a label `INST` is written `[ INST]`). The label, when given, must be an id. Framing lowers how often instructions planted in the text work; it does not make a model ignore them, so an agent that acts on such text is also held to limits and checked evidence.

## Guards Under the Text Functions

`generateText()` and `streamText()` take `guards`, and so do an agent's `generate()`, `stream()` and a session's `send()` and `stream()`:

```typescript
import { GuardrailStopError, generateText } from '@framers/agentos';

const result = await generateText({
  provider: 'openai',
  prompt,
  tools,
  guards: { services: [hardBan, classifier], context: { userId: user.id, sessionId: thread.id, moderation: { surface: 'agent_turn' } } },
});
```

- **Three stages.** The call's own user turn is judged once, before the first provider request. Each tool call the model makes is judged by the guards that set `evaluateToolCalls`, on the arguments the model sent, before `onBeforeToolExecution` and so before any approval. The whole reply is judged before the caller receives it. `stages` picks among `input`, `toolCalls` and `output`.
- **Closed by default.** Each guard runs as `moderateContent()` runs it: closed unless its config says `failClosed: false`, with a deadline, and what decides a stage is what decides `moderateContent()`.
- **A stop** rejects with `GuardrailStopError` (`GUARDRAIL_BLOCKED`, `GUARDRAIL_HELD` or `GUARDRAIL_UNAVAILABLE`); a stream yields it as one `error` part. The input and output stages run once per call, outside the fallback chain, so a stop is not retried on a fallback provider. A refused tool call is not a stop: the tool does not run, the model reads the refusal as the call's result and the loop goes on.
- **A replacement reply.** A `BLOCK` that carries a non-empty `replacementText` on the input is the reply, and no request is made; on the output it takes the reply's place.
- **The report.** `guardReport` carries codes and ids: no guard's reason, no prompt, no reply, and no call id from a provider.

[Guards on a call](../getting-started/HIGH_LEVEL_API.md#guards-on-a-call) has the options, the error, the report and what a stream delivers after a stop.

## The Dry Run

`mode: 'dryRun'` on `moderateContent()` and on `guards` runs every guard as enforcement would, and changes nothing:

- Every verdict is reported with `enforced: false`: `moderateContent()` answers `allow` with `wouldBe`, and `guards` passes each verdict to `onVerdict` and writes its `guardrail.verdict` line with `mode: dry_run`.
- Under `guards` the input is sent as given, tools run and text passes. A stream's output guards judge the whole reply once it was delivered.
- A screen's `BLOCK` still ends its evaluation, so a dry run calls the guards enforcement would call and no others.

## Images: `ImageGuardrail`

`ImageGuardrail` judges the images of an input (`visionInputs`, which `moderateContent()` fills from `content.images`). It holds the order of the checks and no vendor code: the host hands it its checks.

```typescript
import { ImageGuardrail, moderateContent, type ImageCheck } from '@framers/agentos/safety/guardrails';

const hashCheck: ImageCheck = {
  id: 'hash',
  kind: 'match',
  reasonCodes: ['KNOWN_MATERIAL'],
  async check(image) {
    return (await hashService.lookup(image.bytes)) ? { verdict: 'block', reasonCode: 'KNOWN_MATERIAL', quarantine: true } : { verdict: 'pass' };
  },
};
const visionCheck: ImageCheck = {
  id: 'vision',
  kind: 'classify',
  reasonCodes: ['IMAGE_EXPLICIT', 'IMAGE_REVIEW'],
  async check(image) {
    const score = await visionModel.score(image.bytes, image.mimeType);
    if (score > 0.9) return { verdict: 'block', reasonCode: 'IMAGE_EXPLICIT' };
    if (score > 0.6) return { verdict: 'hold', reviewCode: 'IMAGE_REVIEW' };
    return { verdict: 'pass' };
  },
};

const images = ImageGuardrail.create({
  id: 'images',
  checks: [hashCheck, visionCheck], // every match check first
  requireMatch: true,               // a surface that takes people's uploads
  sequential: true,                 // the image checks finish before any vendor guard reads the text
  loadImage: (url) => fetchUnderEgressRules(url),
});

const decision = await moderateContent({ text: message.text, images: message.images }, { guards: [images, textClassifier], context });
```

- **Two kinds of check, in a fixed order.** A `match` check compares an image with known material (a hash service). A `classify` check sends it to a model. The guard runs every `match` check on every image (images in order, checks in list order) before it runs any `classify` check on any image. `create()` keeps its own copy of each check as it was validated, so editing a check object afterwards changes nothing. It throws a `TypeError` on an empty list, on a list with no `classify` check, on a `classify` check listed before a `match` check, on a `match` check with `onError: 'skip'`, on an `onError` other than `refuse` or `skip`, on a reason code that is not a word (letters, digits and `_ . : -`, at most 64), on two checks with one id or a check whose id is `load`, and, with `requireMatch: true`, on a list with no `match` check.
- **A quarantine ends the evaluation.** A `block` with `quarantine: true` on any image ends the whole evaluation there. From a `match` check, no `classify` check has run on any image of the input, and none runs, so nothing of it reaches a model. From a `classify` check, no further check runs on that image or any other. The decision is a `refuse` whose `deciding.metadata` carries `quarantine: true`.
- **What ends one image's chain.** Any other `block`, a `hold`, or a check that could not answer keeps that image from every `classify` check still to run; the other images go on. The other `match` checks still run on it, so a later one can still find known material and quarantine it: a list that holds or blocks, or is down, never hides a hash match. The first `block` on an image decides it. A `flag` and a `pass` let the next check run.
- **`requireMatch`.** For a surface that takes people's uploads: the guard cannot be built until a `match` check exists. Without it a list of `classify` checks alone is allowed, for a host's own generated images.
- **A check that fails.** A check that throws, or answers no verdict, writes one `image_guard.check_failed` line. With `onError: 'refuse'` (the default) the image is refused as unavailable and goes to no `classify` check, though the other `match` checks still run on it. A `classify` check with `onError: 'skip'` is a signal: its failure is written with `posture: skip` and the chain goes on. A `match` check is never skipped.
- **An image nobody judged is refused.** An image counts as judged only when a `classify` check answered for it, or a check held or blocked it. A `match` check's `pass` says the image is not known material; it says nothing of what the image shows. An image no `classify` check answered for (each one that ran was skipped, or `context.vendorSignal` stopped them) is refused as unavailable, whatever the `match` checks answered.
- **Unavailable.** An image refused as unavailable is a `BLOCK` with `reasonCode: 'IMAGE_CHECK_UNAVAILABLE'`, `metadata.failClosed: true` and the id of the check that could not answer (`classify` when none answered). `moderateContent()` reports it `unavailable: true` and ranks it below another guard's refusal or hold, as it ranks a closed guard's failure. The host tells the sender the image could not be checked.
- **One capture, the same bytes for every check.** Before any check runs, the guard captures each image once: a `base64` input is decoded (a `data:` URL is allowed when it says `;base64`, and gives the mime type when `mimeType` is unset); an `image_url` input is handed to the host's `loadImage`, which fetches it under the host's own egress rules. The guard fetches nothing itself. The mime type is the input's `mimeType`, else the one `loadImage` returns. The guard judges the bytes it captured and leaves the input as it came: on the agent's own path (`processRequest()`) an `image_url` input still goes to the model as its URL, which the model's provider fetches again. Where a URL's server could answer differently the second time, hand the turn the bytes (a `base64` input, or a URL of storage you control whose content does not change). Each check receives its own copy of those bytes as an `ImageUnderReview` (`index`, `bytes`, `mimeType`) and never the URL, so a server that would answer the hash service and a model with different bytes gets no second request. An `image_url` input with no `loadImage`, a `loadImage` that throws or returns no bytes, a `base64` input that does not decode (a `data:` URL without `;base64` included), and an image with no mime type are refused as unavailable, with one `image_guard.check_failed` line whose `checkId` is `load`.
- **Store what was judged.** A host that passes `loadImage` stores and serves the bytes it loaded, and never the URL again: the guard cannot see what a viewer later fetches from it.
- **`maxImages`** (default 4). An input with more images is refused with `IMAGE_LIMIT` before any check runs. An input with no images is not judged by this guard.
- **`maxBytes`** (default 20971520, 20 MiB). An image larger than this is refused with `IMAGE_LIMIT` (`metadata.imageIndex` names it) and no check runs on it; the input's other images are still checked, so a quarantine on one of them still decides. `base64` text is measured before it is decoded, and the bytes `loadImage` returns as they come back; a `loadImage` that can fetch large files limits its own download too.
- **`sequential`.** With `sequential: true` the guard runs in phase 1 (see [Screens That Run First](#screens-that-run-first)), so the image checks finish before any phase 2 guard sees the input's text, and a quarantine keeps the text from the vendor guards too. Without it the text guards run beside the image checks.
- **`timeoutMs`** (default 15000) is the deadline for the whole evaluation, every check of every image included. As a required guard the guard runs under its spec's `timeoutMs` instead, and the guard keeps whichever deadline comes first: its own, or the dispatcher's (`deadlineSignal`). The dispatcher answers at the deadline and does not wait for the guard; past it the guard starts no further capture or check, so no image goes to a vendor after the decision, and an image whose checks had not all run is refused as unavailable, named by the step that did not start (`load` or a check's id). A request a check had already sent is not stopped. Images and checks run one after another, so size the deadline for the slowest input you accept: with `maxImages` 4, a hash check of 0.5 s and a model check of 4 s need about 18 s, past the default.
- **The verdict over all images.** A check's `block`, then a `hold`, then an image refused as unavailable, then a `flag`; the first image wins a tie. `metadata` is `{ guardrailId, imageIndex, checkId }`, with `quarantine` on a quarantine and the check's `scores` on a flag (only finite numbers under keys that are words; any other entry is dropped). A `block` or `flag` whose `reasonCode`, or a `hold` whose `reviewCode`, is not a word counts as a check that could not answer. `config.reasonCodes` lists `IMAGE_LIMIT`, `IMAGE_CHECK_UNAVAILABLE` and every code the checks list in their `reasonCodes`, so the `guardrail.verdict` line names the code.
- **Generated images** are judged the same way: the host passes the image to `moderateContent()` with `context.moderation.surface: 'generated_media'`.

No check is built in, and a host that registers no `ImageGuardrail` has no image guard. The library writes no image data, URL or description to a verdict or a log line: a verdict carries the guard's and the check's ids, the image's index and the check's codes and scores. The codes and score keys are the check's own words, so a check keeps anything about the image out of them. To write a check of your own, see [Writing an image check](./CREATING_GUARDRAILS.md#writing-an-image-check).

## Mid-Stream Decision Override ("Changing Mind")

Guardrails can evaluate streaming chunks in real-time and "change their mind" about allowing content. The examples below import `AgentOSResponseChunkType` from `@framers/agentos` (as the Quick Start does): chunk types are lowercase strings such as `'text_delta'`, so compare against the enum. This enables:

- Stopping generation when cost ceiling is exceeded
- Blocking harmful content as it's being generated
- Redacting sensitive information mid-stream

### Example 1: Cost Ceiling Guardrail

Stop generation when the response exceeds a token budget:

```typescript
class CostCeilingGuardrail implements IGuardrailService {
  // Enable streaming evaluation
  config = { evaluateStreamingChunks: true };

  private readonly maxTokens = 1000;
  // Characters per response stream, and when each stream was last seen
  private readonly streams = new Map<string, { chars: number; seenAt: number }>();

  async evaluateOutput({ chunk }: GuardrailOutputPayload): Promise<GuardrailEvaluationResult | null> {
    // The stream's final chunk ends its count
    if (chunk.isFinal) {
      this.streams.delete(chunk.streamId);
      return null;
    }

    // Only evaluate text chunks
    if (chunk.type !== AgentOSResponseChunkType.TEXT_DELTA || !chunk.textDelta) {
      return null;
    }

    const now = Date.now();
    let stream = this.streams.get(chunk.streamId);
    if (!stream) {
      // A stream that ended without a final chunk left its entry: drop the ones idle for ten minutes
      for (const [id, idle] of this.streams) {
        if (now - idle.seenAt > 600_000) this.streams.delete(id);
      }
      stream = { chars: 0, seenAt: now };
      this.streams.set(chunk.streamId, stream);
    }
    stream.chars += chunk.textDelta.length;
    stream.seenAt = now;

    // Estimate tokens (rough: 1 token ≈ 4 chars)
    const tokensUsed = Math.ceil(stream.chars / 4);

    if (tokensUsed > this.maxTokens) {
      this.streams.delete(chunk.streamId);
      // "Change mind" - stop generating mid-stream
      return {
        action: GuardrailAction.BLOCK,
        reason: 'Response exceeded token budget. Please refine your request.',
        reasonCode: 'COST_CEILING_EXCEEDED',
        metadata: { tokensUsed, limit: this.maxTokens },
      };
    }

    return null;
  }
}
```

The guardrail counts characters per `streamId`, so each response is measured on its own, and the stream's final chunk, which every output guardrail is called for, ends the count. A stream can end without a final chunk (another guardrail blocked it, or it failed), so an entry left idle for ten minutes is dropped when the next stream starts. It sets no `maxStreamingEvaluations`: once a stream reaches that limit, the dispatcher stops calling the guardrail on the stream's text deltas (it still calls it on the final chunk), and the count would stop short of the budget.

### Example 2: Real-Time PII Redaction

The `@framers/agentos-ext-pii-redaction` pack detects PII in four tiers (regex patterns from the `openredaction` library, an NLP prefilter, a BERT NER model, an LLM judge): emails, phone numbers, SSNs, payment cards, IP addresses, IBANs, passports, driver's licenses, other government IDs, dates of birth, API and AWS keys, crypto addresses, medical terms, and person, organization and location names. See the [PII Redaction extension docs](/docs/extensions/built-in/pii-redaction) for full configuration reference.

```typescript
import { createPiiRedactionGuardrail } from '@framers/agentos-ext-pii-redaction';

const piiPack = createPiiRedactionGuardrail({
  confidenceThreshold: 0.5,
  redactionStyle: 'placeholder',  // also: 'mask', 'hash', 'category-tag'
  enableNerModel: true,            // BERT NER for person/org/location names
  llmJudge: {                      // optional: resolve ambiguous cases
    provider: 'anthropic',
    model: 'claude-haiku-4-5-20251001',
    apiKey: process.env.ANTHROPIC_API_KEY,
  },
});

const agent = new AgentOS();
await agent.initialize({
  ...config,
  extensionManifest: { packs: [{ factory: () => piiPack }] },
});
```

The extension provides two agent-callable tools (`pii_scan` and `pii_redact`) and a streaming guardrail that automatically redacts PII from input and output. It sets `canSanitize: true` so it runs in Phase 1 (sequential) of the parallel dispatcher.

#### Custom regex-only PII guardrail

If you only need simple regex patterns (no NER, no LLM), you can write a lightweight custom guardrail instead. This demonstrates the [`IGuardrailService`](https://github.com/framerslab/agentos/blob/master/src/safety/guardrails/IGuardrailService.ts) interface with `SANITIZE` action:

```typescript
class SimpleRegexPiiGuardrail implements IGuardrailService {
  config = {
    evaluateStreamingChunks: true,
    canSanitize: true,  // Phase 1: runs before parallel classifiers
  };

  private readonly patterns = [
    { regex: /\b\d{3}-\d{2}-\d{4}\b/g, replacement: '[SSN REDACTED]' },
    { regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, replacement: '[EMAIL REDACTED]' },
    { regex: /\b\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}\b/g, replacement: '[CARD REDACTED]' },
  ];

  async evaluateOutput({ chunk }: GuardrailOutputPayload): Promise<GuardrailEvaluationResult | null> {
    if (chunk.type !== AgentOSResponseChunkType.TEXT_DELTA || !chunk.textDelta) return null;

    let text = chunk.textDelta;
    let modified = false;

    for (const { regex, replacement } of this.patterns) {
      const newText = text.replace(regex, replacement);
      if (newText !== text) { text = newText; modified = true; }
    }

    if (modified) {
      return { action: GuardrailAction.SANITIZE, modifiedText: text, reasonCode: 'PII_REDACTED' };
    }
    return null;
  }
}
```

> **Note:** For production use, the `@framers/agentos-ext-pii-redaction` extension is strongly recommended over custom regex. It catches names, organizations, locations, and 50+ country-specific ID formats that regex alone misses.

### Example 3: Content Policy Mid-Stream

Block harmful content as it's being generated:

```typescript
class ContentPolicyGuardrail implements IGuardrailService {
  config = { evaluateStreamingChunks: true };

  private readonly prohibitedPatterns = [
    /how to make.*bomb/i,
    /instructions for.*weapon/i,
    // ... more patterns
  ];

  // The text each response stream has produced so far, kept as Example 1 keeps its counts
  private readonly streams = new Map<string, { text: string; seenAt: number }>();

  async evaluateOutput({ chunk }: GuardrailOutputPayload): Promise<GuardrailEvaluationResult | null> {
    if (chunk.isFinal) {
      this.streams.delete(chunk.streamId);
      return null;
    }

    if (chunk.type === AgentOSResponseChunkType.TEXT_DELTA && chunk.textDelta) {
      const now = Date.now();
      let stream = this.streams.get(chunk.streamId);
      if (!stream) {
        for (const [id, idle] of this.streams) {
          if (now - idle.seenAt > 600_000) this.streams.delete(id);
        }
        stream = { text: '', seenAt: now };
        this.streams.set(chunk.streamId, stream);
      }
      stream.text += chunk.textDelta;
      stream.seenAt = now;

      for (const pattern of this.prohibitedPatterns) {
        if (pattern.test(stream.text)) {
          this.streams.delete(chunk.streamId);
          return {
            action: GuardrailAction.BLOCK,
            reason: 'Response contains content that violates our usage policy.',
            reasonCode: 'CONTENT_POLICY_VIOLATION',
          };
        }
      }
    }

    return null;
  }
}
```

## Cross-Agent Guardrails

Cross-agent guardrails let one agent (supervisor) monitor and intervene in other agents' outputs. AgentOS attaches them to no stream on its own: neither `processRequest()` nor `agency()` reads them. The host wraps an agent's output stream with `wrapWithCrossAgentGuardrails(guardrails, { sourceAgentId, observerAgentId, agencyId }, guardrailContext, stream, { streamId })` from `@framers/agentos/safety/guardrails`. Each guardrail that observes the source agent (`observeAgentIds`, every agent when empty) evaluates every chunk in turn, a non-final `TEXT_DELTA` only with `evaluateStreamingChunks: true`; a `BLOCK` ends the stream with an error chunk, and a guardrail without `canInterruptOthers: true` has its `BLOCK` and `SANITIZE` downgraded to `FLAG`. A `SANITIZE` of a `FINAL_RESPONSE` rewrites the reply wherever the chunk carries it, as an output guardrail's does: `finalResponseText` and the reply in `updatedConversationContext` read `modifiedText`; `finalResponseTextPlain` reads it rendered as plain text, as a turn renders its own reply; `audioOutput` keeps its voice settings, speaks that plain text and drops the `url` of the audio made from the replaced reply; and a structured value parsed from the replaced reply is withdrawn (`structured.value` is `null`, `meta.valid` is `false`), since the wrapper holds no schema to check the rewrite against. A `modifiedText` equal to the reply changes nothing. The wrapper rewrites the stream only: the source agent's runtime saved its conversation before the chunk reached the wrapper, and the stored reply stays as the model wrote it. A rewrite that must reach the stored conversation runs as one of the agent's own output guardrails, whose rewrite the runtime stores (see "The stored reply" below). This is useful for:

- Supervisor patterns in multi-agent systems
- Quality gates across an agency
- Organization-wide policy enforcement

### Supervisor Pattern

```typescript
import {
  ICrossAgentGuardrailService,
  GuardrailAction,
  type CrossAgentOutputPayload,
  type GuardrailEvaluationResult,
} from '@framers/agentos/safety/guardrails';

class SupervisorGuardrail implements ICrossAgentGuardrailService {
  // Observe specific worker agents (empty = all agents)
  observeAgentIds = ['worker-analyst', 'worker-writer'];

  // Allow this guardrail to block/modify other agents' streams
  canInterruptOthers = true;

  // Evaluate streaming chunks in real-time
  config = { evaluateStreamingChunks: true };

  async evaluateCrossAgentOutput({
    sourceAgentId,
    chunk,
    context,
  }: CrossAgentOutputPayload): Promise<GuardrailEvaluationResult | null> {
    // Check for confidential information leakage
    if (chunk.type === AgentOSResponseChunkType.TEXT_DELTA && chunk.textDelta?.includes('CONFIDENTIAL')) {
      return {
        action: GuardrailAction.BLOCK,
        reason: `Agent ${sourceAgentId} attempted to expose confidential information`,
        reasonCode: 'CROSS_AGENT_CONFIDENTIAL_LEAK',
        metadata: {
          blockedAgent: sourceAgentId,
          supervisor: 'supervisor-agent'
        },
      };
    }

    return null;
  }
}
```

### Quality Gate Guardrail

```typescript
class QualityGateGuardrail implements ICrossAgentGuardrailService {
  observeAgentIds = []; // Observe all agents
  canInterruptOthers = true;

  async evaluateCrossAgentOutput({
    sourceAgentId,
    chunk,
  }: CrossAgentOutputPayload): Promise<GuardrailEvaluationResult | null> {
    // Only evaluate final responses
    if (chunk.type !== AgentOSResponseChunkType.FINAL_RESPONSE) {
      return null;
    }

    const response = chunk.finalResponseText;

    // Check response quality
    if (response && response.length < 50) {
      return {
        action: GuardrailAction.FLAG,
        reason: 'Response may be too brief',
        reasonCode: 'QUALITY_WARNING',
        metadata: {
          responseLength: response.length,
          agent: sourceAgentId
        },
      };
    }

    return null;
  }
}
```

## Configuration Options

### GuardrailConfig

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `evaluateStreamingChunks` | `boolean` | `false` | Evaluate TEXT_DELTA chunks (real-time) vs only FINAL_RESPONSE |
| `evaluateToolCalls` | `boolean` | `false` | Evaluate tool calls: a block refuses a call the runtime runs itself before it runs, and keeps an actionable call from the host and ends the stream; a sanitize is applied as a block. See [Tool Calls](#tool-calls) |
| `maxStreamingEvaluations` | `number` | `undefined` | Rate limit streaming evaluations per guarded stream (the turn's stream and each continuation stream count on their own) |
| `canSanitize` | `boolean` | `false` | Run this guardrail in Phase 1 so SANITIZE results chain deterministically |
| `sequential` | `boolean` | `false` | Run this guardrail in Phase 1, one at a time in registration order, though it does not sanitize: its BLOCK ends the evaluation before any Phase 2 guard is called. A SANITIZE it returns is a FLAG unless `canSanitize` is also set. See [Screens That Run First](#screens-that-run-first) |
| `timeoutMs` | `number` | `undefined` | Per-guardrail timeout. On timeout/error the dispatcher fails open for that guardrail, unless `failClosed` is set or the guard is required. Under `moderateContent()` a guard that names none gets the call's deadline, 8 seconds by default |
| `failClosed` | `boolean` | `false` | A throw or a timeout blocks instead of passing. Forced on for a required guard. Under `moderateContent()` a guard runs closed unless this is `false` |
| `reasonCodes` | `readonly string[]` | `undefined` | Every reason code and review code the guard can answer, a closed list, declared for the log lines that name the code that decided: the `guardrail.verdict` line of `moderateContent()` takes a code from this list only, or a code the library made for a closed guard's failure, and writes `unknown` otherwise. `PhraseListGuardrail` lists the rule ids of the list it holds |

### Output Payload Extras

[`GuardrailOutputPayload`](https://github.com/framerslab/agentos/blob/master/src/safety/guardrails/IGuardrailService.ts) includes `ragSources?: RagRetrievedChunk[]` for output-time grounding checks. This field is populated when the response was generated with RAG retrieval, and is what the grounding guard uses to compare claims against retrieved evidence.

### Performance Considerations

| Mode | Latency | Cost | Use Case |
|------|---------|------|----------|
| **Final-only** (default) | +1-500ms once | Low | Policy checks needing full context |
| **Streaming** | +1-500ms per chunk | High | Real-time PII redaction, immediate blocking |

## Required Guards, Hold Mode and Replacement Replies

A product whose safety rules are code names the guards it cannot run without, and the runtime holds them to it:

```typescript
const agentos = await AgentOS.create({
  extensionManifest: { packs: [{ factory: () => createPhraseListPack(neverDo) }, { factory: () => createPhraseListPack(selfHarm) }] },
  requiredGuardrails: [
    { id: 'never-do', stages: ['output'], timeoutMs: 8_000 },
    { id: 'self-harm', stages: ['input', 'output'], timeoutMs: 8_000 },
  ],
});
```

- **Boot.** `initialize()` throws `SYS_CONFIGURATION_ERROR` (with `missing` and `missingStage` in its details) when a required id has no active guard, the guard is disabled by an override, or it does not implement a required stage.
- **Every request.** `processRequest()`, `handleToolResults()` and `resumeExternalToolRequest()` check again and answer one error chunk, `SYS_GUARDRAIL_REQUIRED_MISSING`, while a required guard is missing. Nothing reaches a provider.
- **Posture.** A required guard runs under its id, fail-closed (a throw, a timeout past `timeoutMs`, or an answer whose action is not a `GuardrailAction` blocks, as `GUARDRAIL_ERROR` or `GUARDRAIL_MALFORMED`), whatever its own `config` says.
- **Hold mode.** A guard required on `output`, or `guardrailOutputMode: 'hold'`, holds every `TEXT_DELTA` until the final guards have judged the whole reply. Allowed or flagged, the deltas go out before the final chunk; blocked or sanitized, they are dropped. An actionable tool call closes the window: the text so far is judged as a final reply before the tool call goes out. The same guards run on the continuation after an external tool result.
- **Replacement replies.** A `BLOCK` whose evaluation carries a non-empty `replacementText` reaches the caller as a `FINAL_RESPONSE` holding that text in `finalResponseText`, and in `finalResponseTextPlain` rendered as plain text as a turn renders its own reply, with `metadata.guardrail.output[0].action === 'block'` and the guard's `reasonCode`, in place of an error chunk. A block without one (or with an empty string) yields the error chunk.
- **The stored reply.** With conversational persistence on, a reply a guard blocked with a replacement or sanitized is rewritten in the conversation's history (and one blocked without a replacement is emptied) before the final chunk leaves, so the history holds what the person saw: the stored message is matched by the text the guards judged, never by position, on a turn and on a tool continuation alike. The message's `metadata.modificationInfo` records the guard's reason code. A block on a streamed delta judges no whole reply and rewrites nothing; hold mode is where nothing streams before the final verdict. With `appendOnlyPersistence` on the conversation manager the stored row keeps the first text and the rewrite stays in memory; the runtime logs a warning when that happens, and a product that must not keep a replaced reply does not run an append-only store. A sanitized final chunk's `updatedConversationContext` reads the rewrite too.
- **Declared stages.** A guard that has both methods but runs on one stage declares it in `IGuardrailService.stages` (the phrase-list guard does, from its `stages` option); a required guard is held to the stages it declares, and a stage it does not declare is reported as missing instead of passing on the method's existence.
- **The text before a tool call.** In hold mode the text held before an actionable tool call is judged as a reply of its own, with the text in `finalResponseText` and as plain text in `finalResponseTextPlain`, as a final reply carries them: a block replaces it and the tool call does not go out; a sanitize rewrites what streams. A block there, a hold included, is reported through `onVerdict` like a block on a final reply, with the withheld calls' ids in `toolCallIds`. An allow or a sanitize there is not reported, since nothing is stored at that point; the turn's final chunk, which carries the whole text, is judged and recorded on its own.
- **Every verdict names its guard.** `metadata.guardrailId` is set on each evaluation when the guard has an `id`; a block's error chunk carries it in `details.metadata`.

### `PhraseListGuardrail`

A guard over a reviewed list of phrases. Each entry blocks on a match, or asks a judge whether the match, read in the text, crosses the rule. Text is normalised before matching (NFKC, case, zero-width characters and combining marks removed, Cyrillic and Greek look-alikes mapped to Latin, curly quotes straightened), so a lookalike letter or an invisible joiner does not get past the list.

```typescript
import { PhraseListGuardrail, StaticPhraseListSource, createLlmPhraseJudge, createPhraseListPack } from '@framers/agentos';

const neverDo = await PhraseListGuardrail.create({
  id: 'never-do',
  stages: ['output'],
  source: new StaticPhraseListSource({
    version: '2026-10-08', reviewedAt: '2026-10-08', reviewedBy: 'counsel',
    entries: [
      { phrase: 'you will pass', match: 'word', onMatch: 'block', ruleId: 'outcome_promise' },
      { phrase: 'index fund', match: 'word', onMatch: 'judge', ruleId: 'money' },
    ],
  }),
  judge: createLlmPhraseJudge({ provider: 'openai', model: 'gpt-6-luna', criteria: 'Investment, tax or legal advice.', apiKey, fallbackProviders: [] }),
  replacementFor: (ruleId) => TEMPLATES[ruleId],
});
```

`PhraseListGuardrail.create` refuses an empty list, a list that does not load, and judge entries without a judge; `reload()` swaps the list in whole and keeps the last good one when the new one fails. The judge fails closed: a throw, an answer without `block` and `confidence`, or a confidence under `judgeThreshold` (default 0.7) blocks. `createLlmPhraseJudge` takes `fallbackProviders: []` by default, so the judge reaches only the provider it was given.

`phraseMatches(entries, text)` runs the same match with no guard and no judge: the text goes through the same normalisation, the entries compile with the same word boundaries, and the entries that occur come back in list order. A `judge` entry comes back like any other; what a match means is the caller's to decide. It throws on an entry whose phrase normalises to nothing, as `PhraseListGuardrail.create` does.

```typescript
import { phraseMatches, type PhraseEntry } from '@framers/agentos';

const entries: PhraseEntry[] = [
  { phrase: 'coming soon', match: 'word', onMatch: 'block', ruleId: 'timing' },
  { phrase: 'next', match: 'word', onMatch: 'judge', ruleId: 'timing' },
  { phrase: 'in\\s+beta', match: 'regex', onMatch: 'block', ruleId: 'stage' },
];

phraseMatches(entries, 'Exports are COMING SOON.').map((e) => e.phrase); // ['coming soon']
phraseMatches(entries, 'The nextcloud connector'); // []: a word entry keeps its word boundaries
phraseMatches(entries, 'Now in beta').map((e) => e.ruleId); // ['stage']
```

### Hard limits in the persona

`IPersonaDefinition.hardLimits` (and `hardLimits:` in a SOUL file's front matter) renders as the last block of the system prompt on every path: every GMI turn for that persona, and every model call of `agent({ soul })` and `souledAgent()`, after `systemBlocks` too, under the heading "Hard limits", after everything the turn added and after every fragment of the persona's own prompt whatever priority it carries. The exception: the plan of a call with `planning` on is a system message after the limits. A memory provider's recall (the wiki's recall on a souled agent) is a data block in a user-role message, never a system message. The guards hold the same rules in code; the block tells the model.

A GMI built by `agent({ runtime: 'gmi' })` or `gmi()` has the block when its `soul` sets `hardLimits`: [`personaFromAgentOptions()`](https://github.com/framerslab/agentos/blob/master/src/api/runtime/gmiPersona.ts) takes them from the soul's front matter ([GMIs from agent()](../GMI.md#gmis-from-agent)). An agent with no soul has none.

## Tool Calls

An output guardrail can judge the tool calls a turn requests. With `config.evaluateToolCalls: true`, `evaluateOutput` receives each `TOOL_CALL_REQUEST` chunk of a guarded stream, the turn's and each continuation's, as the stream carries it: `chunk.toolCalls` lists each call's `id`, `name` and parsed `arguments`.

```typescript
class ShellCommandGuard implements IGuardrailService {
  readonly id = 'shell-commands';
  readonly config: GuardrailConfig = { evaluateToolCalls: true };

  async evaluateOutput({ chunk }: GuardrailOutputPayload): Promise<GuardrailEvaluationResult | null> {
    if (chunk.type !== AgentOSResponseChunkType.TOOL_CALL_REQUEST) return null;
    for (const call of chunk.toolCalls) {
      if (call.name === 'shell_execute' && /rm\s+-rf\s+\//.test(String(call.arguments.command))) {
        return { action: GuardrailAction.BLOCK, reason: 'A destructive shell command', reasonCode: 'SHELL_DESTRUCTIVE' };
      }
    }
    return null;
  }
}
```

- **Block.** The stream ends with the guard's verdict in place of the chunk: the error chunk, or the final response holding `replacementText`. The stream never hands the host an actionable call (`executionMode: 'external'`), so the host does not execute it. In hold mode the text held before the call is dropped with it, and a block on that text withholds the call too. AgentOS drops the pause the runtime saved for the call when the turn stopped for it, before the verdict reaches the host. `getPendingExternalToolRequest()` no longer returns the call, the conversation answers it with a refused tool result (code `AUTH_PERMISSION_DENIED`) so the history stays well formed, and the stream is closed, so `handleToolResult()` cannot continue it. The stream is closed even when the conversation store refuses that save, and AgentOS logs a warning. The conversation in memory drops the pause all the same, and the conversation's next save (on its next turn, before it is evicted from memory, or at shutdown) stores it without the pause: a restart finds the pause stored only when no such save succeeded before the process stopped. A host that wraps a stream with `wrapOutputGuardrails()` itself reads the withheld calls in the verdict's `toolCallIds` (`onVerdict`). A block on a chunk that holds no actionable call, a streamed delta or the chunk of calls the runtime runs itself, withholds no call: it ends the host's stream while the turn goes on inside the runtime, and when the turn then stops for calls the host runs, AgentOS drops that pause in the same way once the turn ends. The host's stream does not wait for the rest of the turn. From the verdict until the pause is dropped, the pause is never offered: `getPendingExternalToolRequest()` returns `null` for it, `resumeExternalToolRequest()` refuses it with one error chunk (`SYS_INVALID_STATE`), and `handleToolResult()` on the blocked stream yields one error chunk (`SYS_INVALID_STATE`).
- **Sanitize.** A guard cannot rewrite a tool call. A `SANITIZE` is applied as a `BLOCK` that keeps the guard's reason and reason code.
- **Flag and allow.** The chunk goes on with the evaluation in `metadata.guardrail.output`.
- **Calls the runtime runs itself.** AgentOS asks the guard about each call with `executionMode: 'internal'` before the call runs, as a `TOOL_CALL_REQUEST` chunk holding that one call, with the sources the turn retrieved in `ragSources`, on `processRequest()`, `handleToolResult()` and `resumeExternalToolRequest()` alike. A continuation the orchestrator is given no gate for (`AgentOSOrchestrator.orchestrateToolResult()` takes none) is judged with the gate its turn ran with, which the runtime keeps with the turn's stream. A continuation retrieves nothing of its own, so its calls are judged with the sources the user turn it continues retrieved, which the runtime keeps with the turn's stream: a turn of another conversation on the session's GMI meanwhile, or a GMI built again for the session, does not change them. A turn resumed after a restart is judged without them: the pause stores the calls, never the documents the turn retrieved. A block (or a sanitize) refuses the call: the tool does not run, and the model reads a refused tool result (code `AUTH_PERMISSION_DENIED`, with the guard's reason), as it reads a permission refusal. When a model step asks for several such calls, every call of the step is judged before any of them runs, and the calls that pass alone are judged once more together, as the stream's chunk for the step holds them, so a guard that rules on calls together (notes read and a shell command run in one step) refuses each of them before any runs. On the stream `processRequest()` returns, the guard also judges the stream's chunk for the step, so it is asked about such calls twice; a block there ends the host's stream with the verdict while the turn finishes inside the runtime. A continuation's stream carries no chunk for the calls the GMI runs itself. A refused call never becomes an actionable request and no pending request is saved for it; the `FINAL_RESPONSE` lists it in `finalToolCalls` beside the calls that ran. To have a person approve a tool before it runs, gate the tool: with a `hitlManager` and `toolOrchestratorConfig.hitl.enabled`, the tool orchestrator asks for an approval before a tool with `hasSideEffects: true` runs ([Human-in-the-Loop](./HUMAN_IN_THE_LOOP.md)).
- **Several guards.** The guards that evaluate tool calls and set `config.sequential` answer first, one at a time in registration order, and the first `BLOCK` among them is the verdict before any other guard is called. The rest run in parallel on each tool-call chunk; the first refusal in registration order is the verdict, else the first hold.
- **What the guards do not see.** The guards judge the calls a turn's model requests. The steps of a composed tool (one `forge_tool` built from a chain of other tools) and the tool tasks of a workflow are not model requests: they run through the tool orchestrator's `processToolCall()` with no tool-call chunk, so a guard that sets `evaluateToolCalls` judges the composed tool's own call, with the arguments the model gave it, and never the steps that call runs, nor a workflow's tool tasks. Those calls meet the tool orchestrator's own checks: the disabled list, the permission check, argument validation and, with `hitl.enabled`, the approval a tool with `hasSideEffects: true` waits for.

**Why it is opt-in.** A guard written for text may read any chunk it is given as text: one that takes every non-final chunk for a `TEXT_DELTA` reads `textDelta` as `undefined`, and a fail-closed guard that throws on it would block every tool call. A guard that sets `evaluateToolCalls` is written to read tool calls, and a guard without it never receives one. A guard that has a tool-call branch already, as the code-safety pack's guard does, runs it once its config sets the flag.

## Using Multiple Guardrails

Multiple guardrails are dispatched in two phases: sanitizers first, then parallel classifiers:

```typescript
import { createPiiRedactionGuardrail } from '@framers/agentos-ext-pii-redaction';
import { createMLClassifierGuardrail } from '@framers/agentos-ext-ml-classifiers';
import { createTopicalityGuardrail } from '@framers/agentos-ext-topicality';
import { createCodeSafetyGuardrail } from '@framers/agentos-ext-code-safety';
import { createGroundingGuardrail } from '@framers/agentos-ext-grounding-guard';

const piiPack = createPiiRedactionGuardrail({
  redactionStyle: 'placeholder',
  confidenceThreshold: 0.5,
});

const mlPack = createMLClassifierGuardrail({
  categories: ['toxic', 'injection'],
});

const topicalityPack = createTopicalityGuardrail({
  allowedTopics: ['customer support', 'billing', 'product features'],
  blockedTopics: ['politics', 'violence', 'gambling'],
});

const codeSafetyPack = createCodeSafetyGuardrail();

const groundingPack = createGroundingGuardrail({
  contradictionAction: 'flag',
});

await agent.initialize({
  ...config,
  extensionManifest: {
    packs: [
      { factory: () => piiPack },
      { factory: () => mlPack },
      { factory: () => topicalityPack },
      { factory: () => codeSafetyPack },
      { factory: () => groundingPack },
    ],
  },
});
```

**Evaluation Order:**
1. Phase 1 sanitizers, and screens with `sequential: true`, run first in registration order
2. If any of them returns `BLOCK`, processing stops immediately
3. Sanitized text from Phase 1 becomes the input to all Phase 2 guardrails
4. Phase 2 guardrails run concurrently, and the worst action wins
5. `SANITIZE` returned from Phase 2 is downgraded to `FLAG` to preserve deterministic output

## API Reference

### IGuardrailService

```typescript
interface IGuardrailService {
  id?: string;               // Names the guard in verdicts and in requiredGuardrails
  config?: GuardrailConfig;
  evaluateInput?(payload: GuardrailInputPayload): Promise<GuardrailEvaluationResult | null>;
  evaluateOutput?(payload: GuardrailOutputPayload): Promise<GuardrailEvaluationResult | null>;
}
```

### ICrossAgentGuardrailService

```typescript
interface ICrossAgentGuardrailService extends IGuardrailService {
  observeAgentIds?: string[];      // Agents to observe (empty = all)
  canInterruptOthers?: boolean;    // Can BLOCK/SANITIZE other agents
  evaluateCrossAgentOutput?(payload: CrossAgentOutputPayload): Promise<GuardrailEvaluationResult | null>;
}
```

### GuardrailAction

```typescript
enum GuardrailAction {
  ALLOW = 'allow',      // Pass unchanged
  FLAG = 'flag',        // Pass, record metadata
  SANITIZE = 'sanitize', // Replace content
  BLOCK = 'block',      // Reject/terminate
}
```

### GuardrailEvaluationResult

```typescript
interface GuardrailEvaluationResult {
  action: GuardrailAction;
  reason?: string;           // User-facing message
  reasonCode?: string;       // Machine-readable code
  metadata?: Record<string, unknown>;
  details?: unknown;         // Debugging detail, not shown to users
  modifiedText?: string | null;  // For SANITIZE action
  replacementText?: string;  // With BLOCK on output, a non-empty string is the reply sent in place of the error chunk
  hold?: { reviewCode: string }; // With BLOCK only: kept back for a person's review, not refused
}
```

### Shared Heavyweight Services

Extension packs that need expensive resources (NER models, ONNX classifiers, embedding functions, NLI pipelines) should load them through `ExtensionLifecycleContext.services`, which is an [`ISharedServiceRegistry`](https://github.com/framerslab/agentos/blob/master/src/extensions/ISharedServiceRegistry.ts). The extension manager provides a shared registry instance so one agent can reuse the same heavyweight dependency across multiple packs instead of loading it once per guardrail.

## Best Practices

1. **Start with final-only evaluation** - Enable streaming only when real-time filtering is required
2. **Use rate limiting** - Set `maxStreamingEvaluations` to control costs
3. **Be specific with reason codes** - Use consistent, machine-readable codes for analytics
4. **Log FLAG actions** - Use FLAG for monitoring without blocking user experience
5. **Test edge cases** - Test with partial PII, edge cases in streaming chunks
6. **Consider latency** - Each streaming evaluation adds latency to user experience

## Folder-Level Permissions

AgentOS has no folder-permission layer. Its guardrails see the user's input and the response chunks, and a guard that sets `evaluateToolCalls` sees each tool call's arguments, but AgentOS ships no path rules. [Wunderland](https://github.com/jddunn/wunderland), the agent CLI built on AgentOS, adds one. Its [`SafeGuardrails`](https://github.com/jddunn/wunderland/blob/master/src/security/SafeGuardrails.ts) class checks a tool call's file paths, and the paths it reads out of `rm`, `cp`, `mv`, `cat`, `touch`, `mkdir`, `rmdir`, `chmod` and `chown` commands, against glob rules with separate read and write flags before the tool runs. It writes each violation to `~/.wunderland/security/violations.log` and can notify webhooks or an email address of high and critical ones. An agent's `security.folderPermissions` in its `agent.config.json` sets the rules; see Wunderland's [guardrails documentation](https://github.com/jddunn/wunderland/blob/master/docs/features/GUARDRAILS.md).

## Related Documentation

- [Architecture Overview](../architecture/ARCHITECTURE.md)
- [Human-in-the-Loop](./HUMAN_IN_THE_LOOP.md)
- [Agent Communication](../architecture/AGENT_COMMUNICATION.md)
- [Safety Primitives](./SAFETY_PRIMITIVES.md)
