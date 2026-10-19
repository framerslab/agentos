#!/usr/bin/env node
// @ts-check
/**
 * Fails when a GitHub Actions workflow pushes a commit to the default branch.
 *
 * master's rules refuse a direct push (GH006, "required status checks are expected"), so a step that pushes there
 * fails at the push, after everything before it has run: the registry step of agentos-extensions' release workflow
 * pushed registry.json to master after its packages were published, was refused, read the refusal as a race and
 * tried again (run 39191821853). A workflow that changes the repository pushes a branch of its own and opens a pull
 * request, or writes to a branch the rules leave open.
 *
 * mikefarah's yq v4 (on GitHub's Ubuntu runners) reads the YAML, so every valid spelling of a key or a value reads
 * as GitHub reads it. The check reads each workflow in .github/workflows and each composite action in
 * .github/actions, or the files named on the command line, and reports:
 * - a git push to master, main or the default branch, from any workflow: the branch written out (HEAD:master,
 *   refs/heads/master), an expression that resolves to it (${{ github.event.repository.default_branch }}, the base
 *   branch, a 'master' fallback, ${BRANCH:-master}), a wildcard destination that matches it, the matching refspec
 *   ":", --all, --branches and --mirror;
 * - a git push of the checked-out branch (no destination, HEAD) while that branch can be the default branch, and a
 *   push to the run's own branch (${{ github.ref_name }}, $GITHUB_REF) from a workflow that runs on it. A workflow
 *   runs on the default branch unless its triggers keep it off: pull_request, pull_request_review(_comment),
 *   merge_group and release never run on a branch, and push filters are read as GitHub reads them. A step that
 *   checks out a branch (actions/checkout with ref, git checkout, git switch) changes the checked-out branch, and
 *   git switch - or git checkout - (@{-1}, @{-N}) returns to the one checked out before it;
 * - an action that pushes there: peaceiris/actions-gh-pages (publish_branch), JamesIves/github-pages-deploy-action
 *   (branch), ad-m/github-push-action (branch; with none it pushes master on v0.6.0 and earlier),
 *   stefanzweifel/git-auto-commit-action (branch, else the pull request's head branch on a pull request event and
 *   the checked-out branch on any other) and EndBug/add-and-commit (new_branch, else the checked-out branch; a push
 *   input other than true or false is read as git push arguments; dry_run, which came in v11.1.0, pushes nothing);
 * - semantic-release run on the default branch (the program, through npx, bunx, npm exec, pnpm exec or dlx, yarn or
 *   bun, a package script that runs it, or cycjimmy/semantic-release-action) while a release configuration lists
 *   @semantic-release/git, which commits the release to the branch the run is on.
 * Commands are read where the shell runs them: at command position, past variable assignments and env, command,
 * exec, sudo, nohup, time, nice and timeout, inside $( ) and backticks (also within double quotes), in an sh -c or
 * bash -c string, an eval, a heredoc or a here-string fed to a shell or to a cat piped into one, the words an echo or
 * a printf pipes into a shell, and the substitutions in a ${ } (${CACHE:-$(...)}) and in an unquoted heredoc's body,
 * which run whatever program reads it. A word that is only printed (echo git push ...), a quoted heredoc fed to
 * another program, a comment and a dry run are not pushes. Not read: a branch held in a shell variable, a job's or
 * step's if: condition, a script a shell reads from a file, a variable or a download (curl ... | bash), and a push
 * made by a script file or by an action not named above.
 *
 * Usage: node .github/scripts/check-workflow-pushes.mjs [--root <dir>] [file ...]
 * DEFAULT_BRANCH names the default branch (master when unset); master and main are refused whatever it is. YQ names
 * the yq binary (yq when unset). Exit status: 0 when nothing pushes there, 1 when something does, 2 on a usage or
 * read error.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** @typedef {{ file: string, line: number, message: string }} Finding */
/**
 * @typedef {object} Context
 * @property {string} root the repository
 * @property {string} branch the default branch
 * @property {Set<string>} names the branches no workflow pushes to
 * @property {string} yq the yq binary
 * @property {Map<string, Record<string, unknown>>} scripts each directory's package scripts, as read
 */
/**
 * Where a job, or a composite action, stands as its steps run.
 * @typedef {object} State
 * @property {boolean} run whether the run's own branch can be the default branch
 * @property {boolean} head whether the checked-out branch can be the default branch
 * @property {boolean[]} prev the same for each branch checked out before it, the newest last: git switch - and
 *   @{-N} return to them
 * @property {boolean} pullRequestOnly whether every trigger is pull_request or pull_request_target, the events that
 *   set github.head_ref
 * @property {string} dir the directory run steps start in, relative to the root
 */
/**
 * @typedef {object} Step
 * @property {State} state
 * @property {Context} ctx
 * @property {string} dir the step's directory, relative to the root
 * @property {(message: string) => void} report
 */

/** A file or a tool this check needs could not be read. */
export class ReadError extends Error {}

const USAGE = 'Usage: node .github/scripts/check-workflow-pushes.mjs [--root <dir>] [file ...]';
// Events whose runs are never on a branch: a pull request's merge ref, a merge queue's ref, a release's tag.
const OFF_BRANCH_EVENTS = new Set(['pull_request', 'pull_request_review', 'pull_request_review_comment', 'merge_group', 'release']);
// The events that set github.head_ref, the pull request's head branch (GitHub's contexts reference names these two
// alone); git-auto-commit-action's branch input defaults to it.
const PULL_REQUEST_EVENTS = new Set(['pull_request', 'pull_request_target']);
// Words that open a compound command; the command after them is at command position.
const RESERVED = new Set(['!', '{', '}', 'if', 'then', 'else', 'elif', 'do', 'while', 'until']);
const SHELLS = new Set(['sh', 'bash', 'dash', 'zsh', 'ksh']);
/** @type {Record<string, string[]>} Programs that run the command after them, with their options that take a value. */
const WRAPPERS = {
  env: ['-u', '--unset', '-C', '--chdir'],
  command: [],
  builtin: [],
  exec: ['-a'],
  sudo: ['-u', '--user', '-g', '--group', '-h', '--host', '-p', '--prompt', '-C', '--close-from', '-D', '--chdir', '-r', '--role', '-t', '--type', '-T', '--command-timeout', '-U', '--other-user'],
  nohup: [],
  time: ['-f', '--format', '-o', '--output'],
  nice: ['-n', '--adjustment'],
  timeout: ['-k', '--kill-after', '-s', '--signal'],
};
const GIT_VALUED = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--super-prefix']);
const PUSH_VALUED = new Set(['--repo', '--receive-pack', '--exec', '--push-option', '-o']);
const RUNNER_VALUED = new Set(['--filter', '-F', '-C', '--dir', '--prefix', '--workspace', '--cwd', '-p', '--package', '-c', '--call', '--registry', '--loglevel']);
const RELEASE_CONFIGS = ['.releaserc', '.releaserc.json', '.releaserc.yaml', '.releaserc.yml', '.releaserc.js', '.releaserc.cjs', '.releaserc.mjs', 'release.config.js', 'release.config.cjs', 'release.config.mjs', 'release.config.ts', 'release.config.cts', 'release.config.mts'];
const SEMANTIC_RELEASE = /^semantic-release(?:@\S*)?$/;
const EXPRESSION = /\$\{\{([\s\S]*?)\}\}/g;

