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

## The keyed persona acceptance and the published-package check

The `personas-semantic` label runs [`personas-semantic.yml`](https://github.com/framerslab/agentos/blob/master/.github/workflows/personas-semantic.yml): the grounded-writing acceptance against real models (the writer `gpt-6.1-sol`, the judge `gpt-6-luna`), paid through the repository secret `OPENAI_API_KEY` and capped at 10 USD a run. Add the label once the branch is final: while it is on, any push, added label or branch update on the pull request restarts the run (its concurrency group cancels the unfinished first attempt; re-runs of one run share a group keyed by that run's id, a running re-run is cancelled by nothing, and a newer pending re-run replaces an older pending one, so re-running an older commit's run spends a run's budget of its own), so read the run and its `personas-semantic-<sha>` artifact (`summary.json` and `records.jsonl`) on the final head before marking the pull request ready. The job is not a required check; a maintainer reads it.

After a release that changes the persona API, dispatch [`personas-published.yml`](https://github.com/framerslab/agentos/blob/master/.github/workflows/personas-published.yml) with the published version and the merge commit. It refuses a version before 0.15.0 (the first minor after the 0.14 line), verifies the registry's tarball, imports the installed package in isolation and exercises both host locks, and its `persona-release-<version>` artifact is the pin a consumer records before changing its manifest.

A title outside the Conventional Commits form matches none of the rows above, so the change would merge and release nothing with every check green. The `Pull request title` check ([`pr-title.yml`](https://github.com/framerslab/agentos/blob/master/.github/workflows/pr-title.yml)) fails a pull request whose title is not a type from the table, an optional scope in parentheses, an optional `!`, a colon, a space and a subject, and reads the title again when it is edited. The release notes carry the title only: what callers of a change that does not break them see differently goes in the feature's documentation page and the pull request's Summary.

## Documentation sites

- The API reference at [framerslab.github.io/agentos](https://framerslab.github.io/agentos/) is built by [`docs.yml`](https://github.com/framerslab/agentos/blob/master/.github/workflows/docs.yml) and published from this repository's `agentos-live-docs` branch. It rebuilds when a push to `master` changes `src/`, `docs/`, `README.md`, `package.json`, `CHANGELOG.md`, `typedoc.json` or the workflow itself, and on a manual run; a manual run on another branch builds the reference without publishing it. Runs that publish build one at a time. A run queued during a build waits for it to finish, so a later run never cancels the build in progress. At most one run waits: a run that starts waiting cancels the one already waiting, which shows as cancelled without having built, and the last run to start waiting builds next.
- The guides at [docs.agentos.sh](https://docs.agentos.sh) are built by the [agentos-live-docs](https://github.com/framerslab/agentos-live-docs) repository on its own pushes or a manual run.
- A release rebuilds neither site. `docs.yml` also lists the `release` event, but semantic-release pushes its tag and creates the GitHub release with `GITHUB_TOKEN`, and GitHub starts no workflow from events that token creates.

## Never

- Edit `CHANGELOG.md` or the `version` field by hand, or read that field as the released version.
- Push to `master` directly: its branch rules refuse it; every change merges through a pull request.
- Add a workflow step that pushes a commit to `master`. Its rules refuse the push (GH006), so the step fails after everything before it has run. A step that changes the repository pushes a branch of its own and opens a pull request, or writes to another branch, as `docs.yml` publishes to `agentos-live-docs`. The `Test & Lint` job runs `.github/scripts/check-workflow-pushes.mjs`, which fails the pull request that adds such a push: a `git push` to `master` (named, or sent there by a `push.default` or `remote.<name>.push` setting), or to the branch the run is on from a workflow that runs on `master` (a merged pull request's `closed` run is on the branch it went into), one of the push actions it knows (`peaceiris/actions-gh-pages`, `JamesIves/github-pages-deploy-action`, `ad-m/github-push-action`, `stefanzweifel/git-auto-commit-action`, `EndBug/add-and-commit`) pushing there (a deploy action whose repository input names another repository is left to that repository's rules), or a semantic-release run while `release.config.js` lists `@semantic-release/git`. It reads a command where the shell runs it, in a substitution, an `sh -c` string, an `eval` or text piped or fed to a shell; follows the checked-out branch of each checkout (the root's, and one `actions/checkout` makes at a `path`) for each git command in the checkout its directory is in: the step's `working-directory`, then the script's `cd` and `pushd` (a subshell, a substitution, a command of a pipeline and a background job change directory for themselves alone, and a function's body where the function is called), `env -C`, `git -C`, `--git-dir` and `GIT_DIR` (set before the command, or in the `env:` of its step, job or workflow; `env -i` and `env -u` remove it, and through `sudo` without `-E` the checkout is one it cannot tell), or a push action's directory input; a command whose directory it cannot tell is read in every checkout. It follows the branch through `&&`, `||`, `if`, `case`, loops and steps with an `if:` condition (any of which may not run) and into the local composite actions a job calls (`uses: ./<path>`, with the inputs its `with:` gives, else their defaults; an input in a step's `if:` is a string, so an input of `false` there still runs the step); reads `git push` options as git does (`--dry-run --no-dry-run` pushes, `--mir` is `--mirror`); and reads `git config` as git does: in the checkout it runs in, with `--global` and `--system` beneath every checkout's own, and `--unset` removing only the value its pattern matches. A script a shell reads from a file, a variable or a download, a git setting made through `GIT_CONFIG_*` variables or a config file, a `GIT_DIR` a script sets, exports or unsets, a checkout `git clone` or `git worktree add` makes, and a push made by another action, are not read. It reads the YAML with [mikefarah's yq](https://github.com/mikefarah/yq) v4, which GitHub's Ubuntu runners carry; run it elsewhere with `yq` on the path, or `YQ` naming it: `node .github/scripts/check-workflow-pushes.mjs`.
- Run `npm publish`.
- Push a code change to `master` with `[skip ci]` in the message.

There is no prerelease channel; every release comes from `master`.

## Secrets

The release publishes through npm trusted publishing. npm trusts this repository's `release.yml` to publish `@framers/agentos`, and the job's `id-token: write` permission lets `@semantic-release/npm` exchange the run's OIDC token with the registry. When the exchange succeeds, the plugin hands `npm publish` no token and npm makes the same exchange itself, which needs npm 11.5.1 or newer; Node 22 ships npm 10, so the job installs npm 11 first, the version `ci.yml`'s Test & Lint job also installs. A package published this way carries npm provenance. When the exchange fails, the plugin uses the `NPM_TOKEN` repository secret (an npm granular access token with read and write access to the `@framers` packages). The GitHub release uses the `GITHUB_TOKEN` that GitHub Actions provides.

## Troubleshooting

- **No release published:** no commit since the last tag has a releasing type, or the release workflow stopped because `master` moved past the tested commit (the newer commit's run releases it).
- **npm publish fails:** for example a 401 when the `NPM_TOKEN` secret has expired or lacks write access to `@framers`, `ENEEDAUTH` when the OIDC exchange succeeded but the npm that publishes is older than 11.5.1, or a failing `prepublishOnly` step. semantic-release pushes the `v<version>` tag before it publishes, so that version is tagged on GitHub and missing from npm, and it is not retried: the tag is the last release from then on. Fix the cause. The next releasing commit publishes the following version; that package contains the skipped version's changes, and its release notes list only the commits after the tag.
