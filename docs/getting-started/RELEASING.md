# Releasing @framers/agentos

Releases are automated. Every push to `master` that passes CI, whether a merged pull request or a maintainer's commit, is evaluated for a release; nobody publishes by hand.

## What happens after a push to `master`

1. CI ([`ci.yml`](https://github.com/framerslab/agentos/blob/master/.github/workflows/ci.yml)) runs on the new commit.
2. When CI succeeds, the release workflow ([`release.yml`](https://github.com/framerslab/agentos/blob/master/.github/workflows/release.yml)) starts. It stops if `master` has moved past the commit CI tested; the newer commit's own CI run releases it.
3. [semantic-release](https://semantic-release.gitbook.io/) reads every commit since the last tag and decides the version with the rules below. With no releasing commit, nothing publishes.
4. On a release, semantic-release pushes the tag `v<version>` and commits nothing to `master`, whose branch rules refuse direct pushes. It then publishes `@framers/agentos` to npm, which runs `prepublishOnly` (`build:knowledge`, `build`, `verify:exports`) first, and creates a GitHub release with the generated notes and the test-count badge attached as `tests.json`. The badge file also ships in the package, and the README's badge reads it through unpkg (`@latest`), since shields.io refuses github.com addresses. The released version is the tag's, npm's and the GitHub release's; `package.json`'s `version` on `master` is not it (`npm view @framers/agentos version` reads it).

## Version rules

AgentOS is 0.x, so the rules in [`release.config.js`](https://github.com/framerslab/agentos/blob/master/release.config.js) are conservative:

| Commit | Release | Example |
|---|---|---|
| `fix:`, `feat:`, `perf:`, `refactor:`, `revert:` | patch | 0.10.31 to 0.10.32 |
| any type with `!`, or a `BREAKING CHANGE:` footer | minor | 0.10.31 to 0.11.0 |
| `docs:`, `chore:`, `test:`, `ci:`, `build:`, `style:` | none | |

A security fix that only updates a dependency is committed as `fix(deps): <summary>` so that it releases; `chore(deps)` and `build(deps)` commits release nothing.

## Merging

Maintainers squash-merge. semantic-release reads the squash commit's subject and body, so before confirming, check the merge box: the subject is the pull request title and the body is empty. For a change that breaks users, the title carries `!` and the merger adds a footer to the commit body in the merge box:

```text
BREAKING CHANGE: <what users must change>
```

That footer becomes the breaking-change note in the GitHub release.

A breaking change needs a maintainer's approval before it merges. The `Breaking change gate` check ([`breaking-change-gate.yml`](https://github.com/framerslab/agentos/blob/master/.github/workflows/breaking-change-gate.yml)) fails a pull request whose title, description or commit messages carry a breaking-change marker, until a maintainer adds the label `breaking-approved`. Prefer a change that keeps existing callers working: a new option with the old behaviour as its default, a widened type, a deprecation before a removal.

A title outside the Conventional Commits form matches none of the rows above, so the change would merge and release nothing with every check green. The `Pull request title` check ([`pr-title.yml`](https://github.com/framerslab/agentos/blob/master/.github/workflows/pr-title.yml)) fails a pull request whose title is not a type from the table, an optional scope in parentheses, an optional `!`, a colon, a space and a subject, and reads the title again when it is edited. The release notes carry the title only: what callers of a change that does not break them see differently goes in the feature's documentation page and the pull request's Summary.

## Documentation sites

- The API reference at [framerslab.github.io/agentos](https://framerslab.github.io/agentos/) is built by [`docs.yml`](https://github.com/framerslab/agentos/blob/master/.github/workflows/docs.yml) and published from this repository's `agentos-live-docs` branch. It rebuilds when a push to `master` changes `src/`, `docs/`, `README.md`, `package.json`, `CHANGELOG.md`, `typedoc.json` or the workflow itself, and on a manual run; a manual run on another branch builds the reference without publishing it. Runs that publish build one at a time. A run queued during a build waits for it to finish, so a later run never cancels the build in progress. At most one run waits: a run that starts waiting cancels the one already waiting, which shows as cancelled without having built, and the last run to start waiting builds next.
- The guides at [docs.agentos.sh](https://docs.agentos.sh) are built by the [agentos-live-docs](https://github.com/framerslab/agentos-live-docs) repository on its own pushes or a manual run.
- A release rebuilds neither site. `docs.yml` also lists the `release` event, but semantic-release pushes its tag and creates the GitHub release with `GITHUB_TOKEN`, and GitHub starts no workflow from events that token creates.

## Never

- Edit `CHANGELOG.md` or the `version` field by hand, or read that field as the released version.
- Push to `master` directly: its branch rules refuse it; every change merges through a pull request.
- Run `npm publish`.
- Push a code change to `master` with `[skip ci]` in the message.

There is no prerelease channel; every release comes from `master`.

## Secrets

The release workflow uses the `NPM_TOKEN` repository secret (an npm granular access token with read and write access to the `@framers` packages) and the `GITHUB_TOKEN` that GitHub Actions provides.

## Troubleshooting

- **No release published:** no commit since the last tag has a releasing type, or the release workflow stopped because `master` moved past the tested commit (the newer commit's run releases it).
- **npm publish fails:** for example a 401 when the `NPM_TOKEN` secret has expired or lacks write access to `@framers`, or a failing `prepublishOnly` step. semantic-release pushes the `v<version>` tag before it publishes, so that version is tagged on GitHub and missing from npm, and it is not retried: the tag is the last release from then on. Fix the cause. The next releasing commit publishes the following version; that package contains the skipped version's changes, and its release notes list only the commits after the tag.
