/**
 * @fileoverview Option types and the policy resolver for the conversational
 * extraction pipeline.
 *
 * Reserved: these settings have no effect in this release. `Memory`,
 * `AgentMemory`, `CognitiveMemoryManager` and the agent memory builder accept
 * them and ignore them, so memory behaves exactly as it does when they are
 * omitted. `resolveExtractionPolicy` is a pure function that computes the
 * policy the pipeline will apply. It calls no model, and no memory entry
 * point calls it.
 *
 * @module agentos/memory/extraction/policy
 */

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

/**
 * Extraction settings a persona definition can hold, as {@link resolveExtractionPolicy} reads them.
 *
 * Reserved for the conversational extraction pipeline. It has no effect in this release.
 *
 * @internal
 */
export interface PersonaExtractionOptions {
  /**
   * Resolver input: `'classical'` resolves to a policy that carries no model callback,
   * `'auto'` to one that can carry one.
   *
   * Reserved for the conversational extraction pipeline. It has no effect in this release.
   *
   * @internal
   */
  mode?: 'auto' | 'classical';
  /**
   * Resolver input: `false` resolves the typed-network stage, its encode trigger and its bank writes to off.
   *
   * Reserved for the conversational extraction pipeline. It has no effect in this release.
   *
   * @internal
   */
  typedNetwork?: boolean;
  /**
   * Resolver input: observation thresholds and model ID, or `false`, which resolves the
   * observation stage and its handoff to reflection to off.
   *
   * Reserved for the conversational extraction pipeline. It has no effect in this release.
   *
   * @internal
   */
  observer?: boolean | Omit<Partial<ObserverConfig>, 'llmInvoker'>;
  /**
   * Resolver input: reflection thresholds and model ID, or `false`, which resolves the
   * reflection stage to off.
   *
   * Reserved for the conversational extraction pipeline. It has no effect in this release.
   *
   * @internal
   */
  reflector?: boolean | Omit<Partial<ReflectorConfig>, 'llmInvoker'>;
  /**
   * Resolver input: model calls allowed for one turn. A non-negative integer; any other
   * value is ignored. The resolved default is 2.
   *
   * Reserved for the conversational extraction pipeline. It has no effect in this release.
   *
   * @internal
   */
  maxCallsPerTurn?: number;
  /**
   * Resolver input: total model time for one turn in milliseconds. A non-negative integer;
   * any other value is ignored. The resolved default is 3,000.
   *
   * Reserved for the conversational extraction pipeline. It has no effect in this release.
   *
   * @internal
   */
  timeoutMs?: number;
}

/**
 * Runtime extraction settings, as {@link resolveExtractionPolicy} reads them. A stage's
 * tuning here takes precedence over the same stage's tuning elsewhere in the configuration.
 *
 * Reserved for the conversational extraction pipeline. It has no effect in this release.
 *
 * @internal
 */
export interface ExtractionOptions extends PersonaExtractionOptions {
  /**
   * Resolver input: a model callback the resolved policy carries when a stage is enabled
   * and a model is allowed.
   *
   * Reserved for the conversational extraction pipeline. It has no effect in this release:
   * nothing calls it.
   *
   * @internal
   */
  invoker?: ITypedExtractionLLM;
  /**
   * Resolver input: observation tuning with an optional callback, or `false`.
   *
   * Reserved for the conversational extraction pipeline. It has no effect in this release.
   *
   * @internal
   */
  observer?: boolean | Partial<ObserverConfig>;
  /**
   * Resolver input: reflection tuning with an optional callback, or `false`.
   *
   * Reserved for the conversational extraction pipeline. It has no effect in this release.
   *
   * @internal
   */
  reflector?: boolean | Partial<ReflectorConfig>;
}

/**
 * Value of the `extraction` setting on the memory configuration types.
 * {@link resolveExtractionPolicy} maps `false` to the `off` path and `true` or an object
 * to the `auto` or `classical` path.
 *
 * Reserved for the conversational extraction pipeline. It has no effect in this release:
 * memory behaves the same whatever value it holds.
 *
 * @internal
 */
