#!/usr/bin/env node
// @ts-check
/**
 * Fails when a GitHub Actions workflow pushes a commit to the default branch.
 *
 * master's rules refuse a direct push (GH006, "required status checks are expected"), so a step that pushes there
 * fails at the push, after everything before it has run: a release step that pushed registry.json to master failed
 * that way after its packages were published, and read the refusal as a race and tried again. A workflow that has
 * to change the repository pushes a branch of its own and opens a pull request, or writes to a branch the rules
 * leave open.
 *
 * It reads the workflows in .github/workflows and the composite actions in .github/actions, or the files named on
 * the command line, and reports with its line:
 * - a git push whose destination is the default branch, master or main, written out (HEAD:master,
 *   refs/heads/master, ${{ github.event.repository.default_branch }}, the pull request's base branch), to any
 *   remote, and a push with --all, --branches or --mirror;
 * - in a workflow that can run on the default branch (any trigger but pull_request, and push unless its filters
 *   keep it off that branch), a git push with no destination, or with the run's own branch as its destination
 *   (HEAD, ${{ github.ref }}, $GITHUB_REF, $GITHUB_REF_NAME): on a run on master that branch is master;
 * - an action that pushes there: peaceiris/actions-gh-pages or JamesIves/github-pages-deploy-action publishing to
 *   it, ad-m/github-push-action with no branch (it then pushes to the default branch), and, in a workflow that can
 *   run on the default branch, stefanzweifel/git-auto-commit-action with no branch and EndBug/add-and-commit with
 *   no new_branch (both then push the checked-out branch);
 * - a semantic-release run while the repository's semantic-release configuration lists @semantic-release/git,
 *   which commits the release to the branch the run is on.
 * A dry run is not a push. A push inside a heredoc, an eval or a `sh -c` string is not read.
 *
 * Usage: node .github/scripts/check-workflow-pushes.mjs [--root <dir>] [file ...]
 * DEFAULT_BRANCH names the default branch (master when unset); master and main are refused whatever it is.
 * Exit status: 0 when nothing pushes to it, 1 when something does, 2 on a usage or read error.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** @typedef {{ file: string, line: number, message: string }} Finding */
/** @typedef {{ text: string, line: number }} Word */
/** @typedef {(line: number, message: string) => void} Report */
/**
 * @typedef {object} Context
 * @property {string} branch the default branch
 * @property {Set<string>} protectedNames the branches no workflow pushes to
 * @property {boolean} onDefault whether the workflow can run with the default branch checked out
 * @property {string} releaseGit the semantic-release configuration that lists @semantic-release/git, or ''
 * @property {Set<string>} releaseScripts the package scripts that run semantic-release
 */

