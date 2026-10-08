# Security policy

## Supported versions

Security fixes ship in a new release of the latest published version of `@framers/agentos`. Older versions are not patched.

## Reporting a vulnerability

Report it privately through GitHub: open the [security advisory form](https://github.com/framerslab/agentos/security/advisories/new), or email team@frame.dev. Do not open a public issue, pull request or chat message about a vulnerability.

## Response

A maintainer acknowledges a report within 5 business days and sends an assessment and a plan within 14 days.

## Disclosure

A fix ships before details are published, and the reporter is credited unless they decline. At 90 days from the report an advisory is published with the fix or, when no fix exists, with mitigations, unless the reporter and a maintainer agree a later date.

## Scope

In scope: defects in this repository's code, including how it handles credentials, files, provider responses and tool results. Out of scope: a flaw that exists only in a third-party provider's service, or only in a deployment's own configuration. Model output, tool results, channel messages, retrieved documents and web content are untrusted input; the guardrail and approval features are described in the [documentation](https://docs.agentos.sh).