export type ExtractionSetting = boolean | ExtractionOptions;

/**
 * Per-source fields on a native memory call, as {@link resolveExtractionPolicy} reads them.
 *
 * Reserved for the conversational extraction pipeline. They have no effect in this release:
 * the memory entry points accept them and ignore them.
 *
 * @internal
 */
export interface ExtractionCallOptions {
  /**
   * Resolver input: `'conversation'` affirms a conversational source even when the call
   * gives a trace type, and `'record'` marks a literal record. A record source type or a
   * preassigned trace ID resolves as a record either way.
   *
   * Reserved for the conversational extraction pipeline. It has no effect in this release.
   *
   * @internal
   */
  inputKind?: 'conversation' | 'record';
  /**
   * Opaque source ID shared by the calls that file one turn.
   *
   * Reserved for the conversational extraction pipeline. It has no effect in this release.
   *
   * @internal
   */
  turnId?: string;
  /**
   * Resolver input: the message's role on a write call. The observe operation takes the
   * role as its first argument.
   *
   * Reserved for the conversational extraction pipeline. It has no effect in this release.
   *
   * @internal
   */
  role?: ExtractionRole;
  /**
   * The subject a source is attributed to.
   *
   * Reserved for the conversational extraction pipeline. It has no effect in this release.
   *
   * @internal
   */
  subjectId?: string;
  /**
   * Resolver input: `false` resolves this source to the `off` path.
   *
   * Reserved for the conversational extraction pipeline. It has no effect in this release:
   * a call that passes `false` is processed exactly as a call that omits it, model
   * callbacks included.
   *
   * @internal
   */
  extraction?: false;
}

/**
 * Source and filing fields on the native observation entry points.
 *
 * Reserved for the conversational extraction pipeline. They have no effect in this release:
 * the observation entry points accept them and ignore them.
 *
 * @internal
 */
export interface ExtractionObservationOptions extends Omit<ExtractionCallOptions, 'role'> {
  /**
   * Visibility of the observed source.
   *
   * Reserved for the conversational extraction pipeline. It has no effect in this release.
   *
   * @internal
   */
  scope?: MemoryScope;
  /**
   * Identifier of the observed source's filing scope.
   *
   * Reserved for the conversational extraction pipeline. It has no effect in this release.
   *
   * @internal
   */
  scopeId?: string;
}

/**
 * A caller's original write options, as {@link resolveExtractionPolicy} classifies them.
 *
 * Reserved for the conversational extraction pipeline. It has no effect in this release.
 *
 * @internal
 */
export interface ExtractionIntent extends ExtractionCallOptions {
  /** A caller-supplied type resolves as a record unless `inputKind` is `'conversation'`. */
  type?: string;
  /** Curated, imported, document and tool provenance resolves as a record. */
  sourceType?: MemorySourceType;
  /** A preassigned trace ID resolves as a record, such as a ledger write. */
  id?: string;
  /** A restored timestamp resolves as a historical record. */
  createdAt?: number;
  /** Descriptive trace tags. The resolver does not read them. */
  tags?: readonly string[];
}

/**
 * A host's decisions about one source, as {@link resolveExtractionPolicy} reads them.
 *
 * Reserved for the conversational extraction pipeline. It has no effect in this release.
 *
 * @internal
 */
export interface ExtractionHostPolicy {
  /** `'off'` and `'raw'` resolve to the `off` path. `'compiled'` leaves the other settings to decide. */
  mode?: 'off' | 'raw' | 'compiled';
  /** `false` resolves to a policy that carries no model callback. */
  allowExternalProcessing?: boolean;
  /** `true` resolves to the `off` path. */
  forgotten?: boolean;
}

/**
 * Typed-network settings as {@link resolveExtractionPolicy} reads and returns them. The
 * model callback is optional here: the resolver accepts a typed network that names none
 * and returns one without it when the policy allows no model. The memory configuration's
 * own `typedNetwork` field keeps the callback required.
 *
 * Reserved for the conversational extraction pipeline. It has no effect in this release.
 *
 * @internal
 */
