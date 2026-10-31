// An application's use of the packed package's logging surface: it imports @framers/agentos/logging and
// @framers/agentos/logging/kit, the subpaths the package's exports name, compiles against the installed declarations
// alone under NodeNext with strict on, and runs. Every event and value in it is synthetic.
// scripts/logging-kit-package.test.mjs installs and runs it.
import assert from 'node:assert/strict';
import {
  AGENTOS_CONTEXT, AGENTOS_EVENTS, lazyLogger, resetLoggerFactory, setLogger,
  type AgentOSEvents, type EventLogger, type Logger, type LogMethod,
} from '@framers/agentos/logging';
import {
  captureConsole, createAllowListLogger, installProcessHandlers, LogValidationError, type AllowListLogger,
} from '@framers/agentos/logging/kit';

// A refusal is thrown under NODE_ENV=test and written as a line otherwise; this consumer reads the lines.
process.env.NODE_ENV = 'production';

type Record_ = Record<string, unknown>;

/** A pino-shaped logger that keeps each record it is given, with its level. */
function recorder(records: Record_[], bindings: Record<string, string | number> = {}): Logger {
  const method = (level: string): LogMethod => ((obj: object | string) => {
    records.push(typeof obj === 'string' ? { level, ...bindings, msg: obj } : { level, ...bindings, ...obj });
  }) as LogMethod;
  return {
    debug: method('debug'), info: method('info'), warn: method('warn'), error: method('error'), fatal: method('fatal'),
    child: (next) => recorder(records, { ...bindings, ...next }),
  };
}

let passed = 0;
/** Runs one item and names it in the log, so a failure says which behaviour broke. */
function item(name: string, run: () => void): void {
  try {
    run();
  } catch (error) {
    throw new Error(`logging kit consumer: ${name}`, { cause: error });
  }
  passed += 1;
  console.log(`ok - ${name}`);
}

const events = { 'job.done': { ms: 'int', state: { enum: ['ok', 'failed'] } } } as const;
const records: Record_[] = [];
const kit = createAllowListLogger({ logger: recorder(records), events });
// The kit's declared type: the product's map and AgentOS's own events, over AgentOS's context keys.
const declared: AllowListLogger<typeof events & AgentOSEvents, typeof AGENTOS_CONTEXT> = kit;

item('both subpaths serve the values their declarations name', () => {
  for (const value of [setLogger, lazyLogger, resetLoggerFactory, createAllowListLogger, captureConsole, installProcessHandlers]) {
    assert.equal(typeof value, 'function');
  }
  assert.equal(typeof LogValidationError, 'function');
  assert.equal(typeof declared.asLogger, 'function');
  assert.ok(Object.prototype.hasOwnProperty.call(AGENTOS_EVENTS, 'http.request'));
  assert.deepEqual(Object.keys(AGENTOS_CONTEXT).sort(), ['component', 'extension', 'requestId']);
});

item('the kit writes a declared event with its declared fields and nothing else', () => {
  kit.info('job.done', { ms: 12, state: 'ok' });
  assert.deepEqual(records.at(-1), { level: 'info', ms: 12, state: 'ok', event: 'job.done' });
});

item('the installed declarations refuse an undeclared event and a field of the wrong kind', () => {
  // @ts-expect-error An event the map does not declare does not compile.
  kit.info('job.unknown', {});
  assert.deepEqual(records.at(-1), { level: 'warn', event: 'log_refused', reason: 'unknown_event' });
  // @ts-expect-error A string where the map declares an integer does not compile.
  kit.info('job.done', { ms: 'slow' });
  assert.deepEqual(records.at(-1), { level: 'warn', event: 'log_refused', reason: 'bad_value', name: 'job.done' });
});

item('a credential-shaped context value is refused without its value', () => {
  kit.child({ component: 'sk-fixture-not-a-key' }).info('job.done', { ms: 1 });
  assert.deepEqual(records.at(-1), { level: 'warn', event: 'log_refused', reason: 'bad_context' });
  assert.equal(JSON.stringify(records).includes('sk-fixture'), false);
});

item('setLogger hands AgentOS the kit, and a handle made before it follows', () => {
  const handle: EventLogger<typeof AGENTOS_EVENTS> = lazyLogger('consumer');
  setLogger(kit.asLogger());
  try {
    handle.warn('llm.retry', { provider: 'openai', status: 429, attempt: 1, waitMs: 5 });
    assert.deepEqual(records.at(-1), {
      level: 'warn', component: 'consumer', provider: 'openai', status: 429, attempt: 1, waitMs: 5, event: 'llm.retry',
    });
  } finally { resetLoggerFactory(); }
});

item('a kit over a product map alone also takes AgentOS events, so the console and process handlers accept it', () => {
  // Both assignments compile only when the kit's type holds AgentOS's own events beside the product's.
  const processKit: Parameters<typeof installProcessHandlers>[0] = kit;
  const consoleKit: Parameters<typeof captureConsole>[0] = kit;
  assert.equal(typeof processKit.terminal, 'function');
  consoleKit.warn('console_line', { method: 'log' });
  assert.deepEqual(records.at(-1), { level: 'warn', method: 'log', event: 'console_line' });
});

item('a console call becomes one console_line event, and the console is restored', () => {
  const original = console.info;
  const restore = captureConsole(kit);
  try { console.info('words of a person never reach a line'); } finally { restore(); }
  assert.equal(console.info, original);
  assert.deepEqual(records.at(-1), { level: 'warn', method: 'info', event: 'console_line' });
  assert.equal(JSON.stringify(records).includes('words of a person'), false);
});

kit.close();
console.log(`installed logging kit passes: ${passed} items`);
