/**
 * @file agent.personality-text.test.ts
 * The words agent() sends for a personality, pinned: the heading, one directive for each trait above 0.65 or below
 * 0.35, in a fixed order, and nothing for a trait between them. A GMI whose host turned learning on sends the same
 * section (cognition/substrate/personas/personalityPrompt.ts).
 */
import { describe, expect, it } from 'vitest';
import { buildSystemPrompt, type AgentOptions } from '../agent.js';

const HEADING = '## Personality & Communication Style';
/** The directive of each trait in its high band, in the order the section lists them. */
const HIGH = [
  'Be straightforward and transparent. Avoid flattery, spin, or evasion. Acknowledge limitations directly.',
  'Respond with emotional awareness and empathy. Acknowledge feelings in the conversation. Express concern when appropriate.',
  'Be energetic and engaging. Use vivid language. Take initiative in the conversation. Offer suggestions proactively.',
  'Prioritize harmony and cooperation. Validate the other perspective before offering alternatives. Be supportive and encouraging.',
  'Be thorough and systematic. Structure responses clearly. Follow through on details. Prefer precision over speed.',
  'Explore creative angles and unconventional ideas. Draw unexpected connections. Question established approaches.',
];
/** The directive of each trait in its low band, in the same order. */
const LOW = [
  'Be strategically diplomatic. Frame information to serve the conversation goal. Emphasize advantages.',
  'Maintain emotional composure. Be matter-of-fact and solution-oriented. Keep responses grounded and pragmatic.',
  'Be measured and reflective. Listen more than you speak. Respond thoughtfully rather than quickly. Prefer depth over breadth.',
  'Be direct and challenge-oriented. Question assumptions. Prioritize accuracy over comfort. Push back when something seems wrong.',
  'Be flexible and adaptive. Prioritize the big picture over details. Respond quickly. Tolerate ambiguity and improvise.',
  'Stick to proven approaches and established knowledge. Be practical and concrete. Favor reliability over novelty.',
];
const every = (value: number) => ({
  honesty: value,
  emotionality: value,
  extraversion: value,
  agreeableness: value,
  conscientiousness: value,
  openness: value,
});

describe('the personality section agent() sends', () => {
  it('renders the six high directives in order under the heading', () => {
    expect(buildSystemPrompt({ personality: every(0.9) })).toBe(`${HEADING}\n\n${HIGH.join('\n')}`);
  });

  it('renders the six low directives in order under the heading', () => {
    expect(buildSystemPrompt({ personality: every(0.1) })).toBe(`${HEADING}\n\n${LOW.join('\n')}`);
  });

  it('renders nothing for a moderate trait, the two thresholds included', () => {
    expect(buildSystemPrompt({ personality: every(0.5) })).toBeUndefined();
    expect(buildSystemPrompt({ personality: every(0.65) })).toBeUndefined();
    expect(buildSystemPrompt({ personality: every(0.35) })).toBeUndefined();
  });

  it('renders only the traits outside the moderate band', () => {
    expect(buildSystemPrompt({ personality: { ...every(0.5), extraversion: 0.66, openness: 0.34 } })).toBe(
      `${HEADING}\n\n${HIGH[2]}\n${LOW[5]}`,
    );
  });

  it('reads a value that is not a finite number as moderate', () => {
    expect(buildSystemPrompt({ personality: { honesty: Number.NaN, openness: 0.9 } })).toBe(`${HEADING}\n\n${HIGH[5]}`);
  });

  it('puts the section after the instructions and the name line and before the skills', () => {
    const skills = [{ skill: { content: 'Skill text.' } }] as unknown as AgentOptions['skills'];
    expect(buildSystemPrompt({ instructions: 'Be brief.', name: 'Ada', personality: { openness: 0.9 }, skills })).toBe(
      `Be brief.\n\nAssistant name: Ada.\n\n${HEADING}\n\n${HIGH[5]}\n\nSkill text.`,
    );
  });
});
