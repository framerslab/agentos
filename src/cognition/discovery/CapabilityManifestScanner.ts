/**
 * @fileoverview Capability Manifest Scanner — file-based discovery.
 * @module @framers/agentos/discovery/CapabilityManifestScanner
 *
 * Scans directories for CAPABILITY.yaml manifest files and optional
 * SKILL.md companions. Supports hot-reload via fs.watch with debouncing.
 *
 * Directory conventions:
 *   ~/.wunderland/capabilities/       (user-global)
 *   ./.wunderland/capabilities/       (workspace-local)
 *   $WUNDERLAND_CAPABILITY_DIRS       (env var, colon-separated)
 *
 * CAPABILITY.yaml format:
 *   id: custom:my-tool
 *   kind: tool
 *   name: my-tool
 *   displayName: My Custom Tool
 *   description: Does something useful
 *   category: information
 *   tags: [search, api]
 *   requiredSecrets: [MY_API_KEY]
 *   inputSchema: { type: object, properties: { query: { type: string } } }
 *   skillContent: ./SKILL.md
 *
 * `skillContent` is optional: a path below the capability's folder, its names joined by `/` after an optional
 * leading `./` (`resolveSkillContentPath`). A manifest that sets `skillContent` to anything else, such as a path that
 * would leave the folder, an empty value, no value or `false`, is refused, and the capability with it. The manifest,
 * the skill's content and `schema.json` are read never through a symbolic link at the capability's folder or below
 * it, never waiting, and only when each is a regular file (`readFileOutsideLinks` in `core/utils/linkFreeWrite`,
 * which on Linux also checks that the file it opened lies below the capability's own folder; where that check cannot
 * run, the scan writes one warning line saying so). A refused capability is left out with a warning, the scan goes on
 * with the others, and `scanWithRefusals()` reports it.
 *
 * Extends the existing workspace-discovery.ts pattern from agentos-skills-registry.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
  readFileOutsideLinks,
  type OpenRefusal,
  type UncheckedOpenPath,
} from '../../core/utils/linkFreeWrite.js';
import {
  MAX_PATH_NAME_BYTES,
  describeRefusedName,
  relativePathProblem,
  resolveInsideFolder,
} from '../../core/utils/pathName.js';
import type {
  CapabilityDescriptor,
  CapabilityKind,
  CapabilityManifestField,
  CapabilityManifestFile,
  CapabilityManifestProblem,
  CapabilityManifestScanResult,
  RefusedCapabilityManifest,
} from './types.js';

// ============================================================================
// YAML FRONTMATTER PARSER (lightweight, no external dependency)
// ============================================================================

/**
 * Parse a simple YAML document into a plain object.
 * Handles basic scalar values, arrays, and nested objects.
 * Not a full YAML parser — sufficient for CAPABILITY.yaml manifests.
 */
function parseSimpleYaml(content: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = content.split('\n');
  let currentKey = '';
  let inArray = false;
  let arrayItems: unknown[] = [];

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');

    // Skip empty lines and comments
    if (!line.trim() || line.trim().startsWith('#')) continue;

    // Array item (indented with -)
    if (inArray && /^\s+-\s*/.test(line)) {
      const value = line.replace(/^\s+-\s*/, '').trim();
      arrayItems.push(parseScalar(value));
      continue;
    }

    // If we were in an array, flush it
    if (inArray) {
      result[currentKey] = arrayItems;
      inArray = false;
      arrayItems = [];
    }

    // Key-value pair
    const kvMatch = line.match(/^(\w[\w.]*)\s*:\s*(.*)/);
    if (kvMatch) {
      const [, key, rawValue] = kvMatch;
      const value = rawValue.trim();

      if (!value) {
        // A key with no value is YAML's null. Indented `- item` lines below it replace that with their list; the
        // lines of a nested object are not read, so the key stays null.
        result[key] = null;
        currentKey = key;
        continue;
      }

      // Inline array: [item1, item2, item3]
      if (value.startsWith('[') && value.endsWith(']')) {
        const inner = value.slice(1, -1);
        result[key] = inner
          .split(',')
          .map((s) => parseScalar(s.trim()))
          .filter((s) => s !== '');
        continue;
      }

      // Inline object: { key: value }
      if (value.startsWith('{') && value.endsWith('}')) {
        try {
          result[key] = JSON.parse(value);
        } catch {
          result[key] = value;
        }
        continue;
      }

      result[key] = parseScalar(value);
      currentKey = key;
      continue;
    }

    // Check if this starts an array
    if (/^\s+-\s*/.test(line) && currentKey) {
      inArray = true;
      const value = line.replace(/^\s+-\s*/, '').trim();
      arrayItems.push(parseScalar(value));
    }
  }

  // Flush any remaining array
  if (inArray && currentKey) {
    result[currentKey] = arrayItems;
  }

  return result;
}

