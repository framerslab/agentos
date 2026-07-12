import { describe, it, expect } from 'vitest';
import { AgentOS } from '../AgentOS.js';

describe('AgentOS.getHttpHandlers', () => {
  it('returns [] before initialization', () => {
    const os = new AgentOS();
    expect(os.getHttpHandlers()).toEqual([]);
  });
});
