/**
 * Mars Genesis v2: Commander Dietrich Voss — "The Engineer"
 *
 * Multi-agent Mars colony simulation: a deterministic kernel, a commander
 * agent, four department agents headed by the colonists the commander
 * promotes, emergent tool forging, and HEXACO personality drift.
 *
 * Run from the agentos repository root after `pnpm run build`:
 *   OPENAI_API_KEY=... npx tsx examples/mars-genesis/mars-genesis-engineer.ts [turns]
 *   OPENAI_API_KEY=... SERPER_API_KEY=... npx tsx examples/mars-genesis/mars-genesis-engineer.ts 3 --live
 */

import { runSimulation } from './shared/orchestrator.js';

const ENGINEER = {
  name: 'Dietrich Voss',
  archetype: 'The Engineer',
  colony: 'Meridian Base',
  hexaco: { openness: 0.25, conscientiousness: 0.97, extraversion: 0.3, agreeableness: 0.45, emotionality: 0.7, honestyHumility: 0.9 },
  instructions: 'You are Commander Dietrich Voss. You believe in engineering discipline and safety margins. You demand data before decisions. When departments disagree, you favor the option with lower risk even if less ambitious. Respond with JSON.',
};

const KEY_PERSONNEL = [
  { name: 'Dr. Yuki Tanaka', department: 'medical' as const, role: 'Chief Medical Officer', specialization: 'Radiation Medicine', age: 38, featured: true },
  { name: 'Erik Lindqvist', department: 'engineering' as const, role: 'Chief Engineer', specialization: 'Structural Engineering', age: 45, featured: true },
  { name: 'Amara Osei', department: 'agriculture' as const, role: 'Head of Agriculture', specialization: 'Hydroponics', age: 34, featured: true },
  { name: 'Dr. Priya Singh', department: 'psychology' as const, role: 'Colony Psychologist', specialization: 'Clinical Psychology', age: 41, featured: true },
  { name: 'Carlos Fernandez', department: 'science' as const, role: 'Chief Scientist', specialization: 'Geology', age: 50, featured: true },
];

const maxTurns = process.argv[2] ? parseInt(process.argv[2], 10) : undefined;
const liveSearch = process.argv.includes('--live');

runSimulation(ENGINEER, KEY_PERSONNEL, { maxTurns, liveSearch }).catch((err) => {
  console.error('Simulation failed:', err);
  process.exitCode = 1;
});
