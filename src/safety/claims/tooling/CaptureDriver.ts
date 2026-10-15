/**
 * @module safety/claims/tooling/CaptureDriver
 *
 * The protocol a capture driver implements: it says whether its implementation can be captured (a driver whose
 * service lacks the pictured view is not ready, and its claim keeps its previous verified capture), and it captures a
 * shot by operating the real interface, returning the file and its manifest. `runCaptures` refuses a driver that is
 * not ready and any output whose size, look, claims or bytes are not the shot's.
 */
import { sha256Hex } from '../digest.js';
import type { CaptureManifest, Look } from './CaptureEvidence.js';
import type { FixtureManifest } from './FixtureManifest.js';

/** One picture to take. */
export interface CaptureShot {
  name: string;
  claimIds: readonly string[];
  route: string;
  width: number;
  height: number;
  scale: number;
  look: Look;
  scenarioId: string;
  testId: string;
}

/** The run a capture belongs to. */
export interface CaptureRunIdentity {
  workflow: string;
  runId: string;
  attempt: number;
  sourceCommit: string;
}

/** What a driver is given. */
export interface CaptureContext {
  outputDir: string;
  run: CaptureRunIdentity;
  fixture: FixtureManifest;
}

/** What a driver returns for one shot. */
export interface CaptureOutput {
  file: string;
  manifest: CaptureManifest;
}

/** A capture driver. */
export interface CaptureDriver {
  id: string;
  /** The implementation the driver captures; `selectDriver` picks by it. */
  implementation: string;
  /** Whether the implementation can be captured now; a service without the pictured view answers no, with the reason. */
  ready(): Promise<{ ok: true } | { ok: false; reason: string }>;
  /** Takes one shot by operating the real interface, and returns the file it wrote and its manifest. */
  capture(shot: CaptureShot, context: CaptureContext): Promise<CaptureOutput>;
}

/**
 * The one driver for an implementation.
 *
 * @throws Error when none or more than one serves it.
 */
export function selectDriver(drivers: readonly CaptureDriver[], implementation: string): CaptureDriver {
  const found = drivers.filter((d) => d.implementation === implementation);
  if (found.length === 0) throw new Error(`selectDriver: no capture driver for ${implementation}`);
  if (found.length > 1) throw new Error(`selectDriver: ${found.length} capture drivers for ${implementation}`);
  return found[0] as CaptureDriver;
}

/**
 * Takes every shot with one driver and checks each output.
 *
 * @param driver - The driver.
 * @param shots - The shots.
 * @param context - The run and the fixture.
 * @param readBytes - Reads a file the driver wrote.
 * @returns Every output, and a problem for each output that is not its shot's; for a driver that is not ready, no
 *   output and that one problem.
 */
export async function runCaptures(driver: CaptureDriver, shots: readonly CaptureShot[], context: CaptureContext, readBytes: (file: string) => Promise<Uint8Array>): Promise<{ outputs: CaptureOutput[]; problems: string[] }> {
  const ready = await driver.ready();
  if (!ready.ok) return { outputs: [], problems: [`${driver.id} is not ready: ${ready.reason}`] };
  const outputs: CaptureOutput[] = [];
  const problems: string[] = [];
  for (const shot of shots) {
    const output = await driver.capture(shot, context);
    const m = output.manifest;
    if (m.width !== shot.width || m.height !== shot.height || m.scale !== shot.scale || m.look !== shot.look) problems.push(`${shot.name}: the capture is not the shot's size and look`);
    if (!shot.claimIds.every((id) => m.claimIds.includes(id))) problems.push(`${shot.name}: the capture does not name the shot's claims`);
    if (sha256Hex(await readBytes(output.file)) !== m.sha256) problems.push(`${shot.name}: the file is not the bytes its manifest names`);
    outputs.push(output);
  }
  return { outputs, problems };
}
