/**
 * The launch surface at the package root and the api barrel. `gmi({ agencies: { launch: true } })` registers
 * `launch_agency`, and `sessionSeat()` seats a persistent gmi() agent in an agency as itself, so a host names the tool,
 * sets the `agencies` option, reads the tool's arguments and result and builds seats from the package's entry points.
 * The launch registry, the engine and the tool factory stay internal. The type checks run in `tsc --noEmit`.
 */
import { describe, expect, it } from 'vitest';
import * as root from '../../../../index.js';
import * as api from '../../../index.js';
import type {
  AgencyLaunchOptions,
  LaunchAgencyArgs,
  LaunchAgencyResult,
  LaunchRefusal,
  LaunchRefusalCode,
  LaunchSeatRecord,
  LaunchSeatSpec,
  LaunchStatus,
  LaunchUsage,
  SeatHandle,
  SeatMetadata,
  SessionSeatOptions,
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
});
