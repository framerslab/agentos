# safety/

Governance. Guardrail interfaces (implementations live in `@framers/agentos-guardrails`), provenance, sandbox, evaluation/observability, validation, auth, checked egress (outbound HTTP to destinations a host does not control). Anything that constrains or audits agent behavior lives here.

A guard answers one of four actions (ALLOW, FLAG, SANITIZE, BLOCK); a BLOCK can carry `hold: { reviewCode }`, which keeps the content back for a person's review and is enforced as the BLOCK it is (`guardrails/guardrailDispatcher.ts`, `holdResult()` and `guardrailOutcomeOf()`).

Content people send each other goes through `moderateContent()` (`guardrails/contentModeration.ts`): every guard runs closed unless its config says otherwise, screens with `config.sequential` run first, and the decision is `allow`, `flag`, `refuse` or `hold`, with codes and ids. Of the content it holds only `sanitizedText`, the text a sanitizer rewrote, and whatever a guard writes into its own `metadata`.

Images go through `ImageGuardrail` (`guardrails/builtin/ImageGuardrail.ts`), which holds the order of a host's checks and no vendor code: every `match` check on every image before any `classify` check, each image captured once and handed to every check as its own copy of the bytes, and an image no `classify` check answered for refused as unavailable.
