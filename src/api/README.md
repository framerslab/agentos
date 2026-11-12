# api/

Public facade. The `AgentOS` lifecycle class, high-level helpers (`agent`, `agency`, `generateText`, `generateObject`, `generateImage`, `generateVideo`, `generateMusic`, `generateSFX`), structured-output schemas. Imports under here are stable user-facing surface — break with caution.

`generateText()` and `streamText()` take `guards`: a host's guards enforced on the call itself (`runtime/textGuardrails.ts`; see [Guards on a call](../../docs/getting-started/HIGH_LEVEL_API.md#guards-on-a-call)).
