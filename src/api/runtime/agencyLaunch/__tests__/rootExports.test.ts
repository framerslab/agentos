/**
 * The launch surface at the package root and the api barrel. `gmi({ agencies: { launch: true } })` and the runtime's
 * `agencies` option register `launch_agency`, and `sessionSeat()` seats a persistent gmi() agent in an agency as itself,
 * so a host names the tool, sets either `agencies` option, reads the tool's arguments and result, the limits of a launch
 * tree, the frame a seat's turns carry, the turn a tool call came from and a launched team's registry record, types a
 * tool hook and builds seats from the package's entry points. Neither barrel exports the launch registry, the engine or
 * the tool factory. The type checks run in `tsc --noEmit`.
 */
import { describe, expect, it } from 'vitest';
import * as root from '../../../../index.js';
import * as api from '../../../index.js';
import type {
  AgencyLaunchFrame,
  AgencyLaunchOptions,
  CallerTurnContext,
  LaunchAgencyArgs,
  LaunchAgencyResult,
  LaunchLimits,
  LaunchRecordMetadata,
  LaunchRefusal,
  LaunchRefusalCode,
  LaunchSeatRecord,
  LaunchSeatSpec,
  LaunchStatus,
  LaunchUsage,
  RuntimeAgencyLaunchOptions,
  SeatHandle,
  SeatMetadata,
  SessionSeatOptions,
  ToolCallHook,
} from '../../../../index.js';
import { sessionSeat } from '../sessionSeat.js';

describe('the launch surface', () => {
  it('exports the tool name and sessionSeat() from the package root and the api barrel', () => {
    for (const barrel of [root, api]) {
      expect(barrel.LAUNCH_AGENCY_TOOL_NAME).toBe('launch_agency');
      expect(barrel.sessionSeat).toBe(sessionSeat);
    }
  });

  it('keeps the launch registry, the engine and the tool factory internal', () => {
    for (const barrel of [root, api]) {
      for (const name of ['launchRegistry', 'runLaunch', 'createGmiLaunchTool', 'buildSessionSeat']) {
        expect(name in barrel).toBe(false);
      }
    }
  });

  it('exports the types of the agencies option, the tool and a seat', () => {
    const options: AgencyLaunchOptions = { launch: true, maxSeats: 3 };
    const seat: LaunchSeatSpec = { role: 'researcher', instructions: 'Find the three newest sources.' };
    const args: LaunchAgencyArgs = { goal: 'A one-page brief', seats: [seat] };
    const code: LaunchRefusalCode = 'too_many_seats';
    const refusal: LaunchRefusal = { code, reason: 'at most 3 seats' };
    const usage: LaunchUsage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
    const record: LaunchSeatRecord = { role: 'researcher', form: 'temporary', status: 'completed', calls: 1, summary: '', usage };
    const status: LaunchStatus = 'completed';
    const result: Pick<LaunchAgencyResult, 'status' | 'text' | 'seats'> = { status, text: '', seats: [record] };
    const seatOptions: SessionSeatOptions = {};
    const seatKeys: Array<keyof SeatMetadata & keyof SeatHandle> = [];

    expect([options, args, refusal, result, seatOptions, seatKeys]).toHaveLength(6);
  });

  it('exports the types of the runtime option, the limits, the frame, the caller turn, a tool hook and the registry record', () => {
    const runtimeOptions: RuntimeAgencyLaunchOptions = { launch: true };
    const limits: LaunchLimits = { maxDepth: 2, maxSeats: 5, maxConcurrent: 1, budgetShare: 0.5, maxLaunchTokens: 200_000, defaultDeadlineMs: 120_000, maxDeadlineMs: 600_000 };
    const frame: AgencyLaunchFrame = { launchId: 'launch-1', role: 'researcher', depth: 1 };
    const callerTurn: CallerTurnContext = { toolNames: new Set(['search']) };
    const hook: ToolCallHook = async (info) => info;
    const record: LaunchRecordMetadata = { kind: 'launched', parentGmiId: 'gmi-1', parentPersonaId: 'lead', launchingSessionId: 's-1', depth: 1, strategy: 'sequential', goalPreview: 'A one-page brief', startedAt: '2026-10-31T00:00:00.000Z', status: 'running' };
    // The same six from the api barrel: a namespace import names the module's types too.
    const fromApi: [api.RuntimeAgencyLaunchOptions, api.LaunchLimits, api.AgencyLaunchFrame, api.CallerTurnContext, api.ToolCallHook, api.LaunchRecordMetadata] = [runtimeOptions, limits, frame, callerTurn, hook, record];

    expect([runtimeOptions, limits, frame, callerTurn, hook, record, fromApi]).toHaveLength(7);
  });
});
