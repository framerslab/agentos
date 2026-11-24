import { randomUUID } from 'node:crypto';
import type {
  CognitiveMemoryConfig,
  CognitiveMemoryPersonaConfig,
  ObserverConfig,
  ReflectorConfig,
  TypedNetworkRuntimeConfig,
} from '../core/config.js';
import type { MemoryScope, MemorySourceType, MemoryTrustPolicy } from '../core/types.js';
import type { ITypedExtractionLLM } from '../retrieval/typed-network/index.js';

/** Message role supplied by the caller or determined by the serving runtime. */
export type ExtractionRole = 'user' | 'assistant' | 'system' | 'tool';

/** Extraction defaults that can be stored in a persona definition. */
export interface PersonaExtractionOptions {
  /** Auto can use an authorized model. Classical uses local extraction and reflection. */
  mode?: 'auto' | 'classical';
  /** Set to false to disable typed claims and bank writes while allowing observation notes. */
  typedNetwork?: boolean;
  /** Observation tuning or false to disable notes and their handoff to reflection. */
  observer?: boolean | Omit<Partial<ObserverConfig>, 'llmInvoker'>;
  /** Reflection tuning or false to disable automatic reflection and its pending queue. */
  reflector?: boolean | Omit<Partial<ReflectorConfig>, 'llmInvoker'>;
  /** Model calls allowed across extraction and reflection for one turn. Default 2. */
  maxCallsPerTurn?: number;
  /** Total model time allowed in milliseconds for one turn. Default 3,000. */
  timeoutMs?: number;
}

/** Runtime extraction options. Stage tuning takes precedence over legacy tuning for that stage. */
export interface ExtractionOptions extends PersonaExtractionOptions {
  /** Shared model callback for enabled stages without a stage-specific callback. */
  invoker?: ITypedExtractionLLM;
  /** Observation tuning and optional runtime callback, or false to disable observation. */
  observer?: boolean | Partial<ObserverConfig>;
  /** Reflection tuning and optional runtime callback, or false to disable automatic reflection. */
  reflector?: boolean | Partial<ReflectorConfig>;
}

/** True or an object selects conversational extraction. False is an enclosing opt-out. */
export type ExtractionSetting = boolean | ExtractionOptions;

/** Per-source extraction hints on a native memory call. */
export interface ExtractionCallOptions {
  /**
   * Affirm a conversation even when giving a trace type, or mark the input as a literal record.
   * An explicit record source or a preassigned trace ID takes precedence. Tags only describe the trace.
   */
  inputKind?: 'conversation' | 'record';
  /** Opaque source ID for paired calls. A dedicated instance assigns a fresh ID to a bare turn. */
  turnId?: string;
  /** Actual message role on a write call. The observe operation takes the role as its first argument. */
  role?: ExtractionRole;
  /** Subject attribution. Shared runtimes derive it from the guarded turn. */
  subjectId?: string;
  /** Skip conversational extraction for this source. The ordinary write receipt is preserved. */
  extraction?: false;
}

/** Source and filing options shared by native observation entry points. */
export interface ExtractionObservationOptions extends Omit<ExtractionCallOptions, 'role'> {
  /** Visibility of the source. An omitted scope uses the instance's filing context. */
  scope?: MemoryScope;
  /** Identifier of the filing scope. */
  scopeId?: string;
}

/** Original write options, before a wrapper fills in type or source defaults. */
export interface ExtractionIntent extends ExtractionCallOptions {
  /** A caller-supplied type identifies a record unless the caller affirms conversation. */
  type?: string;
  /** Explicit curated, imported, document and tool provenance always identifies a record. */
  sourceType?: MemorySourceType;
  /** A preassigned trace ID identifies a record such as a ledger write. */
  id?: string;
  /** A restored timestamp identifies a historical record. */
  createdAt?: number;
  /** Descriptive trace tags have no effect on eligibility. */
  tags?: readonly string[];
}

