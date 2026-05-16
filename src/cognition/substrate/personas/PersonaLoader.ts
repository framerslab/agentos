// File: backend/agentos/cognitive_substrate/personas/PersonaLoader.ts
/**
 * @fileoverview Implements a PersonaLoader that reads persona definitions
 * from JSON files within a specified directory. Each .json file in the directory
 * (and its subdirectories, optionally) is expected to contain a valid IPersonaDefinition.
 *
 * @module backend/agentos/cognitive_substrate/personas/PersonaLoader
 * @see ./IPersonaDefinition.ts
 * @see ./IPersonaLoader.ts
 */

import * as fsPromises from 'fs/promises'; // Use fs/promises for async operations
import * as fs from 'fs'; // For types like Dirent
import * as path from 'path';
import { uuidv4 } from '../../../core/utils/uuid';
import { IPersonaDefinition } from './IPersonaDefinition';
import { IPersonaLoader, PersonaLoaderConfig } from './IPersonaLoader';
import { GMIError, GMIErrorCode } from '../../../core/utils/errors.js';
import { mergeMetapromptPresets } from './metaprompt_presets.js';

/**
 * Configuration specific to the FileSystemPersonaLoader.
 * @interface FileSystemPersonaLoaderConfig
 * @extends {PersonaLoaderConfig}
 */
export interface FileSystemPersonaLoaderConfig extends PersonaLoaderConfig {
  /**
   * The file system path to the directory containing persona definition JSON files.
   * This overrides the generic `personaSource` from `PersonaLoaderConfig`.
   * @type {string}
   */
  personaDefinitionPath: string;

  /**
   * If true, recursively search for .json files in subdirectories.
   * @type {boolean}
   * @optional
   * @default false
   */
  recursiveSearch?: boolean;

  /**
   * File extension to look for (e.g., ".persona.json", ".json").
   * Must include the leading dot.
   * @type {string}
   * @optional
   * @default ".json"
   */
  fileExtension?: string;
}

/**
 * Implements IPersonaLoader to load persona definitions from the file system.
 * Assumes persona definitions are stored as individual JSON files.
 * @class PersonaLoader
 * @implements {IPersonaLoader}
 */
export class PersonaLoader implements IPersonaLoader {
  private config!: FileSystemPersonaLoaderConfig;
  private isInitialized: boolean = false;
  private loadedPersonas: Map<string, IPersonaDefinition> = new Map();
  public readonly loaderId: string;

  constructor() {
    this.loaderId = `persona-loader-fs-${uuidv4()}`;
  }

  private ensureInitialized(): void {
    if (!this.isInitialized) {
      throw new GMIError('PersonaLoader has not been initialized. Call initialize() first.', GMIErrorCode.NOT_INITIALIZED, { loaderId: this.loaderId });
    }
  }

  public async initialize(config: PersonaLoaderConfig): Promise<void> {
    if (this.isInitialized) {
        console.warn(`PersonaLoader (ID: ${this.loaderId}) already initialized. Re-initializing will refresh personas.`);
    }

    // Accept either `personaDefinitionPath` (specific FileSystemPersonaLoader
    // field) OR the generic `personaSource` from `PersonaLoaderConfig` so the
    // auto-generated config from `createAgentOSConfig()` can drive this loader
    // without callers having to know about the field-name asymmetry. Prefer
    // the specific field when both are set.
    const fsConfig = config as FileSystemPersonaLoaderConfig & { personaSource?: string };
    const resolvedPath = fsConfig?.personaDefinitionPath ?? fsConfig?.personaSource;
    if (!fsConfig || !resolvedPath) {
      throw new GMIError(
        'Invalid configuration for FileSystemPersonaLoader: personaDefinitionPath (or personaSource) is required.',
        GMIErrorCode.CONFIGURATION_ERROR, { providedConfig: config, loaderId: this.loaderId }
      );
    }
    this.config = {
      ...fsConfig,
      personaDefinitionPath: resolvedPath,
      loaderType: 'file_system',
      recursiveSearch: fsConfig.recursiveSearch ?? false,
      fileExtension: fsConfig.fileExtension && fsConfig.fileExtension.startsWith('.')
        ? fsConfig.fileExtension.toLowerCase()
        : (fsConfig.fileExtension ? `.${fsConfig.fileExtension.toLowerCase()}` : '.json'),
    };

    try {
      const stats = await fsPromises.stat(this.config.personaDefinitionPath);
      if (!stats.isDirectory()) {
        throw new GMIError(`Persona definition path '${this.config.personaDefinitionPath}' is not a directory.`, GMIErrorCode.CONFIGURATION_ERROR, { path: this.config.personaDefinitionPath });
      }
    } catch (error: any) {
      // ENOENT is downgraded to a warning so the zero-config `AgentOS.create()`
      // path doesn't crash when the consumer hasn't created a personas
      // directory yet. The loader will simply find zero personas at refresh
      // time and the runtime falls back to built-in personas / persona-less
      // operation. Other I/O errors (permission, malformed path) still throw.
      if (error?.code === 'ENOENT') {
        console.warn(
          `PersonaLoader (ID: ${this.loaderId}): persona directory '${this.config.personaDefinitionPath}' not found. Skipping file-system persona discovery; built-in personas remain available.`,
        );
        this.isInitialized = true;
        return;
      }
      throw new GMIError(
        `Persona definition path '${this.config.personaDefinitionPath}' is not accessible: ${error.message}`,
        GMIErrorCode.CONFIGURATION_ERROR,
        { path: this.config.personaDefinitionPath, underlyingError: error }
      );
    }

    this.isInitialized = true;
    console.log(`PersonaLoader (ID: ${this.loaderId}) initialized. Source directory: '${this.config.personaDefinitionPath}'.`);
    await this.refreshPersonas();
  }

