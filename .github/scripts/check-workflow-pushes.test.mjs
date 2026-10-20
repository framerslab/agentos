// @ts-check
// Runs in CI (node --test); it needs mikefarah's yq v4, which GitHub's Ubuntu runners carry.
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
