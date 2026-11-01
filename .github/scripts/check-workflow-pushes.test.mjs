// @ts-check
// Runs in CI (node --test); it needs mikefarah's yq v4, and bash, GNU env and git for the steps it runs, which
// GitHub's Ubuntu runners carry.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkFiles, workflowFiles } from './check-workflow-pushes.mjs';

const script = fileURLToPath(new URL('./check-workflow-pushes.mjs', import.meta.url));
const repository = resolve(dirname(script), '..', '..');

/**
 * YAML or a script written at any indentation. A template literal reads ${ itself, so %{{ stands for ${{ and $\{
 * for ${; \` stands for a backtick.
 * @param {TemplateStringsArray} strings
 */
const text = (strings) => {
  const raw = strings.raw.join('').replaceAll('%{{', '${{').replaceAll('$\\{', '${').replaceAll('\\`', '`');
  const lines = raw.replace(/^\n/, '').replace(/\n\s*$/, '').split('\n');
  const margin = Math.min(...lines.filter((line) => line.trim() !== '').map((line) => line.length - line.trimStart().length));
  return `${lines.map((line) => line.slice(margin)).join('\n')}\n`;
};

/**
 * A workflow with one job: its triggers and its steps, each written at column 0.
 * @param {string} on
 * @param {string} steps
 */
const workflow = (on, steps) => {
  const indent = (/** @type {string} */ block, /** @type {number} */ n) => block.trimEnd().split('\n').map((line) => (line ? ' '.repeat(n) + line : line)).join('\n');
  return `on:\n${indent(on, 2)}\njobs:\n  j:\n    runs-on: ubuntu-latest\n    steps:\n${indent(steps, 6)}\n`;
};

const ON_MASTER = 'push:\n  branches: [master]';
const ON_PULL_REQUEST = 'pull_request:';

/**
 * The checker's findings for a repository holding the files.
 * @param {Record<string, string>} files
 * @param {{ repository?: string }} [options]
 */
function check(files, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'workflow-pushes-'));
  try {
    for (const [path, body] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), body);
    }
    return checkFiles(workflowFiles(root), { root, branch: 'master', ...options });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * Asserts the findings' messages match the patterns, one for one and in order.
 * @param {Record<string, string>} files
 * @param {RegExp[]} patterns
 * @param {{ repository?: string }} [options]
 */
function expectFindings(files, patterns, options = {}) {
  const messages = check(files, options).map((f) => f.message);
  assert.equal(messages.length, patterns.length, `findings:\n${messages.join('\n')}`);
  patterns.forEach((pattern, k) => assert.match(messages[k], pattern));
}

const RELEASE_CONFIG_WITH_GIT = text`
  module.exports = {
    branches: ['master'],
    plugins: ['@semantic-release/commit-analyzer', '@semantic-release/npm', ['@semantic-release/git', { assets: ['package.json'] }]],
  };
`;

