# Streaming Semantics

`agency().stream(...)` exposes multiple streaming surfaces because "what is
happening right now" and "what is finally approved" are not always the same
thing.

Use the right one for the job:

- `textStream`
  - Raw live text chunks from the underlying strategy.
  - Lowest latency.
  - May differ from the final approved answer if output guardrails or HITL
    rewrite the result.
- `fullStream`
  - Structured event stream.
  - Includes raw text/tool/lifecycle events as they happen.
  - Also includes late post-processing events such as:
    - `approval-requested`
    - `approval-decided`
    - `final-output`
    - final agency-level `agent-end`
- `text`
  - Finalized scalar text after output guardrails, parsing, usage normalization,
    and `beforeReturn` HITL approval. See [Human-in-the-Loop](/features/human-in-the-loop) for the full HITL surface.
- `finalTextStream`
  - Finalized-text iterable.
  - Emits only the post-processing-approved text once it is actually finalized.
- `usage`
  - Finalized aggregate usage for the streamed run.
- `agentCalls`
  - Finalized per-agent ledger for the streamed run.
- `parsed`
  - Final structured payload when `output` is configured.

## Recommended Usage

### Fast chat UI

Use `textStream` when you want the lowest-latency token display:

```ts
const stream = team.stream('Draft the answer');

for await (const chunk of stream.textStream) {
  process.stdout.write(chunk);
}
```

This is the right default for conversational UX, but remember it is raw output.

### Approved-only UI

Use `finalTextStream` when the client should only ever see the approved final
answer:

```ts
const stream = team.stream('Draft the answer');

for await (const chunk of stream.finalTextStream) {
  process.stdout.write(chunk);
}
```

This yields after post-processing finishes, so it is higher-latency but
truthful.

### Audits, orchestration visualizers, and runtime tooling

Use `fullStream` when you need the lifecycle:

```ts
const stream = team.stream('Draft the answer');

for await (const part of stream.fullStream) {
  switch (part.type) {
    case 'text':
      console.log('raw text', part.text);
      break;
    case 'approval-requested':
      console.log('approval requested', part.request.id);
      break;
    case 'approval-decided':
      console.log('approval decided', part.approved);
      break;
    case 'final-output':
      console.log('final text', part.text);
      console.log('usage', part.usage.totalTokens);
      console.log('agentCalls', part.agentCalls.length);
      break;
  }
}
```

## Important Distinction

If you enable output guardrails or `hitl.approvals.beforeReturn`, the final
approved answer can differ from the raw streamed text.

That means:

- `textStream` can show content that is later rewritten.
- `text` and `finalTextStream` are the truthful finalized answer.
- `fullStream` is the only stream that shows both the raw path and the final
  approval/finalization events in one place.

## Current Behavior

What is live today:

- `textStream` and `fullStream` are live/incremental again.
- `final-output` is emitted into `fullStream` after post-processing completes.
- `agentCalls` and `usage` resolve for streamed runs.
- `finalTextStream` replays the finalized approved text only.

What is not true today:

- `textStream` is not a post-guardrail stream.
- `textStream` is not a post-HITL stream.
- mid-stream output guardrail intervention is not yet exposed as a separate live
  finalized-token channel.

## Practical Rule

Use this rule unless you have a reason not to:

- `textStream` for speed
- `finalTextStream` for correctness
- `fullStream` for tooling, observability, and audits
- `text` for the simplest finalized scalar result
