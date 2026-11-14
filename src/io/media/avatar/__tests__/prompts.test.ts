import { describe, it, expect } from 'vitest';
import {
  AVATAR_ANGLES,
  AVATAR_EMOTIONS,
  buildAnglePrompt,
  buildPortraitPrompt,
  buildExpressionPrompt,
  buildEmotePrompt,
} from '../prompts';
import type { AvatarIdentityDescriptor } from '../../../../api/types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const fullIdentity: AvatarIdentityDescriptor = {
  displayName: 'Aria Voss',
  ageBand: 'young_adult',
  bodyType: 'athletic',
  faceDescriptor: 'sharp jawline, green eyes, high cheekbones',
  hairDescriptor: 'shoulder-length silver hair',
  skinDescriptor: 'warm olive skin',
  distinguishingFeatures: 'small scar above left eyebrow',
  styleNotes: 'anime cel-shaded',
};

const minimalIdentity: AvatarIdentityDescriptor = {
  displayName: 'Kai',
  ageBand: 'teen',
  faceDescriptor: 'round face, brown eyes',
};

// ---------------------------------------------------------------------------
// buildPortraitPrompt
// ---------------------------------------------------------------------------

describe('buildPortraitPrompt', () => {
  it('includes all descriptor fields for a full identity', () => {
    const prompt = buildPortraitPrompt(fullIdentity);

    expect(prompt).toContain('portrait of Aria Voss');
    expect(prompt).toContain('young adult age');
    expect(prompt).toContain('athletic build');
    expect(prompt).toContain('sharp jawline, green eyes, high cheekbones');
    expect(prompt).toContain('shoulder-length silver hair');
    expect(prompt).toContain('warm olive skin');
    expect(prompt).toContain('small scar above left eyebrow');
    expect(prompt).toContain('anime cel-shaded');
  });

  it('omits undefined optional fields for a minimal identity', () => {
    const prompt = buildPortraitPrompt(minimalIdentity);

    expect(prompt).toContain('portrait of Kai');
    expect(prompt).toContain('teen age');
    expect(prompt).toContain('round face, brown eyes');
    // Should NOT contain "build", hair, skin, etc.
    expect(prompt).not.toContain('build');
    expect(prompt).not.toContain('hair');
    expect(prompt).not.toContain('skin');
  });

  it('returns comma-separated parts', () => {
    const prompt = buildPortraitPrompt(fullIdentity);
    const parts = prompt.split(', ');
    expect(parts.length).toBeGreaterThanOrEqual(5);
  });

  it('normalises age band underscores to spaces', () => {
    const prompt = buildPortraitPrompt(fullIdentity);
    expect(prompt).toContain('young adult age');
    expect(prompt).not.toContain('young_adult');
  });
});

// ---------------------------------------------------------------------------
// buildExpressionPrompt
// ---------------------------------------------------------------------------

describe('buildExpressionPrompt', () => {
  it('appends emotion to the base portrait prompt', () => {
    const prompt = buildExpressionPrompt(fullIdentity, 'happy');
    expect(prompt).toContain('portrait of Aria Voss');
    expect(prompt).toContain('happy expression');
  });

  it('returns the base prompt for neutral emotion (no redundant suffix)', () => {
    const prompt = buildExpressionPrompt(fullIdentity, 'neutral');
    expect(prompt).not.toContain('neutral expression');
    expect(prompt).toEqual(buildPortraitPrompt(fullIdentity));
  });

  it('works with all canonical emotions', () => {
    for (const emotion of AVATAR_EMOTIONS) {
      const prompt = buildExpressionPrompt(minimalIdentity, emotion);
      expect(prompt).toContain('portrait of Kai');
      if (emotion !== 'neutral') {
        expect(prompt).toContain(`${emotion} expression`);
      }
    }
  });

  it('accepts arbitrary string emotions', () => {
    const prompt = buildExpressionPrompt(minimalIdentity, 'mischievous');
    expect(prompt).toContain('mischievous expression');
  });
});

// ---------------------------------------------------------------------------
// buildEmotePrompt
// ---------------------------------------------------------------------------

describe('buildEmotePrompt', () => {
  it('produces an animation loop prompt with the given emotion', () => {
    const prompt = buildEmotePrompt('happy');
    expect(prompt).toContain('animated emote loop');
    expect(prompt).toContain('happy expression');
    expect(prompt).toContain('seamless loop');
  });

  it('works for all canonical emotions', () => {
    for (const emotion of AVATAR_EMOTIONS) {
      const prompt = buildEmotePrompt(emotion);
      expect(prompt).toContain(`${emotion} expression`);
      expect(prompt).toContain('animated emote loop');
    }
  });
});

// ---------------------------------------------------------------------------
// AVATAR_EMOTIONS
// ---------------------------------------------------------------------------

describe('AVATAR_EMOTIONS', () => {
  it('contains 7 emotions', () => {
    expect(AVATAR_EMOTIONS).toHaveLength(7);
  });

  it('starts with neutral', () => {
    expect(AVATAR_EMOTIONS[0]).toBe('neutral');
  });

  it('is a readonly tuple at the type level', () => {
    // `as const` enforces readonly at compile time; verify the array is stable
    expect(Array.isArray(AVATAR_EMOTIONS)).toBe(true);
    expect(AVATAR_EMOTIONS).toEqual([
      'neutral', 'happy', 'sad', 'angry', 'surprised', 'flirty', 'fearful',
    ]);
  });
});

// ---------------------------------------------------------------------------
// AVATAR_ANGLES and buildAnglePrompt
// ---------------------------------------------------------------------------

describe('AVATAR_ANGLES', () => {
  it('names the three-quarter and profile views', () => {
    expect(AVATAR_ANGLES).toEqual(['three-quarter view', 'profile view']);
  });
});

describe('buildAnglePrompt', () => {
  it('appends the angle words to the base portrait prompt', () => {
    const prompt = buildAnglePrompt(fullIdentity, 'profile view');
    expect(prompt.startsWith(buildPortraitPrompt(fullIdentity))).toBe(true);
    expect(prompt.endsWith(', profile view')).toBe(true);
  });

  it('takes a caller angle as written', () => {
    expect(buildAnglePrompt(minimalIdentity, 'from behind, full figure')).toBe(
      `${buildPortraitPrompt(minimalIdentity)}, from behind, full figure`,
    );
  });
});
