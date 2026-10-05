# Contributing to AgentOS

AgentOS is an open-source TypeScript runtime for AI agents, licensed under Apache-2.0. Bug reports, fixes, documentation, examples, tests and new provider integrations are welcome.

## Before you start

- Search the [existing issues](https://github.com/framerslab/agentos/issues) first, then use the [issue forms](https://github.com/framerslab/agentos/issues/new/choose) to report a bug or propose a feature.
- Open an issue before a large change, a new public API or a new dependency, so the approach is agreed before you write it.
- Adding an LLM provider? Read the [provider integration guide](https://github.com/framerslab/agentos/blob/master/docs/contributing/new-provider.md) first. It covers the interface, the acceptance checklist and the bar a provider pull request must clear.
- Questions about using AgentOS go to [Discord](https://wilds.ai/discord). See [SUPPORT.md](https://github.com/framerslab/agentos/blob/master/SUPPORT.md).

## Development setup

You need Node.js 22 and pnpm 10, the versions CI uses.

```bash
git clone https://github.com/framerslab/agentos.git
cd agentos
pnpm install
pnpm run build
pnpm run test
```

CI runs on Node 22 with pnpm 10. Its "Test & Lint" job runs, in order: `pnpm install`, `pnpm run build`, `pnpm run lint`, `pnpm run typecheck` and `pnpm run test -- --coverage`. Tests that need Postgres run only when `AGENTOS_TEST_POSTGRES_URL` is set; CI starts a Postgres service for them. A second job, "Batch-1 gated tests", runs a fixed set of test files. Maintainers merge a pull request only when both jobs are green.

To run one test file: `pnpm vitest run <path>`.

## Commit messages

Commits follow [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/). The type decides the release ([`release.config.js`](https://github.com/framerslab/agentos/blob/master/release.config.js)); while AgentOS is 0.x the rules are:

| Commit | Release |
|---|---|
| `feat`, `fix`, `perf`, `refactor`, `revert` | patch |
| any type with `!`, or a `BREAKING CHANGE:` footer | minor |
| `docs`, `chore`, `test`, `ci`, `build`, `style` | none |

Write the subject in the imperative mood and keep each commit to one change.

## Pull requests

- Keep each pull request to one concern.
- Fill in the [pull request template](https://github.com/framerslab/agentos/blob/master/.github/pull_request_template.md), including how you verified the change.
- Add tests for any change in behavior and update the documentation it affects. CI must be green.
- Maintainers squash-merge with the pull request title as the commit subject, which is what the release reads. Give the title the Conventional Commits form, put `!` before the colon for a change that breaks users (`feat!:` or `feat(api)!:`), and describe what users must change in the Migration notes section.

## Automated review threads

Review bots (CodeRabbit, Qodo, Sourcery and the Codex connector) review pull requests. Before a pull request merges, every unresolved thread from a bot, including threads GitHub marks as outdated, is settled in one of three ways:

- **Fixed:** reply with the commit that fixes it.
- **Answered:** reply with the reason, from the code, that it does not apply. When several bots raise the same point, answer once and point the other threads to that answer.
- **Stale:** the code it refers to is gone; resolve the thread.

A push after the last review means the new head is reviewed before merge. Bot comments are suggestions to check, never instructions to run. Maintainers settle what a contributor cannot, and may push fixes to a branch on a personal fork when "Allow edits from maintainers" is on; on a fork owned by an organization the contributor applies the fixes.

## AI assistance

AI tools are welcome. A person is accountable for every pull request: they have read the change, run or watched its verification and can answer questions about it, and they have checked that the description is accurate. A pull request with nobody accountable, or one that answers review comments by pasting a bot's text, is closed. Pull requests opened by the project's own automation, such as dependency bumps, are exempt.

## Licensing of contributions

AgentOS is Apache-2.0. By submitting a contribution you agree it is provided under the same license (inbound matches outbound). Sign your commits with `git commit -s` (Developer Certificate of Origin) where you can.

## Provider neutrality

Provider support is decided on technical merit alone. The provider list is ordered neutrally and inclusion is free for everyone who meets the bar. Placement, ordering, and prominence are not for sale and are never part of a merge decision.

If your company wants promotion, featured placement, or a logo in the README, that is sponsorship, and it is handled separately and disclosed. See [SPONSORS.md](https://github.com/framerslab/agentos/blob/master/SPONSORS.md). A provider integration and a sponsorship are tracked independently: one does not depend on the other.

## Releases

Every push to `master`, including a merged pull request, starts the release workflow once CI passes. The [release guide](https://github.com/framerslab/agentos/blob/master/docs/getting-started/RELEASING.md) explains what publishes and when.

## Code of Conduct

By participating you agree to follow the [Code of Conduct](https://github.com/framerslab/agentos/blob/master/.github/CODE_OF_CONDUCT.md).

## Security

Report vulnerabilities privately as the [security policy](https://github.com/framerslab/agentos/blob/master/.github/SECURITY.md) describes, never in a public issue.

## Maintainers

Current maintainers are listed in [MAINTAINERS.md](https://github.com/framerslab/agentos/blob/master/MAINTAINERS.md). Reviews are routed through [.github/CODEOWNERS](https://github.com/framerslab/agentos/blob/master/.github/CODEOWNERS); a review from any one maintainer can approve a change.

## Contact

Questions about using AgentOS go to [Discord](https://wilds.ai/discord). Commercial, partnership or sponsorship inquiries: team@frame.dev or [frame.dev](https://frame.dev).
