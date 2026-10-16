/**
 * @module learning/manifest
 *
 * The loop manifest: which loops a deployment runs, and for each one that is off, why. A host reads it through
 * `ILearningLayer.manifest()`; a measurement records it so that a result names the loops it measured.
 */
import { resolveTurnMode } from './config.js';
import {
  HOST_LOOP_NAMES,
  type HostLoopName,
  type LearningLoopName,
  type LearningProfile,
  type LoopManifest,
  type LoopName,
  type LoopState,
  type ResolvedLearning,
} from './types.js';

/** What a manifest is built from. */
export interface ManifestSource {
  surface: LoopManifest['surface'];
  profile: LearningProfile;
  resolved: ResolvedLearning;
  /** What the host's own configuration says about the loops it runs. */
  hostLoops?: Partial<Record<HostLoopName, LoopState>>;
  turns: LoopManifest['turns'];
}

/** A self-change kind this release does not run: asked for or not, it is off, and the detail says which. */
function unbuiltKind(asked: boolean, what: string): LoopState {
  return { live: false, detail: asked ? `asked for; this release ${what}` : 'switched off' };
}

/** The learning layer's own loops as this release runs them: it renders the personality section and nothing else. */
function learningLoops(resolved: ResolvedLearning): Record<LearningLoopName, LoopState> {
  return {
    personality_rendering: { live: true },
    outcomes: { live: false, detail: 'this release records no outcomes' },
    trait_changes: unbuiltKind(resolved.traits, 'changes no trait'),
    lessons: unbuiltKind(resolved.lessons, 'writes no lessons'),
    skills: unbuiltKind(resolved.skills, 'keeps no skill library'),
    ledger: { live: false, detail: 'this release keeps no ledger' },
  };
}

/** Builds the manifest. A host loop the host did not report is listed as off, with that as its detail. */
export function buildManifest(source: ManifestSource): LoopManifest {
  const loops = {} as Record<LoopName, LoopState>;
  for (const name of HOST_LOOP_NAMES) {
    loops[name] = source.hostLoops?.[name] ?? { live: false, detail: 'not reported by the host' };
  }
  Object.assign(loops, learningLoops(source.resolved));
  const { mode, setBy } = resolveTurnMode(source.resolved.mode);
  return {
    manifestVersion: 1,
    surface: source.surface,
    profile: source.profile,
    mode,
    modeSetBy: setBy,
    loops,
    guardrails: { complete: false, detail: 'this release holds no guardrail set, so no self-change kind runs' },
    turns: { prepared: source.turns.prepared, bound: source.turns.bound, none: { ...source.turns.none } },
  };
}
