/**
 * @file AgencyRegistry.ts
 * @description Registry for tracking active Agency sessions in the AgentOS runtime.
 * @module AgentOS/Agency
 */

import { uuidv4 } from '../../core/utils/uuid.js';

import type { ILogger } from '../../core/logging/ILogger.js';
import type {
  AgencySeatHistoryEntry,
  AgencySeatRegistrationArgs,
  AgencySeatState,
  AgencySession,
  AgencyUpsertArgs,
} from './AgencyTypes';

/**
 * A copy of plain data: arrays and plain objects copied at every depth, any other value (a string, a `Date`, a class
 * instance, a function) kept as it is. Each object is copied once, so a record that refers to itself does not loop.
 */
function copyPlainData<T>(value: T, copies: Map<object, unknown> = new Map()): T {
  if (typeof value !== 'object' || value === null) return value;
  const known = copies.get(value);
  if (known !== undefined) return known as T;
  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    copies.set(value, copy);
    for (const item of value) copy.push(copyPlainData(item, copies));
    return copy as T;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  const copy: Record<string, unknown> = {};
  copies.set(value, copy);
  for (const [key, item] of Object.entries(value)) copy[key] = copyPlainData(item, copies);
  return copy as T;
}

/**
 * Tracks the Agencies (multi-GMI collectives) active inside the AgentOS runtime.
 *
 * @remarks
 * The registry is intentionally ephemeral; durable state should be captured via
 * workflow persistence. For shared memory, use {@link AgencyMemoryManager}.
 *
 * @example
 * ```typescript
 * const registry = new AgencyRegistry(logger);
 *
 * // Create agency with shared memory enabled
 * const session = registry.upsertAgency({
 *   workflowId: 'workflow-123',
 *   conversationId: 'conv-456',
 *   memoryConfig: { enabled: true },
 * });
 *
 * // Register GMI seats
 * registry.registerSeat({
 *   agencyId: session.agencyId,
 *   roleId: 'researcher',
 *   gmiInstanceId: 'gmi-789',
 *   personaId: 'research-persona',
 * });
 * ```
 */
export class AgencyRegistry {
  /** Active agency sessions keyed by agency ID */
  private readonly agencies = new Map<string, AgencySession>();

  /** Workflow to agency mapping for quick lookup */
  private readonly workflowToAgency = new Map<string, string>();

  /**
   * Creates a new AgencyRegistry instance.
   * @param logger - Optional logger for diagnostics
   */
  constructor(private readonly logger?: ILogger) {}

  /**
   * Creates or updates an agency session associated with a workflow.
   *
   * @param args - Upsert payload containing workflow linkage, memory config, and optional metadata.
   * @returns The upserted agency session.
   *
   * @example
   * ```typescript
   * const session = registry.upsertAgency({
   *   workflowId: 'workflow-123',
   *   conversationId: 'conv-456',
   *   memoryConfig: {
   *     enabled: true,
   *     autoIngestCommunications: true,
   *   },
   * });
   * ```
   */
  public upsertAgency(args: AgencyUpsertArgs): AgencySession {
    const existingId = args.agencyId ?? this.workflowToAgency.get(args.workflowId);
    const now = new Date().toISOString();

    if (existingId && this.agencies.has(existingId)) {
      const session = this.agencies.get(existingId)!;
      session.updatedAt = now;
      session.metadata = {
        ...session.metadata,
        ...args.metadata,
      };
      // Merge memory config if provided
      if (args.memoryConfig) {
        session.memoryConfig = {
          ...session.memoryConfig,
          ...args.memoryConfig,
        };
      }
      this.workflowToAgency.set(args.workflowId, session.agencyId);
      return session;
    }

    const agencyId = existingId ?? `agency-${uuidv4()}`;
    const session: AgencySession = {
      agencyId,
      workflowId: args.workflowId,
      conversationId: args.conversationId,
      createdAt: now,
      updatedAt: now,
      seats: {},
      metadata: args.metadata ?? {},
      memoryConfig: args.memoryConfig,
    };
    this.agencies.set(agencyId, session);
    this.workflowToAgency.set(args.workflowId, agencyId);
    this.logger?.info?.('Created Agency session', {
      agencyId,
      workflowId: args.workflowId,
      conversationId: args.conversationId,
      memoryEnabled: args.memoryConfig?.enabled ?? false,
    });
    return session;
  }