/**
 * The GitHub expressions of the scripts read so far. GitHub replaces an expression before the shell runs, so a
 * script holds each as <index> while its words are read, and a word gets its expressions back when a
 * branch is read from it.
 * @type {string[]}
 */
const expressions = [];
/** @param {string} text */
const hold = (text) => text.replace(EXPRESSION, (_, inner) => `${expressions.push(String(inner).trim()) - 1}`);
/** @param {string} text */
const unhold = (text) => text.replace(/(\d+)/g, (_, k) => `\${{ ${expressions[Number(k)]} }}`);
/** @param {string} word */
const base = (word) => word.slice(word.lastIndexOf('/') + 1);
/** @param {string} word */
const isAssignment = (word) => /^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(word);
/** @param {string} word an option of sh or bash that makes it run its next argument (-c, -ec, -xc) */
const isCommandOption = (word) => /^-[A-Za-z]*c[A-Za-z]*$/.test(word);
/**
 * Whether a command is a shell that reads its script from its standard input: no -c, and no script file operand
 * unless -s makes the operands its arguments (-o and -O take a value).
 * @param {{ name: string, args: string[] } | null} run
 */
const readsScript = (run) => {
  if (run === null || !SHELLS.has(run.name) || run.args.some(isCommandOption)) return false;
  if (run.args.some((a) => /^-[A-Za-z]*s[A-Za-z]*$/.test(a))) return true;
  for (let k = 0; k < run.args.length; k++) {
    const a = run.args[k];
    if (a === '--') return k + 1 === run.args.length;
    if (/^[-+][oO]$/.test(a)) k++;
    else if (!/^[-+]/.test(a)) return false;
  }
  return true;
};
/** @param {string} text */
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The program a simple command runs and its arguments, past assignments and wrappers, or null when it runs none.
 * @param {string[]} words
 * @returns {{ name: string, args: string[] } | null}
 */
export function invoked(words) {
  let i = 0;
  while (i < words.length && RESERVED.has(words[i])) i++;
  for (;;) {
    while (i < words.length && isAssignment(words[i])) i++;
    if (i >= words.length) return null;
    const name = base(words[i]);
    if (!Object.hasOwn(WRAPPERS, name)) return { name, args: words.slice(i + 1) };
    const valued = new Set(WRAPPERS[name]);
    i++;
    while (i < words.length && words[i].startsWith('-')) {
      const option = words[i];
      if (option === '--') {
        i++;
        break;
      }
      // command -v and -V print what would run instead of running it.
      if (name === 'command' && /^-[pvV]+$/.test(option) && /[vV]/.test(option)) return null;
      i += valued.has(option) ? 2 : 1;
    }
    if (name === 'timeout') i++; // its duration
  }
}

/**
 * A heredoc waiting for its body: the delimiter, whether <<- strips tabs, the words of its command, whether the
 * delimiter was quoted (which keeps the body from being expanded) and whether a shell reads it as a script.
 * @typedef {{ delimiter: string, tabs: boolean, words: string[], quoted: boolean, script: boolean }} Heredoc
 */

/**
 * The simple commands of a shell script, each as its words with quotes and escapes removed, in the order they end.
 * A command substitution's commands come out on their own and its text stays in its word; a heredoc's body is read
 * as a script when it feeds a shell, directly or through a cat piped into one, and otherwise its substitutions are
 * read when its delimiter is unquoted. A here-string fed so, and what an echo or a printf pipes into a shell, is read
 * as a script too.
 * @param {string} src
 * @returns {string[][]}
 */
