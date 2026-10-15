/**
 * @file loggerFactory.spec.ts
 * @description Unit tests for the logger factory.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createLogger,
  setLoggerFactory,
  resetLoggerFactory,
} from '../../src/logging/loggerFactory';
import type { ILogger } from '../../src/logging/ILogger';

describe('Logger Factory', () => {
  afterEach(() => {
    resetLoggerFactory();
  });

  describe('createLogger', () => {
    it('should create a logger with the given name', () => {
      const logger = createLogger('test-component');
      expect(logger).toBeDefined();
      expect(logger.debug).toBeDefined();
      expect(logger.info).toBeDefined();
      expect(logger.warn).toBeDefined();
      expect(logger.error).toBeDefined();
    });

    it('should create a logger with bindings', () => {
      const logger = createLogger('test-component', { userId: '123' });
      expect(logger).toBeDefined();
    });

    it('should create unique logger instances', () => {
      const logger1 = createLogger('component1');
      const logger2 = createLogger('component2');
      expect(logger1).not.toBe(logger2);
    });
  });

  describe('setLoggerFactory', () => {
    it('should use custom factory when set', () => {
      const customLogger: ILogger = {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        critical: vi.fn(),
        child: vi.fn().mockReturnThis(),
      };

      const customFactory = vi.fn().mockReturnValue(customLogger);
      setLoggerFactory(customFactory);

      const logger = createLogger('custom-component');
      expect(customFactory).toHaveBeenCalledWith('custom-component', undefined);
      logger.warn('custom message');
      expect(customLogger.warn).toHaveBeenCalledExactlyOnceWith('custom message');
    });

    it('should pass bindings to custom factory', () => {
      const customLogger: ILogger = {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        critical: vi.fn(),
        child: vi.fn().mockReturnThis(),
      };

      const customFactory = vi.fn().mockReturnValue(customLogger);
      setLoggerFactory(customFactory);

      createLogger('component', { key: 'value' });
      expect(customFactory).toHaveBeenCalledWith('component', { key: 'value' });
    });
  });

  describe('resetLoggerFactory', () => {
    it('should reset to default factory', () => {
      const customFactory = vi.fn();
      setLoggerFactory(customFactory);

      resetLoggerFactory();

      const logger = createLogger('test');
      // After reset, should use default factory (PinoLogger)
      expect(customFactory).not.toHaveBeenCalledWith('test', undefined);
      expect(logger).toBeDefined();
    });
  });

  describe('Logger methods', () => {
    let logger: ILogger;

    beforeEach(() => {
      logger = createLogger('test-logger');
    });

    it('should have debug method', () => {
      expect(() => logger.debug?.('Debug message')).not.toThrow();
    });

    it('should have info method', () => {
      expect(() => logger.info?.('Info message')).not.toThrow();
    });

    it('should have warn method', () => {
      expect(() => logger.warn?.('Warning message')).not.toThrow();
    });

    it('should have error method', () => {
      expect(() => logger.error?.('Error message')).not.toThrow();
    });

    it('should have critical method', () => {
      expect(() => logger.critical?.('Critical message')).not.toThrow();
    });

    it('should create child logger', () => {
      const childLogger = logger.child?.({ operation: 'test' });
      expect(childLogger).toBeDefined();
    });
  });
});


