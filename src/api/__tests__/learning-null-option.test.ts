/**
 * @file learning-null-option.test.ts
 * `learning: null` is the off value a config read from JSON or YAML writes, and the option's docs name it: a typed
 * caller passes it to `agent()`, `gmi()` and the full runtime's config, and it resolves to no learning layer.
 */
import { describe, expect, it } from 'vitest';
import type { AgentOptions } from '../agent';
import type { AgentOSConfig } from '../AgentOS';
import { resolveCognition, type CognitionInputs } from '../runtime/gmiCognition';

describe('learning: null', () => {
  it('type-checks on agent() and gmi() options and on the full runtime config, and resolves to no learning layer', () => {
    const agentOptions: Pick<AgentOptions, 'learning'> = { learning: null };
    const cognition: CognitionInputs = { cognition: 'light', learning: null };
    const runtimeConfig: Pick<AgentOSConfig, 'learning'> = { learning: null };

    expect(resolveCognition({ cognition: 'light', learning: agentOptions.learning }).learning).toBeUndefined();
    expect(resolveCognition(cognition).learning).toBeUndefined();
    expect(runtimeConfig.learning).toBeNull();
  });
});