const USAGE = 'Usage: node .github/scripts/check-workflow-pushes.mjs [--root <dir>] [file ...]';
const GIT_OPTIONS_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--super-prefix']);
const PUSH_OPTIONS_WITH_VALUE = new Set(['--push-option', '--repo', '--receive-pack', '--exec']);
const PACKAGE_RUNNERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
// The default branch spelled as an expression: the repository's, or a pull request's base.
const DEFAULT_REF = /^\$\{\{\s*github\.(?:event\.repository\.default_branch|base_ref|event\.pull_request\.base\.ref)\s*\}\}$|^\$\{?GITHUB_BASE_REF\}?$/;
// The branch the run is on: master on a run on master.
const RUN_REF = /^\$\{\{\s*github\.(?:ref|ref_name|event\.workflow_run\.head_branch)\s*\}\}$|^\$\{?GITHUB_REF(?:_NAME)?(?:[#%][^}]*)?\}?$|^(?:HEAD|@)$/;
const RELEASE_CONFIGS = ['.releaserc', '.releaserc.json', '.releaserc.yaml', '.releaserc.yml', '.releaserc.js', '.releaserc.cjs', '.releaserc.mjs', 'release.config.js', 'release.config.cjs', 'release.config.mjs', 'release.config.ts'];
const GIT_PLUGIN = /@semantic-release\/git(?![\w-])/;
const SEMANTIC_RELEASE = /(?:^|\/)semantic-release(?:@\S*)?$/;
const ON_KEY = /^(?:on|"on"|'on'|true)\s*:(.*)$/;

/** @param {string} line */
const indentOf = (line) => line.length - line.trimStart().length;
/** @param {string} line */
const isBlankOrComment = (line) => line.trim() === '' || line.trim().startsWith('#');
/** @param {string} line */
const isItem = (line) => /^\s*-\s/.test(line);
/**
 * The column where a line's key starts, past a sequence item's dash.
 * @param {string} line
 */
const keyColumn = (line) => {
  const item = /^(\s*-\s+)\S/.exec(line);
  return item ? item[1].length : indentOf(line);
};

/**
 * A YAML value without its trailing comment. A quote opens a quoted scalar only as the value's first character.
 * @param {string} value
 */
function stripYamlComment(value) {
  const v = value.trim();
  let quote = '';
  for (let i = 0; i < v.length; i++) {
    const c = v[i];
    if (quote === "'") {
      if (c === "'" && v[i + 1] === "'") i++;
      else if (c === "'") quote = '';
    } else if (quote === '"') {
      if (c === '\\') i++;
      else if (c === '"') quote = '';
    } else if (i === 0 && (c === '"' || c === "'")) {
      quote = c;
    } else if (c === '#' && (i === 0 || /\s/.test(v[i - 1]))) {
      return v.slice(0, i).trimEnd();
    }
  }
  return v;
}

/**
 * A one-line YAML scalar's value: its comment dropped and its quotes taken off.
 * @param {string} value
 */
function yamlScalar(value) {
  const v = stripYamlComment(value);
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    return v.slice(1, -1).replace(/\\(.)/g, (_, c) => (c === 'n' ? '\n' : c === 't' ? '\t' : c));
  }
  return v;
}

/**
 * The lines inside block scalars (`key: |` or `key: >`): they hold text, not keys.
 * @param {string[]} src
 */
function blockMask(src) {
  const mask = src.map(() => false);
  for (let i = 0; i < src.length; i++) {
    if (mask[i]) continue;
    const m = /^(\s*)(-\s+)?(?:[\w.-]+|"[^"]*"|'[^']*')\s*:\s+[|>][0-9+-]*\s*(?:#.*)?$/.exec(src[i]);
    if (!m) continue;
    const keyIndent = m[1].length + (m[2] ? m[2].length : 0);
    for (let k = i + 1; k < src.length; k++) {
      if (src[k].trim() !== '' && indentOf(src[k]) <= keyIndent) break;
      mask[k] = true;
    }
  }
  return mask;
}

/**
 * A block scalar's lines, each without the block's indentation and with its file line.
 * @param {string[]} src
 * @param {number} start
 * @param {number} keyIndent
 * @returns {Word[]}
 */
function blockLines(src, start, keyIndent) {
  /** @type {Word[]} */
  const out = [];
  let indent = -1;
  for (let i = start; i < src.length; i++) {
    const line = src[i];
    if (line.trim() === '') {
      out.push({ text: '', line: i + 1 });
      continue;
    }
    const ind = indentOf(line);
    if (ind <= keyIndent) break;
    if (indent < 0) indent = ind;
    out.push({ text: line.slice(Math.min(indent, ind)), line: i + 1 });
  }
  while (out.length > 0 && out[out.length - 1].text === '') out.pop();
  return out;
}

/**
 * A folded block scalar's lines: lines at the block's indentation join with a space, as YAML folds them.
 * @param {Word[]} lines
 * @returns {Word[]}
 */
function fold(lines) {
  /** @type {Word[]} */
  const out = [];
  for (const l of lines) {
    const prev = out[out.length - 1];
    if (prev && prev.text !== '' && l.text !== '' && !/^\s/.test(prev.text) && !/^\s/.test(l.text)) prev.text += ` ${l.text}`;
    else out.push({ ...l });
  }
  return out;
}

/**
 * A plain or quoted scalar from line `at`, with the lines below it that continue it, folded into one line.
 * @param {string[]} src
 * @param {number} at
 * @param {number} keyIndent
 * @param {string} first
 * @returns {Word[]}
 */
function continuedScalar(src, at, keyIndent, first) {
  const parts = [first];
  for (let k = at + 1; k < src.length; k++) {
    if (src[k].trim() === '' || indentOf(src[k]) <= keyIndent) break;
    parts.push(src[k].trim());
  }
  return [{ text: yamlScalar(parts.join(' ')), line: at + 1 }];
}

/**
 * The run: scripts of a workflow or action file, as lines with their file lines.
 * @param {string[]} src
 * @param {boolean[]} mask
 * @returns {Word[][]}
 */
function runScripts(src, mask) {
  /** @type {Word[][]} */
  const scripts = [];
  for (let i = 0; i < src.length; i++) {
    if (mask[i]) continue;
    const m = /^(\s*)(-\s+)?run:(?:\s+(.*))?$/.exec(src[i]);
    if (!m) continue;
    const keyIndent = m[1].length + (m[2] ? m[2].length : 0);
    const value = stripYamlComment(m[3] ?? '');
    const header = /^([|>])[0-9+-]*$/.exec(value);
    if (header) {
      const body = blockLines(src, i + 1, keyIndent);
      scripts.push(header[1] === '>' ? fold(body) : body);
    } else if (value !== '') {
      scripts.push(continuedScalar(src, i, keyIndent, value));
    } else {
      // The value sits on the lines below; a mapping there (defaults.run) holds no script.
      let k = i + 1;
      while (k < src.length && isBlankOrComment(src[k])) k++;
      if (k < src.length && indentOf(src[k]) > keyIndent && !/^\s*[^\s:#][^:]*:(?:\s|$)/.test(src[k])) {
        scripts.push(continuedScalar(src, k, keyIndent, stripYamlComment(src[k])));
      }
    }
  }
  return scripts;
}

/**
 * The index of the double quote that closes the one at `start`.
 * @param {string} s
 * @param {number} start
 * @returns {number}
 */
function doubleQuoteEnd(s, start) {
  for (let i = start + 1; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') i++;
    else if (c === '"') return i;
    else if (c === '$' && s[i + 1] === '(') i = parenEnd(s, i + 1);
  }
  return s.length;
}

/**
 * The index of the parenthesis that closes the one at `open`, past quoted text.
 * @param {string} s
 * @param {number} open
 * @returns {number}
 */
function parenEnd(s, open) {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') i++;
    else if (c === "'") {
      const close = s.indexOf("'", i + 1);
      i = close < 0 ? s.length : close;
    } else if (c === '"') i = doubleQuoteEnd(s, i);
    else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return i;
  }
  return s.length;
}

/**
 * The index past the word at `start`: a redirection's target.
 * @param {string} s
 * @param {number} start
 */
function wordEnd(s, start) {
  let i = start;
  while (i < s.length && !' \t\n;&|()<>'.includes(s[i])) {
    if (s[i] === '\\') i += 2;
    else if (s[i] === "'") {
      const close = s.indexOf("'", i + 1);
      i = close < 0 ? s.length : close + 1;
    } else if (s[i] === '"') i = doubleQuoteEnd(s, i) + 1;
    else if (s.startsWith('${{', i)) {
      const close = s.indexOf('}}', i);
      i = close < 0 ? s.length : close + 2;
    } else i++;
  }
  return i;
}

/**
 * The simple commands of a shell script: their words, quotes taken off and ${{ }} expressions kept whole, each with
 * its file line. Comments, redirections and heredoc bodies are dropped; $( ), backticks, pipes and lists split
 * commands.
 * @param {Word[]} script
 * @returns {Word[][]}
 */
function shellCommands(script) {
  const s = script.map((l) => l.text).join('\n');
  /** @type {number[]} */
  const starts = [];
  let offset = 0;
  for (const l of script) {
    starts.push(offset);
    offset += l.text.length + 1;
  }
  /** @param {number} pos */
  const lineAt = (pos) => {
    let k = 0;
    while (k + 1 < starts.length && starts[k + 1] <= pos) k++;
    return script[k].line;
  };
  /** @type {Word[][]} */
  const commands = [];
  /** @type {Word[]} */
  let words = [];
  /** @type {Word | null} */
  let word = null;
  /** @type {string[]} */
  let heredocs = [];
  const endWord = () => {
    if (word) words.push(word);
    word = null;
  };
  const endCommand = () => {
    endWord();
    if (words.length > 0) commands.push(words);
    words = [];
  };
  /**
   * @param {string} text
   * @param {number} pos
   */
  const add = (text, pos) => {
    if (!word) word = { text: '', line: lineAt(pos) };
    word.text += text;
  };

  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '\n') {
      endCommand();
      i++;
      // A heredoc's body runs from the next line to the line that holds its delimiter.
      for (const delimiter of heredocs) {
        while (i < s.length) {
          const eol = s.indexOf('\n', i);
          const text = s.slice(i, eol < 0 ? s.length : eol);
          i = eol < 0 ? s.length : eol + 1;
          if (text.trim() === delimiter) break;
        }
      }
      heredocs = [];
    } else if (c === ' ' || c === '\t') {
      endWord();
      i++;
    } else if (c === '\\') {
      if (s[i + 1] !== '\n') add(s[i + 1] ?? '', i);
      i += 2;
    } else if (c === '#' && !word) {
      const eol = s.indexOf('\n', i);
      i = eol < 0 ? s.length : eol;
    } else if (c === "'") {
      const close = s.indexOf("'", i + 1);
      const end = close < 0 ? s.length : close;
      add(s.slice(i + 1, end), i);
      i = end + 1;
    } else if (c === '"') {
      const end = doubleQuoteEnd(s, i);
      add(s.slice(i + 1, end), i);
      i = end + 1;
    } else if (s.startsWith('${{', i)) {
      const close = s.indexOf('}}', i);
      const end = close < 0 ? s.length : close + 2;
      add(s.slice(i, end), i);
      i = end;
    } else if (c === '$' && s[i + 1] === '(') {
      endCommand();
      i += 2;
    } else if (c === '$' && s[i + 1] === '{') {
      const close = s.indexOf('}', i);
      const end = close < 0 ? s.length : close + 1;
      add(s.slice(i, end), i);
      i = end;
    } else if (s.startsWith('<<', i) && !s.startsWith('<<<', i)) {
      const heredoc = /^<<-?[ \t]*(?:'([^']*)'|"([^"]*)"|\\?([^\s;&|<>()]+))/.exec(s.slice(i));
      if (heredoc) heredocs.push(heredoc[1] ?? heredoc[2] ?? heredoc[3]);
      endWord();
      i += heredoc ? heredoc[0].length : 2;
    } else if (c === '<' || c === '>' || (c === '&' && s[i + 1] === '>')) {
      // A redirection: its file descriptor number, its operator and its target are not words of the command.
      if (word && /^\d+$/.test(word.text)) word = null;
      endWord();
      const operator = /^(?:&>>?|<<<|<>|<&|>&|>>|>\||<|>)/.exec(s.slice(i));
      i += operator ? operator[0].length : 1;
      while (s[i] === ' ' || s[i] === '\t') i++;
      i = wordEnd(s, i);
    } else if (';&|()`'.includes(c)) {
      endCommand();
      i++;
    } else {
      add(c, i);
      i++;
    }
  }
  endCommand();
  return commands;
}

