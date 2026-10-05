# Releasing @framers/agentos

Releases are automated. Every push to `master` that passes CI, whether a merged pull request or a maintainer's commit, is evaluated for a release; nobody publishes by hand.

## What happens after a push to `master`

1. CI ([`ci.yml`](https://github.com/framerslab/agentos/blob/master/.github/workflows/ci.yml)) runs on the new commit.
2. When CI succeeds, the release workflow ([`release.yml`](https://github.com/framerslab/agentos/blob/master/.github/workflows/release.yml)) starts. It stops if `master` has moved past the commit CI tested; the newer commit's own CI run releases it.
3. [semantic-release](https://semantic-release.gitbook.io/) reads every commit since the last tag and decides the version with the rules below. With no releasing commit, nothing publishes.
4. On a release, semantic-release writes the notes to `CHANGELOG.md` and the version to `package.json`, commits both with the test-count badge as `chore(release): <version> [skip ci]`, and pushes that commit and the tag `v<version>`. It then publishes `@framers/agentos` to npm, which runs `prepublishOnly` (`build:knowledge`, `build`, `verify:exports`) first, and creates a GitHub release with the generated notes.

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

That footer becomes the breaking-change note in the changelog and the GitHub release.

## Documentation sites

- The API reference at [framerslab.github.io/agentos](https://framerslab.github.io/agentos/) is built by [`docs.yml`](https://github.com/framerslab/agentos/blob/master/.github/workflows/docs.yml) and published from this repository's `agentos-live-docs` branch. It rebuilds when a push to `master` changes `src/`, `docs/`, `README.md`, `package.json`, `CHANGELOG.md`, `typedoc.json` or the workflow itself, and on a manual run.
- The guides at [docs.agentos.sh](https://docs.agentos.sh) are built by the [agentos-live-docs](https://github.com/framerslab/agentos-live-docs) repository on its own pushes or a manual run.
- A release rebuilds neither site. `docs.yml` also lists the `release` event, but semantic-release pushes its commit and creates the GitHub release with `GITHUB_TOKEN`, and GitHub starts no workflow from events that token creates.

## Never

- Edit `CHANGELOG.md` or the `version` field by hand.
- Run `npm publish`.
- Push a code change to `master` with `[skip ci]` in the message.

There is no prerelease channel; every release comes from `master`.

## Secrets

The release workflow uses the `NPM_TOKEN` repository secret (an npm granular access token with read and write access to the `@framers` packages) and the `GITHUB_TOKEN` that GitHub Actions provides.

## Troubleshooting

- **No release published:** no commit since the last tag has a releasing type, or the release workflow stopped because `master` moved past the tested commit (the newer commit's run releases it).
- **npm publish fails:** for example a 401 when the `NPM_TOKEN` secret has expired or lacks write access to `@framers`, or a failing `prepublishOnly` step. semantic-release pushes the release commit and the `v<version>` tag before it publishes, so that version is tagged on GitHub and missing from npm, and it is not retried: the tag is the last release from then on. Fix the cause. The next releasing commit publishes the following version; that package contains the skipped version's changes, and its release notes list only the commits after the tag.
