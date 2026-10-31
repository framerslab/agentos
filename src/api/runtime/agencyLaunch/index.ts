/**
 * @file index.ts
 * The public surface of teams of GMIs (docs/AGENCIES.md), all of which the package root and `./api` export:
 * `sessionSeat()`, which seats a persistent gmi() agent in an agency as itself, the `launch_agency` tool's name, and
 * the types of the `agencies` options, a launch tree's limits, the tool's arguments and result, a seat, the frame a
 * seat's turns carry, the turn a tool call came from, a tool hook and a launched team's registry record. Neither the
 * root nor `./api` exports the launch registry, the engine or the two tool factories.
 */
export { sessionSeat, type SessionSeatOptions, type SeatHandle } from './sessionSeat.js';
export {
  LAUNCH_AGENCY_TOOL_NAME,
  type AgencyLaunchOptions,
  type RuntimeAgencyLaunchOptions,
  type LaunchLimits,
  type AgencyLaunchFrame,
  type CallerTurnContext,
  type ToolCallHook,
  type LaunchSeatSpec,
  type LaunchAgencyArgs,
  type LaunchStatus,
  type LaunchRefusalCode,
  type LaunchRefusal,
  type LaunchUsage,
  type LaunchSeatRecord,
  type LaunchAgencyResult,
  type LaunchRecordMetadata,
  type SeatMetadata,
} from './types.js';