/**
 * Where a refspec pushes: 'default' for a protected branch, 'run' for the branch the run is on, '' elsewhere.
 * @param {string} spec
 * @param {Set<string>} protectedNames
 */
function destination(spec, protectedNames) {
  const s = spec.replace(/^\+/, '');
  let colon = -1;
  for (let i = 0; i < s.length; i++) {
    if (s.startsWith('${{', i)) {
      const close = s.indexOf('}}', i);
      if (close < 0) break;
      i = close + 1;
    } else if (s.startsWith('${', i)) {
      const close = s.indexOf('}', i);
      if (close < 0) break;
      i = close;
    } else if (s[i] === ':') {
      colon = i;
      break;
    }
  }
  const target = colon < 0 ? s : s.slice(colon + 1);
  if (target.startsWith('refs/tags/')) return '';
  const name = target.replace(/^refs\/heads\//, '');
  if (protectedNames.has(name) || DEFAULT_REF.test(name)) return 'default';
  if (RUN_REF.test(name)) return 'run';
  return '';
}

/**
 * A git push's arguments: its refspecs (the words after the remote), whether it is a dry run, and whether it pushes
 * every branch or only tags.
 * @param {Word[]} args
 */
function parsePush(args) {
  /** @type {Word[]} */
  const positional = [];
  let dryRun = false;
  let every = '';
  let tags = false;
  for (let k = 0; k < args.length; k++) {
    const a = args[k].text;
    if (a === '--') {
      positional.push(...args.slice(k + 1));
      break;
    }
    if (a.startsWith('--')) {
      const name = a.split('=')[0];
      if (name === '--dry-run') dryRun = true;
      else if (name === '--all' || name === '--branches' || name === '--mirror') every = name;
      else if (name === '--tags') tags = true;
      else if (!a.includes('=') && PUSH_OPTIONS_WITH_VALUE.has(name)) k++;
    } else if (a.length > 1 && a.startsWith('-')) {
      for (let j = 1; j < a.length; j++) {
        if (a[j] === 'n') dryRun = true;
        if (a[j] === 'o') {
          if (j === a.length - 1) k++;
          break;
        }
      }
    } else {
      positional.push(args[k]);
    }
  }
  return { dryRun, every, tags, refspecs: positional.slice(1) };
}

/**
 * Reports a git push that reaches the default branch.
 * @param {Word[]} args the words after `push`
 * @param {number} line the line of `git`
 * @param {Context} ctx
 * @param {Report} report
 */
function checkPush(args, line, ctx, report) {
  const push = parsePush(args);
  const b = ctx.branch;
  if (push.dryRun) return;
  if (push.every) {
    report(line, `git push ${push.every} pushes every local branch, ${b} among them, and ${b} refuses a direct push (GH006). Push one branch of the workflow's own: git push origin HEAD:refs/heads/<branch>.`);
    return;
  }
  if (push.refspecs.length === 0) {
    if (!push.tags && ctx.onDefault) {
      report(line, `git push with no destination pushes the checked-out branch, which is ${b} on a run on ${b}, and ${b} refuses a direct push (GH006). Name a branch of the workflow's own: git push origin HEAD:refs/heads/<branch>.`);
    }
    return;
  }
  for (const spec of push.refspecs) {
    const where = destination(spec.text, ctx.protectedNames);
    if (where === 'default') {
      report(spec.line, `git push ${spec.text} pushes to a protected branch, whose rules refuse a direct push (GH006). Push a branch of the workflow's own and open a pull request, or write to an unprotected branch.`);
    } else if (where === 'run' && ctx.onDefault) {
      report(spec.line, `git push ${spec.text} pushes the branch the run is on, which is ${b} on a run on ${b}, and ${b} refuses a direct push (GH006). Name a branch of the workflow's own: git push origin HEAD:refs/heads/<branch>.`);
    }
  }
}

/**
 * Reports the pushes in one simple command, and a semantic-release run that commits to the branch.
 * @param {Word[]} words
 * @param {Context} ctx
 * @param {Report} report
 */
function checkCommand(words, ctx, report) {
  const texts = words.map((w) => w.text);
  for (let k = 0; k < words.length; k++) {
    if (texts[k] !== 'git' && !texts[k].endsWith('/git')) continue;
    let j = k + 1;
    while (j < texts.length && texts[j].startsWith('-')) j += GIT_OPTIONS_WITH_VALUE.has(texts[j]) ? 2 : 1;
    if (texts[j] === 'push') {
      checkPush(words.slice(j + 1), words[k].line, ctx, report);
      return;
    }
  }
  if (!ctx.releaseGit || texts.includes('--dry-run') || texts.includes('-d')) return;
  const program = texts.find((t) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) ?? '';
  const run = words.find((w) => SEMANTIC_RELEASE.test(w.text))
    ?? (PACKAGE_RUNNERS.has(program) ? words.find((w) => ctx.releaseScripts.has(w.text)) : undefined);
  if (run) report(run.line, semanticReleaseMessage(ctx));
}

/** @param {Context} ctx */
function semanticReleaseMessage(ctx) {
  return `semantic-release runs here with @semantic-release/git in ${ctx.releaseGit}, which commits the release to the branch it runs on, and ${ctx.branch} refuses a direct push (GH006). Take the git plugin out: the tag, the package and the GitHub release carry the version.`;
}

/**
 * A step's `with:` inputs that fit on one line, each with its line, read from the step's keys around `uses:`.
 * @param {string[]} src
 * @param {boolean[]} mask
 * @param {number} at the index of the uses: line
 * @param {number} keyIndent the column of the step's keys
 * @returns {Record<string, Word>}
 */
function stepInputs(src, mask, at, keyIndent) {
  /** @type {Record<string, Word>} */
  const inputs = {};
  /** @param {number} i */
  const readWith = (i) => {
    const inline = stripYamlComment(src[i].slice(src[i].indexOf('with:') + 5));
    if (inline.startsWith('{')) {
      for (const pair of inline.slice(1, inline.lastIndexOf('}')).split(',')) {
        const m = /^\s*([\w-]+)\s*:\s*(.*)$/.exec(pair);
        if (m) inputs[m[1]] = { text: yamlScalar(m[2]), line: i + 1 };
      }
      return;
    }
    let child = -1;
    for (let k = i + 1; k < src.length; k++) {
      if (mask[k] || isBlankOrComment(src[k])) continue;
      const ind = indentOf(src[k]);
      if (ind <= keyIndent) break;
      if (child < 0) child = ind;
      if (ind !== child) continue;
      const m = /^\s*([\w-]+)\s*:(?:\s+(.*))?$/.exec(src[k]);
      if (m) inputs[m[1]] = { text: yamlScalar(m[2] ?? ''), line: k + 1 };
    }
  };
  if (!isItem(src[at])) {
    // The step's keys above uses:, up to the dash that starts the step.
    for (let i = at - 1; i >= 0; i--) {
      if (mask[i] || isBlankOrComment(src[i])) continue;
      const col = keyColumn(src[i]);
      if (col < keyIndent) break;
      if (col > keyIndent) continue;
      if (/^\s*(?:-\s+)?with\s*:/.test(src[i])) readWith(i);
      if (isItem(src[i])) break;
    }
  }
  for (let i = at + 1; i < src.length; i++) {
    if (mask[i] || isBlankOrComment(src[i])) continue;
    const col = keyColumn(src[i]);
    if (col < keyIndent || (col === keyIndent && isItem(src[i]))) break;
    if (col === keyIndent && /^\s*with\s*:/.test(src[i])) readWith(i);
  }
  return inputs;
}

/**
 * Reports an action step that pushes to the default branch.
 * @param {string[]} src
 * @param {boolean[]} mask
 * @param {Context} ctx
 * @param {Report} report
 */
function checkActions(src, mask, ctx, report) {
  const b = ctx.branch;
  for (let i = 0; i < src.length; i++) {
    if (mask[i]) continue;
    const m = /^(\s*)(-\s+)?uses:\s*(.+)$/.exec(src[i]);
    if (!m) continue;
    const action = yamlScalar(m[3]);
    const name = action.split('@')[0].toLowerCase();
    const line = i + 1;
    const inputs = stepInputs(src, mask, i, m[1].length + (m[2] ? m[2].length : 0));
    /**
     * @param {string} input
     * @param {string} fallback the action's default for the input
     */
    const toward = (input, fallback) => {
      const target = inputs[input]?.text || fallback;
      const where = destination(target, ctx.protectedNames);
      const at = inputs[input]?.line ?? line;
      if (where === 'default') {
        report(at, `${action} pushes to ${target} (${input}), a protected branch whose rules refuse a direct push (GH006). Set ${input} to a branch of the workflow's own.`);
      } else if (where === 'run' && ctx.onDefault) {
        report(at, `${action} pushes to ${target} (${input}), the branch the run is on, which is ${b} on a run on ${b} and refuses a direct push (GH006). Set ${input} to a branch of the workflow's own.`);
      }
    };
    /** @param {string} input */
    const checkedOut = (input) => {
      if (ctx.onDefault) {
        report(line, `${action} with no ${input} pushes the checked-out branch, which is ${b} on a run on ${b}, and ${b} refuses a direct push (GH006). Set ${input} to a branch of the workflow's own.`);
      }
    };
    if (name === 'peaceiris/actions-gh-pages') toward('publish_branch', 'gh-pages');
    else if (name === 'jamesives/github-pages-deploy-action') toward('branch', 'gh-pages');
    else if (name === 'ad-m/github-push-action') {
      if (inputs.branch?.text) toward('branch', '');
      else report(line, `${action} with no branch pushes to the default branch, which refuses a direct push (GH006). Set branch to a branch of the workflow's own.`);
    } else if (name === 'stefanzweifel/git-auto-commit-action') {
      if (inputs.branch?.text) toward('branch', '');
      else checkedOut('branch');
    } else if (name === 'endbug/add-and-commit') {
      const push = inputs.push?.text ?? 'true';
      if (push === 'false') continue;
      if (push !== 'true' && push !== '') {
        // push holds the arguments the action gives git push.
        const args = push.split(/\s+/).filter(Boolean).map((text) => ({ text, line: inputs.push.line }));
        checkPush(args, inputs.push.line, ctx, report);
      } else if (inputs.new_branch?.text) toward('new_branch', '');
      else checkedOut('new_branch');
    } else if (name === 'cycjimmy/semantic-release-action') {
      if (ctx.releaseGit && inputs.dry_run?.text !== 'true') report(line, semanticReleaseMessage(ctx));
    }
  }
}

/**
 * Whether a push trigger's filters let it run on the branch: a branches list whose last pattern to take it is not a
 * negation, a branches-ignore list that does not take it, or no branch filter and no tag filter.
 * @param {string[]} src
 * @param {number} at the index of the push: line
 * @param {string} branch
 */
function pushReaches(src, at, branch) {
  const inline = stripYamlComment(src[at].slice(src[at].indexOf(':') + 1));
  if (inline !== '' && inline !== '{}' && inline !== 'null' && inline !== '~') return true;
  const indent = indentOf(src[at]);
  /** @type {string[] | null} */
  let branches = null;
  /** @type {string[] | null} */
  let ignore = null;
  let tags = false;
  for (let i = at + 1; i < src.length; i++) {
    if (isBlankOrComment(src[i])) continue;
    if (indentOf(src[i]) <= indent) break;
    const m = /^\s*(branches|branches-ignore|tags|tags-ignore)\s*:(.*)$/.exec(src[i]);
    if (!m) continue;
    if (m[1].startsWith('tags')) tags = true;
    else if (m[1] === 'branches') branches = yamlList(src, i, m[2]);
    else ignore = yamlList(src, i, m[2]);
  }
  if (branches) {
    let taken = false;
    for (const pattern of branches) {
      if (pattern.startsWith('!')) {
        if (globMatch(pattern.slice(1), branch)) taken = false;
      } else if (globMatch(pattern, branch)) taken = true;
    }
    return taken;
  }
  if (ignore) return !ignore.some((pattern) => globMatch(pattern, branch));
  return !tags;
}

/**
 * A YAML list after a key: a flow list on the key's line, or the block list below it.
 * @param {string[]} src
 * @param {number} at
 * @param {string} rest the text after the key's colon
 * @returns {string[]}
 */
function yamlList(src, at, rest) {
  const inline = stripYamlComment(rest);
  if (inline.startsWith('[')) {
    return inline.slice(1, inline.lastIndexOf(']')).split(',').map((item) => yamlScalar(item)).filter(Boolean);
  }
  if (inline !== '') return [yamlScalar(inline)];
  /** @type {string[]} */
  const out = [];
  const indent = indentOf(src[at]);
  for (let i = at + 1; i < src.length; i++) {
    if (isBlankOrComment(src[i])) continue;
    const m = /^(\s*)-\s*(.*)$/.exec(src[i]);
    if (!m || m[1].length < indent) break;
    out.push(yamlScalar(m[2]));
  }
  return out;
}

/**
 * GitHub's branch filter match: * takes any characters but /, ** takes any characters, and ?, + and [ ] work as in
 * a regular expression.
 * @param {string} pattern
 * @param {string} name
 */
function globMatch(pattern, name) {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') {
      re += '.*';
      i++;
    } else if (c === '*') re += '[^/]*';
    else if ('?+[]'.includes(c)) re += c;
    else re += c.replace(/[.^$(){}|\\]/g, '\\$&');
  }
  try {
    return new RegExp(`^${re}$`).test(name);
  } catch {
    return true;
  }
}

