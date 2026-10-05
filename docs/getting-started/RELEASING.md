# Releasing @framers/agentos

Releases are automated. A maintainer releases by merging a pull request to `master`; nobody publishes by hand.

## What happens on a merge

1. CI ([`ci.yml`](https://github.com/framerslab/agentos/blob/master/.github/workflows/ci.yml)) runs on the merge commit.
2. When CI succeeds, the release workflow ([`release.yml`](https://github.com/framerslab/agentos/blob/master/.github/workflows/release.yml)) starts. It stops if `master` has moved past the commit CI tested; the newer commit's own CI run releases it.
3. [semantic-release](https://semantic-release.gitbook.io/) reads every commit since the last tag and decides the version with the rules below. With no releasing commit, nothing publishes.
4. On a release, npm runs `prepublishOnly` (`build:knowledge`, `build`, `verify:exports`) and publishes `@framers/agentos`. semantic-release then commits `CHANGELOG.md`, `package.json` and the test-count badge as `chore(release): <version> [skip ci]`, tags `v<version>` and creates a GitHub release with the generated notes.

## Version rules

AgentOS is 0.x, so the rules in [`release.config.js`](https://github.com/framerslab/agentos/blob/master/release.config.js) are conservative:

| Commit | Release | Example |
|---|---|---|
| `fix:`, `feat:`, `perf:`, `refactor:`, `revert:` | patch | 0.10.31 to 0.10.32 |
| any type with `!`, or a `BREAKING CHANGE:` footer | minor | 0.10.31 to 0.11.0 |
| `docs:`, `chore:`, `test:`, `ci:`, `build:`, `style:` | none | |

## Merging

Maintainers squash-merge. The squash commit's subject is the pull request title and its body is empty, so the title is what semantic-release reads. Read the subject in the merge box before confirming. For a change that breaks users, the title carries `!` and the merger adds a footer to the commit body in the merge box:

```text
BREAKING CHANGE: <what users must change>
```

That footer becomes the breaking-change note in the changelog and the GitHub release.

## Documentation sites

- The API reference rebuilds when a push to `master` changes `src/`, `docs/`, `README.md`, `package.json`, `CHANGELOG.md` or `typedoc.json` ([`docs.yml`](https://github.com/framerslab/agentos/blob/master/.github/workflows/docs.yml)).
- The guides at [docs.agentos.sh](https://docs.agentos.sh) are built by the [agentos-live-docs](https://github.com/framerslab/agentos-live-docs) repository on its own pushes or a manual run. A release rebuilds neither site.

## Never

- Edit `CHANGELOG.md` or the `version` field by hand.
- Run `npm publish`.
- Push a code change to `master` with `[skip ci]` in the message.

There is no prerelease channel; every release comes from `master`.

## Secrets

The release workflow uses the `NPM_TOKEN` repository secret (an npm automation token with publish rights for the `@framers` scope) and the `GITHUB_TOKEN` that GitHub Actions provides.

## Troubleshooting

- **No release published:** no commit since the last tag has a releasing type.
- **npm publish fails with 401:** the `NPM_TOKEN` secret has expired or lacks publish rights for `@framers`.
