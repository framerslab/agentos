/**
 * @file ExtensionRegistry.spec.ts
 * @description Unit tests for the Extension Registry
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ExtensionRegistry } from '../../src/extensions/ExtensionRegistry';
import type { ExtensionDescriptor, ExtensionLifecycleContext } from '../../src/extensions/types';

interface TestPayload {
  name: string;
  execute: () => void;
}

function createTestDescriptor(
  id: string,
  priority?: number,
  hooks?: {
    onActivate?: (ctx: ExtensionLifecycleContext) => Promise<void>;
    onDeactivate?: (ctx: ExtensionLifecycleContext) => Promise<void>;
  }
): ExtensionDescriptor<TestPayload> {
  return {
    id,
    kind: 'tool',
    priority,
    payload: {
      name: id,
      execute: vi.fn(),
    },
    ...hooks,
  };
}

describe('ExtensionRegistry', () => {
  let registry: ExtensionRegistry<TestPayload>;

  beforeEach(() => {
    registry = new ExtensionRegistry<TestPayload>('tool');
  });

  describe('constructor', () => {
    it('should create registry with kind', () => {
      const reg = new ExtensionRegistry('custom-kind');
      expect(reg).toBeDefined();
    });
  });

  describe('register', () => {
    it('keeps the newer descriptor active when it registers while an older one of the same id still awaits its activation', async () => {
      let finishActivation!: () => void;
      const activation = new Promise<void>((resolve) => {
        finishActivation = resolve;
      });
      const older = createTestDescriptor('race-tool', undefined, { onActivate: () => activation });
      older.payload.name = 'older';
      const newer = createTestDescriptor('race-tool');
      newer.payload.name = 'newer';

      const olderRegistered = registry.register(older);
      await registry.register(newer);
      expect(registry.getActive('race-tool')?.payload.name).toBe('newer');
      // The older registration finishes last; it must not take the id back.
      finishActivation();
      await olderRegistered;
      expect(registry.getActive('race-tool')?.payload.name).toBe('newer');
    });

    it('should register a descriptor', async () => {
      const descriptor = createTestDescriptor('test-tool');
      await registry.register(descriptor);

      const active = registry.getActive('test-tool');
      expect(active).toBeDefined();
      expect(active?.id).toBe('test-tool');
    });

    it('should set default priority to 0', async () => {
      const descriptor = createTestDescriptor('test-tool');
      await registry.register(descriptor);

      const active = registry.getActive('test-tool');
      expect(active?.resolvedPriority).toBe(0);
    });

    it('should use provided priority', async () => {
      const descriptor = createTestDescriptor('test-tool', 100);
      await registry.register(descriptor);

      const active = registry.getActive('test-tool');
      expect(active?.resolvedPriority).toBe(100);
    });

    it('should set stack index', async () => {
      const descriptor1 = createTestDescriptor('test-tool');
      const descriptor2 = createTestDescriptor('test-tool');

      await registry.register(descriptor1);
      await registry.register(descriptor2);

      const history = registry.listHistory('test-tool');
      expect(history[0].stackIndex).toBe(0);
      expect(history[1].stackIndex).toBe(1);
    });

    it('should call onActivate hook', async () => {
      const onActivate = vi.fn();
      const descriptor = createTestDescriptor('test-tool', undefined, { onActivate });

      await registry.register(descriptor);

      expect(onActivate).toHaveBeenCalled();
    });

    it('should call onActivate with context', async () => {
      const onActivate = vi.fn();
      const descriptor = createTestDescriptor('test-tool', undefined, { onActivate });
      const context: ExtensionLifecycleContext = { getSecret: vi.fn() };

      await registry.register(descriptor, context);

      expect(onActivate).toHaveBeenCalledWith(context);
    });

    it('should call onActivate with empty context if not provided', async () => {
      const onActivate = vi.fn();
      const descriptor = createTestDescriptor('test-tool', undefined, { onActivate });

      await registry.register(descriptor);

      expect(onActivate).toHaveBeenCalledWith({});
    });
  });

  describe('unregister', () => {
    it('should unregister a descriptor', async () => {
      const descriptor = createTestDescriptor('test-tool');
      await registry.register(descriptor);

      const result = await registry.unregister('test-tool');

      expect(result).toBe(true);
      expect(registry.getActive('test-tool')).toBeUndefined();
    });

    it('should return false for non-existent descriptor', async () => {
      const result = await registry.unregister('nonexistent');
      expect(result).toBe(false);
    });

    it('should return false for empty stack', async () => {
      // Create and immediately unregister
      const descriptor = createTestDescriptor('test-tool');
      await registry.register(descriptor);
      await registry.unregister('test-tool');

      // Try to unregister again
      const result = await registry.unregister('test-tool');
      expect(result).toBe(false);
    });

    it('should call onDeactivate hook', async () => {
      const onDeactivate = vi.fn();
      const descriptor = createTestDescriptor('test-tool', undefined, { onDeactivate });
      await registry.register(descriptor);

      await registry.unregister('test-tool');

      expect(onDeactivate).toHaveBeenCalled();
    });

    it('should activate previous descriptor when unregistering', async () => {
      const onActivate1 = vi.fn();
      const onActivate2 = vi.fn();
      const descriptor1 = createTestDescriptor('test-tool', undefined, { onActivate: onActivate1 });
      const descriptor2 = createTestDescriptor('test-tool', undefined, { onActivate: onActivate2 });

      await registry.register(descriptor1);
      await registry.register(descriptor2);

      // Reset mocks to track re-activation
      onActivate1.mockClear();
      onActivate2.mockClear();

      await registry.unregister('test-tool');

      // First descriptor should be re-activated
      expect(onActivate1).toHaveBeenCalled();
    });

    it('should delete stack when last descriptor is unregistered', async () => {
      const descriptor = createTestDescriptor('test-tool');
      await registry.register(descriptor);

      await registry.unregister('test-tool');

      expect(registry.listHistory('test-tool')).toEqual([]);
    });
  });

  describe('getActive', () => {
    it('should return active descriptor', async () => {
      const descriptor = createTestDescriptor('test-tool');
      await registry.register(descriptor);

      const active = registry.getActive('test-tool');

      expect(active?.id).toBe('test-tool');
    });

    it('should return undefined for non-existent id', () => {
      const active = registry.getActive('nonexistent');
      expect(active).toBeUndefined();
    });

    it('should return most recent descriptor in stack', async () => {
      const descriptor1 = createTestDescriptor('test-tool');
      descriptor1.payload.name = 'first';
      const descriptor2 = createTestDescriptor('test-tool');
      descriptor2.payload.name = 'second';

      await registry.register(descriptor1);
      await registry.register(descriptor2);

      const active = registry.getActive('test-tool');
      expect(active?.payload.name).toBe('second');
    });
  });

  describe('listActive', () => {
    it('should return empty array when no descriptors', () => {
      const active = registry.listActive();
      expect(active).toEqual([]);
    });

    it('should return all active descriptors', async () => {
      await registry.register(createTestDescriptor('tool1'));
      await registry.register(createTestDescriptor('tool2'));
      await registry.register(createTestDescriptor('tool3'));

      const active = registry.listActive();

      expect(active).toHaveLength(3);
      expect(active.map((d) => d.id)).toContain('tool1');
      expect(active.map((d) => d.id)).toContain('tool2');
      expect(active.map((d) => d.id)).toContain('tool3');
    });

    it('should only return most recent for each id', async () => {
      await registry.register(createTestDescriptor('tool1'));
      await registry.register(createTestDescriptor('tool1')); // Override

      const active = registry.listActive();

      expect(active).toHaveLength(1);
    });
  });

  describe('listHistory', () => {
    it('should return empty array for non-existent id', () => {
      const history = registry.listHistory('nonexistent');
      expect(history).toEqual([]);
    });

    it('should return all descriptors in stack order', async () => {
      const descriptor1 = createTestDescriptor('test-tool');
      descriptor1.payload.name = 'first';
      const descriptor2 = createTestDescriptor('test-tool');
      descriptor2.payload.name = 'second';
      const descriptor3 = createTestDescriptor('test-tool');
      descriptor3.payload.name = 'third';

      await registry.register(descriptor1);
      await registry.register(descriptor2);
      await registry.register(descriptor3);

      const history = registry.listHistory('test-tool');

      expect(history).toHaveLength(3);
      expect(history[0].payload.name).toBe('first');
      expect(history[1].payload.name).toBe('second');
      expect(history[2].payload.name).toBe('third');
    });

    it('should return a copy of the history', async () => {
      await registry.register(createTestDescriptor('test-tool'));

      const history1 = registry.listHistory('test-tool');
      const history2 = registry.listHistory('test-tool');

      expect(history1).not.toBe(history2);
      expect(history1).toEqual(history2);
    });
  });

  describe('clear', () => {
    it('should clear all stacks', async () => {
      await registry.register(createTestDescriptor('tool1'));
      await registry.register(createTestDescriptor('tool2'));

      await registry.clear();

      expect(registry.listActive()).toEqual([]);
      expect(registry.getActive('tool1')).toBeUndefined();
      expect(registry.getActive('tool2')).toBeUndefined();
    });

    it('should call onDeactivate for all descriptors', async () => {
      const onDeactivate1 = vi.fn();
      const onDeactivate2 = vi.fn();
      const onDeactivate3 = vi.fn();

      await registry.register(createTestDescriptor('tool1', undefined, { onDeactivate: onDeactivate1 }));
      await registry.register(createTestDescriptor('tool1', undefined, { onDeactivate: onDeactivate2 }));
      await registry.register(createTestDescriptor('tool2', undefined, { onDeactivate: onDeactivate3 }));

      await registry.clear();

      expect(onDeactivate1).toHaveBeenCalled();
      expect(onDeactivate2).toHaveBeenCalled();
      expect(onDeactivate3).toHaveBeenCalled();
    });

    it('should deactivate superseded descriptors during registration and the active descriptor during clear', async () => {
      const order: number[] = [];
      const onDeactivate1 = vi.fn(() => { order.push(1); return Promise.resolve(); });
      const onDeactivate2 = vi.fn(() => { order.push(2); return Promise.resolve(); });
      const onDeactivate3 = vi.fn(() => { order.push(3); return Promise.resolve(); });

      await registry.register(createTestDescriptor('tool', undefined, { onDeactivate: onDeactivate1 }));
      await registry.register(createTestDescriptor('tool', undefined, { onDeactivate: onDeactivate2 }));
      await registry.register(createTestDescriptor('tool', undefined, { onDeactivate: onDeactivate3 }));

      await registry.clear();

      // When a descriptor is superseded by a newer one, it is deactivated immediately.
      // The final active descriptor is deactivated when the registry is cleared.
      expect(order).toEqual([1, 2, 3]);
    });

    it('should pass context to onDeactivate', async () => {
      const onDeactivate = vi.fn();
      await registry.register(createTestDescriptor('tool', undefined, { onDeactivate }));

      const context: ExtensionLifecycleContext = { getSecret: vi.fn() };
      await registry.clear(context);

      expect(onDeactivate).toHaveBeenCalledWith(context);
    });
  });

  describe('stacking behavior', () => {
    it('should support multiple registrations for same id', async () => {
      await registry.register(createTestDescriptor('test-tool'));
      await registry.register(createTestDescriptor('test-tool'));
      await registry.register(createTestDescriptor('test-tool'));

      const history = registry.listHistory('test-tool');
      expect(history).toHaveLength(3);
    });

    it('should pop descriptors in LIFO order', async () => {
      const descriptor1 = createTestDescriptor('test-tool');
      descriptor1.payload.name = 'first';
      const descriptor2 = createTestDescriptor('test-tool');
      descriptor2.payload.name = 'second';
      const descriptor3 = createTestDescriptor('test-tool');
      descriptor3.payload.name = 'third';

      await registry.register(descriptor1);
      await registry.register(descriptor2);
      await registry.register(descriptor3);

      expect(registry.getActive('test-tool')?.payload.name).toBe('third');

      await registry.unregister('test-tool');
      expect(registry.getActive('test-tool')?.payload.name).toBe('second');

      await registry.unregister('test-tool');
      expect(registry.getActive('test-tool')?.payload.name).toBe('first');

      await registry.unregister('test-tool');
      expect(registry.getActive('test-tool')).toBeUndefined();
    });
  });

  describe('priority behavior', () => {
    it('should keep the highest-priority descriptor active regardless of registration order', async () => {
      const high = createTestDescriptor('test-tool', 100);
      high.payload.name = 'high';
      const low = createTestDescriptor('test-tool', 10);
      low.payload.name = 'low';

      await registry.register(high);
      await registry.register(low);

      const active = registry.getActive('test-tool');
      expect(active?.payload.name).toBe('high');
      expect(active?.resolvedPriority).toBe(100);
    });

    it('should activate a lower-priority descriptor after unregistering the active one', async () => {
      const onActivateHigh = vi.fn();
      const onActivateLow = vi.fn();
      const onDeactivateHigh = vi.fn();

      const high = createTestDescriptor('test-tool', 100, { onActivate: onActivateHigh, onDeactivate: onDeactivateHigh });
      high.payload.name = 'high';
      const low = createTestDescriptor('test-tool', 10, { onActivate: onActivateLow });
      low.payload.name = 'low';

      await registry.register(high);
      await registry.register(low);

      expect(onActivateHigh).toHaveBeenCalledTimes(1);
      expect(onActivateLow).toHaveBeenCalledTimes(0);
      expect(registry.getActive('test-tool')?.payload.name).toBe('high');

      await registry.unregister('test-tool');

      expect(onDeactivateHigh).toHaveBeenCalledTimes(1);
      expect(onActivateLow).toHaveBeenCalledTimes(1);
      expect(registry.getActive('test-tool')?.payload.name).toBe('low');
    });
  });
});