/**
 * Whether a workflow can run with the branch checked out: any trigger but pull_request, and push unless its filters
 * keep it off the branch. A file with no `on:` (a composite action) can.
 * @param {string[]} src
 * @param {string} branch
 */
function canRunOn(src, branch) {
  const at = src.findIndex((l) => ON_KEY.test(l));
  if (at < 0) return true;
  const inline = stripYamlComment(/** @type {RegExpExecArray} */ (ON_KEY.exec(src[at]))[1]);
  /** @type {{ name: string, line: number }[]} */
  const events = [];
  if (inline.startsWith('{')) return true;
  if (inline.startsWith('[')) {
    for (const e of inline.slice(1, inline.lastIndexOf(']')).split(',')) events.push({ name: yamlScalar(e), line: -1 });
  } else if (inline !== '') {
    events.push({ name: yamlScalar(inline), line: -1 });
  } else {
    let child = -1;
    for (let i = at + 1; i < src.length; i++) {
      if (isBlankOrComment(src[i])) continue;
      const ind = indentOf(src[i]);
      if (ind === 0) break;
      if (child < 0) child = ind;
      if (ind !== child) continue;
      const m = /^\s*(?:-\s*)?([A-Za-z_]+)/.exec(src[i]);
      if (m) events.push({ name: m[1], line: i });
    }
  }
  return events.some(({ name, line }) => {
    if (name === 'pull_request') return false;
    if (name !== 'push' || line < 0) return true;
    return pushReaches(src, line, branch);
  });
}

