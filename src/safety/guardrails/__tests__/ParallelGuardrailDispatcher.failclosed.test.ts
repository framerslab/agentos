import { describe, it, expect } from 'vitest';
import { ParallelGuardrailDispatcher } from '../ParallelGuardrailDispatcher';
import { GuardrailAction, type IGuardrailService, type GuardrailConfig } from '../IGuardrailService';

// Minimal casts — the dispatcher only touches svc.config + svc.evaluateInput
// and returns sanitizedInput: input verbatim, so the exact shapes don't matter.
const input = {} as never;
const context = {} as never;

function throwingGuard(config?: GuardrailConfig): IGuardrailService {
  return {
    name: 'throwing-guard',
    evaluateInput: async () => {
      throw new Error('guard boom');
    },
    config,
  } as unknown as IGuardrailService;
}

function blocked(outcome: { evaluations?: Array<{ action: GuardrailAction } | null> }): boolean {
  return (outcome.evaluations ?? []).some((e) => e?.action === GuardrailAction.BLOCK);
}

describe('ParallelGuardrailDispatcher — CR3 fail-closed posture', () => {
  it('fails OPEN by default when a guardrail throws (back-compat)', async () => {
    const outcome = await ParallelGuardrailDispatcher.evaluateInput(
      [throwingGuard(undefined)],
      input,
      context,
    );
    expect(blocked(outcome)).toBe(false);
  });

  it('fails CLOSED (synthetic BLOCK) when failClosed:true and a guardrail throws', async () => {
    const outcome = await ParallelGuardrailDispatcher.evaluateInput(
      [throwingGuard({ failClosed: true })],
      input,
      context,
    );
    expect(blocked(outcome)).toBe(true);
    const block = (outcome.evaluations ?? []).find((e) => e?.action === GuardrailAction.BLOCK);
    expect(block?.reasonCode).toBe('GUARDRAIL_ERROR');
  });
});