describe('refused: a workflow that pushes to master', () => {
  test('the registry step of agentos-extensions run 39191821853, which pushed to the run\'s branch and retried the refusal', () => {
    expectFindings(
      {
        '.github/workflows/release.yml': text`
          name: Release & Publish
          on:
            push:
              branches: [master]
            workflow_dispatch:
          jobs:
            release:
              runs-on: ubuntu-latest
              steps:
                - uses: actions/checkout@v5
                - name: Update registry after publish
                  run: |
                    node scripts/update-registry.js
                    cp registry.json "$RUNNER_TEMP/registry.json"
                    for attempt in 1 2 3 4 5; do
                      if ! git fetch --quiet origin "$GITHUB_REF"; then
                        echo "fetching $GITHUB_REF_NAME failed (attempt $attempt of 5); trying again."
                        sleep $(( attempt * 10 ))
                        continue
                      fi
                      git reset --quiet --hard FETCH_HEAD
                      cp "$RUNNER_TEMP/registry.json" registry.json
                      git add registry.json
                      git commit --quiet -m "chore: update extension registry [skip ci]"
                      if git push origin "HEAD:$GITHUB_REF"; then
                        exit 0
                      fi
                      echo "$GITHUB_REF_NAME moved before the push (attempt $attempt of 5); trying again."
                      sleep $(( attempt * 10 ))
                    done
                    echo "::error::registry.json was not pushed after 5 attempts."
                    exit 1
        `,
      },
      [/^jobs\.release\.steps\[1\] \(Update registry after publish\): "git push origin HEAD:\$GITHUB_REF" pushes to the run's own branch, master on a run on master$/],
    );
  });

  test('master named in the push, from a pull request workflow', () => {
    expectFindings({ '.github/workflows/w.yml': workflow(ON_PULL_REQUEST, text`
      - run: |
          git push origin HEAD:master
          git push origin HEAD:refs/heads/main
          git push -f origin main:main
          git push origin --delete master
    `) }, [/"git push origin HEAD:master" pushes to master$/, /pushes to refs\/heads\/main$/, /"git push -f origin main:main" pushes to main$/, /"git push origin --delete master" deletes master$/]);
  });

  test('the first operand names the repository even after --repo, which git reads only when no operand does', () => {
    expectFindings({
      '.github/workflows/m.yml': workflow(ON_MASTER, '- run: git push --repo=origin'),
      '.github/workflows/w.yml': workflow(ON_PULL_REQUEST, text`
        - run: |
            git push --repo=fork origin HEAD:master
            git push --repo fork origin master
      `),
    }, [/"git push --repo=origin" pushes the checked-out branch, master on a run on master$/, /"git push --repo=fork origin HEAD:master" pushes to master$/, /"git push --repo fork origin master" pushes to master$/]);
  });

  test('every branch: --all, --mirror, a wildcard destination, the matching refspec', () => {
    expectFindings({ '.github/workflows/w.yml': workflow(ON_PULL_REQUEST, text`
      - run: |
          git push --all origin
          git push --mirror
          git push origin 'refs/heads/*:refs/heads/*'
          git push origin :
          git push origin +:
          git push origin 'refs/*:refs/*'
    `) }, [/pushes every branch, master among them$/, /pushes every branch, master among them$/, /pushes to refs\/heads\/\*$/, /pushes every branch the remote also has/, /pushes every branch the remote also has/, /pushes to refs\/\*$/]);
  });

  test('expressions and defaults that resolve to the default branch', () => {
    expectFindings({ '.github/workflows/w.yml': workflow(ON_PULL_REQUEST, text`
      - run: git push origin "HEAD:%{{ github.event.repository.default_branch || 'master' }}"
      - run: git push origin "HEAD:%{{ github.base_ref }}"
      - run: git push origin "HEAD:$GITHUB_BASE_REF"
      - run: git push origin "HEAD:$\{TARGET:-master}"
    `) }, [/pushes to \$\{\{ github\.event\.repository\.default_branch \|\| 'master' \}\}$/, /pushes to \$\{\{ github\.base_ref \}\}$/, /pushes to \$GITHUB_BASE_REF$/, /pushes to \$\{TARGET:-master\}$/]);
  });

  test('every YAML spelling reads the same: quoted keys, an escaped line break, a block scalar, a flow mapping, an alias', () => {
    expectFindings({
      '.github/workflows/w.yml': text`
        on: pull_request
        jobs:
          j:
            runs-on: ubuntu-latest
            steps:
              - "run": git push origin HEAD:master
              - run: "git push origin HEAD:ma\
                  ster"
              - uses: peaceiris/actions-gh-pages@v4
                with:
                  publish_branch: >-
                    master
              - uses: peaceiris/actions-gh-pages@v4
                with: { "publish_branch": "master" }
              - &push
                run: git push origin HEAD:master
          k:
            runs-on: ubuntu-latest
            steps:
              - *push
      `,
    }, [/^jobs\.j\.steps\[0\]: "git push origin HEAD:master" pushes to master$/, /^jobs\.j\.steps\[1\]: "git push origin HEAD:master" pushes to master$/, /^jobs\.j\.steps\[2\]: peaceiris\/actions-gh-pages publishes to master$/, /^jobs\.j\.steps\[3\]: peaceiris\/actions-gh-pages publishes to master$/, /^jobs\.j\.steps\[4\]: /, /^jobs\.k\.steps\[0\]: /]);
  });

  test('the checked-out branch, from workflows whose triggers reach master however they are written', () => {
    expectFindings({
      '.github/workflows/a.yml': workflow("'push':\n  branches: [master]", '- run: git push'),
      '.github/workflows/b.yml': `on: { push: { branches: [master] } }\njobs:\n  j:\n    runs-on: ubuntu-latest\n    steps:\n      - run: git push\n`,
      '.github/workflows/c.yml': `on: [push]\njobs:\n  j:\n    runs-on: ubuntu-latest\n    steps:\n      - run: git push origin HEAD\n`,
      '.github/workflows/d.yml': workflow("push:\n  paths: ['src/**']", '- run: git push'),
      '.github/workflows/e.yml': workflow("workflow_dispatch:\nschedule:\n  - cron: '0 0 * * *'", '- run: git push origin "HEAD:${{ github.ref_name }}"'),
    }, [/"git push" pushes the checked-out branch, master on a run on master$/, /"git push" pushes the checked-out branch/, /"git push origin HEAD" pushes the checked-out branch/, /"git push" pushes the checked-out branch/, /pushes to the run's own branch, master on a run on master$/]);
  });

  test('a push the shell runs: in a substitution, behind a wrapper, in sh -c, eval, an if, a heredoc fed to bash', () => {
    expectFindings({ '.github/workflows/w.yml': workflow(ON_PULL_REQUEST, text`
      - run: |
          out="$(git push origin HEAD:master 2>&1)"
          echo "\`git push origin HEAD:master\`"
          env GIT_TRACE=1 git -C repo push origin master
          sudo -E git push origin master
          bash -c "git push origin HEAD:master"
          eval "git push origin HEAD:master"
          if git push origin master; then echo pushed; fi
          bash <<'EOF'
          git push origin master
          EOF
    `) }, Array(8).fill(/pushes to master$/));
  });

  test('a push in text the shell expands or reads: a ${ } default, an unquoted heredoc, a heredoc or words piped to a shell, past -o values in an option cluster', () => {
    expectFindings({ '.github/workflows/w.yml': workflow(ON_PULL_REQUEST, text`
      - run: |
          echo "$\{CACHE:-$(git push origin HEAD:master)}"
          cat <<EOF > notes.txt
          pushed: $(git push origin HEAD:master)
          EOF
          cat <<'EOF' | bash
          git push origin master
          EOF
          echo 'git push origin HEAD:master' | sh
          printf '%s\n' 'git push origin master' |& bash -s
          bash -o pipefail <<'EOF'
          git push origin master
          EOF
          bash <<< 'git push origin HEAD:master'
          cat <<< "git push origin master" | sh -e
          bash -eo pipefail <<'EOF'
          git push origin master
          EOF
          echo 'git push origin HEAD:master' | bash -eo pipefail
          bash -co pipefail 'git push origin master'
    `) }, Array(11).fill(/pushes to master$/));
  });

  test('a step that checks out master makes a pull request job push it', () => {
    expectFindings({ '.github/workflows/w.yml': workflow(ON_PULL_REQUEST, text`
      - uses: actions/checkout@v5
        with:
          ref: master
      - run: git push
      - run: |
          git switch feature
          git checkout main
          git push origin HEAD
      - run: |
          git switch feature
          git switch --track origin/master
          git push origin
      - run: |
          git checkout feature
          git checkout -t origin/main
          git push
    `) }, [/^jobs\.j\.steps\[1\]: "git push" pushes the checked-out branch/, /^jobs\.j\.steps\[2\]: "git push origin HEAD" pushes the checked-out branch/, /^jobs\.j\.steps\[3\]: "git push origin" pushes the checked-out branch/, /^jobs\.j\.steps\[4\]: "git push" pushes the checked-out branch/]);
  });

  test('a switch back to master with git switch -, git checkout - or @{-N}', () => {
    expectFindings({ '.github/workflows/w.yml': workflow(ON_MASTER, text`
      - uses: actions/checkout@v5
      - run: |
          git switch -c feature
          git switch -
          git push origin HEAD
      - run: |
          git checkout -b one
          git checkout -b two
          git checkout @{-2}
          git push
      - run: |
          git checkout --detach
          git checkout -q -
          git push origin HEAD
    `) }, [/^jobs\.j\.steps\[1\]: "git push origin HEAD" pushes the checked-out branch/, /^jobs\.j\.steps\[2\]: "git push" pushes the checked-out branch/, /^jobs\.j\.steps\[3\]: "git push origin HEAD" pushes the checked-out branch/]);
  });

  test('a checkout that may not run leaves the branch before it: after && or ||, in an if, a case or a loop', () => {
    // Bash skips git checkout feature after false &&, so the push sends master.
    expectFindings({ '.github/workflows/w.yml': workflow(ON_PULL_REQUEST, text`
      - run: git checkout master; false && git checkout feature; git push origin HEAD
      - run: |
          git checkout master
          if [ -n "$FEATURE" ]; then
            git checkout feature
          fi
          git push origin HEAD
      - run: |
          git checkout master
          case "$MODE" in
            a|b) git checkout feature ;;
            (c) git checkout -b next ;;
          esac
          git push origin HEAD
      - run: |
          git checkout master
          while false; do git checkout feature; done
          git push origin HEAD
      - run: |
          git checkout master
          test -n "$FEATURE" &&
            git checkout feature
          git push origin HEAD
      - run: |
          git checkout master
          [ -n "$KEEP" ] || git checkout feature
          git push origin HEAD
      - run: bash -c 'git checkout master; false && git checkout feature; git push origin HEAD'
    `) }, Array(7).fill(/"git push origin HEAD" pushes the checked-out branch, master on a run on master$/));
  });

  test('a step whose if: condition may not hold, or never holds, leaves the branch before it', () => {
    // The job skips each conditional checkout when its condition is false, so each push can send master.
    expectFindings({ '.github/workflows/w.yml': workflow(ON_PULL_REQUEST, text`
      - run: git checkout master
      - if: false
        run: git checkout feature
      - run: git push origin HEAD
      - if: github.event.pull_request.draft == false
        run: git checkout feature
      - run: git push origin HEAD
      - if: %{{ github.actor != 'dependabot[bot]' }}
        uses: actions/checkout@v5
        with: { ref: feature }
      - run: git push origin HEAD
    `) }, [
      /^jobs\.j\.steps\[2\]: "git push origin HEAD" pushes the checked-out branch, master on a run on master$/,
      /^jobs\.j\.steps\[4\]: "git push origin HEAD" pushes the checked-out branch, master on a run on master$/,
      /^jobs\.j\.steps\[6\]: "git push origin HEAD" pushes the checked-out branch, master on a run on master$/,
    ]);
  });

  test('a local composite action runs in the job that calls it: the branch it checks out is the one the job pushes', () => {
    expectFindings({
      '.github/actions/to-master/action.yml': text`
        name: to-master
        runs:
          using: composite
          steps:
            - run: git checkout master
              shell: bash
      `,
      // Outside .github/actions, so only the job that calls it reads it.
      'tools/push/action.yml': text`
        name: push
        runs:
          using: composite
          steps:
            - run: git push origin HEAD
              shell: bash
      `,
      '.github/workflows/w.yml': workflow(ON_PULL_REQUEST, text`
        - run: git checkout -b feature
        - uses: ./.github/actions/to-master
        - run: git push origin HEAD
        - uses: ./tools/push
      `),
    }, [
      /^jobs\.j\.steps\[2\]: "git push origin HEAD" pushes the checked-out branch, master on a run on master$/,
      /^runs\.steps\[0\]: "git push origin HEAD" pushes the checked-out branch, master on a run on master$/,
    ]);
    const findings = check({
      '.github/actions/push/action.yml': text`
        name: push
        runs:
          using: composite
          steps:
            - run: git push origin HEAD
              shell: bash
      `,
      '.github/workflows/a.yml': workflow(ON_MASTER, '- uses: ./.github/actions/push\n- uses: ./.github/actions/push/'),
      '.github/workflows/b.yml': workflow(ON_MASTER, '- uses: ./.github/actions/push'),
    });
    // Found where the action is read and in three calls, reported once, on the action's line.
    assert.deepEqual(findings.map((f) => `${f.file}:${f.line}`), ['.github/actions/push/action.yml:5']);
  });

  test('a checkout in another directory keeps a branch of its own: the root is pushed from the root, the other from its directory', () => {
    expectFindings({
      // From the review of agentos-extensions#341: the root checkout is master, and the one at a path is not.
      '.github/workflows/a.yml': workflow(ON_MASTER, text`
        - uses: actions/checkout@v5
        - uses: actions/checkout@v5
          with:
            repository: framerslab/agentos
            path: packages/agentos
            ref: feature
        - run: git push origin HEAD
        - working-directory: packages/agentos
          run: git push origin HEAD
      `),
      // A pull request run that checks master out in a directory of its own and pushes from there.
      '.github/workflows/b.yml': workflow(ON_PULL_REQUEST, text`
        - uses: actions/checkout@v5
        - uses: actions/checkout@v5
          with:
            ref: master
            path: base
        - run: git push origin HEAD
        - working-directory: base/docs
          run: git push origin HEAD
        - run: git -C base push origin HEAD
        - run: git --git-dir=base/.git push origin HEAD
        - run: cd base && git push origin HEAD
        - uses: EndBug/add-and-commit@v9
          with:
            cwd: ./base
      `),
      // Another repository checked out with no ref is on its default branch.
      '.github/workflows/c.yml': workflow(ON_PULL_REQUEST, text`
        - uses: actions/checkout@v5
        - uses: actions/checkout@v5
          with:
            repository: framerslab/agentos-live-docs
            path: site
        - run: git -C site push origin HEAD
      `),
    }, [
      /^jobs\.j\.steps\[2\]: "git push origin HEAD" pushes the checked-out branch, master on a run on master$/,
      /^jobs\.j\.steps\[3\]: "git push origin HEAD" pushes the checked-out branch, master on a run on master$/,
      /^jobs\.j\.steps\[4\]: "git push origin HEAD" pushes the checked-out branch, master on a run on master$/,
      /^jobs\.j\.steps\[5\]: "git push origin HEAD" pushes the checked-out branch, master on a run on master$/,
      /^jobs\.j\.steps\[6\]: "git push origin HEAD" pushes the checked-out branch, master on a run on master$/,
      /^jobs\.j\.steps\[7\]: EndBug\/add-and-commit with no new_branch input pushes the checked-out branch, master on a run on master$/,
      /^jobs\.j\.steps\[2\]: "git push origin HEAD" pushes the checked-out branch, master on a run on master$/,
    ]);
  });

  test('a checkout of an ancestor removes the checkouts beneath it, so git -C into a directory made there again runs in the ancestor\'s', () => {
    // From the review of agentos-extensions#353: actions/checkout empties a directory that is not a checkout of the
    // same repository, and cleans one that is with git clean -ffdx, which removes nested repositories. The site
    // checkout on feature is gone once the root is checked out on master, so the push from site/ pushes master.
    expectFindings({ '.github/workflows/w.yml': workflow(ON_PULL_REQUEST, text`
      - uses: actions/checkout@v5
        with:
          ref: feature
          path: site
      - uses: actions/checkout@v5
        with:
          ref: master
      - run: |
          mkdir -p site
          git -C site push origin HEAD
    `) }, [/^jobs\.j\.steps\[2\]: "git push origin HEAD" pushes the checked-out branch, master on a run on master$/]);
  });

  test('a checkout a skipped step would have made leaves its directory in the checkout that holds it, and pushd -n changes no directory', () => {
    // From CodeRabbit's review of agentos-extensions#353. When the step with if: is skipped, site/sub is a directory
    // of the site checkout on master, so the push from there pushes master.
    expectFindings({ '.github/workflows/w.yml': workflow(ON_PULL_REQUEST, text`
      - uses: actions/checkout@v5
      - uses: actions/checkout@v5
        with:
          path: site
          ref: master
      - if: %{{ vars.SUB }}
        uses: actions/checkout@v5
        with:
          path: site/sub
          ref: feature
      - run: git -C site/sub push origin HEAD
    `) }, [/^jobs\.j\.steps\[3\]: "git push origin HEAD" pushes the checked-out branch, master on a run on master$/]);
    // pushd -n adds base to the directory stack and leaves the shell where it is, in the root checkout on master.
    expectFindings({ '.github/workflows/w.yml': workflow(ON_MASTER, text`
      - uses: actions/checkout@v5
      - uses: actions/checkout@v5
        with:
          ref: feature
          path: base
      - run: |
          pushd -n base
          git push origin HEAD
    `) }, [/^jobs\.j\.steps\[2\]: "git push origin HEAD" pushes the checked-out branch, master on a run on master$/]);
  });

  test('a script a shell reads from its standard input runs in the directory env -C gives that shell, with its GIT_DIR', () => {
    const pushes = (/** @type {number[]} */ steps) => steps.map((k) => new RegExp(`^jobs\\.j\\.steps\\[${k}\\]: "git push origin HEAD" pushes the checked-out branch, master on a run on master$`));
    // From Codex's review of agentos-extensions#353 (51ae362). On a pull request run with master checked out at base,
    // echo 'git push origin HEAD' | env -C base bash pushes master from base. A printf's words, a here-string, a
    // heredoc and a cat's heredoc fed to the shell run there too, and a GIT_DIR set before the shell names the
    // repository its script pushes from.
    expectFindings({ '.github/workflows/w.yml': workflow(ON_PULL_REQUEST, text`
      - uses: actions/checkout@v5
      - uses: actions/checkout@v5
        with:
          ref: master
          path: base
      - run: echo 'git push origin HEAD' | env -C base bash
      - run: printf 'git push origin HEAD\n' | env --chdir=base sh
      - run: env -C base bash <<< 'git push origin HEAD'
      - run: |
          env -C base bash <<'EOF'
          git push origin HEAD
          EOF
      - run: |
          cat <<'EOF' | env -C base bash
          git push origin HEAD
          EOF
      - run: echo 'git push origin HEAD' | GIT_DIR=base/.git bash
      - run: |
          env -C base bash <<EOF
          $(git push origin HEAD)
          EOF
      - run: |
          env -C base bash <<EOF
          \$(git push origin HEAD)
          EOF
      - run: |
          cd base <<EOF
          $(git push origin HEAD)
          EOF
    `) }, pushes([2, 3, 4, 5, 6, 7, 9]));
    // A master run with feature checked out at base: the script the shell reads pushes feature from base, and the
    // step's next command runs in the root checkout, on master, as before. A heredoc's script runs where its shell
    // runs, before the commands after the shell on its line: bash <<'EOF'; cd base pushes master from the root. From
    // Codex's review of agentos-extensions#353 (989aa73): the calling shell expands an unquoted heredoc's body before
    // the shell that reads it starts, so a substitution in it runs in the caller's directory, the root's on master
    // here and on the pull request's branch above, and an escaped one (\$( )) is left to the shell that reads it.
    // From Codex's review of agentos-extensions#353 (0a06344): the calling shell expands the body before it runs
    // the command the heredoc feeds, so cd base <<EOF with a $(git push origin HEAD) in its body pushes from the
    // directory the script was in, the root's, on master here and on the pull request's branch above.
    expectFindings({ '.github/workflows/w.yml': workflow(ON_MASTER, text`
      - uses: actions/checkout@v5
      - uses: actions/checkout@v5
        with:
          ref: feature
          path: base
      - run: echo 'git push origin HEAD' | env -C base bash
      - run: |
          env -C base bash <<'EOF'
          git push origin HEAD
          EOF
          git push origin HEAD
      - run: |
          bash <<'EOF'; cd base
          git push origin HEAD
          EOF
      - run: |
          env -C base bash <<EOF
          $(git push origin HEAD)
          EOF
      - run: |
          cd base <<EOF
          $(git push origin HEAD)
          EOF
    `) }, pushes([3, 4, 5, 6]));
  });

  test('a directory the last command of a pipeline changes to is one this check cannot tell, since shopt -s lastpipe runs that command in the script\'s own shell', () => {
    const pushes = (/** @type {number[]} */ steps) => steps.map((k) => new RegExp(`^jobs\\.j\\.steps\\[${k}\\]: "git push origin HEAD" pushes the checked-out branch, master on a run on master$`));
    // From Codex's review of agentos-extensions#353 (94d31a1). On a pull request run with master checked out at base,
    // shopt -s lastpipe; true | cd base; git push origin HEAD pushes master from base: lastpipe runs the last command of
    // a pipeline in the script's own shell. A last command that changes no directory leaves the script where it was,
    // and a command before a | still changes directory for itself alone.
    expectFindings({ '.github/workflows/w.yml': workflow(ON_PULL_REQUEST, text`
      - uses: actions/checkout@v5
      - uses: actions/checkout@v5
        with:
          ref: master
          path: base
      - run: |
          shopt -s lastpipe
          true | cd base
          git push origin HEAD
      - run: |
          true | pushd base
          git push origin HEAD
      - run: |
          echo base | grep base
          git push origin HEAD
      - run: |
          cd base | cat
          git push origin HEAD
    `) }, pushes([2, 3]));
  });

  test('a local composite action reads the inputs its caller gives, else their defaults', () => {
    expectFindings({
      // From the review of agentos-extensions#341: the caller names master, which the action checks out.
      '.github/actions/to-branch/action.yml': text`
        name: to-branch
        inputs:
          branch:
            required: true
        runs:
          using: composite
          steps:
            - run: git checkout "%{{ inputs.branch }}"
              shell: bash
      `,
      '.github/actions/fallback/action.yml': text`
        name: fallback
        inputs:
          branch:
            required: false
        runs:
          using: composite
          steps:
            - run: git switch "%{{ inputs.branch || 'docs' }}"
              shell: bash
      `,
      '.github/actions/publish/action.yml': text`
        name: publish
        inputs:
          target:
            default: master
        runs:
          using: composite
          steps:
            - run: git push origin "HEAD:%{{ inputs.target }}"
              shell: bash
      `,
      '.github/workflows/w.yml': workflow(ON_PULL_REQUEST, text`
        - run: git checkout -b feature
        - uses: ./.github/actions/to-branch
          with:
            branch: master
        - run: git push origin HEAD
        - run: git checkout -b docs-update
        - uses: ./.github/actions/to-branch
          with:
            Branch: %{{ github.event.repository.default_branch }}
        - run: git push origin HEAD
        - run: git checkout -b registry-update
        - uses: ./.github/actions/fallback
          with:
            branch: master
        - run: git push origin HEAD
        - uses: ./.github/actions/publish
      `),
    }, [
      /^jobs\.j\.steps\[2\]: "git push origin HEAD" pushes the checked-out branch, master on a run on master$/,
      /^jobs\.j\.steps\[5\]: "git push origin HEAD" pushes the checked-out branch, master on a run on master$/,
      /^jobs\.j\.steps\[8\]: "git push origin HEAD" pushes the checked-out branch, master on a run on master$/,
      // Its default pushes master: found in its own reading and in the call, reported once.
      /^runs\.steps\[0\]: "git push origin HEAD:master" pushes to master$/,
    ]);
  });

  test('git config --unset with a value pattern removes only what it matches, and a checkout keeps settings of its own', () => {
    expectFindings({
      // From the review of agentos-extensions#341: two refspecs set, and the feature one unset by its pattern.
      '.github/workflows/w.yml': workflow(ON_PULL_REQUEST, text`
        - run: |
            git switch -c feature
            git config --add remote.origin.push HEAD:master
            git config --add remote.origin.push HEAD:feature
            git config --unset remote.origin.push HEAD:feature
            git push origin
        - run: |
            git config --add remote.origin.push HEAD:feature
            git config --unset remote.origin.push HEAD
            git config unset --value=HEAD --all --fixed-value remote.origin.push
            git config --unset --all remote.origin.push
            git push origin
        - run: |
            git config --unset-all remote.origin.push '!master'
            git push
        - run: |
            git config --unset-all remote.origin.push
            git config --global push.default matching
            git config --unset push.default
            git push origin
      `),
      '.github/workflows/x.yml': workflow(ON_PULL_REQUEST, text`
        - uses: actions/checkout@v5
        - uses: actions/checkout@v5
          with:
            path: other
            ref: feature
        - run: git config --add remote.origin.push HEAD:master
        - working-directory: other
          run: git config --unset-all remote.origin.push
        - run: git push origin
      `),
    }, [
      /^jobs\.j\.steps\[0\]: "git push origin" \(remote\.<name>\.push\) pushes to master$/,
      /^jobs\.j\.steps\[1\]: "git push origin" \(remote\.<name>\.push\) pushes to master$/,
      /^jobs\.j\.steps\[2\]: "git push" \(remote\.<name>\.push\) pushes to master$/,
      /^jobs\.j\.steps\[3\]: "git push origin" with push\.default=matching pushes every branch the remote also has, master among them$/,
      /^jobs\.j\.steps\[4\]: "git push origin" \(remote\.<name>\.push\) pushes to master$/,
    ]);
  });

  test('a push with no refspec sends the refspecs of the remote it names, and of any remote when it names none', () => {
    // From CodeRabbit's review of framerslab/agentos#679: git reads remote.<name>.push for the remote it pushes to
    // alone, so with HEAD:master set for backup, git push origin pushes the checked-out branch as push.default says.
    // With no remote named, or one this check cannot tell, the remote may be any of them.
    expectFindings({
      '.github/workflows/a.yml': workflow(ON_PULL_REQUEST, text`
        - run: |
            git config --add remote.backup.push HEAD:master
            git push origin
      `),
      '.github/workflows/b.yml': workflow(ON_PULL_REQUEST, '- run: git -c remote.backup.push=HEAD:master push origin'),
      '.github/workflows/c.yml': workflow(ON_PULL_REQUEST, text`
        - run: |
            git config --add remote.backup.push HEAD:master
            git push backup
      `),
      '.github/workflows/d.yml': workflow(ON_PULL_REQUEST, text`
        - run: |
            git config --add remote.backup.push HEAD:master
            git push
      `),
      '.github/workflows/e.yml': workflow(ON_PULL_REQUEST, text`
        - run: |
            git config --add remote.backup.push HEAD:master
            git push $REMOTE
      `),
      '.github/workflows/f.yml': workflow(ON_PULL_REQUEST, '- run: git -c remote.backup.push=HEAD:master push backup'),
    }, [
      /^jobs\.j\.steps\[0\]: "git push backup" \(remote\.<name>\.push\) pushes to master$/,
      /^jobs\.j\.steps\[0\]: "git push" \(remote\.<name>\.push\) pushes to master$/,
      /^jobs\.j\.steps\[0\]: "git push \$REMOTE" \(remote\.<name>\.push\) pushes to master$/,
      /^jobs\.j\.steps\[0\]: "git push backup" \(remote\.<name>\.push\) pushes to master$/,
    ]);
  });

  test('a push that names no remote may reach origin or a remote with refspecs, and a key held in a variable any remote', () => {
    // From CodeRabbit's review of framerslab/agentos#679: --repo names the remote when no operand does, and a push that
    // names none goes to origin unless settings this check does not follow choose another. So with HEAD:side set for
    // backup alone, git push and git push --repo=origin push the checked-out branch, master on a master run. A remote
    // held in a variable in the key may be the one pushed to.
    expectFindings({
      '.github/workflows/a.yml': workflow(ON_MASTER, text`
        - run: |
            git config --add remote.backup.push HEAD:side
            git push --repo=origin
      `),
      '.github/workflows/b.yml': workflow(ON_MASTER, text`
        - run: |
            git config --add remote.backup.push HEAD:side
            git push
      `),
      '.github/workflows/c.yml': workflow(ON_PULL_REQUEST, text`
        - run: |
            git config --add remote.$REMOTE.push HEAD:master
            git push origin
      `),
      '.github/workflows/d.yml': workflow(ON_PULL_REQUEST, text`
        - run: |
            git config --add remote.backup.push HEAD:master
            git push --repo origin
      `),
    }, [
      /^jobs\.j\.steps\[0\]: "git push --repo=origin" pushes the checked-out branch, master on a run on master$/,
      /^jobs\.j\.steps\[0\]: "git push" pushes the checked-out branch, master on a run on master$/,
      /^jobs\.j\.steps\[0\]: "git push origin" \(remote\.<name>\.push\) pushes to master$/,
    ]);
  });

  test('a git command runs in the checkout its directory is in: cd, env -C, GIT_DIR, --git-dir after -C, and where that cannot be told', () => {
    const pushes = (/** @type {number[]} */ steps) => steps.map((k) => new RegExp(`^jobs\\.j\\.steps\\[${k}\\]: "git push origin HEAD" pushes the checked-out branch, master on a run on master$`));
    // A pull request run with master checked out at base and at nested/base. A compound command a | feeds or an &
    // ends runs in a shell of its own, a function's body runs where the function is called, and a GIT_DIR in a
    // step's env: names a repository as one before the command does. From Codex's review of agentos-extensions#353
    // (6a0e047): an & runs the whole and-or list it ends in a shell of its own, so cd base; cd .. && true & wait;
    // git push origin HEAD pushes master from base, and a heredoc's script runs where its shell runs, within the job.
    expectFindings({ '.github/workflows/w.yml': workflow(ON_PULL_REQUEST, text`
      - uses: actions/checkout@v5
      - uses: actions/checkout@v5
        with:
          ref: master
          path: base
      - run: |
          cd base
          git push origin HEAD
      - run: (cd base && git push origin HEAD)
      - run: env -C base git push origin HEAD
      - run: GIT_DIR=base/.git git push origin HEAD
      - uses: actions/checkout@v5
        with:
          ref: master
          path: nested/base
      - run: git --git-dir=base/.git -C nested push origin HEAD
      - run: |
          cd "$DIR"
          git push origin HEAD
      - run: |
          f() { cd base; }
          f
          git push origin HEAD
      - run: |
          { cd base; } | cat
          git push origin HEAD
      - run: |
          eval eval eval eval eval cd base
          git push origin HEAD
      - run: |
          { cd base; } &
          wait
          git push origin HEAD
      - run: |
          g() { cd base; }
          git push origin HEAD
      - env:
          GIT_DIR: base/.git
        run: git push origin HEAD
      - run: |
          { cd base; }|cat
          git push origin HEAD
      - run: cd base; cd .. && true & wait; git push origin HEAD
      - run: |
          cd base && cat <<'EOF' | bash &
          git push origin HEAD
          EOF
          wait
      - run: env -C . -C base git push origin HEAD
    `) }, pushes([2, 3, 4, 5, 7, 8, 9, 11, 14, 16, 17, 18]));
    // A master run with feature checked out at base: a shell of its own does not move the script. From Codex's review
    // of agentos-extensions#353 (989aa73): env changes to the last directory it is given alone, from where it starts
    // (coreutils' env.c keeps one newdir), so env -C base -C . git push origin HEAD pushes master from the root.
    expectFindings({ '.github/workflows/w.yml': workflow(ON_MASTER, text`
      - uses: actions/checkout@v5
      - uses: actions/checkout@v5
        with:
          ref: feature
          path: base
      - run: |
          x=$(cd base && pwd)
          git push origin HEAD
      - run: |
          (cd base)
          git push origin HEAD
      - run: |
          cd base | cat
          git push origin HEAD
      - run: |
          cd base &
          git push origin HEAD
      - run: |
          bash -c 'cd base'
          git push origin HEAD
      - run: |
          { cd base; } | cat
          git push origin HEAD
      - run: |
          if true; then cd base; fi &
          git push origin HEAD
      - run: |
          h() { cd base; }
          git push origin HEAD
      - run: |
          { cd base; }&
          git push origin HEAD
      - run: |
          cd base && true &
          wait
          git push origin HEAD
      - run: env -C base -C . git push origin HEAD
    `) }, pushes([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]));
  });

  test('a GIT_DIR in env: names the repository (the step\'s, else the job\'s, else the workflow\'s) beneath GIT_DIR= and --git-dir; env -i and env -u remove it, and sudo may drop it', () => {
    expectFindings({
      '.github/workflows/w.yml': text`
        on:
          pull_request:
        env:
          GIT_DIR: base/.git
        jobs:
          j:
            runs-on: ubuntu-latest
            steps:
              - uses: actions/checkout@v5
                with:
                  ref: master
                  path: base
              - run: git push origin HEAD
          k:
            runs-on: ubuntu-latest
            env:
              GIT_DIR: .git
            steps:
              - uses: actions/checkout@v5
                with:
                  ref: master
                  path: base
              - run: git push origin HEAD
              - run: GIT_DIR=base/.git git push origin HEAD
              - env:
                  GIT_DIR: base/.git
                run: git --git-dir=.git push origin HEAD
              - run: GIT_DIR=.git sudo git push origin HEAD
              - run: sudo GIT_DIR=.git git push origin HEAD
          # env -i and env -u remove it; sudo's env_reset may drop it unless -E or --preserve-env keeps it; a shell
          # passes it on.
          m:
            runs-on: ubuntu-latest
            env:
              GIT_DIR: base/.git
            steps:
              - uses: actions/checkout@v5
                with:
                  ref: master
                  path: base
              - run: env -u GIT_DIR git push origin HEAD
              - run: env -i PATH="$PATH" git push origin HEAD
              - run: sudo git push origin HEAD
              - run: sudo -E git push origin HEAD
              - run: sudo --preserve-env=HOME git push origin HEAD
              - run: env -u GIT_DIR sudo -E git push origin HEAD
              - run: bash -c 'git push origin HEAD'
              - run: env -i bash -c 'git push origin HEAD'
      `,
      // A push action's git commands read the GIT_DIR its step's env: gives, from its directory.
      '.github/workflows/x.yml': workflow(ON_MASTER, text`
        - uses: actions/checkout@v5
          with:
            ref: feature
        - uses: actions/checkout@v5
          with:
            ref: master
            path: base
        - uses: stefanzweifel/git-auto-commit-action@v5
          env:
            GIT_DIR: base/.git
        - uses: stefanzweifel/git-auto-commit-action@v5
      `),
    }, [
      /^jobs\.j\.steps\[1\]: "git push origin HEAD" pushes the checked-out branch, master on a run on master$/,
      /^jobs\.k\.steps\[2\]: "git push origin HEAD" pushes the checked-out branch, master on a run on master$/,
      /^jobs\.k\.steps\[4\]: "git push origin HEAD" pushes the checked-out branch, master on a run on master$/,
      /^jobs\.m\.steps\[3\]: "git push origin HEAD" pushes the checked-out branch, master on a run on master$/,
      /^jobs\.m\.steps\[4\]: "git push origin HEAD" pushes the checked-out branch, master on a run on master$/,
      /^jobs\.m\.steps\[5\]: "git push origin HEAD" pushes the checked-out branch, master on a run on master$/,
      /^jobs\.m\.steps\[7\]: "git push origin HEAD" pushes the checked-out branch, master on a run on master$/,
      /^jobs\.j\.steps\[2\]: stefanzweifel\/git-auto-commit-action with no branch input pushes the checked-out branch, master on a run on master$/,
    ]);
  });

  test('push settings: an unset push.default merges as the setting beneath it, --system apart from --global, refused unsets, and a checkout of another repository', () => {
    expectFindings({
      '.github/workflows/w.yml': workflow(ON_PULL_REQUEST, text`
        - run: |
            git switch -c feature
            git config --global push.default matching
            [ -n "$X" ] && git config push.default simple
            git push origin
        - run: |
            git config --unset push.default
            git config --global --unset push.default
            sudo git config --system --add remote.origin.push HEAD:master
            git config --global --add remote.origin.push HEAD:feature
            git config --global --unset-all remote.origin.push
            git push origin
        - run: |
            git config --system --unset-all remote.origin.push
            git config --add remote.origin.push HEAD:master
            git config unset remote.origin.push HEAD:feature
            git config --file other.cfg --unset-all remote.origin.push
            git config --unset-all remote.origin.push '\<HEAD'
            git push origin
      `),
      // A step of actions/checkout with a path this check cannot tell may move a checkout it already knows.
      '.github/workflows/x.yml': workflow(ON_PULL_REQUEST, text`
        - uses: actions/checkout@v5
          with:
            path: site
            ref: gh-pages
        - uses: actions/checkout@v5
          with:
            path: %{{ env.SITE_DIR }}
            ref: master
        - run: git -C site push origin HEAD
      `),
      // Another repository where one was starts with git's own settings: push.default=nothing is gone.
      '.github/workflows/y.yml': workflow(ON_PULL_REQUEST, text`
        - uses: actions/checkout@v5
          with:
            repository: framerslab/one
            path: site
        - run: git -C site config push.default nothing
        - uses: actions/checkout@v5
          with:
            repository: framerslab/two
            path: site
        - run: git -C site push origin
      `),
    }, [
      /^jobs\.j\.steps\[0\]: "git push origin" with push\.default=matching pushes every branch the remote also has, master among them$/,
      /^jobs\.j\.steps\[1\]: "git push origin" \(remote\.<name>\.push\) pushes to master$/,
      /^jobs\.j\.steps\[2\]: "git push origin" \(remote\.<name>\.push\) pushes to master$/,
      /^jobs\.j\.steps\[2\]: "git push origin HEAD" pushes the checked-out branch, master on a run on master$/,
      /^jobs\.j\.steps\[3\]: "git push origin" pushes the checked-out branch, master on a run on master$/,
    ]);
  });

  test('a composite input whose value mixes text and an expression, inside a longer expression', () => {
    expectFindings({
      // From the review of agentos#572: format() of an input the caller gives as refs/heads/ and the default branch.
      '.github/actions/publish/action.yml': text`
        name: publish
        inputs:
          target:
            required: true
        runs:
          using: composite
          steps:
            - run: git push origin "HEAD:%{{ format('{0}', inputs.target) }}"
              shell: bash
      `,
      '.github/workflows/w.yml': workflow(ON_PULL_REQUEST, text`
        - uses: ./.github/actions/publish
          with:
            target: refs/heads/%{{ github.event.repository.default_branch }}
      `),
    }, [/^runs\.steps\[0\]: "git push origin HEAD:\$\{\{ format\('\{0\}', format\('refs\/heads\/\{0\}', \(github\.event\.repository\.default_branch\)\)\) \}\}" pushes to /]);
  });

  test('a global push.default set on one path and unset on the other merges as what each reads, the system one beneath', () => {
    expectFindings({
      // From the review of agentos#572: the path that leaves the global setting unset pushes with the system matching.
      '.github/workflows/w.yml': workflow(ON_PULL_REQUEST, text`
        - run: |
            git switch -c feature
            sudo git config --system push.default matching
            [ -n "$X" ] && git config --global push.default simple
            git push origin
      `),
      // The same where a directory this check cannot tell has the unset read in each checkout in turn.
      '.github/workflows/x.yml': workflow(ON_PULL_REQUEST, text`
        - uses: actions/checkout@v5
          with:
            path: site
        - run: |
            git switch -c feature
            sudo git config --system push.default matching
            git config --global push.default simple
            cd "$DIR"
            git config --global --unset push.default
            git push origin
      `),
    }, [
      /^jobs\.j\.steps\[0\]: "git push origin" with push\.default=matching pushes every branch the remote also has, master among them$/,
      /^jobs\.j\.steps\[1\]: "git push origin" with push\.default=matching pushes every branch the remote also has, master among them$/,
    ]);
  });

  test('a composite step whose if: is an input, a string there, so an input of false still runs it', () => {
    expectFindings({
      // From the review of agentos#572: in an if: the string 'false' is true, so the step runs and pushes master.
      '.github/actions/release/action.yml': text`
        name: release
        inputs:
          push:
            default: 'false'
        runs:
          using: composite
          steps:
            - if: %{{ inputs.push }}
              run: git push origin HEAD:master
              shell: bash
      `,
      '.github/workflows/w.yml': workflow(ON_PULL_REQUEST, text`
        - uses: ./.github/actions/release
          with:
            push: false
      `),
    }, [/^runs\.steps\[0\]: "git push origin HEAD:master" pushes to master$/]);
  });

  test('git switch -- master and git checkout master --, which check master out, and git push options as git reads them', () => {
    expectFindings({ '.github/workflows/w.yml': workflow(ON_PULL_REQUEST, text`
      - run: |
          git switch -- master
          git push origin HEAD
      - run: |
          git checkout -b feature
          git checkout master --
          git push origin HEAD
      - run: |
          git checkout -b feature
          git push --dry-run --no-dry-run origin HEAD:master
          git push -n --no-dry origin HEAD:master
          git push --mir origin
    `) }, [
      /^jobs\.j\.steps\[0\]: "git push origin HEAD" pushes the checked-out branch, master on a run on master$/,
      /^jobs\.j\.steps\[1\]: "git push origin HEAD" pushes the checked-out branch, master on a run on master$/,
      /^jobs\.j\.steps\[2\]: "git push --dry-run --no-dry-run origin HEAD:master" pushes to master$/,
      /^jobs\.j\.steps\[2\]: "git push -n --no-dry origin HEAD:master" pushes to master$/,
      /^jobs\.j\.steps\[2\]: "git push --mir origin" pushes every branch, master among them$/,
    ]);
  });

  test('a push with no refspec under push.default=matching or upstream, or with remote.<name>.push set', () => {
    expectFindings({ '.github/workflows/w.yml': workflow(ON_MASTER, text`
      - uses: actions/checkout@v5
      - run: |
          git switch -c feature
          git -c push.default=matching push origin
      - run: |
          git config --global push.default upstream
          git push
      - run: |
          git -c remote.origin.push=refs/heads/feature:refs/heads/master push
          git config push.default simple
          git config --add remote.origin.push HEAD:refs/heads/master
          git push origin
    `) }, [
      /^jobs\.j\.steps\[1\]: "git push origin" with push\.default=matching pushes every branch the remote also has, master among them$/,
      /^jobs\.j\.steps\[2\]: "git push" with push\.default=upstream pushes the checked-out branch to the branch it tracks, which can be master/,
      /^jobs\.j\.steps\[3\]: "git push" \(remote\.<name>\.push\) pushes to refs\/heads\/master$/,
      /^jobs\.j\.steps\[3\]: "git push origin" \(remote\.<name>\.push\) pushes to refs\/heads\/master$/,
    ]);
  });

  test('a pull request workflow that runs when the pull request closes, which a merge runs on master', () => {
    // A merged pull request's closed run has GITHUB_REF set to the branch it went into (GitHub's events reference).
    expectFindings({ '.github/workflows/w.yml': workflow('pull_request:\n  types: [closed]\n  branches: [master]', text`
      - uses: actions/checkout@v5
      - run: git push origin "HEAD:$GITHUB_REF"
      - run: git push
    `) }, [/^jobs\.j\.steps\[1\]: "git push origin HEAD:\$GITHUB_REF" pushes to the run's own branch, master on a run on master$/, /^jobs\.j\.steps\[2\]: "git push" pushes the checked-out branch, master on a run on master$/]);
  });

  test('a pull_request_target run, which is on the default branch whatever base branches it filters', () => {
    // GITHUB_REF of a pull_request_target run is the default branch (GitHub's events reference, pull_request_target);
    // its branches filter picks the pull requests by their base branch.
    expectFindings({ '.github/workflows/w.yml': workflow('pull_request_target:\n  branches: [develop]', text`
      - uses: actions/checkout@v5
      - run: git push origin "HEAD:$GITHUB_REF"
    `) }, [/^jobs\.j\.steps\[1\]: "git push origin HEAD:\$GITHUB_REF" pushes to the run's own branch, master on a run on master$/]);
  });

  test('a deploy action whose repository input names this repository', () => {
    expectFindings({ '.github/workflows/w.yml': workflow(ON_MASTER, text`
      - uses: peaceiris/actions-gh-pages@v4
        with: { github_token: x, publish_dir: out, publish_branch: master, external_repository: '%{{ github.repository }}' }
      - uses: JamesIves/github-pages-deploy-action@v4
        with: { folder: out, branch: master, repository-name: Framerslab/This-Repo }
      - uses: ad-m/github-push-action@v0.8.0
        with: { github_token: x, repository: framerslab/this-repo }
    `) }, [/peaceiris\/actions-gh-pages publishes to master$/, /JamesIves\/github-pages-deploy-action publishes to master$/, /ad-m\/github-push-action with no branch input pushes master, the repository's default branch/], { repository: 'framerslab/this-repo' });
  });

  test('a pull request review run, on which git-auto-commit-action has no head branch and pushes the checked-out one', () => {
    // github.head_ref is set on pull_request and pull_request_target alone (GitHub's contexts reference).
    expectFindings({ '.github/workflows/w.yml': workflow('pull_request_review:', text`
      - uses: actions/checkout@v5
        with:
          ref: master
      - uses: stefanzweifel/git-auto-commit-action@v5
    `) }, [/git-auto-commit-action with no branch input pushes the checked-out branch, master on a run on master$/]);
  });

  test('actions that push to master', () => {
    expectFindings({ '.github/workflows/w.yml': workflow(ON_MASTER, text`
      - uses: ad-m/github-push-action@v0.6.0
        with: { github_token: x }
      - uses: JamesIves/github-pages-deploy-action@v4
        with: { branch: master, folder: build }
      - uses: stefanzweifel/git-auto-commit-action@v5
      - uses: EndBug/add-and-commit@v9
      - uses: EndBug/add-and-commit@v9
        with:
          push: origin HEAD:master --force
      # dry_run came in v11.1.0; v10 ignores it and pushes.
      - uses: EndBug/add-and-commit@v10
        with:
          dry_run: true
    `) }, [/ad-m\/github-push-action with no branch input pushes master, the repository's default branch/, /JamesIves\/github-pages-deploy-action publishes to master$/, /git-auto-commit-action with no branch input pushes the checked-out branch, master on a run on master$/, /EndBug\/add-and-commit with no new_branch input pushes the checked-out branch/, /"git push origin HEAD:master --force" pushes to master$/, /EndBug\/add-and-commit with no new_branch input pushes the checked-out branch/]);
  });

  test('semantic-release on master while the configuration lists @semantic-release/git', () => {
    expectFindings({
      'release.config.js': RELEASE_CONFIG_WITH_GIT,
      'package.json': JSON.stringify({ scripts: { release: 'semantic-release --ci', ship: 'npm run release' } }),
      '.github/workflows/w.yml': workflow(ON_MASTER, text`
        - run: npx semantic-release
        - run: pnpm exec semantic-release
        - run: npm run ship
        - uses: cycjimmy/semantic-release-action@v4
      `),
    }, [/"npx semantic-release" runs semantic-release on a run on master while release\.config\.js lists @semantic-release\/git/, /"pnpm exec semantic-release" runs semantic-release/, /"npm run ship" runs semantic-release/, /cycjimmy\/semantic-release-action runs semantic-release on a run on master while release\.config\.js lists/]);
  });

  test('a composite action, which runs in whichever job calls it', () => {
    expectFindings({ '.github/actions/push/action.yml': text`
      name: push
      runs:
        using: composite
        steps:
          - run: git push
            shell: bash
    ` }, [/^runs\.steps\[0\]: "git push" pushes the checked-out branch/]);
  });
});

describe('allowed: a workflow that does not push to master', () => {
  test('a push that is printed, commented, fed to cat, or a dry run', () => {
    expectFindings({ '.github/workflows/w.yml': workflow(ON_MASTER, text`
      - run: |
          echo git push origin HEAD:master
          printf '%s\n' "git push origin master"
          # git push origin master
          cat <<EOF > notes.txt
          git push origin master
          EOF
          git push --dry-run origin HEAD:master
          git push -n origin master
          command -v git
          echo git push origin HEAD:master | tee push.log
          cat <<'EOF' | sh -c 'cat > release.sh'
          git push origin master
          EOF
          bash release.sh <<'EOF'
          git push origin master
          EOF
          bash release.sh <<< 'git push origin master'
    `) }, []);
  });

  test('a branch of its own, tags, and a token URL as the repository', () => {
    expectFindings({ '.github/workflows/w.yml': workflow(ON_MASTER, text`
      - run: |
          git checkout -b "chore/update-$GITHUB_RUN_ID"
          git push -u origin HEAD
          git push origin HEAD:refs/heads/chore/x
          git push --tags
          git push origin v1.2.3
          git push origin tag v1.2.4
          git push "https://x-access-token:%{{ secrets.TOKEN }}@github.com/o/r.git" HEAD:refs/heads/feature
          git switch -c other
          git push
          git switch -c feature --track origin/master
          git push
    `) }, []);
  });

  test('git switch - back to a branch of its own, and a branch started from the one before', () => {
    expectFindings({ '.github/workflows/w.yml': workflow(ON_MASTER, text`
      - uses: actions/checkout@v5
      - run: |
          git switch -c one
          git switch -c two
          git switch -
          git push origin HEAD
          git checkout - -- package.json
          git push
          git switch - -c three
          git push -u origin HEAD
    `) }, []);
  });

  test('a checkout every path takes: an && chain, an if with an else, a case with a * pattern, || exit 1, a group or a subshell after &&', () => {
    expectFindings({
      '.github/workflows/a.yml': workflow(ON_MASTER, '- run: git fetch origin && git checkout -b registry-update && git push origin HEAD'),
      '.github/workflows/b.yml': workflow(ON_MASTER, text`
        - run: |
            if [ -n "$NEXT" ]; then
              git checkout -b next
            elif [ -n "$DOCS" ]; then
              git checkout -b docs-update
            else
              git checkout -b registry-update
            fi
            git push origin HEAD
      `),
      '.github/workflows/c.yml': workflow(ON_MASTER, text`
        - run: |
            case "$KIND" in
              docs) git checkout -b docs-update ;;
              *) git checkout -b registry-update ;;
            esac
            git push -u origin HEAD
      `),
      '.github/workflows/d.yml': workflow(ON_MASTER, text`
        - run: |
            git checkout -b registry-update || exit 1
            git push origin HEAD
      `),
      '.github/workflows/e.yml': workflow(ON_MASTER, '- run: git fetch origin && { git checkout -b registry-update; git push origin HEAD; }'),
      '.github/workflows/f.yml': workflow(ON_MASTER, '- run: git fetch origin && (git checkout -b registry-update; git push origin HEAD)'),
    }, []);
  });

  test('a step whose condition holds when the steps before it succeed, a step with if: false, and a local composite action that checks out a branch of its own', () => {
    expectFindings({
      '.github/actions/branch/action.yml': text`
        name: branch
        runs:
          using: composite
          steps:
            - run: git checkout -b registry-update
              shell: bash
      `,
      '.github/actions/outer/action.yml': text`
        name: outer
        runs:
          using: composite
          steps:
            - uses: ./.github/actions/branch
      `,
      // An action that calls itself is followed a few calls deep, then left.
      '.github/actions/again/action.yml': text`
        name: again
        runs:
          using: composite
          steps:
            - uses: ./.github/actions/again
      `,
      '.github/workflows/a.yml': workflow(ON_MASTER, text`
        - if: success()
          run: git checkout -b registry-update
        - run: git push origin HEAD
        - if: %{{ always() }}
          run: git checkout -b docs-update
        - run: git push origin HEAD
        - if: false
          run: git push origin HEAD:master
      `),
      '.github/workflows/b.yml': workflow(ON_MASTER, text`
        - uses: ./.github/actions/outer
        - uses: ./.github/actions/again
        - uses: ./.github/actions/missing
        - run: git push origin HEAD
      `),
    }, []);
  });

  test('a push from a checkout in another directory on a branch of its own, and from a root checkout that is not master', () => {
    expectFindings({ '.github/workflows/w.yml': workflow(ON_MASTER, text`
      - uses: actions/checkout@v5
        with:
          ref: registry-update
      - uses: actions/checkout@v5
        with:
          path: site
          ref: gh-pages
      - working-directory: site
        run: git push origin HEAD
      - run: |
          git -C site push origin HEAD
          git -C site checkout -b preview
          git -C site push origin HEAD
          git push origin HEAD
      - run: cd site && git push origin HEAD
      - uses: stefanzweifel/git-auto-commit-action@v5
        with:
          repository: site
      - uses: EndBug/add-and-commit@v9
        with:
          cwd: %{{ github.workspace }}/site
    `) }, []);
  });

  test('a local composite action given a branch of its own, or left to the default it names', () => {
    expectFindings({
      '.github/actions/to-branch/action.yml': text`
        name: to-branch
        inputs:
          branch:
            default: registry-update
        runs:
          using: composite
          steps:
            - run: git checkout -B "%{{ inputs.branch }}"
              shell: bash
            - run: git push origin "HEAD:%{{ inputs.branch }}"
              shell: bash
      `,
      '.github/workflows/w.yml': workflow(ON_MASTER, text`
        - uses: ./.github/actions/to-branch
        - run: git push origin HEAD
        - uses: ./.github/actions/to-branch
          with:
            branch: docs-update
        - run: git push origin HEAD
      `),
    }, []);
  });

  test('git config --unset with a pattern that matches the master refspec, with --fixed-value, and --global beneath the checkout', () => {
    expectFindings({ '.github/workflows/w.yml': workflow(ON_PULL_REQUEST, text`
      - run: |
          git switch -c feature
          git config --add remote.origin.push HEAD:master
          git config --add remote.origin.push HEAD:feature
          git config --unset remote.origin.push master
          git push origin
          git config --add remote.origin.push refs/heads/x:refs/heads/master
          git config unset --all --value=master remote.origin.push
          git config --add remote.origin.push HEAD:master
          git config --unset-all --fixed-value remote.origin.push HEAD:master
          git push
          git config --global --add remote.origin.push HEAD:master
          git config --global --unset remote.origin.push
          git push
    `) }, []);
  });

  test('a checkout of the same repository with clean: false keeps the checkouts beneath it, and a --global unset where the directory cannot be told holds in every checkout', () => {
    // The root checked out again on master with clean: false: the site checkout on feature stays, and so does its branch.
    expectFindings({ '.github/workflows/w.yml': workflow(ON_PULL_REQUEST, text`
      - uses: actions/checkout@v5
      - uses: actions/checkout@v5
        with:
          ref: feature
          path: site
      - uses: actions/checkout@v5
        with:
          ref: master
          clean: false
      - run: git -C site push origin HEAD
    `) }, []);
    // From the review of agentos-extensions#353: a --global setting is one file whichever checkout the command runs
    // in, so its unset, read in each checkout in turn after cd "$DIR", leaves no master refspec in any.
    expectFindings({ '.github/workflows/w.yml': workflow(ON_MASTER, text`
      - uses: actions/checkout@v5
        with:
          ref: feature
      - uses: actions/checkout@v5
        with:
          ref: feature
          path: base
      - run: git config --global --add remote.origin.push HEAD:master
      - run: |
          cd "$DIR"
          git config --global --unset-all remote.origin.push
      - run: git push origin
    `) }, []);
  });

  test('a git command in another checkout by cd, or by a path git -C names whatever the directory', () => {
    // A master run with feature checked out at base.
    expectFindings({ '.github/workflows/w.yml': workflow(ON_MASTER, text`
      - uses: actions/checkout@v5
      - uses: actions/checkout@v5
        with:
          ref: feature
          path: base
      - run: cd base && git push origin HEAD
      - run: |
          cd base
          git checkout -b preview
          git push origin HEAD
      - run: (cd base; git push origin HEAD)
      - run: |
          eval 'cd base'
          git push origin HEAD
      - run: |
          pushd base
          git push origin HEAD
    `) }, []);
    // A pull request run: git -C names site from wherever cd left the script, so the root stays as it was.
    expectFindings({ '.github/workflows/w.yml': workflow(ON_PULL_REQUEST, text`
      - uses: actions/checkout@v5
      - uses: actions/checkout@v5
        with:
          path: site
          ref: gh-pages
      - run: |
          cd site
          git -C "$GITHUB_WORKSPACE/site" checkout master
      - run: git push origin HEAD
    `) }, []);
  });

  test('value patterns with bracket expressions, and a checkout of the same repository again keeps its settings', () => {
    expectFindings({
      '.github/workflows/w.yml': workflow(ON_PULL_REQUEST, text`
        - run: |
            git switch -c feature
            git config --add remote.origin.push HEAD:master
            git config --unset-all remote.origin.push 'HEAD:[a-z]*'
            git config --add remote.origin.push refs/heads/x:refs/heads/master
            git config --unset remote.origin.push '^refs/heads/[[:lower:]]:refs[/]heads[/]master$'
            git push origin
      `),
      '.github/workflows/x.yml': workflow(ON_PULL_REQUEST, text`
        - uses: actions/checkout@v5
          with:
            repository: framerslab/one
            path: site
        - run: git -C site config push.default nothing
        - uses: actions/checkout@v5
          with:
            repository: framerslab/one
            path: site
        - run: git -C site push origin
      `),
    }, []);
  });

  test('git checkout -- <paths> and <tree-ish> -- <paths> restore files, and git push options undone or cut short', () => {
    expectFindings({ '.github/workflows/w.yml': workflow(ON_MASTER, text`
      - run: |
          git checkout -b feature
          git checkout -- master
          git checkout master -- registry.json
          git push origin HEAD
          git push --dry origin HEAD:master
          git push --no-tags --mirror --no-mirror origin HEAD:feature
    `) }, []);
  });

  test('push.default current or nothing, a git config that only reads, and a refspec setting unset', () => {
    expectFindings({ '.github/workflows/w.yml': workflow(ON_MASTER, text`
      - uses: actions/checkout@v5
      - run: |
          git config --get push.default
          git config push.default
          git -c push.default=nothing push
          git config --add remote.origin.push HEAD:refs/heads/master
          git config --unset-all remote.origin.push
          git switch -c feature
          git -c push.default=current push origin
          git push
    `) }, []);
  });

  test('a pull request workflow that runs on a close into another branch, or not on a close', () => {
    expectFindings({
      '.github/workflows/a.yml': workflow('pull_request:\n  types: [closed]\n  branches: [develop]', text`
        - uses: actions/checkout@v5
        - run: git push origin "HEAD:$GITHUB_REF"
      `),
      '.github/workflows/b.yml': workflow('pull_request:\n  types: [opened, synchronize]', text`
        - uses: actions/checkout@v5
        - run: git push origin "HEAD:$GITHUB_REF"
      `),
    }, []);
  });

  test('deploy actions that publish to another repository, whose own rules apply there', () => {
    expectFindings({ '.github/workflows/w.yml': workflow(ON_MASTER, text`
      - uses: peaceiris/actions-gh-pages@v4
        with: { github_token: x, publish_dir: out, publish_branch: main, external_repository: org/org.github.io }
      - uses: JamesIves/github-pages-deploy-action@v4
        with: { folder: out, branch: master, repository-name: org/site }
      - uses: ad-m/github-push-action@v0.8.0
        with: { github_token: x, repository: org/mirror }
      - uses: ad-m/github-push-action@v0.8.0
        with: { github_token: x, repository: '%{{ secrets.MIRROR }}', branch: master }
    `) }, [], { repository: 'framerslab/this-repo' });
  });

  test('git checkout - after a checkout of a branch held in a variable returns to the branch before it', () => {
    expectFindings({ '.github/workflows/w.yml': workflow(ON_MASTER, text`
      - uses: actions/checkout@v5
      - run: |
          git switch -c feature
          git checkout "$BRANCH"
          git checkout -
          git push origin HEAD
    `) }, []);
  });

  test('actions that publish elsewhere or do not push', () => {
    expectFindings({ '.github/workflows/w.yml': workflow(ON_MASTER, text`
      - uses: peaceiris/actions-gh-pages@v4
      - uses: peaceiris/actions-gh-pages@v4
        with:
          publish_branch: agentos-live-docs
      - uses: JamesIves/github-pages-deploy-action@v4
      - uses: stefanzweifel/git-auto-commit-action@v5
        with:
          skip_push: true
      - uses: EndBug/add-and-commit@v9
        with:
          push: false
      - uses: EndBug/add-and-commit@v9
        with:
          new_branch: chore/generated
      - uses: EndBug/add-and-commit@v11.1.0
        with:
          dry_run: true
      - uses: EndBug/add-and-commit@v11
        with: { dry_run: true }
    `) }, []);
  });

  test('triggers that keep the workflow off master', () => {
    const steps = '- run: git push';
    expectFindings({
      '.github/workflows/a.yml': workflow('push:\n  branches: [release]', steps),
      '.github/workflows/b.yml': `on: { push: { branches: [develop] } }\njobs:\n  j:\n    runs-on: ubuntu-latest\n    steps:\n      - run: git push\n`,
      // A push trigger with only tags or tags-ignore runs for no branch push (GitHub's workflow syntax).
      '.github/workflows/c.yml': workflow("push:\n  tags: ['v*']", steps),
      '.github/workflows/d.yml': workflow("push:\n  tags-ignore: ['v*']", steps),
      '.github/workflows/e.yml': workflow('push:\n  branches-ignore: [master, main]', steps),
      '.github/workflows/f.yml': workflow("push:\n  branches: ['**', '!master', '!main']", steps),
      '.github/workflows/g.yml': `on: [pull_request, merge_group, release]\njobs:\n  j:\n    runs-on: ubuntu-latest\n    steps:\n      - run: git push origin "HEAD:$GITHUB_REF_NAME"\n`,
    }, []);
  });

  test('a pull request\'s head branch', () => {
    expectFindings({
      '.github/workflows/a.yml': workflow('pull_request_target:', text`
        - uses: actions/checkout@v5
          with:
            ref: %{{ github.head_ref }}
        - run: git push
        - uses: stefanzweifel/git-auto-commit-action@v5
      `),
      // On a pull request event the action's branch input defaults to github.head_ref, the head branch.
      '.github/workflows/b.yml': workflow(ON_PULL_REQUEST, text`
        - uses: actions/checkout@v5
          with:
            ref: master
        - uses: stefanzweifel/git-auto-commit-action@v5
      `),
    }, []);
  });

  test('semantic-release that commits nothing to master', () => {
    expectFindings({
      'release.config.js': text`
        module.exports = {
          branches: ['master'],
          plugins: [
            '@semantic-release/npm',
            // ['@semantic-release/git', { assets: ['package.json'] }],
            /* '@semantic-release/git', */
          ],
        };
      `,
      '.github/workflows/w.yml': workflow(ON_MASTER, '- run: npx semantic-release'),
    }, []);
    expectFindings({
      'release.config.js': RELEASE_CONFIG_WITH_GIT,
      'package.json': JSON.stringify({ scripts: { print: 'echo semantic-release' } }),
      '.github/workflows/a.yml': workflow(ON_MASTER, text`
        - run: |
            npm install -D semantic-release
            pnpm add -D semantic-release
            npm uninstall semantic-release
            npm run print
            npx semantic-release --dry-run
            echo semantic-release
      `),
      '.github/workflows/b.yml': workflow(ON_PULL_REQUEST, '- run: npx semantic-release'),
    }, []);
  });

  test("this repository's own workflows", () => {
    const branch = process.env.DEFAULT_BRANCH || 'master';
    assert.deepEqual(checkFiles(workflowFiles(repository), { root: repository, branch }), []);
  });
});

describe('the command', () => {
  /**
   * @param {Record<string, string>} files
   * @param {Record<string, string>} [env]
   */
  const run = (files, env = {}) => {
    const root = mkdtempSync(join(tmpdir(), 'workflow-pushes-'));
    try {
      for (const [path, body] of Object.entries(files)) {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), body);
      }
      return spawnSync(process.execPath, [script, '--root', root], { encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: '', ...env } });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };

  test('exits 1 and names the file, line and step of a push to master', () => {
    const result = run({ '.github/workflows/w.yml': workflow(ON_MASTER, '- run: echo build\n- name: Push\n  run: git push origin HEAD:master') });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /^\.github\/workflows\/w\.yml:9: jobs\.j\.steps\[1\] \(Push\): "git push origin HEAD:master" pushes to master$/m);
    assert.match(result.stderr, /Its rules refuse a direct push \(GH006\)/);
  });

  test('exits 0 when nothing pushes to master', () => {
    const result = run({ '.github/workflows/w.yml': workflow(ON_MASTER, '- run: git push origin HEAD:refs/heads/chore/x') });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /No workflow pushes to master \(1 files read\)/);
  });

  test('exits 2 when yq is not there', () => {
    const result = run({ '.github/workflows/w.yml': workflow(ON_MASTER, '- run: git push') }, { YQ: join(tmpdir(), 'no-such-yq') });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /mikefarah's yq v4/);
  });
});

describe('the command, against what bash and git do', () => {
  // Each case is a pull request workflow whose job checks out the pull request's branch at the root and master at
  // base, then runs one step. The command reads them all as the build job runs it. Then each step's script runs as
  // a runner runs it, under bash -e (a composite action's bash step under bash --noprofile --norc -eo pipefail), from
  // a root cloned from a bare remote's side branch, with base a clone of its master, each a commit ahead of the
  // remote. The command must report the steps after which the remote's master has moved, each on its step's line,
  // and no other. Beside git it needs bash and GNU env (env -C), which GitHub's Ubuntu runners carry.
  /** @type {{ name: string, pushes: boolean, run: string }[]} */
  const steps = [
    // Each checkout keeps a branch of its own: the root's is the pull request's, base's is master.
    { name: 'root', pushes: false, run: 'git push origin HEAD' },
    { name: 'git-c', pushes: true, run: 'git -C base push origin HEAD' },
    // cd moves the script, and so does a function's cd where the function is called; a subshell and pushd -n do not.
    { name: 'cd', pushes: true, run: 'cd base\ngit push origin HEAD' },
    { name: 'subshell', pushes: false, run: '(cd base)\ngit push origin HEAD' },
    { name: 'function', pushes: true, run: 'f() { cd base; }\nf\ngit push origin HEAD' },
    { name: 'pushd-n', pushes: false, run: 'pushd -n base\ngit push origin HEAD' },
    // env changes to the last directory it is given.
    { name: 'env-c-last', pushes: true, run: 'env -C . -C base git push origin HEAD' },
    { name: 'env-c-first', pushes: false, run: 'env -C base -C . git push origin HEAD' },
    // A command of a pipeline changes directory for itself alone; lastpipe runs the last one in the script's shell.
    { name: 'pipeline', pushes: false, run: 'cd base | true\ngit push origin HEAD' },
    { name: 'lastpipe', pushes: true, run: 'shopt -s lastpipe\ntrue | cd base\ngit push origin HEAD' },
    { name: 'and-pipeline', pushes: true, run: 'cd base && git push origin HEAD | cat' },
    // An & runs the whole and-or list it ends in a shell of its own.
    { name: 'background', pushes: false, run: 'cd base && true &\nwait\ngit push origin HEAD' },
    { name: 'background-push', pushes: true, run: 'cd base && git push origin HEAD &\nwait' },
    // A heredoc's script runs where the shell it feeds runs; an unquoted heredoc's substitutions run where its command
    // runs, before it.
    { name: 'heredoc', pushes: true, run: "bash <<'EOF'\ncd base\ngit push origin HEAD\nEOF" },
    { name: 'heredoc-cd', pushes: false, run: "bash <<'EOF'\ncd base\nEOF\ngit push origin HEAD" },
    { name: 'env-c-heredoc', pushes: true, run: "env -C base bash <<'EOF'\ngit push origin HEAD\nEOF" },
    { name: 'substitution-before-cd', pushes: false, run: 'cd base <<EOF\n$(git push origin HEAD)\nEOF' },
    { name: 'substitution-in-base', pushes: true, run: 'cd base\ncat <<EOF\n$(git push origin HEAD)\nEOF' },
    // git config --unset removes the one value its pattern matches. Each checkout has settings of its own, with the
    // global ones beneath them.
    {
      name: 'unset-side',
      pushes: true,
      run: 'git config remote.origin.push HEAD:refs/heads/master\ngit config --add remote.origin.push HEAD:refs/heads/side\ngit config --unset remote.origin.push refs/heads/side\ngit push origin',
    },
    {
      name: 'unset-master',
      pushes: false,
      run: 'git config remote.origin.push HEAD:refs/heads/master\ngit config --add remote.origin.push HEAD:refs/heads/side\ngit config --unset remote.origin.push master\ngit push origin',
    },
    // An unset reads the values of the remote it names alone. From Codex's review of agentos-extensions#353
    // (0667973): with HEAD:master set for origin and for backup, unsetting each remote's one value leaves none.
    {
      name: 'unset-each-remote',
      pushes: false,
      run: 'git config --add remote.origin.push HEAD:refs/heads/master\ngit config --add remote.backup.push HEAD:refs/heads/master\ngit config --unset remote.origin.push\ngit config --unset remote.backup.push\ngit push origin',
    },
    {
      name: 'unset-other-remote',
      pushes: true,
      run: 'git config --add remote.origin.push HEAD:refs/heads/master\ngit config --add remote.backup.push HEAD:refs/heads/master\ngit config --unset remote.backup.push\ngit push origin',
    },
    // A push reads the refspecs of the remote it pushes to alone. From CodeRabbit's review of framerslab/agentos#679.
    { name: 'other-remote-setting', pushes: false, run: 'git config --add remote.backup.push HEAD:refs/heads/master\ngit push origin' },
    { name: 'other-remote-flag', pushes: false, run: 'git -c remote.backup.push=HEAD:refs/heads/master push origin' },
    // A push that names no remote, or names it with --repo, pushes to origin as push.default says when origin has no
    // refspecs of its own.
    { name: 'other-remote-bare', pushes: true, run: 'cd base\ngit config --add remote.backup.push HEAD:refs/heads/side\ngit push' },
    { name: 'other-remote-repo', pushes: true, run: 'cd base\ngit config --add remote.backup.push HEAD:refs/heads/side\ngit push --repo=origin' },
    { name: 'base-setting', pushes: false, run: 'git -C base config remote.origin.push HEAD:refs/heads/master\ngit push origin' },
    { name: 'global-setting', pushes: true, run: 'git config --global remote.origin.push HEAD:refs/heads/master\ngit push origin' },
  ];
  // A local composite action pushes to the branch its caller's input names, else to its default.
  /** @type {{ name: string, pushes: boolean, branch?: string }[]} */
  const calls = [
    { name: 'given', pushes: true, branch: 'master' },
    { name: 'fallback', pushes: false },
  ];
  const action = (/** @type {string} */ name) => [
    `name: ${name}`,
    'inputs:',
    '  branch:',
    '    default: side',
    'runs:',
    '  using: composite',
    '  steps:',
    '    - run: git push origin "HEAD:${{ inputs.branch }}"',
    '      shell: bash',
    '',
  ].join('\n');
  const job = (/** @type {string} */ step) => workflow(ON_PULL_REQUEST, `- uses: actions/checkout@v5\n- uses: actions/checkout@v5\n  with:\n    ref: master\n    path: base\n${step}`);

  /**
   * The command's output for a repository holding the files, as the build job runs it.
   * @param {Record<string, string>} files
   */
  const command = (files) => {
    const root = mkdtempSync(join(tmpdir(), 'workflow-pushes-'));
    try {
      for (const [path, body] of Object.entries(files)) {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), body);
      }
      return spawnSync(process.execPath, [script, '--root', root], {
        encoding: 'utf8',
        env: { ...process.env, GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'framerslab/agentos-extensions', DEFAULT_BRANCH: 'master' },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };

  /**
   * Runs a step's script as a runner runs it and tells whether the remote's master moved.
   * @param {string} run
   * @param {string[]} options bash's options for the step
   */
  const movesMaster = (run, options) => {
    const dir = mkdtempSync(join(tmpdir(), 'workflow-pushes-run-'));
    try {
      // HOME holds the --global settings, and nothing else from the environment reaches git.
      const env = {
        PATH: process.env.PATH ?? '',
        HOME: dir,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_AUTHOR_NAME: 'check',
        GIT_AUTHOR_EMAIL: 'check@example.invalid',
        GIT_COMMITTER_NAME: 'check',
        GIT_COMMITTER_EMAIL: 'check@example.invalid',
      };
      const git = (/** @type {string[]} */ args) => {
        const result = spawnSync('git', args, { cwd: dir, env, encoding: 'utf8' });
        assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
        return result.stdout.trim();
      };
      const remote = join(dir, 'remote.git');
      git(['init', '-q', '-b', 'master', 'work']);
      git(['-C', 'work', 'commit', '-q', '--allow-empty', '-m', 'start']);
      git(['-C', 'work', 'branch', 'side']);
      git(['clone', '-q', '--bare', 'work', remote]);
      git(['clone', '-q', '-b', 'side', remote, 'root']);
      git(['clone', '-q', '-b', 'master', remote, join('root', 'base')]);
      git(['-C', 'root', 'commit', '-q', '--allow-empty', '-m', 'side']);
      git(['-C', join('root', 'base'), 'commit', '-q', '--allow-empty', '-m', 'master']);
      const before = git(['-C', remote, 'rev-parse', 'refs/heads/master']);
      writeFileSync(join(dir, 'step.sh'), `${run}\n`);
      const ran = spawnSync('bash', [...options, join(dir, 'step.sh')], { cwd: join(dir, 'root'), env, encoding: 'utf8' });
      assert.equal(ran.status, 0, `${run}\n${ran.stderr}`);
      return git(['-C', remote, 'rev-parse', 'refs/heads/master']) !== before;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  test('reports the steps whose scripts move master when a runner runs them, each on its line, and no other', () => {
    /** @type {Record<string, string>} */
    const files = {};
    /** @type {{ name: string, pushes: boolean, file: string, line: number, run: string, options: string[] }[]} */
    const cases = [];
    for (const { name, pushes, run } of steps) {
      files[`.github/workflows/${name}.yml`] = job(`- run: |\n${run.split('\n').map((line) => `    ${line}`).join('\n')}`);
      // The step's line, after the trigger's two, the job's four and the two checkouts' five.
      cases.push({ name, pushes, file: `.github/workflows/${name}.yml`, line: 12, run, options: ['-e'] });
    }
    for (const { name, pushes, branch } of calls) {
      files[`.github/actions/${name}/action.yml`] = action(name);
      files[`.github/workflows/${name}.yml`] = job(`- uses: ./.github/actions/${name}${branch ? `\n  with:\n    branch: ${branch}` : ''}`);
      // Reported on the action's step, which runs with the input its caller gives, else the default.
      cases.push({ name, pushes, file: `.github/actions/${name}/action.yml`, line: 8, run: `git push origin "HEAD:${branch ?? 'side'}"`, options: ['--noprofile', '--norc', '-eo', 'pipefail'] });
    }
    const result = command(files);
    /** @param {RegExp} pattern */
    const lines = (pattern) => result.stdout.split('\n').flatMap((line) => {
      const match = pattern.exec(line);
      return match ? [{ file: match[1], line: Number(match[2]), message: match[3] }] : [];
    });
    const printed = lines(/^(\.github\/[^:,]+):(\d+): (.+)$/);
    const shown = `${printed.map((f) => `${f.file}:${f.line}: ${f.message}`).join('\n')}\n${result.stderr}`;
    const named = new Map(cases.map((c) => [c.file, c]));
    const reported = [...new Set(printed.map((f) => named.get(f.file)?.name ?? f.file))].sort();
    const moved = cases.filter((c) => movesMaster(c.run, c.options)).map((c) => c.name).sort();
    const pushes = cases.filter((c) => c.pushes).map((c) => c.name).sort();
    // What the command reports, what running each step does, and what the table above says, all one list.
    assert.deepEqual({ reported, moved }, { reported: pushes, moved: pushes }, shown);
    assert.equal(result.status, 1, shown);
    assert.match(result.stderr, /Its rules refuse a direct push \(GH006\)/);
    // Each finding is on its step's line, and annotated there, where a pull request's checks show it.
    for (const f of printed) assert.equal(f.line, named.get(f.file)?.line, `${f.file}:${f.line}: ${f.message}`);
    assert.deepEqual(lines(/^::error file=([^,]+),line=(\d+)::(.+)$/), printed);
  });
});
