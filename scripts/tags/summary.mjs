// Prints the tag suggestion scores as one Markdown table, a row a part, for a CI run's summary. It reads the report
// that src/cognition/library/__tests__/tags.scoring.test.ts writes (its path is the one argument) and writes the word
// "missing" for each part the module does not hold. It changes no figure and judges none: the hard checks fail the job
// in the test that computes them. A report it cannot read fails this step, with the reason in the summary.
//
//   node scripts/tags/summary.mjs "$RUNNER_TEMP/tags-report/report.json" >> "$GITHUB_STEP_SUMMARY"
import { readFileSync } from 'node:fs';

/** The parts in the report's order, each with the name its row shows. A member not named here is printed after them. */
const PARTS = [
  ['engine', 'Engine revision'],
  ['step1', 'Step 1: candidates from the text'],
  ['step3', 'Step 3: the model proposer'],
  ['quotes', 'Quotes found'],
  ['refusals', 'Refusal list and name check'],
  ['language', 'Language check'],
  ['injection', 'Injection fixtures'],
  ['browserGraph', "Browser entry's import graph"],
  ['bytes', "Model input's bytes"],
  ['timing', "Extractor's time"],
];

function figure(value) {
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : value.toFixed(3);
  return String(value);
}

function cell(value) {
  const text =
    value !== null && typeof value === 'object'
      ? Object.entries(value)
          .map(([name, member]) => `${name} ${figure(member)}`)
          .join('; ')
      : figure(value);
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

const file = process.argv[2];
let report;
try {
  if (!file) throw new Error('no report path was given');
  report = JSON.parse(readFileSync(file, 'utf8'));
  if (report === null || typeof report !== 'object' || Array.isArray(report)) throw new Error('the report is not an object');
} catch (error) {
  process.stdout.write(`## Tag suggestions (fixtures and scores)\n\nNo report to show: ${error.message}.\n`);
  process.exit(1);
}

const named = new Set(PARTS.map(([key]) => key));
const rows = [
  ...PARTS.filter(([key]) => key in report).map(([key, name]) => [name, report[key]]),
  ...Object.keys(report)
    .filter((key) => !named.has(key))
    .map((key) => [key, report[key]]),
];
const lines = [
  '## Tag suggestions (fixtures and scores)',
  '',
  'Scores on the fixture texts under `tests/fixtures/tags/`. A part the module does not hold reads "missing". The scores carry no threshold.',
  '',
  '| Part | Result |',
  '|---|---|',
  ...rows.map(([name, value]) => `| ${cell(name)} | ${cell(value)} |`),
  '',
];
process.stdout.write(lines.join('\n'));
