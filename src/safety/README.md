# safety/

Governance. Guardrail interfaces (implementations live in `@framers/agentos-guardrails`), provenance, sandbox, evaluation/observability, validation, auth, checked egress (outbound HTTP to destinations a host does not control). Anything that constrains or audits agent behavior lives here.

A guard answers one of four actions (ALLOW, FLAG, SANITIZE, BLOCK); a BLOCK can carry `hold: { reviewCode }`, which keeps the content back for a person's review and is enforced as the BLOCK it is (`guardrails/guardrailDispatcher.ts`, `holdResult()` and `guardrailOutcomeOf()`).