  /**
   * Retrieves an agency session by identifier.
   * @param agencyId - Target Agency identifier.
   * @returns The matching agency session or `undefined` when absent.
   */
  public getAgency(agencyId: string): AgencySession | undefined {
    return this.agencies.get(agencyId);
  }

  /**
   * Resolves the agency session associated with a workflow instance (if any).
   * @param workflowId - Workflow instance identifier.
   * @returns The agency session mapped to the workflow, if present.
   */
  public getAgencyByWorkflow(workflowId: string): AgencySession | undefined {
    const agencyId = this.workflowToAgency.get(workflowId);
    return agencyId ? this.agencies.get(agencyId) : undefined;
  }

  /**
   * Copies of the agency sessions running now, in the order they were created: workflow agencies, and the teams a GMI
   * launched on the full runtime (`launch_agency`), whose metadata has `kind: 'launched'`. Each copy's seats, their
   * histories, its metadata and its memory config are copied as far down as they hold arrays and plain objects, so a
   * caller cannot change the registry through them; a value of another kind in a metadata record (a `Date`, a class
   * instance) is the registry's own.
   *
   * @returns The running sessions.
   */
  public listAgencies(): AgencySession[] {
    return [...this.agencies.values()].map((session) => copyPlainData(session));
  }

  /**
   * Registers or updates a seat inside the agency.
   * @param args - Seat registration payload.
   * @returns Updated agency session after the seat registration.
   * @throws {Error} When attempting to register against an unknown agency.
   */
  public registerSeat(args: AgencySeatRegistrationArgs): AgencySession {
    const session = this.getAgency(args.agencyId);
    if (!session) {
      throw new Error(`AgencyRegistry.registerSeat called with unknown agencyId '${args.agencyId}'.`);
    }
    const now = new Date().toISOString();
    const existingSeat = session.seats[args.roleId];
    const seat: AgencySeatState = {
      roleId: args.roleId,
      gmiInstanceId: args.gmiInstanceId,
      personaId: args.personaId,
      metadata: args.metadata,
      attachedAt: now,
      history: existingSeat?.history ?? [],
    };
    session.seats[args.roleId] = seat;
    session.updatedAt = now;
    this.logger?.debug?.('Registered Agency seat', {
      agencyId: args.agencyId,
      roleId: args.roleId,
      gmiInstanceId: args.gmiInstanceId,
    });
    return session;
  }

  /**
   * Removes an agency entirely (e.g., when the workflow reaches a terminal state).
   * @param agencyId - Agency identifier to remove.
   * @returns `true` when the agency existed and was removed.
   */
  public removeAgency(agencyId: string): boolean {
    const session = this.agencies.get(agencyId);
    if (!session) {
      return false;
    }
    this.agencies.delete(agencyId);
    this.workflowToAgency.delete(session.workflowId);
    this.logger?.info?.('Removed Agency session', {
      agencyId,
      workflowId: session.workflowId,
    });
    return true;
  }

  /**
   * Appends a history entry to the specified seat and returns the updated state.
   */
  public appendSeatHistory(
    agencyId: string,
    roleId: string,
    entry: AgencySeatHistoryEntry,
    maxEntries = 20,
  ): AgencySeatState | undefined {
    return this.mutateSeat(agencyId, roleId, (seat) => {
      const history = seat.history ? [...seat.history, entry] : [entry];
      if (history.length > maxEntries) {
        history.splice(0, history.length - maxEntries);
      }
      return { ...seat, history };
    });
  }

  /**
   * Merges metadata onto a seat without altering other properties.
   */
  public mergeSeatMetadata(
    agencyId: string,
    roleId: string,
    metadata: Record<string, unknown>,
  ): AgencySeatState | undefined {
    return this.mutateSeat(agencyId, roleId, (seat) => ({
      ...seat,
      metadata: {
        ...(seat.metadata ?? {}),
        ...metadata,
      },
    }));
  }

  private mutateSeat(
    agencyId: string,
    roleId: string,
    updater: (seat: AgencySeatState) => AgencySeatState,
  ): AgencySeatState | undefined {
    const session = this.agencies.get(agencyId);
    if (!session) {
      return undefined;
    }
    const seat = session.seats[roleId];
    if (!seat) {
      return undefined;
    }
    const updated = updater(seat);
    session.seats[roleId] = updated;
    session.updatedAt = new Date().toISOString();
    return updated;
  }
}
