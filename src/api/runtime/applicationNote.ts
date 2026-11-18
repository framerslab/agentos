/**
 * @file applicationNote.ts
 * A host's note for one reply (`AgentOSInput.applicationNote`) as the runtime keeps it.
 */

/**
 * The note a host gave, as the runtime keeps and sends it: the text with its leading and trailing whitespace trimmed.
 *
 * @param note - The value the host gave.
 * @returns The trimmed text; undefined when the value is not a string or is blank.
 */
export function hostApplicationNote(note: unknown): string | undefined {
  if (typeof note !== 'string') return undefined;
  const trimmed = note.trim();
  return trimmed ? trimmed : undefined;
}
