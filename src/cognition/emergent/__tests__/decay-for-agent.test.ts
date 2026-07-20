import { describe, it, expect } from 'vitest';

describe('ci-gate-drill', () => {
  it('deliberately fails to prove the batch gate can go red', () => {
    expect(1).toBe(2);
  });
});