/**
 * The semantic-release configuration under root that lists @semantic-release/git (a commented-out entry counts), and
 * the package scripts that run semantic-release.
 * @param {string} root
 */
function semanticRelease(root) {
  let file = '';
  for (const name of RELEASE_CONFIGS) {
    const path = join(root, name);
    if (existsSync(path) && GIT_PLUGIN.test(readFileSync(path, 'utf8'))) {
      file = name;
      break;
    }
  }
  /** @type {Set<string>} */
  const scripts = new Set();
  const manifest = join(root, 'package.json');
  if (existsSync(manifest)) {
    const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
    if (!file && pkg.release && GIT_PLUGIN.test(JSON.stringify(pkg.release))) file = 'package.json (release)';
    for (const [name, body] of Object.entries(pkg.scripts ?? {})) {
      if (typeof body === 'string' && /(?:^|[\s/&;|])semantic-release(?=\s|$|@)/.test(body) && !/--dry-run|\s-d(?:\s|$)/.test(body)) {
        scripts.add(name);
      }
    }
  }
  return { file, scripts };
}

/**
 * The workflow files and composite actions under root's .github directory.
 * @param {string} root
 * @returns {string[]}
 */
export function workflowFiles(root) {
  /** @type {string[]} */
  const out = [];
  const workflows = join(root, '.github', 'workflows');
  if (existsSync(workflows)) {
    for (const name of readdirSync(workflows).sort()) if (/\.ya?ml$/.test(name)) out.push(join(workflows, name));
  }
  /** @param {string} dir */
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/^action\.ya?ml$/.test(name)) out.push(path);
    }
  };
  const actions = join(root, '.github', 'actions');
  if (existsSync(actions)) walk(actions);
  return out;
}

