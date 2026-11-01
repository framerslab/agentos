/**
 * @file content-safe-origins.spec.ts
 * @description While content-safe telemetry is on, a line an AgentOS module writes through its event handle reaches
 * the sink as one fixed event naming that module, as the module's console lines do, and a handle from `lazyLogger`
 * reports `library`. Nothing of the line, its fields or the handle's bindings is read.
 */

import { beforeEach, expect, it, vi } from 'vitest';
import type { ContentSafeLogEvent } from '../../src/core/logging/contentSafeTelemetry.js';

// Content-safe telemetry cannot be turned off, so each case loads fresh modules.
beforeEach(() => { vi.resetModules(); });

it('a module handle and its children report the module, and a lazy handle reports library', async () => {
  const telemetry = await import('../../src/core/logging/contentSafeTelemetry.js');
  const factory = await import('../../src/core/logging/loggerFactory.js');
  const host = vi.fn();
  factory.setLoggerFactory(() => ({ debug: host, info: host, warn: host, error: host, fatal: host }));
  try {
    const module = factory.moduleLogger('llm', 'openai_provider');
    const child = module.child({ extension: 'fixture' });
    const lazy = factory.lazyLogger('fixture');
    const events: ContentSafeLogEvent[] = [];
    telemetry.enableContentSafeTelemetry((event) => { events.push(event); });
    module.warn('llm.retry', { provider: 'openai', status: 429, attempt: 1, waitMs: 10 });
    child.fatal('process.uncaught', { type: 'Error', code: 'unknown' });
    lazy.info('llm.models_refresh', { provider: 'openai' });
    expect(events.map((event) => [event.state, event.component])).toEqual([
      ['warn', 'openai_provider'], ['error', 'openai_provider'], ['info', 'library'],
    ]);
    expect(events.every((event) => Object.keys(event).sort().join(',') === 'component,kind,n,state')).toBe(true);
    expect(host).not.toHaveBeenCalled();
  } finally { factory.resetLoggerFactory(); }
});

it('an origin outside the closed list reports library', async () => {
  const telemetry = await import('../../src/core/logging/contentSafeTelemetry.js');
  const factory = await import('../../src/core/logging/loggerFactory.js');
  const events: ContentSafeLogEvent[] = [];
  telemetry.enableContentSafeTelemetry((event) => { events.push(event); });
  const handle = Reflect.apply(factory.moduleLogger, undefined, ['llm', 'private-words-9031']) as ReturnType<typeof factory.moduleLogger>;
  handle.error('llm.models_failed', { provider: 'openai', type: 'Error', code: 'unknown' });
  expect(events.map((event) => event.component)).toEqual(['library']);
  expect(JSON.stringify(events).includes('private-words-9031')).toBe(false);
});