/** Host decisions established before a source reaches the extractor. */
export interface ExtractionHostPolicy {
  /** Off and raw both veto extraction. Compiled permits eligible local derivatives. */
  mode?: 'off' | 'raw' | 'compiled';
  /** False keeps eligible extraction local. */
  allowExternalProcessing?: boolean;
  /** A forgotten subject cannot produce derivatives. */
  forgotten?: boolean;
}

/** The settings available to the conversational extraction stages. */
export interface ResolvedExtractionPolicy {
  /** Legacy delegates to the existing memory behavior. Off skips conversational extraction. */
  path: 'legacy' | 'off' | 'classical' | 'auto';
  /** Typed-network settings or false when the stage is disabled. */
  typedNetwork: false | TypedNetworkRuntimeConfig;
  /** Whether remember and encode can extract typed claims. */
  extractAtEncode: boolean;
  /** Whether the extraction result can write typed-network banks. */
  bankWrites: boolean;
  /** Observer settings or false when observation is disabled. */
  observer: false | Partial<ObserverConfig>;
  /** Reflector settings or false when automatic reflection is disabled. */
  reflector: false | Partial<ReflectorConfig>;
  /** Whether accepted observation notes can enter the automatic reflection queue. */
  reflectionHandoff: boolean;
  /** Shared model callback, available only to an eligible automatic stage. */
  invoker?: ITypedExtractionLLM;
  /** Effective model call allowance for the turn. */
  maxCallsPerTurn: number;
  /** Effective model time allowance in milliseconds for the turn. */
  timeoutMs: number;
}

/** @internal Host-screened source with attribution and limits for any derivatives. */
export interface ScreenedTurn {
  readonly text: string;
  readonly ownerId: string;
  readonly subjectId: string;
  readonly scope: MemoryScope;
  readonly scopeId: string;
  readonly role: 'user' | 'assistant';
  readonly turnId: string;
  readonly revision: number;
  /** Source mention time in Unix milliseconds. */
  readonly mentionedAt: number;
  readonly policyCeiling: Readonly<{
    allowExternalProcessing: boolean;
    expiresAt?: number;
    trust: Readonly<MemoryTrustPolicy & {
      usableForAuthorization: false;
      usableForFactClaim: false;
    }>;
  }>;
}

type RuntimeConfig = Pick<CognitiveMemoryConfig, 'extraction' | 'observer' | 'reflector' | 'typedNetwork'>;
type PersonaConfig = Pick<CognitiveMemoryPersonaConfig, 'extraction' | 'observer' | 'reflector'>;

/** @internal Reuse a paired source ID or allocate one for a dedicated bare call. */
export function resolveExtractionTurnId(turnId?: string): string {
  return turnId || randomUUID();
}

function isConversation(call: ExtractionIntent): boolean {
  if (
    call.inputKind === 'record' ||
    call.id !== undefined ||
    call.createdAt !== undefined ||
    (call.role !== undefined && call.role !== 'user' && call.role !== 'assistant')
  ) {
    return false;
  }
  if (call.sourceType !== undefined && call.sourceType !== 'user_statement') {
    return call.sourceType === 'agent_inference' &&
      call.role === 'assistant' &&
      call.inputKind === 'conversation';
  }
  return call.inputKind === 'conversation' || call.type === undefined;
}

function stageOptions<T>(setting: boolean | T | undefined): T | undefined {
  return setting && typeof setting === 'object' ? setting : undefined;
}