export function shellCommands(src) {
  /** @type {string[][]} */
  const out = [];
  const n = src.length;
  let i = 0;

  const single = () => {
    const end = src.indexOf("'", i);
    const text = src.slice(i, end < 0 ? n : end);
    i = end < 0 ? n : end + 1;
    return text;
  };

  const double = () => {
    let text = '';
    while (i < n && src[i] !== '"') {
      const c = src[i];
      if (c === '\\' && i + 1 < n) {
        const d = src[i + 1];
        i += 2;
        if (d !== '\n') text += '"\\$`'.includes(d) ? d : c + d;
      } else if (c === '$') {
        text += dollar();
      } else if (c === '`') {
        i++;
        text += `\`${commandsUntil('`')}\``;
      } else {
        text += c;
        i++;
      }
    }
    i++;
    return text;
  };

  /** @returns {string} */
  const dollar = () => {
    const start = i;
    if (src.startsWith('$((', i)) {
      i += 3;
      for (let depth = 2; i < n && depth > 0; i++) depth += src[i] === '(' ? 1 : src[i] === ')' ? -1 : 0;
      return src.slice(start, i);
    }
    if (src.startsWith('$(', i)) {
      i += 2;
      return `$(${commandsUntil(')')})`;
    }
    if (src.startsWith('${', i)) {
      i += 2;
      // A default value, an alternative or a pattern can hold a command substitution, which runs when the shell
      // expands the parameter: ${CACHE:-$(git push origin HEAD:master)}.
      for (let depth = 1; i < n && depth > 0; ) {
        const c = src[i];
        if (c === '\\') {
          i += 2;
        } else if (c === '$' && (src[i + 1] === '(' || src[i + 1] === '{')) {
          dollar();
        } else if (c === '`') {
          i++;
          commandsUntil('`');
        } else {
          depth += c === '{' ? 1 : c === '}' ? -1 : 0;
          i++;
        }
      }
      return src.slice(start, i);
    }
    if (src.startsWith("$'", i)) {
      i += 2;
      let text = '';
      while (i < n && src[i] !== "'") {
        if (src[i] === '\\' && i + 1 < n) {
          const d = src[i + 1];
          text += d === 'n' ? '\n' : d === 't' ? '\t' : d;
          i += 2;
        } else {
          text += src[i++];
        }
      }
      i++;
      return text;
    }
    if (src.startsWith('$"', i)) {
      i += 2;
      return double();
    }
    i++;
    return '$';
  };

  /** One word after a redirection operator: its target, or a heredoc's delimiter. */
  const target = () => {
    while (i < n && (src[i] === ' ' || src[i] === '\t')) i++;
    let text = '';
    while (i < n && !' \t\r\n;&|<>()'.includes(src[i])) {
      const c = src[i];
      if (c === '\\') {
        text += src[i + 1] ?? '';
        i += 2;
      } else if (c === "'") {
        i++;
        text += single();
      } else if (c === '"') {
        i++;
        text += double();
      } else if (c === '$') {
        text += dollar();
      } else {
        text += c;
        i++;
      }
    }
    return text;
  };

  /** @param {Heredoc} heredoc */
  const readHeredoc = (heredoc) => {
    /** @type {string[]} */
    const lines = [];
    while (i < n) {
      const newline = src.indexOf('\n', i);
      const end = newline < 0 ? n : newline;
      let line = src.slice(i, end);
      i = Math.min(end + 1, n);
      if (heredoc.tabs) line = line.replace(/^\t+/, '');
      if (line.replace(/\r$/, '') === heredoc.delimiter) break;
      lines.push(line);
    }
    const body = lines.join('\n');
    const run = invoked(heredoc.words);
    if (heredoc.script || readsScript(run)) {
      out.push(...shellCommands(body));
    } else if (!heredoc.quoted) {
      // An unquoted delimiter leaves the body's $( ) and backticks to run before the program reads it, as within
      // double quotes. The body is read as one double-quoted word of a ':' command, which is dropped.
      out.push(...shellCommands(`: "${body.replace(/"/g, "'")}"`).slice(0, -1));
    }
  };

  /**
   * Reads simple commands up to `stop` (')' or '`'; '' for none) or the end, adding them to out.
   * @param {string} stop
   * @returns {string} the text read
   */
  function commandsUntil(stop) {
    const start = i;
    /** @type {string[]} */
    let words = [];
    /** @type {string | null} */
    let word = null;
    /** @type {Heredoc[]} */
    let heredocs = [];
    let depth = 0;
    /** @type {string[] | null} the command whose output a | feeds to the next command */
    let piped = null;
    /** @type {{ words: string[], text: string }[]} the here-strings (<<<) of the line, with their commands */
    let strings = [];
    /** @param {string} text */
    const add = (text) => {
      word = (word ?? '') + text;
    };
    const endWord = () => {
      if (word !== null) words.push(word);
      word = null;
    };
    /**
     * A shell that reads its script from its standard input runs what the command before it writes there: the
     * heredoc of a cat (cat <<'EOF' | bash), or the words of an echo or a printf.
     * @param {string[]} source
     * @param {string[]} sink
     */
    const feed = (source, sink) => {
      if (!readsScript(invoked(sink))) return;
      const from = invoked(source);
      if (!from) return;
      if (from.name === 'cat' && from.args.every((a) => a.startsWith('-'))) {
        for (const heredoc of heredocs) if (heredoc.words === source) heredoc.script = true;
        for (const s of strings) if (s.words === source) out.push(...shellCommands(s.text));
      } else if (from.name === 'echo' || from.name === 'printf') {
        let k = 0;
        if (from.name === 'echo') while (k < from.args.length && /^-[neE]+$/.test(from.args[k])) k++;
        out.push(...shellCommands(from.args.slice(k).join(from.name === 'echo' ? ' ' : '\n').replace(/\\n/g, '\n')));
      }
    };
    /** @param {boolean} [pipe] whether a | ends the command, feeding its output to the next one */
    const endCommand = (pipe = false) => {
      endWord();
      // An empty command (the & of |&, a line break after |) leaves a pipe as it is.
      if (words.length > 0) {
        out.push(words);
        // A here-string fed to a shell is its script: bash <<< "git push ...".
        if (readsScript(invoked(words))) for (const s of strings) if (s.words === words) out.push(...shellCommands(s.text));
        if (piped) feed(piped, words);
        piped = pipe ? words : null;
      }
      words = [];
    };
    while (i < n) {
      const c = src[i];
      if (c === stop && (stop === '`' || depth === 0)) {
        i++;
        endCommand();
        return src.slice(start, i - 1);
      }
      if (c === '\\') {
        if (src[i + 1] !== '\n') add(src[i + 1] ?? '');
        i += 2;
      } else if (c === "'") {
        i++;
        add(single());
      } else if (c === '"') {
        i++;
        add(double());
      } else if (c === '$') {
        add(dollar());
      } else if (c === '`') {
        i++;
        add(`\`${commandsUntil('`')}\``);
      } else if (c === '#' && word === null) {
        while (i < n && src[i] !== '\n') i++;
      } else if (c === ' ' || c === '\t' || c === '\r') {
        endWord();
        i++;
      } else if (c === '\n') {
        i++;
        endCommand();
        for (const heredoc of heredocs) readHeredoc(heredoc);
        heredocs = [];
        strings = [];
      } else if (c === '<' || c === '>' || (c === '&' && src[i + 1] === '>')) {
        if (word !== null && /^\d+$/.test(word)) word = null; // the descriptor of 2>&1
        endWord();
        if (src.startsWith('<<<', i)) {
          i += 3;
          strings.push({ words, text: target() });
        } else if (src.startsWith('<<', i)) {
          i += 2;
          const tabs = src[i] === '-';
          if (tabs) i++;
          const from = i;
          const delimiter = target();
          heredocs.push({ delimiter, tabs, words, quoted: /['"\\]/.test(src.slice(from, i)), script: false });
        } else {
          i++;
          while (i < n && '<>&|'.includes(src[i])) i++;
          target();
        }
      } else if (c === ';' || c === '&' || c === '|') {
        endCommand(c === '|' && src[i + 1] !== '|' && src[i - 1] !== '|');
        i++;
      } else if (c === '(') {
        endCommand();
        depth++;
        i++;
      } else if (c === ')') {
        endCommand();
        if (depth > 0) depth--;
        i++;
      } else {
        add(c);
        i++;
      }
    }
    endCommand();
    for (const heredoc of heredocs) readHeredoc(heredoc);
    return src.slice(start, i);
  }

  commandsUntil('');
  return out;
}

/**
 * A git refspec glob (one * that matches any text) as a regular expression.
 * @param {string} pattern
 */
const refGlob = (pattern) => new RegExp(`^${pattern.split('*').map(escapeRegExp).join('.*')}$`);

/**
 * A branch filter pattern as GitHub reads it: * matches any text but /, ** any text, ? and + repeat the character
 * before them, [ ] is a character class.
 * @param {string} pattern
 */
function filterGlob(pattern) {
  let source = '';
  for (let k = 0; k < pattern.length; k++) {
    const c = pattern[k];
    if (c === '*') {
      source += pattern[k + 1] === '*' ? '.*' : '[^/]*';
      if (pattern[k + 1] === '*') k++;
    } else if ((c === '?' || c === '+') && source !== '') {
      source += c;
    } else if (c === '[' && pattern.indexOf(']', k) > k) {
      const end = pattern.indexOf(']', k);
      source += pattern.slice(k, end + 1);
      k = end;
    } else {
      source += escapeRegExp(c);
    }
  }
  try {
    return new RegExp(`^${source}$`);
  } catch {
    return new RegExp(`^${escapeRegExp(pattern)}$`);
  }
}

/**
 * Whether a list of branch patterns lets a branch through: the last pattern that matches it decides, and a pattern
 * that starts with ! keeps it out.
 * @param {string[]} patterns
 * @param {string} branch
 */
function filterAllows(patterns, branch) {
  let allowed = false;
  for (const pattern of patterns) {
    const negated = pattern.startsWith('!');
    if (filterGlob(negated ? pattern.slice(1) : pattern).test(branch)) allowed = !negated;
  }
  return allowed;
}

/** @param {unknown} value */
const strings = (value) => (Array.isArray(value) ? value : value == null ? [] : [value]).map(String);

/**
 * Whether a push trigger can run on one of the named branches. A trigger with only tags or tags-ignore never runs
 * for a branch push; one with neither branch nor tag filters runs on every branch.
 * @param {unknown} filters
 * @param {Set<string>} names
 */
function pushRunsOn(filters, names) {
  if (!filters || typeof filters !== 'object' || Array.isArray(filters)) return true;
  const f = /** @type {Record<string, unknown>} */ (filters);
  if ('branches' in f) return [...names].some((branch) => filterAllows(strings(f.branches), branch));
  if ('branches-ignore' in f) return [...names].some((branch) => !strings(f['branches-ignore']).some((p) => filterGlob(p).test(branch)));
  return !('tags' in f || 'tags-ignore' in f);
}

/**
 * The workflow's triggers as event names and their settings, or null when it has none.
 * @param {Record<string, unknown>} doc
 * @returns {Record<string, unknown> | null}
 */
function triggers(doc) {
  // YAML 1.1 reads a bare on as true; yq reads YAML 1.2, which keeps it a string.
  const on = 'on' in doc ? doc.on : doc.true;
  if (typeof on === 'string') return { [on]: null };
  if (Array.isArray(on)) return Object.fromEntries(on.map((event) => [String(event), null]));
  return on && typeof on === 'object' ? /** @type {Record<string, unknown>} */ (on) : null;
}

/**
 * What a destination branch names: 'protected' (master, main, the default branch, or an expression, pattern or
 * default value that resolves to one), 'run' (the run's own branch), 'head' (the checked-out branch), 'other'
 * (another branch, a tag, a pull request's head) or '' (one this check cannot tell).
 * @param {string} name
 * @param {Context} ctx
 * @returns {'protected' | 'run' | 'head' | 'other' | ''}
 */
export function classify(name, ctx) {
  const s = unhold(name).trim().replace(/^refs\/heads\//, '');
  if (s === '') return '';
  if (s === 'HEAD' || s === '@') return 'head';
  const whole = /^\$\{\{([\s\S]*)\}\}$/.exec(s);
  if (whole && !whole[1].includes('}}')) {
    const e = whole[1];
    if (/\bgithub\.(?:event\.repository\.(?:default|master)_branch|base_ref|event\.pull_request\.base\.ref)\b/.test(e)) return 'protected';
    if ([...e.matchAll(/'([^']*)'/g)].some((m) => ctx.names.has(m[1].replace(/^refs\/heads\//, '')))) return 'protected';
    if (/\bgithub\.ref(?:_name)?\b|\bgithub\.event\.workflow_run\.head_branch\b|\benv\.GITHUB_REF(?:_NAME)?\b/.test(e)) return 'run';
    if (/\bgithub\.head_ref\b|\bgithub\.event\.pull_request\.head\.(?:ref|sha)\b/.test(e)) return 'other';
    return '';
  }
  if (/^\$\{?GITHUB_BASE_REF\}?$/.test(s)) return 'protected';
  if (/^\$\{?GITHUB_REF(?:_NAME)?(?:[#%]{1,2}[^}]*)?\}?$/.test(s)) return 'run';
  if (/^\$\{?GITHUB_HEAD_REF\}?$/.test(s)) return 'other';
  const fallback = /^\$\{[A-Za-z_][A-Za-z0-9_]*:?[-=]([^}]*)\}$/.exec(s);
  if (fallback) return classify(fallback[1], ctx) === 'protected' ? 'protected' : '';
  // A pattern is matched against each branch's short and full names: refs/*:refs/* updates refs/heads/master.
  if (s.includes('*')) return [...ctx.names].some((branch) => refGlob(s).test(branch) || refGlob(s).test(`refs/heads/${branch}`)) ? 'protected' : 'other';
  if (/[$`]/.test(s)) return '';
  return ctx.names.has(s) ? 'protected' : 'other';
}

/**
 * The last colon of a refspec outside ${ }, or -1.
 * @param {string} spec
 */
function lastColon(spec) {
  let depth = 0;
  let at = -1;
  for (let k = 0; k < spec.length; k++) {
    if (spec.startsWith('${', k)) {
      depth++;
      k++;
    } else if (spec[k] === '}' && depth > 0) {
      depth--;
    } else if (spec[k] === ':' && depth === 0) {
      at = k;
    }
  }
  return at;
}

/**
 * Reports a git push (its arguments after push) that reaches the default branch.
 * @param {string[]} args
 * @param {Step} step
 */
function checkPush(args, { state, ctx, report }) {
  const command = `git push ${args.map(unhold).join(' ')}`.trim();
  const branch = ctx.branch;
  let dryRun = false;
  let every = '';
  let tags = false;
  let remove = false;
  /** @type {string[]} */
  const positional = [];
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a === '--') {
      positional.push(...args.slice(k + 1));
      break;
    }
    if (!a.startsWith('-') || a === '-') positional.push(a);
    else if (PUSH_VALUED.has(a)) k++;
    else if (a === '--dry-run') dryRun = true;
    else if (a === '--all' || a === '--branches' || a === '--mirror') every = a;
    else if (a === '--tags') tags = true;
    else if (a === '--delete') remove = true;
    else if (/^-[^-]/.test(a)) {
      // bundled short options: -n dry run, -d delete, -o takes the rest of the word or the next one
      for (let j = 1; j < a.length; j++) {
        if (a[j] === 'n') dryRun = true;
        else if (a[j] === 'd') remove = true;
        else if (a[j] === 'o') {
          if (j === a.length - 1) k++;
          break;
        }
      }
    }
  }
  if (dryRun) return;
  if (every) {
    report(`"${command}" pushes every branch, ${branch} among them`);
    return;
  }
  // The first operand names the repository even after --repo, which git reads only when no operand is given
  // (builtin/push.c sets the repository from the first operand), so every refspec comes after it. "tag <name>" is a
  // tag.
  const operands = positional.slice(1);
  /** @type {string[]} */
  const refspecs = [];
  for (let k = 0; k < operands.length; k++) {
    if (operands[k] === 'tag') k++;
    else refspecs.push(operands[k]);
  }
  if (refspecs.length === 0) {
    if (!tags && state.head) report(`"${command}" pushes the checked-out branch, ${branch} on a run on ${branch}`);
    return;
  }
  for (const refspec of refspecs) {
    const spec = refspec.replace(/^\+/, '');
    if (spec === ':') {
      report(`"${command}" pushes every branch the remote also has, ${branch} among them`);
      continue;
    }
    const colon = lastColon(spec);
    const destination = colon < 0 ? spec : colon === spec.length - 1 ? spec.slice(0, colon) : spec.slice(colon + 1);
    const kind = classify(destination, ctx);
    if (kind === 'protected') report(`"${command}" ${remove || colon === 0 ? 'deletes' : 'pushes to'} ${unhold(destination)}`);
    else if (kind === 'head' && state.head) report(`"${command}" pushes the checked-out branch, ${branch} on a run on ${branch}`);
    else if (kind === 'run' && state.run) report(`"${command}" pushes to the run's own branch, ${branch} on a run on ${branch}`);
  }
}

/**
 * Checks out a branch: the one before it becomes the newest earlier branch, as git's reflog records it (each
 * checkout, a detaching one too, is a "checkout: moving from <old> to <new>" line, and @{-N} reads the Nth newest).
 * @param {State} state
 * @param {boolean} head whether the branch checked out can be the default branch
 */
function moveHead(state, head) {
  state.prev.push(state.head);
  state.head = head;
}

/**
 * Follows git checkout and git switch: the branch they check out is the checked-out branch from then on.
 * @param {string} sub
 * @param {string[]} args
 * @param {Step} step
 */
function checkout(sub, args, { state, ctx }) {
  const create = sub === 'checkout' ? ['-b', '-B', '--orphan'] : ['-c', '-C', '--create', '--force-create', '--orphan'];
  const creating = args.some((a) => create.includes(a) || /^--(?:create|force-create|orphan)=/.test(a));
  // git checkout <tree-ish> -- <paths> restores files and leaves the branch as it is.
  if (sub === 'checkout' && args.includes('--') && !creating) return;
  // --track with no name for the new branch names it for the remote-tracking branch past the remote's part, so
  // git switch --track origin/master makes and checks out master (git-checkout(1), -t).
  const track = args.some((a) => a === '-t' || a === '--track' || a.startsWith('--track=')) && !creating;
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a === '--') return;
    if (a === '--detach' || (sub === 'switch' && a === '-d')) {
      moveHead(state, false);
      return;
    }
    // - is @{-1}, the branch checked out before this one; @{-N} is the Nth before it. Where git has no such branch
    // the job's starting branch stands in. With -c or -b it is only the new branch's start.
    const back = a === '-' ? 1 : Number(/^@\{-(\d+)\}$/.exec(a)?.[1] ?? 0);
    if (back > 0 && !creating) {
      moveHead(state, state.prev.length >= back ? state.prev[state.prev.length - back] : state.run);
      return;
    }
    const attached = /^--(?:create|force-create|orphan)=(.+)$/.exec(a);
    const creates = create.includes(a) || attached !== null;
    const operand = create.includes(a) ? args[k + 1] : attached ? attached[1] : a.startsWith('-') ? undefined : a;
    if (operand === undefined) continue;
    const name = track ? operand.replace(/^(?:refs\/)?(?:remotes\/)?[^/]+\//, '') : operand;
    // A branch made here is a new one unless it is named for the default branch (-B master resets it). A branch
    // this check cannot tell (a variable) leaves the checked-out branch as it was, but git still moved, so - after it
    // returns to the branch before it.
    const kind = classify(name, ctx);
    if (kind === 'protected') moveHead(state, true);
    else if (kind === 'other' || creates || track) moveHead(state, false);
    else if (kind === 'run') moveHead(state, state.run);
    else moveHead(state, state.head);
    return;
  }
}

/**
 * The package scripts of a directory's package.json.
 * @param {string} dir
 * @param {Context} ctx
 * @returns {Record<string, unknown>}
 */
function packageScripts(dir, ctx) {
  const cached = ctx.scripts.get(dir);
  if (cached) return cached;
  const file = join(dir, 'package.json');
  let scripts = {};
  if (existsSync(file)) {
    try {
      scripts = JSON.parse(readFileSync(file, 'utf8')).scripts ?? {};
    } catch (error) {
      throw new ReadError(`${relative(ctx.root, file)}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  ctx.scripts.set(dir, scripts);
  return scripts;
}

/**
 * Whether a command runs semantic-release, other than as a dry run.
 * @param {{ name: string, args: string[] }} run
 * @param {string} dir the directory it runs in
 * @param {Context} ctx
 * @param {number} depth
 * @returns {boolean}
 */
function runsSemanticRelease({ name, args }, dir, ctx, depth) {
  if (depth > 4 || args.includes('--dry-run')) return false;
  if (SEMANTIC_RELEASE.test(name)) return !args.includes('-d');
  /** @type {string[]} */
  const operands = [];
  for (let k = 0; k < args.length; k++) {
    if (args[k] === '--') {
      operands.push(...args.slice(k + 1));
      break;
    }
    if (!args[k].startsWith('-')) operands.push(args[k]);
    else if (RUNNER_VALUED.has(args[k])) k++;
  }
  const [sub, next] = operands;
  if (name === 'npx' || name === 'bunx') return SEMANTIC_RELEASE.test(base(sub ?? ''));
  if (!['npm', 'pnpm', 'yarn', 'bun'].includes(name) || sub === undefined) return false;
  if (['exec', 'dlx', 'x'].includes(sub)) return SEMANTIC_RELEASE.test(base(next ?? ''));
  const script = ['run', 'run-script'].includes(sub) ? next : name !== 'npm' || ['test', 'start', 'stop', 'restart'].includes(sub) ? sub : undefined;
  if (script === undefined) return false;
  const scripts = packageScripts(dir, ctx);
  // pnpm, yarn and bun run a package's binary by its name when no script has that name.
  if (!Object.hasOwn(scripts, script)) return name !== 'npm' && script === sub && SEMANTIC_RELEASE.test(script);
  return [`pre${script}`, script, `post${script}`].some((s) => {
    const body = scripts[s];
    if (typeof body !== 'string') return false;
    return shellCommands(hold(body)).some((words) => {
      const run = invoked(words);
      return run !== null && runsSemanticRelease(run, dir, ctx, depth + 1);
    });
  });
}

/**
 * JavaScript without its comments.
 * @param {string} text
 */
function stripComments(text) {
  let out = '';
  let quote = '';
  for (let k = 0; k < text.length; k++) {
    const c = text[k];
    if (quote) {
      out += c;
      if (c === '\\') out += text[++k] ?? '';
      else if (c === quote) quote = '';
    } else if (c === '/' && text[k + 1] === '/') {
      while (k < text.length && text[k] !== '\n') k++;
      out += '\n';
    } else if (c === '/' && text[k + 1] === '*') {
      const end = text.indexOf('*/', k + 2);
      k = end < 0 ? text.length : end + 1;
    } else {
      if (c === '"' || c === "'" || c === '`') quote = c;
      out += c;
    }
  }
  return out;
}

/** @param {unknown} plugins */
const listsGitPlugin = (plugins) => Array.isArray(plugins) && plugins.some((p) => (Array.isArray(p) ? p[0] : p) === '@semantic-release/git');

/**
 * The release configuration, in the step's directory or the root, that lists @semantic-release/git, or ''.
 * @param {string} dir
 * @param {Context} ctx
 */
function gitPluginConfig(dir, ctx) {
  for (const at of new Set([dir, ctx.root])) {
    const pkg = join(at, 'package.json');
    if (existsSync(pkg)) {
      try {
        if (listsGitPlugin(JSON.parse(readFileSync(pkg, 'utf8')).release?.plugins)) return relative(ctx.root, pkg);
      } catch (error) {
        throw new ReadError(`${relative(ctx.root, pkg)}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    for (const name of RELEASE_CONFIGS) {
      const file = join(at, name);
      if (!existsSync(file)) continue;
      if (/\.[cm]?[jt]s$/.test(name)) {
        if (/(['"`])@semantic-release\/git\1/.test(stripComments(readFileSync(file, 'utf8')))) return relative(ctx.root, file);
      } else {
        const config = readYaml(file, ctx);
        if (config && typeof config === 'object' && listsGitPlugin(/** @type {Record<string, unknown>} */ (config).plugins)) return relative(ctx.root, file);
      }
    }
  }
  return '';
}

/**
 * Reports a simple command of a run step that pushes to the default branch, and follows the ones that change the
 * checked-out branch.
 * @param {string[]} words
 * @param {Step} step
 * @param {number} depth
 */
function checkCommand(words, step, depth) {
  const run = invoked(words);
  if (!run || depth > 4) return;
  const { name, args } = run;
  if (SHELLS.has(name)) {
    const k = args.findIndex(isCommandOption);
    if (k >= 0 && k + 1 < args.length) for (const inner of shellCommands(args[k + 1])) checkCommand(inner, step, depth + 1);
  } else if (name === 'eval') {
    for (const inner of shellCommands(args.join(' '))) checkCommand(inner, step, depth + 1);
  } else if (name === 'git') {
    let k = 0;
    while (k < args.length && args[k].startsWith('-')) k += GIT_VALUED.has(args[k]) ? 2 : 1;
    if (args[k] === 'push') checkPush(args.slice(k + 1), step);
    else if (args[k] === 'checkout' || args[k] === 'switch') checkout(args[k], args.slice(k + 1), step);
  } else if (step.state.run) {
    const dir = join(step.ctx.root, step.dir);
    if (runsSemanticRelease(run, dir, step.ctx, 0)) {
      const config = gitPluginConfig(dir, step.ctx);
      const branch = step.ctx.branch;
      if (config) step.report(`"${words.map(unhold).join(' ')}" runs semantic-release on a run on ${branch} while ${config} lists @semantic-release/git, which commits the release to ${branch}`);
    }
  }
}

/**
 * Whether an action reference names a release at or after major.minor: @v11 (the newest 11 release) and @v11.1.0 do
 * for 11.1; @v11.0.0, a commit and a branch do not.
 * @param {string} uses
 * @param {number} major
 * @param {number} minor
 */
function releaseAtLeast(uses, major, minor) {
  const m = /@v?(\d+)(?:\.(\d+))?(?:\.\d+)?$/.exec(uses.trim());
  if (!m) return false;
  const have = Number(m[1]);
  const sub = m[2] === undefined ? Infinity : Number(m[2]);
  return have > major || (have === major && sub >= minor);
}

/**
 * Reports an action step that pushes to the default branch, and follows actions/checkout.
 * @param {string} uses
 * @param {unknown} inputs
 * @param {Step} step
 */
function checkAction(uses, inputs, step) {
  const { state, ctx, report } = step;
  const action = uses.trim().toLowerCase().split('@')[0].split('/').slice(0, 2).join('/');
  const given = inputs && typeof inputs === 'object' ? /** @type {Record<string, unknown>} */ (inputs) : {};
  /** @param {string} key */
  const input = (key) => (given[key] == null ? '' : String(given[key]).trim());
  const branch = ctx.branch;
  /**
   * @param {string} value
   * @param {string} what
   */
  const destination = (value, what) => {
    const kind = classify(value, ctx);
    if (kind === 'protected') report(`${what} ${value}`);
    else if (kind === 'run' && state.run) report(`${what} the run's own branch, ${branch} on a run on ${branch}`);
    else if (kind === 'head' && state.head) report(`${what} the checked-out branch, ${branch} on a run on ${branch}`);
  };
  if (action === 'actions/checkout') {
    const ref = input('ref');
    const kind = ref === '' ? 'run' : classify(ref, ctx);
    moveHead(state, kind === 'protected' || (kind !== 'other' && state.run));
  } else if (action === 'peaceiris/actions-gh-pages') {
    destination(input('publish_branch') || 'gh-pages', 'peaceiris/actions-gh-pages publishes to');
  } else if (action === 'jamesives/github-pages-deploy-action') {
    destination(input('branch') || 'gh-pages', 'JamesIves/github-pages-deploy-action publishes to');
  } else if (action === 'ad-m/github-push-action') {
    if (input('branch') === '') report(`ad-m/github-push-action with no branch input pushes ${branch} on v0.6.0 and earlier, and fails on later versions; give it a branch of its own`);
    else destination(input('branch'), 'ad-m/github-push-action pushes to');
  } else if (action === 'stefanzweifel/git-auto-commit-action') {
    if (input('skip_push') === 'true') return;
    // Its branch input defaults to github.head_ref: a pull request event pushes the head branch, any other event
    // pushes the checked-out branch.
    if (input('branch') !== '') destination(input('branch'), 'stefanzweifel/git-auto-commit-action pushes to');
    else if (state.head && !state.pullRequestOnly) report(`stefanzweifel/git-auto-commit-action with no branch input pushes the checked-out branch, ${branch} on a run on ${branch}`);
  } else if (action === 'endbug/add-and-commit') {
    // dry_run came in v11.1.0; an earlier version ignores it and pushes.
    if (input('dry_run') === 'true' && releaseAtLeast(uses, 11, 1)) return;
    const push = 'push' in given ? input('push') : 'true';
    if (push === 'false') return;
    if (push !== 'true') {
      for (const words of shellCommands(hold(push)).slice(0, 1)) checkPush(words, step);
    } else if (input('new_branch') !== '') {
      destination(input('new_branch'), 'EndBug/add-and-commit pushes to');
    } else if (state.head) {
      report(`EndBug/add-and-commit with no new_branch input pushes the checked-out branch, ${branch} on a run on ${branch}`);
    }
  } else if (action === 'cycjimmy/semantic-release-action') {
    if (input('dry_run') === 'true' || !state.run) return;
    const config = gitPluginConfig(join(ctx.root, input('working_directory') || step.dir), ctx);
    if (config) report(`cycjimmy/semantic-release-action runs semantic-release on a run on ${branch} while ${config} lists @semantic-release/git, which commits the release to ${branch}`);
  }
}

/**
 * Reports the steps of a job or a composite action, in order.
 * @param {string} file
 * @param {unknown} steps
 * @param {string} path the yq path of the job or the action
 * @param {State} state
 * @param {Context} ctx
 * @param {(Finding & { path: string })[]} findings
 */
function checkSteps(file, steps, path, state, ctx, findings) {
  if (!Array.isArray(steps)) return;
  steps.forEach((raw, index) => {
    if (!raw || typeof raw !== 'object') return;
    const s = /** @type {Record<string, unknown>} */ (raw);
    const at = `${path}.steps[${index}]`;
    const label = `${at.slice(1).replace(/\["([^"]*)"\]/g, '.$1')}${s.name == null ? '' : ` (${String(s.name)})`}`;
    /** @type {Step} */
    const step = {
      state,
      ctx,
      dir: s['working-directory'] == null ? state.dir : String(s['working-directory']),
      report: (message) => findings.push({ file, path: at, line: 0, message: `${label}: ${message}` }),
    };
    if (typeof s.uses === 'string') checkAction(s.uses, s.with, step);
    if (s.run != null) for (const words of shellCommands(hold(String(s.run)))) checkCommand(words, step, 0);
  });
}

/** @param {unknown} defaults */
const workingDirectory = (defaults) => {
  const run = defaults && typeof defaults === 'object' ? /** @type {Record<string, unknown>} */ (defaults).run : undefined;
  const dir = run && typeof run === 'object' ? /** @type {Record<string, unknown>} */ (run)['working-directory'] : undefined;
  return dir == null ? '' : String(dir);
};

/**
 * Reports one workflow or composite action.
 * @param {string} file
 * @param {unknown} doc
 * @param {Context} ctx
 * @param {(Finding & { path: string })[]} findings
 */
function checkDocument(file, doc, ctx, findings) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return;
  const d = /** @type {Record<string, unknown>} */ (doc);
  const runs = d.runs && typeof d.runs === 'object' ? /** @type {Record<string, unknown>} */ (d.runs) : null;
  if (runs && runs.using === 'composite') {
    // A composite action runs in the job that calls it, which may be on the default branch.
    checkSteps(file, runs.steps, '.runs', { run: true, head: true, prev: [], pullRequestOnly: false, dir: '.' }, ctx, findings);
    return;
  }
  if (!d.jobs || typeof d.jobs !== 'object') return;
  const events = triggers(d);
  const run = events === null || Object.entries(events).some(([event, filters]) => (event === 'push' ? pushRunsOn(filters, ctx.names) : !OFF_BRANCH_EVENTS.has(event)));
  const names = events === null ? [] : Object.keys(events);
  const pullRequestOnly = names.length > 0 && names.every((event) => PULL_REQUEST_EVENTS.has(event));
  for (const [id, job] of Object.entries(/** @type {Record<string, unknown>} */ (d.jobs))) {
    if (!job || typeof job !== 'object') continue;
    const j = /** @type {Record<string, unknown>} */ (job);
    const dir = workingDirectory(j.defaults) || workingDirectory(d.defaults) || '.';
    checkSteps(file, j.steps, `.jobs[${JSON.stringify(id)}]`, { run, head: run, prev: [], pullRequestOnly, dir }, ctx, findings);
  }
}

/**
 * A YAML file as yq reads it, anchors and aliases expanded, or null when it is empty.
 * @param {string} file
 * @param {Context} ctx
 * @returns {unknown}
 */
function readYaml(file, ctx) {
  const result = spawnSync(ctx.yq, ['--output-format=json', '--indent=0', 'explode(.)', file], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const name = relative(ctx.root, file) || file;
  if (result.error) throw new ReadError(`${name}: ${ctx.yq} did not start (${result.error.message})`);
  if (result.status !== 0) throw new ReadError(`${name}: ${result.stderr.trim() || `${ctx.yq} exited with status ${result.status}`}`);
  const text = result.stdout.trim();
  if (text === '' || text === 'null') return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new ReadError(`${name}: more than one YAML document`);
  }
}

/**
 * The line of a node, by its yq path, or 0.
 * @param {string} file
 * @param {string} path
 * @param {Context} ctx
 */
function lineOf(file, path, ctx) {
  const result = spawnSync(ctx.yq, [`${path} | line`, file], { encoding: 'utf8' });
  const line = Number.parseInt(result.stdout, 10);
  return result.status === 0 && line > 0 ? line : 0;
}

/**
 * Fails unless the yq this check runs is mikefarah's v4.
 * @param {string} yq
 */
function requireYq(yq) {
  const result = spawnSync(yq, ['--version'], { encoding: 'utf8' });
  const printed = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  if (result.error || result.status !== 0 || !/mikefarah\/yq/.test(printed) || !/version v?4\./.test(printed)) {
    const why = result.error ? `did not start (${result.error.message})` : `printed ${JSON.stringify(printed)}`;
    throw new ReadError(`This check reads YAML with mikefarah's yq v4 (https://github.com/mikefarah/yq), which GitHub's Ubuntu runners carry; ${yq} ${why}. Install it, or set YQ to its path.`);
  }
}

/**
 * The workflows in .github/workflows and the composite actions in .github/actions of a repository.
 * @param {string} root
 */
export function workflowFiles(root) {
  /** @type {string[]} */
  const files = [];
  const workflows = join(root, '.github', 'workflows');
  if (existsSync(workflows)) for (const name of readdirSync(workflows).sort()) if (/\.ya?ml$/.test(name)) files.push(join(workflows, name));
  /** @param {string} dir */
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/^action\.ya?ml$/.test(name)) files.push(path);
    }
  };
  const actions = join(root, '.github', 'actions');
  if (existsSync(actions)) walk(actions);
  return files;
}

/**
 * The pushes to the default branch in the files.
 * @param {string[]} files
 * @param {{ root?: string, branch?: string, yq?: string }} [options]
 * @returns {Finding[]}
 */
export function checkFiles(files, options = {}) {
  const branch = options.branch || 'master';
  /** @type {Context} */
  const ctx = {
    root: resolve(options.root ?? '.'),
    branch,
    names: new Set(['master', 'main', branch]),
    yq: options.yq || process.env.YQ || 'yq',
    scripts: new Map(),
  };
  requireYq(ctx.yq);
  /** @type {(Finding & { path: string })[]} */
  const findings = [];
  for (const file of files) {
    const before = findings.length;
    checkDocument(file, readYaml(file, ctx), ctx, findings);
    for (const finding of findings.slice(before)) finding.line = lineOf(file, finding.path, ctx);
  }
  return findings.map(({ file, line, message }) => ({ file: relative(ctx.root, file), line, message }));
}

/** @param {string} text */
const annotation = (text) => text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');

/**
 * @param {string[]} argv
 * @returns {number} the exit status
 */
function main(argv) {
  let root = '.';
  /** @type {string[]} */
  const files = [];
  for (let k = 0; k < argv.length; k++) {
    const a = argv[k];
    if (a === '-h' || a === '--help') {
      console.log(USAGE);
      return 0;
    }
    if (a === '--root' && argv[k + 1] !== undefined) root = argv[++k];
    else if (a.startsWith('-')) {
      console.error(USAGE);
      return 2;
    } else files.push(a);
  }
  const branch = process.env.DEFAULT_BRANCH || 'master';
  try {
    const list = files.length > 0 ? files.map((file) => resolve(file)) : workflowFiles(resolve(root));
    const findings = checkFiles(list, { root, branch });
    for (const f of findings) {
      console.log(`${f.file}:${f.line}: ${f.message}`);
      if (process.env.GITHUB_ACTIONS === 'true') console.log(`::error file=${annotation(f.file)},line=${f.line}::${annotation(f.message)}`);
    }
    if (findings.length > 0) {
      console.error(`${findings.length} workflow ${findings.length === 1 ? 'step pushes' : 'steps push'} to ${branch}. Its rules refuse a direct push (GH006), so the step fails after everything before it has run. Push a branch of its own and open a pull request, or write to a branch the rules leave open.`);
      return 1;
    }
    console.log(`No workflow pushes to ${branch} (${list.length} files read).`);
    return 0;
  } catch (error) {
    if (error instanceof ReadError) {
      console.error(error.message);
      return 2;
    }
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = main(process.argv.slice(2));
