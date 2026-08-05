import { describe, expect, it, vi } from 'vitest';
import { AgentMemory } from '../AgentMemory.js';
import { CognitiveMemoryManager } from '../CognitiveMemoryManager.js';
import { createCognitiveMemoryDescriptor } from '../io/extension/CognitiveMemoryExtension.js';

describe('memory lifecycle serialization', () => {
  it('queues facade initialization behind an in-flight shutdown', async () => {
    let signalShutdownStarted: (() => void) | undefined;
    let releaseShutdown: (() => void) | undefined;
    const shutdownStarted = new Promise<void>((resolve) => {
      signalShutdownStarted = resolve;
    });
    const shutdownGate = new Promise<void>((resolve) => {
      releaseShutdown = resolve;
    });
    const backend = {
      initialize: vi.fn().mockResolvedValue(undefined),
      shutdown: vi.fn().mockImplementation(async () => {
        signalShutdownStarted?.();
        await shutdownGate;
      }),
    };
    const memory = new AgentMemory(backend as never);
    await memory.initialize({} as never);

    const shuttingDown = memory.shutdown();
    const reinitializing = memory.initialize({} as never);
    try {
      await shutdownStarted;
      expect(memory.isInitialized).toBe(false);
      expect(backend.initialize).toHaveBeenCalledTimes(1);
    } finally {
      releaseShutdown?.();
      await Promise.all([shuttingDown, reinitializing]);
    }

    expect(backend.shutdown).toHaveBeenCalledTimes(1);
    expect(backend.initialize).toHaveBeenCalledTimes(2);
    expect(memory.isInitialized).toBe(true);
  });

  it('queues facade shutdown behind an in-flight initialization', async () => {
    let signalInitializeStarted: (() => void) | undefined;
    let releaseInitialize: (() => void) | undefined;
    const initializeStarted = new Promise<void>((resolve) => {
      signalInitializeStarted = resolve;
    });
    const initializeGate = new Promise<void>((resolve) => {
      releaseInitialize = resolve;
    });
    const backend = {
      initialize: vi.fn().mockImplementation(async () => {
        signalInitializeStarted?.();
        await initializeGate;
      }),
      shutdown: vi.fn().mockResolvedValue(undefined),
    };
    const memory = new AgentMemory(backend as never);

    const initializing = memory.initialize({} as never);
    const shuttingDown = memory.shutdown();
    try {
      await initializeStarted;
      expect(backend.shutdown).not.toHaveBeenCalled();
      expect(memory.isInitialized).toBe(false);
    } finally {
      releaseInitialize?.();
      await Promise.all([initializing, shuttingDown]);
    }

    expect(backend.initialize).toHaveBeenCalledTimes(1);
    expect(backend.shutdown).toHaveBeenCalledTimes(1);
    expect(memory.isInitialized).toBe(false);
  });

  it('clears facade readiness when backend shutdown rejects', async () => {
    const backend = {
      initialize: vi.fn().mockResolvedValue(undefined),
      shutdown: vi.fn().mockRejectedValue(new Error('simulated shutdown failure')),
    };
    const memory = new AgentMemory(backend as never);
    await memory.initialize({} as never);

    await expect(memory.shutdown()).rejects.toThrow('simulated shutdown failure');
    expect(memory.isInitialized).toBe(false);
  });

  it('preserves initialization and cleanup failures together', async () => {
    const manager = new CognitiveMemoryManager();
    const lifecycle = manager as unknown as {
      initializeResources(config: never): Promise<void>;
      cleanupResources(): Promise<void>;
    };
    const initializationError = new Error('simulated initialization failure');
    const cleanupError = new Error('simulated cleanup failure');
    vi.spyOn(lifecycle, 'initializeResources').mockRejectedValue(initializationError);
    vi.spyOn(lifecycle, 'cleanupResources').mockRejectedValue(cleanupError);

    try {
      await manager.initialize({} as never);
      expect.fail('expected initialization to reject');
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors).toEqual([
        initializationError,
        cleanupError,
      ]);
    }
  });

  it('keeps a replacement extension manager installed after the old one shuts down', async () => {
    let signalShutdownStarted: (() => void) | undefined;
    let releaseShutdown: (() => void) | undefined;
    const shutdownStarted = new Promise<void>((resolve) => {
      signalShutdownStarted = resolve;
    });
    const shutdownGate = new Promise<void>((resolve) => {
      releaseShutdown = resolve;
    });
    const oldManager = {
      encode: vi.fn().mockResolvedValue({ id: 'old' }),
      retrieve: vi.fn().mockResolvedValue({ retrieved: [] }),
      shutdown: vi.fn().mockImplementation(async () => {
        signalShutdownStarted?.();
        await shutdownGate;
      }),
    };
    const replacementManager = {
      encode: vi.fn().mockResolvedValue({ id: 'replacement' }),
      retrieve: vi.fn().mockResolvedValue({ retrieved: [] }),
      shutdown: vi.fn().mockResolvedValue(undefined),
    };
    const payload = createCognitiveMemoryDescriptor().payload;
    await payload.initialize?.({ manager: oldManager });

    const shuttingDown = payload.shutdown?.() ?? Promise.resolve();
    try {
      await shutdownStarted;
      await payload.initialize?.({ manager: replacementManager });
    } finally {
      releaseShutdown?.();
      await shuttingDown;
    }

    await payload.query?.('memory', 'hello');
    expect(replacementManager.retrieve).toHaveBeenCalledTimes(1);
  });
});
