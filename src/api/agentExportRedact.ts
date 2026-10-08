/**
 * @fileoverview The redaction rules `exportAgentConfig` applies to a config
 * tree. Pure: no imports, no I/O, so `agentExportCore.ts` (which the
 * lightweight `agent()` entry point loads) stays free of runtime code.
 *
 * A property is a secret when its value is a non-empty string and its name,
 * read as words (camelCase, snake_case or kebab-case), ends with one of the
 * secret words or word pairs, or with its plural (`botTokens`, `apiKeys`),
 * except the settings and counts in SETTING_PLURALS (`stopTokens`,
 * `maxTokens`). A pair's joined form counts at the end of any name
 * (`openAIAPIKey`); a word's joined form only for a one-word name. Every
 * string under an object or array whose own name is exactly a secret word or
 * pair is a secret whatever its key, except the keys of the seat and tool
 * maps, which are names. A number is never a secret. Class instances become
 * a marker, since what they hold cannot be redacted by name.
 */

/** The placeholder written in place of a secret string. */
export const REDACTED = '<<REDACTED>>';
/** The single key of the object written in place of a class instance. */
export const INSTANCE_MARKER_KEY = '<<instance>>';
/** `REDACTED` as `encodeURIComponent` writes it, for import's URL check. */
export const REDACTED_ENCODED = '%3C%3CREDACTED%3E%3E';

const SECRET_WORDS = ['token', 'secret', 'password', 'passwd', 'credential', 'credentials', 'authorization', 'cookie'];
const SECRET_PAIRS = [
  'api key', 'private key', 'secret key', 'access key', 'auth key',
  'encryption key', 'signing key', 'subscription key', 'master key', 'account key', 'role key',
];
/**
 * Names that end with the plural of a secret word but hold settings or counts:
 * `stopTokens` is a list of stop strings, and the token counts are numbers that
 * never reach the string rule. Matched on the last two words.
 */
const SETTING_PLURALS = new Set([
  'stop tokens', 'max tokens', 'prompt tokens', 'completion tokens', 'total tokens', 'input tokens',
  'output tokens', 'reasoning tokens', 'thinking tokens', 'cached tokens', 'cache tokens',
]);
/** Maps whose keys are names the user chooses (seats, tools), never container names. */
const USER_NAMED_MAPS = new Set(['agents', 'tools', 'agentAccess']);
/** Words added by this rule whose string values can be settings, not secrets. */
const SETTING_WORDS = new Set(['credential', 'credentials', 'authorization', 'cookie']);
/** fetch's `credentials` values and the bare auth-mode words, kept as settings. */
const KEPT_SETTING_VALUES = new Set(['include', 'same-origin', 'omit', 'none', 'oauth', 'bearer', 'basic', 'strict', 'lax']);

/** Splits `camelCase`, `snake_case`, `kebab-case` and `UPPER_CASE` into lower-case words. */
export function splitWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[\s_\-.]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

function singular(word: string): string {
  if (SECRET_WORDS.includes(word) || word === 'keys') return word === 'keys' ? 'key' : word;
  return word.endsWith('s') ? word.slice(0, -1) : word;
}

/** The secret word or pair `name` ends with, or undefined. */
export function secretWordOf(name: string): string | undefined {
  const words = splitWords(name);
  if (words.length === 0) return undefined;
  const last = words[words.length - 1];
  // The plural settings and counts (`stopTokens`, `maxTokens`) are not secrets.
  if (words.length >= 2 && SETTING_PLURALS.has(`${words[words.length - 2]} ${last}`)) return undefined;
  // A secret word, or its plural, at the end of any name: `botToken`,
  // `signing_secret`, `refreshTokens`, `clientSecrets`.
  if (SECRET_WORDS.includes(last)) return last;
  const plural = singular(last);
  if (SECRET_WORDS.includes(plural)) return plural;
  // A pair, singular or plural, at the end of any name: `apiKey`,
  // `aws_secret_access_key`, `apiKeys`, `serviceRoleKey`.
  if (words.length >= 2) {
    const pair = `${words[words.length - 2]} ${last === 'keys' ? 'key' : last}`;
    if (SECRET_PAIRS.includes(pair)) return pair;
  }
  // Compared without separators: the joined form of a pair at the end of any
  // name (`apikey`, `APIKEY`, `openAIAPIKey`, whose acronym run hides the word
  // boundary), and the joined form of a word only for a name that is one word
  // (`accesstoken`), so `maxtokenlimit` stays a setting.
  const joined = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const pair of SECRET_PAIRS) {
    const j = pair.replace(' ', '');
    if (joined.endsWith(j) || joined.endsWith(`${j}s`)) return pair;
  }
  if (words.length === 1) {
    for (const word of SECRET_WORDS) {
      if (joined.endsWith(word) || joined.endsWith(`${word}s`)) return word;
    }
  }
  return undefined;
}

/** Whether a string property named `name` is a secret. */
export function isSecretName(name: string): boolean {
  return secretWordOf(name) !== undefined;
}