/**
 * The pushes to the default branch in workflow and action files.
 * @param {string[]} files
 * @param {{ root?: string, defaultBranch?: string }} [options] root holds the semantic-release configuration
 * @returns {Finding[]}
 */
export function checkFiles(files, options = {}) {
  const root = resolve(options.root ?? '.');
  const branch = options.defaultBranch || 'master';
  const protectedNames = new Set([branch, 'master', 'main']);
  const release = semanticRelease(root);
  /** @type {Finding[]} */
  const findings = [];
  for (const file of files) {
    const src = readFileSync(file, 'utf8').replace(/\r\n?/g, '\n').split('\n');
    const mask = blockMask(src);
    /** @type {Context} */
    const ctx = { branch, protectedNames, onDefault: canRunOn(src, branch), releaseGit: release.file, releaseScripts: release.scripts };
    /** @type {Report} */
    const report = (line, message) => findings.push({ file, line, message });
    for (const script of runScripts(src, mask)) {
      for (const words of shellCommands(script)) checkCommand(words, ctx, report);
    }
    checkActions(src, mask, ctx, report);
  }
  return findings.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));
}

/** @param {string} text */
const escapeData = (text) => text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
/** @param {string} text */
const escapeProperty = (text) => escapeData(text).replace(/:/g, '%3A').replace(/,/g, '%2C');

