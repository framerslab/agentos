/**
 * @fileoverview The date tool a host can offer its model: `getCurrentDateTime`, which answers the current date and
 * time, in an IANA timezone when the call names one. The full runtime registers it only when the host lists it in
 * `tools`; a `ToolExecutor` built directly registers it unless its options set `builtInTools: false`.
 *
 * @module agentos/core/tools/builtins/currentDateTime
 */

import type { ITool, JSONSchemaObject, ToolExecutionContext, ToolExecutionResult } from '../ITool.js';

/**
 * Builds the optional runtime date tool; hosts register it through their tools list.
 *
 * @returns A new `getCurrentDateTime` tool (id `system-current-time-tool-v1.1`).
 *
 * @example
 * ```ts
 * import { AgentOS, createCurrentDateTimeTool } from '@framers/agentos';
 *
 * const runtime = await AgentOS.create({ tools: [createCurrentDateTimeTool()] });
 * ```
 */
export function createCurrentDateTimeTool(): ITool<
  { timezone?: string }, { currentTime: string; timezoneUsed: string; isoTimestamp: string }
> {
  return {
    id: 'system-current-time-tool-v1.1',
    name: 'getCurrentDateTime',
    displayName: 'Current Date & Time Service',
    description: "Gets the current date and time, optionally for a specific IANA timezone (e.g., 'America/New_York', 'Europe/London'). Defaults to the server's local timezone if no timezone is provided or if the provided one is invalid.",
    inputSchema: {
      type: 'object',
      properties: { timezone: { type: 'string', description: "Optional: IANA timezone string (e.g., 'America/Los_Angeles', 'Europe/London'). Examples: 'UTC', 'America/New_York', 'Asia/Tokyo'.", format: 'time-zone' } },
      additionalProperties: false,
    } as JSONSchemaObject,
    outputSchema: {
      type: 'object',
      properties: {
        currentTime: { type: 'string', description: "The current date and time formatted as a locale string (e.g., '5/24/2025, 11:43:58 AM')." },
        timezoneUsed: { type: 'string', description: 'The IANA timezone that was used for the calculation.' },
        isoTimestamp: { type: 'string', format: 'date-time', description: 'The current date and time in ISO 8601 format (UTC).' },
      },
      required: ['currentTime', 'timezoneUsed', 'isoTimestamp'],
    } as JSONSchemaObject,
    category: 'System Utilities', version: '1.1.0', hasSideEffects: false,
    execute: async (args: { timezone?: string }, context: ToolExecutionContext): Promise<ToolExecutionResult<{
      currentTime: string; timezoneUsed: string; isoTimestamp: string;
    }>> => {
      try {
        let effectiveTimezone = args.timezone;
        const serverDefaultTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
        if (effectiveTimezone) {
          try { new Date().toLocaleString('en-US', { timeZone: effectiveTimezone }); }
          catch (tzError: any) {
            console.warn(`ToolExecutor[getCurrentDateTime]: Invalid timezone '${args.timezone}' provided by GMI ${context.gmiId}. Falling back to ${serverDefaultTimezone}. Error: ${tzError.message}`);
            effectiveTimezone = serverDefaultTimezone;
          }
        } else { effectiveTimezone = serverDefaultTimezone; }
        const currentDate = new Date();
        return {
          success: true,
          output: {
            currentTime: currentDate.toLocaleString('en-US', { timeZone: effectiveTimezone, hour12: true, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }),
            timezoneUsed: effectiveTimezone,
            isoTimestamp: currentDate.toISOString(),
          },
          contentType: 'application/json',
        };
      } catch (e: any) {
        return { success: false, error: `Error getting current time: ${e.message}`, details: { stack: e.stack } };
      }
    },
  };
}