function modelLimit(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

/**
 * Resolve conversational extraction for one source. Host and enclosing vetoes
 * take precedence. Supply the caller's options before filling in filing defaults.
 */
export function resolveExtractionPolicy(
  runtime: RuntimeConfig = {},
  persona: PersonaConfig = {},
  call: ExtractionIntent = {},
  host: ExtractionHostPolicy = {},
): ResolvedExtractionPolicy {
  const disabled: ResolvedExtractionPolicy = {
    path: 'off',
    typedNetwork: false,
    extractAtEncode: false,
    bankWrites: false,
    observer: false,
    reflector: false,
    reflectionHandoff: false,
    maxCallsPerTurn: 0,
    timeoutMs: 0,
  };
  if (
    host.mode === 'off' ||
    host.mode === 'raw' ||
    host.forgotten ||
    runtime.extraction === false ||
    persona.extraction === false ||
    call.extraction === false
  ) {
    return disabled;
  }

  if (runtime.extraction === undefined && persona.extraction === undefined) {
    // A local-only host must also prevent a configured legacy model from receiving this source.
    return host.allowExternalProcessing === false ? disabled : { ...disabled, path: 'legacy' };
  }
  if (!isConversation(call)) return disabled;

  const runtimeOptions = stageOptions(runtime.extraction);
  const personaOptions = stageOptions(persona.extraction);
  const maxCallsPerTurn = modelLimit(runtimeOptions?.maxCallsPerTurn ?? personaOptions?.maxCallsPerTurn, 2);
  const timeoutMs = modelLimit(runtimeOptions?.timeoutMs ?? personaOptions?.timeoutMs, 3000);
  const allowModel = (runtimeOptions?.mode ?? personaOptions?.mode) !== 'classical' &&
    host.allowExternalProcessing !== false &&
    call.role !== 'assistant' &&
    maxCallsPerTurn > 0 &&
    timeoutMs > 0;

  const runtimeObserver = stageOptions(runtimeOptions?.observer);
  const personaObserver = stageOptions(personaOptions?.observer);
  const observer = (runtimeOptions?.observer ?? personaOptions?.observer) === false
    ? false
    : {
        activationThresholdMessages: runtimeObserver?.activationThresholdMessages ??
          personaObserver?.activationThresholdMessages ?? runtime.observer?.activationThresholdMessages ??
          persona.observer?.activationThresholdMessages ?? 1,
        activationThresholdTokens: runtimeObserver?.activationThresholdTokens ??
          personaObserver?.activationThresholdTokens ?? runtime.observer?.activationThresholdTokens ??
          persona.observer?.activationThresholdTokens ?? 512,
        modelId: runtimeObserver?.modelId ?? personaObserver?.modelId ??
          runtime.observer?.modelId ?? persona.observer?.modelId,
        llmInvoker: allowModel ? runtimeObserver?.llmInvoker ?? runtime.observer?.llmInvoker : undefined,
      };

  const runtimeReflector = stageOptions(runtimeOptions?.reflector);
  const personaReflector = stageOptions(personaOptions?.reflector);
  const reflector = (runtimeOptions?.reflector ?? personaOptions?.reflector) === false
    ? false
    : {
        activationThresholdNotes: runtimeReflector?.activationThresholdNotes ??
          personaReflector?.activationThresholdNotes ?? runtime.reflector?.activationThresholdNotes ??
          persona.reflector?.activationThresholdNotes ?? 4,
        activationThresholdTokens: runtimeReflector?.activationThresholdTokens ??
          personaReflector?.activationThresholdTokens ?? runtime.reflector?.activationThresholdTokens ??
          persona.reflector?.activationThresholdTokens ?? 1024,
        modelId: runtimeReflector?.modelId ?? personaReflector?.modelId ??
          runtime.reflector?.modelId ?? persona.reflector?.modelId,
        llmInvoker: allowModel ? runtimeReflector?.llmInvoker ?? runtime.reflector?.llmInvoker : undefined,
      };

  const typedNetwork: ResolvedExtractionPolicy['typedNetwork'] = (runtimeOptions?.typedNetwork ?? personaOptions?.typedNetwork) === false
    ? false
    : {
        ...runtime.typedNetwork,
        variant: runtime.typedNetwork?.variant ?? 'minimal',
        observerLLM: allowModel ? runtime.typedNetwork?.observerLLM : undefined,
      };

  return {
    path: allowModel ? 'auto' : 'classical',
    typedNetwork,
    extractAtEncode: typedNetwork !== false && typedNetwork.extractAtEncode !== false,
    bankWrites: typedNetwork !== false,
    observer,
    reflector,
    reflectionHandoff: observer !== false && reflector !== false,
    invoker: allowModel && (observer || typedNetwork) ? runtimeOptions?.invoker : undefined,
    maxCallsPerTurn: allowModel ? maxCallsPerTurn : 0,
    timeoutMs: allowModel ? timeoutMs : 0,
  };
}