/**
 * @param {string[]} argv
 * @returns {number} the exit status
 */
function main(argv) {
  let root = '.';
  /** @type {string[]} */
  const files = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--help' || argv[i] === '-h') {
      console.log(USAGE);
      return 0;
    }
    if (argv[i] === '--root' && argv[i + 1] !== undefined) root = argv[++i];
    else if (argv[i].startsWith('-')) {
      console.error(`check-workflow-pushes: ${argv[i] === '--root' ? '--root needs a directory' : `unknown option ${argv[i]}`}\n${USAGE}`);
      return 2;
    } else files.push(argv[i]);
  }
  const branch = process.env.DEFAULT_BRANCH || 'master';
  /** @type {Finding[]} */
  let findings;
  let count = files.length;
  try {
    const list = files.length > 0 ? files : workflowFiles(resolve(root));
    count = list.length;
    if (count === 0) {
      console.error(`check-workflow-pushes: no workflow files under ${join(resolve(root), '.github')}`);
      return 2;
    }
    findings = checkFiles(list, { root, defaultBranch: branch });
  } catch (error) {
    console.error(`check-workflow-pushes: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  const annotate = process.env.GITHUB_ACTIONS === 'true';
  for (const f of findings) {
    const file = relative(process.cwd(), f.file) || f.file;
    if (annotate) console.log(`::error file=${escapeProperty(file)},line=${f.line}::${escapeData(f.message)}`);
    else console.log(`${file}:${f.line}: ${f.message}`);
  }
  if (findings.length > 0) {
    console.log(`${findings.length} push${findings.length === 1 ? '' : 'es'} to ${branch} in ${count} workflow file${count === 1 ? '' : 's'}.`);
    return 1;
  }
  console.log(`Read ${count} workflow file${count === 1 ? '' : 's'}: none pushes to ${branch}.`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
