/**
 * @file CostGuard.ts
 * @description In-process spending caps per agent session/day.
 * Complements the backend CostService (which handles billing persistence)
 * by enforcing hard limits that halt execution immediately.
 */

export type CostCapType = 'session' | 'daily' | 'single_operation';

export interface CostGuardConfig {
  /** Maximum USD spend per agent session. @default 1.00 */
  maxSessionCostUsd: number;
  /** Maximum USD spend per agent per day. @default 5.00 */
  maxDailyCostUsd: number;
  /** Maximum USD spend per single operation. @default 0.50 */
  maxSingleOperationCostUsd: number;
  /** Callback when a cap is hit. */
  onCapReached?: (agentId: string, capType: CostCapType, currentCost: number, limit: number) => void;
}

export interface CostRecord {
  agentId: string;
  operationId: string;
  costUsd: number;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

export interface CostSnapshot {
  agentId: string;
  sessionCostUsd: number;
  dailyCostUsd: number;
  sessionLimit: number;
  dailyLimit: number;
  isSessionCapReached: boolean;
  isDailyCapReached: boolean;
}

export class CostCapExceededError extends Error {
  constructor(
    public readonly agentId: string,
    public readonly capType: CostCapType,
    public readonly currentCost: number,
    public readonly limit: number,
  ) {
    super(`Cost cap '${capType}' exceeded for agent '${agentId}': $${currentCost.toFixed(4)} >= $${limit.toFixed(2)}`);
    this.name = 'CostCapExceededError';
  }
}

interface AgentCosts {
  sessionCost: number;
  dailyCost: number;
  dailyResetAt: number;
  records: CostRecord[];
}

const DEFAULT_CONFIG: CostGuardConfig = {
  maxSessionCostUsd: 1.0,
  maxDailyCostUsd: 5.0,
  maxSingleOperationCostUsd: 0.50,
};

export class CostGuard {
  private agents: Map<string, AgentCosts> = new Map();
  private config: CostGuardConfig;
  private agentLimits: Map<string, Partial<Pick<CostGuardConfig, 'maxSessionCostUsd' | 'maxDailyCostUsd'>>> = new Map();

  constructor(config?: Partial<CostGuardConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Whether an operation estimated at `estimatedCostUsd` fits the caps that apply to `agentId`. A refusal names the cap
   * that refused it in `capType`, says why in `reason`, and carries that cap's numbers: `currentCostUsd`, the id's total
   * under the cap before the operation (for the single-operation cap, the estimate itself), and `limitUsd`, the cap.
   */
  canAfford(
    agentId: string,
    estimatedCostUsd: number,
  ): { allowed: boolean; reason?: string; capType?: CostCapType; currentCostUsd?: number; limitUsd?: number } {
    if (estimatedCostUsd > this.config.maxSingleOperationCostUsd) {
      return {
        allowed: false,
        reason: `Single operation cost $${estimatedCostUsd.toFixed(4)} exceeds limit $${this.config.maxSingleOperationCostUsd.toFixed(2)}`,
        capType: 'single_operation',
        currentCostUsd: estimatedCostUsd,
        limitUsd: this.config.maxSingleOperationCostUsd,
      };
    }

    const costs = this.getOrCreate(agentId);
    this.maybeResetDaily(costs);

    const limits = this.agentLimits.get(agentId);
    const sessionLimit = limits?.maxSessionCostUsd ?? this.config.maxSessionCostUsd;
    const dailyLimit = limits?.maxDailyCostUsd ?? this.config.maxDailyCostUsd;

    if (costs.sessionCost + estimatedCostUsd > sessionLimit) {
      return {
        allowed: false,
        reason: `Session cost $${(costs.sessionCost + estimatedCostUsd).toFixed(4)} would exceed limit $${sessionLimit.toFixed(2)}`,
        capType: 'session',
        currentCostUsd: costs.sessionCost,
        limitUsd: sessionLimit,
      };
    }

    if (costs.dailyCost + estimatedCostUsd > dailyLimit) {
      return {
        allowed: false,
        reason: `Daily cost $${(costs.dailyCost + estimatedCostUsd).toFixed(4)} would exceed limit $${dailyLimit.toFixed(2)}`,
        capType: 'daily',
        currentCostUsd: costs.dailyCost,
        limitUsd: dailyLimit,
      };
    }

    return { allowed: true };
  }

  recordCost(agentId: string, costUsd: number, operationId?: string, metadata?: Record<string, unknown>): CostRecord {
    const costs = this.getOrCreate(agentId);
    this.maybeResetDaily(costs);

    costs.sessionCost += costUsd;
    costs.dailyCost += costUsd;

    const record: CostRecord = {
      agentId,
      operationId: operationId ?? `op_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      costUsd,
      timestamp: Date.now(),
      metadata,
    };
    costs.records.push(record);

    // Check caps and fire callbacks
    const limits = this.agentLimits.get(agentId);
    const sessionLimit = limits?.maxSessionCostUsd ?? this.config.maxSessionCostUsd;
    const dailyLimit = limits?.maxDailyCostUsd ?? this.config.maxDailyCostUsd;

    if (costs.sessionCost >= sessionLimit) {
      this.config.onCapReached?.(agentId, 'session', costs.sessionCost, sessionLimit);
    }
    if (costs.dailyCost >= dailyLimit) {
      this.config.onCapReached?.(agentId, 'daily', costs.dailyCost, dailyLimit);
    }

    return record;
  }

  getSnapshot(agentId: string): CostSnapshot {
    const costs = this.getOrCreate(agentId);
    this.maybeResetDaily(costs);

    const limits = this.agentLimits.get(agentId);
    const sessionLimit = limits?.maxSessionCostUsd ?? this.config.maxSessionCostUsd;
    const dailyLimit = limits?.maxDailyCostUsd ?? this.config.maxDailyCostUsd;

    return {
      agentId,
      sessionCostUsd: costs.sessionCost,
      dailyCostUsd: costs.dailyCost,
      sessionLimit,
      dailyLimit,
      isSessionCapReached: costs.sessionCost >= sessionLimit,
      isDailyCapReached: costs.dailyCost >= dailyLimit,
    };
  }

  resetSession(agentId: string): void {
    const costs = this.agents.get(agentId);
    if (costs) {
      costs.sessionCost = 0;
      costs.records = [];
    }
  }

  resetDailyAll(): void {
    for (const costs of this.agents.values()) {
      costs.dailyCost = 0;
      costs.dailyResetAt = this.getNextMidnight();
    }
  }

  setAgentLimits(agentId: string, overrides: Partial<Pick<CostGuardConfig, 'maxSessionCostUsd' | 'maxDailyCostUsd'>>): void {
    this.agentLimits.set(agentId, overrides);
  }

  private getOrCreate(agentId: string): AgentCosts {
    let costs = this.agents.get(agentId);
    if (!costs) {
      costs = {
        sessionCost: 0,
        dailyCost: 0,
        dailyResetAt: this.getNextMidnight(),
        records: [],
      };
      this.agents.set(agentId, costs);
    }
    return costs;
  }

  private maybeResetDaily(costs: AgentCosts): void {
    if (Date.now() >= costs.dailyResetAt) {
      costs.dailyCost = 0;
      costs.dailyResetAt = this.getNextMidnight();
    }
  }

  private getNextMidnight(): number {
    const now = new Date();
    const midnight = new Date(now);
    midnight.setHours(24, 0, 0, 0);
    return midnight.getTime();
  }
}