export type PolicyTypedNetworkConfig = Omit<TypedNetworkRuntimeConfig, 'observerLLM'> & {
  observerLLM?: ITypedExtractionLLM;
};

/**
 * The value {@link resolveExtractionPolicy} returns: a path, stage settings and limits.
 *
 * Reserved for the conversational extraction pipeline. It has no effect in this release:
 * no memory entry point reads a resolved policy.
 *
 * @internal
 */
export interface ResolvedExtractionPolicy {
  /**
   * `legacy` is the result when no level sets `extraction`. `off` is the result when a
   * level or the host turns extraction off, or the source is a record. `classical` carries
   * no model callback and `auto` can carry one.
   */
  path: 'legacy' | 'off' | 'classical' | 'auto';
  /** Typed-network settings, or `false` when the stage resolves to off. */
  typedNetwork: false | PolicyTypedNetworkConfig;
  /** Whether the typed-network stage's encode trigger resolves to on. */
  extractAtEncode: boolean;
  /** Whether typed-network bank writes resolve to on. */
  bankWrites: boolean;
  /** Observer settings, or `false` when observation resolves to off. */
  observer: false | Partial<ObserverConfig>;
  /** Reflector settings, or `false` when reflection resolves to off. */
  reflector: false | Partial<ReflectorConfig>;
  /** Whether observation notes can enter the reflection queue under this policy. */
  reflectionHandoff: boolean;
  /** Shared model callback, present only on the `auto` path with a stage enabled. */
  invoker?: ITypedExtractionLLM;
  /** Model calls allowed for the turn. 0 off the `auto` path. */
  maxCallsPerTurn: number;
  /** Model time allowed for the turn in milliseconds. 0 off the `auto` path. */
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

type RuntimeConfig = Pick<CognitiveMemoryConfig, 'extraction' | 'observer' | 'reflector'> & {
  typedNetwork?: PolicyTypedNetworkConfig;
};
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

/** A limit counts only as a non-negative safe integer. Any other value is treated as unset. */
function validLimit(value: number | undefined): number | undefined {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/**
 * Compute the extraction policy for one source from the runtime settings, the persona
 * settings, the caller's original write options and the host's decisions.
 *
 * A host mode of `off` or `raw`, a forgotten subject, or `false` at the runtime, persona
 * or call level returns the `off` policy. With `extraction` set at no level the result
 * is the `legacy` path, or `off` when the host allows no external processing. Otherwise
 * a record source returns `off`, and a conversational source returns `auto` or
 * `classical` with the runtime's stage settings ahead of the persona's. A limit
 * (`maxCallsPerTurn`, `timeoutMs`) is validated at each level before the levels are
 * compared, and a limit of zero resolves to `classical`. Pass the caller's options as
 * given, before a wrapper fills in a type or a source type.
 *
 * Reserved for the conversational extraction pipeline. It has no effect in this release:
 * it is a pure function, it calls no model, and no memory entry point calls it.
 *
 * @internal
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
    // A local-only host resolves to off here: the legacy path carries no local-only variant.
    return host.allowExternalProcessing === false ? disabled : { ...disabled, path: 'legacy' };
  }
  if (!isConversation(call)) return disabled;

  const runtimeOptions = stageOptions(runtime.extraction);
  const personaOptions = stageOptions(persona.extraction);
  // Each level is validated before the levels are compared, so an invalid runtime limit
  // cannot displace a valid persona limit (a persona's zero would otherwise become the default).
  const maxCallsPerTurn = validLimit(runtimeOptions?.maxCallsPerTurn) ??
    validLimit(personaOptions?.maxCallsPerTurn) ?? 2;
  const timeoutMs = validLimit(runtimeOptions?.timeoutMs) ??
    validLimit(personaOptions?.timeoutMs) ?? 3000;
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
