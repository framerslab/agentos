/**
 * @file turnContent.ts
 * A turn's content as the message parts a provider takes, and as text for
 * what reads a turn as text: memory, planning, recall queries and the
 * conversation store.
 *
 * A multimodal turn used to carry its inputs as one object,
 * `{ text, vision, audio }`. Prompt construction serializes an object that is
 * neither a string nor a parts array to JSON, so the model got the image as
 * text (base64 billed as prompt tokens, an image URL as a string) and never
 * saw it, and memory, recall and the conversation store kept that JSON with
 * the image data in it.
 */
import { imagePartType } from '../../io/media/images/blobPart.js';
import type { AudioInputData, GMITurnInput, VisionInputData } from './IGMI';

/** A part of a user message, in the shape the providers take. */
export type TurnContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

/**
 * The URL of a vision input's image part: a base64 input as a data URL of
 * its MIME type, or of the type its first bytes show (JPEG when they show
 * none), and a URL input as given. `undefined` for an input with no data.
 */
function imageUrlOf(vision: VisionInputData): string | undefined {
  // `url` is accepted beside `data`, the field the type names.
  const data = typeof vision.data === 'string' ? vision.data : (vision as { url?: unknown }).url;
  if (typeof data !== 'string' || data === '') return undefined;
  if (vision.type !== 'base64') return data;
  const head = Buffer.from(data.slice(0, 32), 'base64');
  const mimeType = vision.mimeType || imagePartType(head)?.mimeType || 'image/jpeg';
  return `data:${mimeType};base64,${data}`;
}

let warnedUntranscribedAudio = false;

/**
 * The text that stands for audio a turn carries as data (`audio_url` or
 * `base64`), which no chat provider behind a turn takes: a note that a clip
 * came with the message and was not transcribed, with the address of an
 * http(s) clip and none of the clip's data. Warns once a process.
 */
function untranscribedAudioText(audio: AudioInputData): string {
  if (!warnedUntranscribedAudio) {
    warnedUntranscribedAudio = true;
    console.warn(
      `[agentos] A turn's audio input of type '${audio.type}' reached the model as a note that it was not transcribed: ` +
        "no chat provider behind a turn takes audio. Transcribe it and pass it with type 'transcription'.",
    );
  }
  const kind = audio.mimeType ? ` (${audio.mimeType})` : '';
  const where = audio.type === 'audio_url' && typeof audio.data === 'string' && /^https?:\/\//i.test(audio.data) ? ` at ${audio.data}` : '';
  return `[An audio clip${kind} came with this message${where}. It was not transcribed, so what it says is not available.]`;
}

/**
 * A multimodal turn's inputs as message parts: the text, then the audio as
 * text (its transcription, or a note that it was not transcribed when it
 * comes as data), then one image part per vision input, each after its
 * description as text when it has one. A provider then gets the images as
 * images, and prompt construction keeps the parts whole.
 *
 * @param text - The turn's text, when it has one.
 * @param vision - The turn's vision inputs.
 * @param audio - The turn's audio input.
 */
export function multimodalTurnParts(
  text: string | null | undefined,
  vision: readonly VisionInputData[] | undefined,
  audio: AudioInputData | undefined,
): TurnContentPart[] {
  const parts: TurnContentPart[] = [];
  if (text) parts.push({ type: 'text', text });
  if (audio?.type === 'transcription') {
    if (audio.data) parts.push({ type: 'text', text: audio.data });
  } else if (audio) {
    parts.push({ type: 'text', text: untranscribedAudioText(audio) });
  }
  for (const input of vision ?? []) {
    const url = imageUrlOf(input);
    if (!url) continue;
    // A caption the caller gave, which the pixels may not carry.
    if (input.description) parts.push({ type: 'text', text: input.description });
    parts.push({ type: 'image_url', image_url: { url } });
  }
  return parts;
}

/**
 * A turn's content as text, holding no image data: a string as given;
 * message parts as their text with `[image]` for each image part; the
 * earlier `{ text, vision, audio }` object as its text with `[image]` for
 * each vision input; anything else, such as tool results, as JSON.
 *
 * @param content - The turn's content.
 */
export function turnContentText(content: GMITurnInput['content']): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    if (content.every((part) => isMessagePart(part))) {
      return content
        .map((part) => (part.type === 'text' ? String((part as { text?: unknown }).text ?? '') : '[image]'))
        .filter(Boolean)
        .join('\n');
    }
    return JSON.stringify(content);
  }
  if (content && typeof content === 'object' && ('vision' in content || 'audio' in content) && !('toolCallId' in content)) {
    const legacy = content as { text?: unknown; vision?: unknown; audio?: { type?: unknown; data?: unknown } };
    const pieces = [typeof legacy.text === 'string' ? legacy.text : ''];
    if (legacy.audio?.type === 'transcription' && typeof legacy.audio.data === 'string') pieces.push(legacy.audio.data);
    if (Array.isArray(legacy.vision)) {
      for (const input of legacy.vision as Array<{ description?: unknown }>) {
        if (typeof input?.description === 'string' && input.description) pieces.push(input.description);
        pieces.push('[image]');
      }
    }
    return pieces.filter(Boolean).join('\n');
  }
  try {
    return JSON.stringify(content) ?? '';
  } catch {
    return '';
  }
}

/** Whether `part` is a text or image message part. */
function isMessagePart(part: unknown): part is TurnContentPart {
  const type = (part as { type?: unknown } | null)?.type;
  return type === 'text' || type === 'image_url';
}