/**
 * Parse a YAML scalar value to its JS type.
 */
function parseScalar(value: string): string | number | boolean {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null' || value === '~') return '';
  if (/^-?\d+$/.test(value)) return parseInt(value, 10);
  if (/^-?\d+\.\d+$/.test(value)) return parseFloat(value);
  // Remove surrounding quotes
  if ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

// ============================================================================
// SKILL CONTENT PATH AND FILE READS
// ============================================================================

/** The part of the rule each problem with a `skillContent` value breaks, as the error message words it. */
const RULE_BROKEN: Record<Exclude<CapabilityManifestProblem, OpenRefusal>, string> = {
  type: 'skillContent is a string',
  empty: 'skillContent names a file',
  character: 'skillContent holds no backslash, no colon, none of " * < > ? | and no control character',
  segment: 'skillContent is names joined by single slashes, after an optional leading ./, with no slash at its start or end',
  dot: 'no name in skillContent starts with a dot, after an optional leading ./',
  edge: 'no name in skillContent starts or ends with a space or ends with a dot',
  length: `each name in skillContent is at most ${MAX_PATH_NAME_BYTES} bytes in UTF-8`,
  outside: "the file skillContent names would be outside the capability's folder",
};

/** What is wrong with a file's place, as the error message words it. */
const PLACE_BROKEN: Record<OpenRefusal, string> = {
  link: 'is reached through a symbolic link',
  special: 'is not a regular file',
};

/**
 * Thrown by `parseManifest`, and reported by `scanWithRefusals`, when a capability is refused: its `skillContent`
 * is not a path below its folder, or a symbolic link or something other than a regular file holds the place of its
 * manifest, its skill's content or its `schema.json`, or of a folder on the way to one, its own folder among them.
 * Nothing of the refused capability is used.
 */
export class CapabilityManifestRefusedError extends Error {
  /** A stable code for callers that branch on the kind of failure. */
  readonly code = 'CAPABILITY_MANIFEST_REFUSED';

  /**
   * @param field - What was refused: the manifest, the skill's content or the schema file.
   * @param problem - Why it was refused.
   * @param refused - For `link` and `special`, the absolute path of the file; otherwise the `skillContent` value,
   *   which the message shows escaped and cut to its first 64 characters.
   */
  constructor(
    readonly field: CapabilityManifestField,
    readonly problem: CapabilityManifestProblem,
    refused: unknown,
  ) {
    super(
      problem === 'link' || problem === 'special'
        ? `capability ${field} refused: ${String(refused)} ${PLACE_BROKEN[problem]}`
        : `capability skillContent ${describeRefusedName(refused)} refused: ${RULE_BROKEN[problem]}`,
    );
    this.name = 'CapabilityManifestRefusedError';
  }
}

/**
 * The file a manifest's `skillContent` names, resolved. The value is a path below the capability's folder: its
 * names joined by `/`, after an optional leading `./`, held to the rule every path built from data meets
 * (`relativePathProblem` in `core/utils/pathName`), so it starts at neither the root nor a drive and no name in it
 * is `.` or `..`. Then the resolved file must lie inside the resolved folder, a second guard should a platform's
 * path rules ever place the file of an accepted value elsewhere.
 *
 * @param capabilityDir - The capability's folder, which holds its manifest.
 * @param skillContent - The manifest's `skillContent` value.
 * @param paths - The path functions to resolve with: the platform's by default, `path.win32` or `path.posix` to pick one.
 * @returns The absolute path of the file.
 * @throws CapabilityManifestRefusedError (`field: 'skillContent'`) when the value is refused or its file would be
 *   outside the folder.
 */
export function resolveSkillContentPath(
  capabilityDir: string,
  skillContent: unknown,
  paths: Pick<path.PlatformPath, 'resolve' | 'sep'> = path,
): string {
  if (typeof skillContent !== 'string') {
    throw new CapabilityManifestRefusedError('skillContent', 'type', skillContent);
  }
  const relative = skillContent.startsWith('./') ? skillContent.slice(2) : skillContent;
  const problem = relativePathProblem(relative);
  if (problem) throw new CapabilityManifestRefusedError('skillContent', problem, skillContent);
  const file = resolveInsideFolder(capabilityDir, [relative], paths);
  if (file === null) throw new CapabilityManifestRefusedError('skillContent', 'outside', skillContent);
  return file;
}

/**
 * The files one scan, or one `parseManifest` call, read on Linux without the full check that the file the open
 * reached lies below its capability's folder, counted by why, so that the scan writes one warning line for them all.
 */
type UncheckedReads = Map<UncheckedOpenPath, number>;

/** Why a read went without the full check, as the warning words it. */
const UNCHECKED_BECAUSE: Record<UncheckedOpenPath, string> = {
  realpath: "a folder's real path could not be had",
  proc: '/proc/self/fd gave no path for an open file',
};

/**
 * Write one warning line for the files a scan read without the full check of the path the open reached, when there
 * are any. Such a file was still refused when a link or something other than a regular file was in its place, or
 * in a folder's on the way, when the scan looked.
 */
function warnUncheckedReads(unchecked: UncheckedReads): void {
  if (unchecked.size === 0) return;
  let files = 0;
  for (const count of unchecked.values()) files += count;
  const because = [...unchecked.keys()].map((reason) => UNCHECKED_BECAUSE[reason]).join('; ');
  console.warn(
    `[CapabilityManifestScanner] Read ${files} capability file${files === 1 ? '' : 's'} without checking that ` +
      `the file opened lies below its capability's folder (${because}); links and special files met on the way ` +
      'were still refused',
  );
}

/**
 * Read `file`, a path inside `folder`, never waiting, only when it is a regular file, and never through a symbolic
 * link at the folder or below it (`readFileOutsideLinks`). The file is read below the folder's parent, the folder
 * that holds every capability's folder when the scan reads it, so the capability's own folder is looked at too, and
 * on Linux the file the open reached is checked to lie below the capability's own folder, whose real path is taken
 * before the looks. A read made without that check is counted in `unchecked`.
 *
 * @param folder - The capability's folder, which holds the file. It may not be a link.
 * @param file - The file's path, absolute or relative to `folder`, inside `folder`.
 * @param field - What the file is, for a refusal.
 * @param unchecked - The scan's count of files read without the full check, which this adds to.
 * @returns The file's text, or null when no file is there.
 * @throws CapabilityManifestRefusedError (`link` or `special`) when the file is not read through.
 */
async function readCapabilityFile(
  folder: string,
  file: string,
  field: CapabilityManifestField,
  unchecked: UncheckedReads,
): Promise<string | null> {
  const dir = path.resolve(folder);
  const target = path.resolve(dir, file);
  const root = path.dirname(dir);
  const read = await readFileOutsideLinks(root, path.relative(root, target), { within: dir });
  if (typeof read === 'string') throw new CapabilityManifestRefusedError(field, read, target);
  if (read === null) return null;
  if (read.unchecked !== undefined) unchecked.set(read.unchecked, (unchecked.get(read.unchecked) ?? 0) + 1);
  return read.text;
}

/**
 * True when an entry of any kind is at `file`, looked at without following a link, so a link that leads nowhere
 * counts. A look that fails for any other reason counts as no entry.
 */
function entryAt(file: string): boolean {
  try {
    return fs.lstatSync(file, { throwIfNoEntry: false }) !== undefined;
  } catch {
    return false;
  }
}

// ============================================================================
// MANIFEST SCANNER
// ============================================================================

export class CapabilityManifestScanner {
  private watchers: fs.FSWatcher[] = [];

  /**
   * Get default scan directories.
   *
   * 1. ~/.wunderland/capabilities/ (user-global)
   * 2. ./.wunderland/capabilities/ (workspace-local, relative to cwd)
   * 3. $WUNDERLAND_CAPABILITY_DIRS (env var, colon-separated)
   */
  getDefaultDirs(): string[] {
    const dirs: string[] = [];

    // User-global
    const homeDir = os.homedir();
    dirs.push(path.join(homeDir, '.wunderland', 'capabilities'));

    // Workspace-local
    dirs.push(path.join(process.cwd(), '.wunderland', 'capabilities'));

    // Env var
    const envDirs = process.env.WUNDERLAND_CAPABILITY_DIRS;
    if (envDirs) {
      dirs.push(...envDirs.split(':').filter(Boolean));
    }

    return dirs;
  }

  /**
   * Scan directories for CAPABILITY.yaml files.
   * Each subdirectory should contain a CAPABILITY.yaml and optional SKILL.md.
   *
   * Structure:
   *   <dir>/
   *     my-custom-tool/
   *       CAPABILITY.yaml
   *       SKILL.md          (optional)
   *       schema.json       (optional)
   *
   * A refused capability is left out with a warning; {@link scanWithRefusals} also reports it.
   */
  async scan(dirs?: string[]): Promise<CapabilityDescriptor[]> {
    return (await this.scanWithRefusals(dirs)).descriptors;
  }

  /**
   * Scan directories for CAPABILITY.yaml files, as {@link scan} does, and report each capability left out because
   * its `skillContent` or the place of one of its files was refused (see {@link CapabilityManifestRefusedError}).
   * A refused capability is left out, a warning names it, and the scan goes on with the others. On Linux, when the
   * check that each file opened lies below its capability's folder cannot run, the files are read without it and the
   * scan writes one warning line saying so.
   *
   * @param dirs - The folders to scan, each holding one folder per capability; {@link getDefaultDirs} by default.
   * @returns The capabilities read, and the ones refused with their manifests and reasons.
   */
  async scanWithRefusals(dirs?: string[]): Promise<CapabilityManifestScanResult> {
    const scanDirs = dirs ?? this.getDefaultDirs();
    const descriptors: CapabilityDescriptor[] = [];
    const refused: RefusedCapabilityManifest[] = [];
    const unchecked: UncheckedReads = new Map();

    for (const dir of scanDirs) {
      if (!fs.existsSync(dir)) continue;

      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const capDir = path.join(dir, entry.name);
        const yamlPath = path.join(capDir, 'CAPABILITY.yaml');
        const ymlPath = path.join(capDir, 'CAPABILITY.yml');

        // An entry of any kind at a manifest's place selects it, a link that leads nowhere among them, so the read
        // refuses and reports what is there rather than the scan passing over it.
        const manifestPath = entryAt(yamlPath) ? yamlPath : entryAt(ymlPath) ? ymlPath : null;

        if (!manifestPath) continue;

        try {
          const descriptor = await this.readManifest(manifestPath, capDir, unchecked);
          if (descriptor) {
            descriptors.push(descriptor);
          }
        } catch (err) {
          if (err instanceof CapabilityManifestRefusedError) {
            refused.push({ manifestPath, field: err.field, problem: err.problem });
            console.warn(`[CapabilityManifestScanner] Skipped ${manifestPath}: ${err.message}`);
          } else {
            console.warn(
              `[CapabilityManifestScanner] Failed to parse ${manifestPath}: ${err}`,
            );
          }
        }
      }
    }

    warnUncheckedReads(unchecked);
    return { descriptors, refused };
  }

  /**
   * Parse a single CAPABILITY.yaml file into a CapabilityDescriptor. The manifest, the skill's content and
   * `schema.json` are read never through a symbolic link at the capability's folder or below it, never waiting, and
   * only when each is a regular file; the file `skillContent` names is read only when it lies inside `capDir`
   * ({@link resolveSkillContentPath}). On Linux each file opened must also lie below the capability's folder; when
   * that check cannot run, the files are read without it and one warning line says so.
   *
   * @param yamlPath - The manifest's path.
   * @param capDir - The capability's folder, which holds its files. Its files are read below its parent folder, so
   *   it may not be a link, as {@link scanWithRefusals} reads no folder that is one.
   * @returns The capability, or null when no manifest is at `yamlPath` or it lacks `name`, `kind` or `description`.
   * @throws CapabilityManifestRefusedError when `skillContent` is refused, or when a symbolic link or something
   *   other than a regular file holds the place of the manifest, the skill's content or `schema.json`, or a link
   *   holds the place of a folder on the way to one of them, the capability's folder among them.
   */
  async parseManifest(
    yamlPath: string,
    capDir: string,
  ): Promise<CapabilityDescriptor | null> {
    const unchecked: UncheckedReads = new Map();
    try {
      return await this.readManifest(yamlPath, capDir, unchecked);
    } finally {
      warnUncheckedReads(unchecked);
    }
  }

  /**
   * What {@link parseManifest} does, counting in `unchecked` each file read without the full check of its path, so
   * that a scan writes one warning line for all of its capabilities.
   */
  private async readManifest(
    yamlPath: string,
    capDir: string,
    unchecked: UncheckedReads,
  ): Promise<CapabilityDescriptor | null> {
    const content = await readCapabilityFile(path.dirname(yamlPath), path.basename(yamlPath), 'manifest', unchecked);
    if (content === null) {
      console.warn(`[CapabilityManifestScanner] No manifest at ${yamlPath}`);
      return null;
    }
    const parsed = parseSimpleYaml(content) as Partial<CapabilityManifestFile>;

    // Validate required fields
    if (!parsed.name || !parsed.kind || !parsed.description) {
      console.warn(
        `[CapabilityManifestScanner] Missing required fields in ${yamlPath}`,
      );
      return null;
    }

    // The skill's content: the file skillContent names, which must lie inside the capability's folder, or
    // SKILL.md beside the manifest when the manifest does not set skillContent. A value that is set is held to the
    // rule even when it is empty, false or a number, so a malformed manifest is refused rather than read as unset.
    // YAML's null, written as no value, `null` or `~`, is read as the empty value.
    const skillContent: unknown = parsed.skillContent === null ? '' : parsed.skillContent;
    const skillFile = skillContent === undefined ? 'SKILL.md' : resolveSkillContentPath(capDir, skillContent);
    const fullContent = (await readCapabilityFile(capDir, skillFile, 'skillContent', unchecked)) ?? undefined;

    // Load optional schema.json
    let fullSchema: Record<string, unknown> | undefined;
    if (parsed.inputSchema) {
      fullSchema = parsed.inputSchema as Record<string, unknown>;
    } else {
      const schemaText = await readCapabilityFile(capDir, 'schema.json', 'schema', unchecked);
      if (schemaText !== null) {
        try {
          fullSchema = JSON.parse(schemaText);
        } catch {
          // Ignore invalid schema files
        }
      }
    }

    const kind = parsed.kind as CapabilityKind;
    const name = parsed.name as string;
    const id = (parsed.id as string) ?? `${kind}:${name}`;

    return {
      id,
      kind,
      name,
      displayName: (parsed.displayName as string) ?? name,
      description: parsed.description as string,
      category: (parsed.category as string) ?? 'custom',
      tags: (parsed.tags as string[]) ?? [],
      requiredSecrets: (parsed.requiredSecrets as string[]) ?? [],
      requiredTools: (parsed.requiredTools as string[]) ?? [],
      available: true,
      hasSideEffects: (parsed.hasSideEffects ?? undefined) as boolean | undefined,
      fullSchema,
      fullContent,
      sourceRef: {
        type: 'manifest',
        manifestPath: yamlPath,
        entryId: id,
      },
    };
  }

  /**
   * Watch directories for changes and call the callback when capabilities
   * are added, modified, or removed. The callback gets the capabilities
   * read and, second, the ones refused (as {@link scanWithRefusals} reports them).
   *
   * Uses debouncing to prevent rapid-fire events from fs.watch.
   */
  watch(
    dirs: string[],
    onChange: (descriptors: CapabilityDescriptor[], refused: RefusedCapabilityManifest[]) => void,
    debounceMs = 500,
  ): void {
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    const handleChange = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(async () => {
        try {
          const { descriptors, refused } = await this.scanWithRefusals(dirs);
          onChange(descriptors, refused);
        } catch (err) {
          console.warn(`[CapabilityManifestScanner] Watch error: ${err}`);
        }
      }, debounceMs);
    };

    for (const dir of dirs) {
      if (!fs.existsSync(dir)) continue;

      try {
        const watcher = fs.watch(dir, { recursive: true }, handleChange);
        this.watchers.push(watcher);
      } catch {
        // fs.watch may not support recursive on all platforms
      }
    }
  }

  /**
   * Stop watching all directories.
   */
  stopWatching(): void {
    for (const watcher of this.watchers) {
      watcher.close();
    }
    this.watchers = [];
  }
}
