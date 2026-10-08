# Streaming Semantics

`agency().stream(...)` exposes multiple streaming surfaces because "what is
happening right now" and "what is finally approved" are not always the same
thing.

Use the right one for the job:

- `textStream`
  - Raw text chunks from the strategy, as it produces them.
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
  - Yields the post-processing-approved text as one chunk once the run is
    finalized, and nothing when that text is empty.
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

It yields once, after post-processing finishes, so it waits for the whole
run and never shows text that a guardrail or reviewer later changes.

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

## Which Strategies Stream Token by Token

- `sequential` and `graph` stream each agent's tokens as they arrive.
  `fullStream` brackets every agent with `agent-start` and `agent-end` parts
  and tags each `text` part with its `agent`. `graph` runs the agents of a tier
  one after another while it streams, where `generate()` runs them in
  parallel.
- `parallel`, `debate`, `review-loop` and `hierarchical` run to completion
  first. `textStream` then yields the whole text as one chunk, and
  `fullStream` carries that one `text` part before the post-processing parts.
  An agency created with `adaptive: true` runs any other strategy under a
  hierarchical manager, so it streams this way too.

In `sequential` and `graph`, `textStream` carries the text of every agent in
turn, not only the last one, and the streamed `text` joins all of it in
order. `generate()` returns the last agent's text instead (for `graph`, the
last agent of the final tier).

## Guarantees

- `final-output` is emitted into `fullStream` after post-processing completes.
- `sequential` and `graph` end their raw stream with an `agent-end` part for
  `__agency__` (`sequential` with the last agent's text as `output`, `graph`
  with an empty `output`), so that part comes before `final-output`.
- After `final-output`, `fullStream` adds an `agent-end` for the agency (its
  `name`, or `__agency__`) with the final text as `output`, unless an earlier
  part already carried that agent and that output.
- `text`, `usage`, `agentCalls` and `parsed` resolve once the run is
  finalized.
- `textStream` carries the text before output guardrails and before
  `beforeReturn` approval. Output guardrails act on the finalized text only,
  so no stream carries guardrail-rewritten tokens while the run streams.

## Practical Rule

Use this rule unless you have a reason not to:

- `textStream` for speed
- `finalTextStream` for correctness
- `fullStream` for tooling, observability, and audits
- `text` for the simplest finalized scalar result