  private async findPersonaFiles(dirPath: string, extension: string): Promise<string[]> {
    let dirents: fs.Dirent[];
    try {
        dirents = await fsPromises.readdir(dirPath, { withFileTypes: true });
    } catch (error: any) {
        console.error(`PersonaLoader (ID: ${this.loaderId}): Error reading directory ${dirPath}: ${error.message}`);
        return [];
    }

    const files: string[][] = await Promise.all(
      dirents.map(async (dirent: fs.Dirent) => { // Specify fs.Dirent type
        const res = path.resolve(dirPath, dirent.name);
        if (dirent.isDirectory() && this.config.recursiveSearch) {
          return this.findPersonaFiles(res, extension);
        } else if (dirent.isFile() && path.extname(dirent.name).toLowerCase() === extension) {
          return [res];
        }
        return [];
      })
    );
    return files.flat();
  }

  public async loadPersonaById(personaId: string): Promise<IPersonaDefinition | undefined> {
    this.ensureInitialized();
    const persona = this.loadedPersonas.get(personaId);
    if (!persona) {
      console.warn(`PersonaLoader (ID: ${this.loaderId}): Persona with ID '${personaId}' not found in cache.`);
      return undefined;
    }
    return JSON.parse(JSON.stringify(persona));
  }

  public async loadAllPersonaDefinitions(): Promise<IPersonaDefinition[]> {
    this.ensureInitialized();
    return Array.from(this.loadedPersonas.values()).map(p => JSON.parse(JSON.stringify(p)));
  }

  public async refreshPersonas(): Promise<void> {
    this.ensureInitialized();
    const oldSize = this.loadedPersonas.size;
    this.loadedPersonas.clear();
    console.log(`PersonaLoader (ID: ${this.loaderId}): Refreshing personas from '${this.config.personaDefinitionPath}'...`);

    let personaFilePaths: string[];
    try {
      personaFilePaths = await this.findPersonaFiles(this.config.personaDefinitionPath, this.config.fileExtension!);
    } catch (error: any) {
      console.error(`PersonaLoader (ID: ${this.loaderId}): Error scanning persona directory '${this.config.personaDefinitionPath}': ${error.message}`);
      throw new GMIError(`Failed to scan persona directory: ${error.message}`, GMIErrorCode.PERSONA_LOAD_ERROR, { path: this.config.personaDefinitionPath, underlyingError: error }); // Corrected: Use PERSONA_LOAD_ERROR
    }

    if (personaFilePaths.length === 0) {
      console.warn(`PersonaLoader (ID: ${this.loaderId}): No persona files found in '${this.config.personaDefinitionPath}' with extension '${this.config.fileExtension}'. Previous cache size: ${oldSize}.`);
      return;
    }

    for (const filePath of personaFilePaths) {
      try {
        const fileContent = await fsPromises.readFile(filePath, 'utf-8');
        const personaDefinition = JSON.parse(fileContent) as IPersonaDefinition;

        if (!personaDefinition.id || !personaDefinition.name || !personaDefinition.baseSystemPrompt || !personaDefinition.version) {
          console.warn(`PersonaLoader (ID: ${this.loaderId}): Skipping file '${filePath}' due to missing required fields (id, name, version, baseSystemPrompt).`);
          continue;
        }

        // Only merge sentiment-aware preset metaprompts when explicitly enabled
        const sentimentConfig = personaDefinition.sentimentTracking;
        if (sentimentConfig?.enabled && sentimentConfig.presets && sentimentConfig.presets.length > 0) {
          // Map short preset names to full metaprompt IDs
          const presetNameToId: Record<string, string> = {
            'frustration_recovery': 'gmi_frustration_recovery',
            'confusion_clarification': 'gmi_confusion_clarification',
            'satisfaction_reinforcement': 'gmi_satisfaction_reinforcement',
            'error_recovery': 'gmi_error_recovery',
            'engagement_boost': 'gmi_engagement_boost',
          };

          const requestedIds = sentimentConfig.presets.includes('all')
            ? undefined // undefined = include all presets
            : sentimentConfig.presets
                .filter((p): p is Exclude<typeof p, 'all'> => p !== 'all')
                .map((p) => presetNameToId[p])
                .filter(Boolean);

          personaDefinition.metaPrompts = mergeMetapromptPresets(
            personaDefinition.metaPrompts,
            requestedIds
          );
          console.log(`PersonaLoader (ID: ${this.loaderId}): Merged ${personaDefinition.metaPrompts.length} metaprompts (${requestedIds ? requestedIds.length + ' presets' : 'all presets'} + custom) for persona '${personaDefinition.id}'.`);
        }

        if (this.loadedPersonas.has(personaDefinition.id)) {
          console.warn(`PersonaLoader (ID: ${this.loaderId}): Duplicate persona ID '${personaDefinition.id}' found in file '${filePath}'. Overwriting previous definition. Ensure persona IDs are unique.`);
        }
        this.loadedPersonas.set(personaDefinition.id, personaDefinition);
      } catch (error: any) {
        console.error(`PersonaLoader (ID: ${this.loaderId}): Error loading or parsing persona from file '${filePath}': ${error.message}`, error);
      }
    }
    console.log(`PersonaLoader (ID: ${this.loaderId}): Successfully loaded/refreshed ${this.loadedPersonas.size} persona definitions.`);
  }

  public async shutdown(): Promise<void> {
      this.isInitialized = false;
      this.loadedPersonas.clear();
      console.log(`PersonaLoader (ID: ${this.loaderId}) shut down.`);
  }
}
