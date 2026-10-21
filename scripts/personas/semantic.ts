import {
  HEXACO_TRAIT_KEYS,
  NOTETAKER_PERSONA,
  renderPersonalitySection,
  type TraitBand,
} from '@framers/agentos/cognition/substrate';
import { z } from 'zod';
import { GROUNDING_FIXTURES, type GroundingFixture } from './grounding-fixtures.ts';

type Trait = (typeof HEXACO_TRAIT_KEYS)[number];
/** One writing section rendered for a named trait profile. */
export interface WritingProfile { id: string; section: string }
/** What the judge sees: the source, its required meanings, the style section and the answer. */
export interface JudgeInput {
  source: string;
  required: readonly string[];
  section: string;
  answer: string;
}
/** The judge's structured verdict on whether an answer keeps the source's meaning. */
export const GroundingVerdict = z.strictObject({
  grounded: z.boolean(),
  complete: z.boolean(),
  unsupported: z.array(z.string().min(1).max(500)).max(10),
  missing: z.array(z.string().min(1).max(500)).max(10),
  rationale: z.string().min(1).max(1500),
});
/** One judged case as written to the CI evidence, whether it passed or failed. */
export interface SemanticRecord {
  profile: string;
  fixture: string;
  case: string;
  section: string;
  answer: string;
  expected: boolean;
  verdict: z.infer<typeof GroundingVerdict>;
  passed: boolean;
}

/** Renders the preset, every trait in every band and the two combined corners as writing sections. */
export function profiles(): WritingProfile[] {
  const entries: Array<{ id: string; bands: Partial<Record<Trait, TraitBand>> }> = [
    { id: 'preset', bands: {} },
  ];
  for (const trait of HEXACO_TRAIT_KEYS) {
    for (const band of ['low', 'moderate', 'high'] as const) {
      entries.push({ id: `${trait}:${band}`, bands: { [trait]: band } });
    }
  }
  for (const band of ['low', 'high'] as const) {
    entries.push({
      id: `editable:${band}`,
      bands: { extraversion: band, agreeableness: band, conscientiousness: band, openness: band },
    });
  }
  return entries.map(({ id, bands }) => {
    const section = renderPersonalitySection(NOTETAKER_PERSONA, { bands, register: 'writing' });
    if (section === null) throw new Error(`missing writing section: ${id}`);
    return { id, section };
  });
}

/**
 * Calibrates the judge on each fixture's grounded controls once, under the preset's section, then, for every profile
 * and fixture, judges both planted controls under that profile's section and one generated answer, stopping at the
 * first failure. A grounded control judged under every profile multiplied the judge's variance without testing the
 * writer (the first keyed runs stopped on grounded controls the judge had passed before); a planted suggestion is
 * still refused under every band, so no band's style text gets an unsupported meaning past the judge.
 */
export async function runSemanticAcceptance(deps: {
  write: (input: { source: string; section: string }) => Promise<string>;
  judge: (input: JudgeInput) => Promise<unknown>;
  record: (record: SemanticRecord) => Promise<void>;
}): Promise<{ profiles: number; fixtures: number; generated: number; judgments: number }> {
  const entries = profiles();
  const preset = entries.find((entry) => entry.id === 'preset');
  if (!preset) throw new Error('missing preset profile');
  let generated = 0;
  let judgments = 0;
  const judge = async (
    profile: WritingProfile, fixture: GroundingFixture, answer: string, expected: boolean, label: string,
  ): Promise<void> => {
    if (answer.trim() === '') throw new Error('empty writing answer');
    const verdict = GroundingVerdict.parse(await deps.judge({
      source: fixture.source, required: fixture.required, section: profile.section, answer,
    }));
    const accepted = verdict.grounded && verdict.complete && verdict.unsupported.length === 0 && verdict.missing.length === 0;
    // A negative control must be rejected for unsupported meaning, not a parse error or an unrelated omission.
    const rejected = !verdict.grounded && verdict.unsupported.length > 0;
    const passed = expected ? accepted : rejected;
    judgments += 1;
    await deps.record({
      profile: profile.id, fixture: fixture.id, case: label,
      section: profile.section, answer, expected, verdict, passed,
    });
    if (!passed) throw new Error(`semantic acceptance failed: ${profile.id}:${fixture.id}:${label}`);
  };
  for (const fixture of GROUNDING_FIXTURES) {
    for (const [index, answer] of fixture.accepted.entries()) {
      await judge(preset, fixture, answer, true, `grounded-${index + 1}`);
    }
  }
  for (const profile of entries) {
    for (const fixture of GROUNDING_FIXTURES) {
      for (const [index, answer] of fixture.rejected.entries()) {
        await judge(profile, fixture, answer, false, `planted-${index + 1}`);
      }
      const answer = await deps.write({ source: fixture.source, section: profile.section });
      generated += 1;
      await judge(profile, fixture, answer, true, 'generated');
    }
  }
  return { profiles: entries.length, fixtures: GROUNDING_FIXTURES.length, generated, judgments };
}