/** Whether an object or array named `name` is a secret container (exact word or pair, singular or plural). */
export function isSecretContainerName(name: string): boolean {
  const joined = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  const forms = [...SECRET_WORDS, ...SECRET_PAIRS.map((p) => p.replace(' ', ''))];
  return forms.some((f) => joined === f || joined === `${f}s`);
}

/** Whether `value` under `name` is a kept setting (fetch credentials modes, auth mode words). */
export function isKeptSettingValue(name: string, value: string): boolean {
  const word = secretWordOf(name);
  if (word === undefined || !SETTING_WORDS.has(word)) return false;
  return KEPT_SETTING_VALUES.has(value.toLowerCase());
}

/**
 * Whether a URL found under `name` (inside an object named `parent`) is a
 * webhook URL, which carries its secret in the path: a name that ends with the
 * words `webhook url` or `web hook url` (or their plurals), a name that is
 * `webhook` itself, or a `url` inside an object named `webhook`.
 */
export function isWebhookUrlName(name: string, parent = ''): boolean {
  const isHook = (n: string): boolean => {
    const w = splitWords(n);
    return w.length === 1 && (w[0] === 'webhook' || w[0] === 'webhooks');
  };
  if (isHook(name)) return true;
  const words = splitWords(name);
  const n = words.length;
  const last = words[n - 1];
  if (last !== 'url' && last !== 'urls') return false;
  if (n === 1) return isHook(parent);
  if (words[n - 2] === 'webhook') return true;
  return n >= 3 && words[n - 3] === 'web' && words[n - 2] === 'hook';
}

/** Whether a string looks like an absolute URL. */
export function isUrlString(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
}

export interface CopyExportTreeOptions {
  /** `false` keeps every string as it is. */
  redactSecrets: boolean;
  /** `'object'` keeps functions, and instances by reference when not redacting; `'serialized'` drops functions and always marks instances. */
  form: 'object' | 'serialized';
  /** Rewrites a URL-shaped string found under `name`, inside an object named `parent`. */
  redactUrl: (url: string, name: string, parent: string) => string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function instanceMarker(value: object): Record<string, string> {
  const ctor = (value as { constructor?: { name?: string } }).constructor;
  return { [INSTANCE_MARKER_KEY]: ctor?.name || 'Object' };
}

/**
 * Copies a config tree for export. Plain objects and arrays are copied; a
 * string is redacted by the rules above; a function is kept in the object
 * form and dropped otherwise (written as `null` inside an array, so later
 * items keep their index); any other object becomes an instance marker
 * (kept by reference only in the object form with `redactSecrets: false`).
 */
export function copyExportTree(value: unknown, opts: CopyExportTreeOptions): unknown {
  return copyNode(value, '', '', undefined, opts, new WeakMap());
}

/**
 * @param parent The name of the object or array that holds this value.
 * @param container The name of the nearest enclosing secret container, whose
 *   setting values stay kept inside it (`authorization: { type: 'bearer' }`).
 * @param keyIsName `name` is a key of a seat or tool map, which the user
 *   chose, not a property name.
 * @param inArray The value is an item of an array named `name`.
 */
function copyNode(
  value: unknown,
  name: string,
  parent: string,
  container: string | undefined,
  opts: CopyExportTreeOptions,
  seen: WeakMap<object, unknown>,
  keyIsName = false,
  inArray = false,
): unknown {
  if (typeof value === 'string') {
    if (!opts.redactSecrets) return value;
    if (container !== undefined || isSecretName(name)) {
      // An empty string holds nothing to protect, and import would ask for it.
      if (value === '') return value;
      const kept =
        isKeptSettingValue(name, value) || (container !== undefined && isKeptSettingValue(container, value));
      return kept ? value : REDACTED;
    }
    return isUrlString(value) ? opts.redactUrl(value, name, parent) : value;
  }
  if (typeof value === 'function') {
    return opts.form === 'object' ? value : undefined;
  }
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return seen.get(value);
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    seen.set(value, out);
    const inner = isSecretContainerName(name) && !keyIsName ? name : container;
    for (const item of value) {
      const copied = copyNode(item, name, parent, inner, opts, seen, false, true);
      // A function left out of JSON and YAML leaves `null` in its place, as
      // JSON.stringify writes it, so every later item keeps its index and
      // import can put the function back at the path where it stood.
      out.push(copied === undefined && typeof item === 'function' ? null : copied);
    }
    return out;
  }
  if (!isPlainObject(value)) {
    if (!opts.redactSecrets && opts.form === 'object') return value;
    return instanceMarker(value);
  }
  const out: Record<string, unknown> = {};
  seen.set(value, out);
  // A seat or tool named `authorization` or `credentials` is a name, not a
  // secret container: the container rule skips the keys of those maps. The
  // items of an array (a tools list) are definitions, whose keys are
  // property names however the array is named.
  const inner = isSecretContainerName(name) && !keyIsName ? name : container;
  const childrenAreNames = USER_NAMED_MAPS.has(name) && !inArray;
  for (const [key, item] of Object.entries(value)) {
    const copied = copyNode(item, key, name, inner, opts, seen, childrenAreNames);
    if (copied === undefined && typeof item === 'function') continue;
    out[key] = copied;
  }
  return out;
}
