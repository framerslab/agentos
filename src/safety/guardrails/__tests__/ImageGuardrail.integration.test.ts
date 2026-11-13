/**
 * @file ImageGuardrail.integration.test.ts
 * The image guard through moderateContent(): every match check on every image before any model check, a quarantine
 * that ends the whole evaluation, one capture whose bytes every check receives as its own copy, a check that fails
 * closed or is skipped as it says, an image nobody judged refused as unavailable, and the deadline signal every check
 * receives, which stops a check still waiting and a request in flight once the dispatcher has answered.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import pino from 'pino';
import { moderateContent } from '../contentModeration';
import { holdResult } from '../guardrailDispatcher';
import { ParallelGuardrailDispatcher } from '../ParallelGuardrailDispatcher';
import { withRequiredPosture } from '../requiredGuardrails';
import { ImageGuardrail, type ImageCheck, type ImageUnderReview } from '../builtin/ImageGuardrail';
import type { GuardrailContext, IGuardrailService } from '../IGuardrailService';
import type { VisionInputData } from '../../../cognition/substrate/IGMI';
import type { AgentOSInput } from '../../../api/types/AgentOSInput';
import { resetLoggerFactory, setLogger } from '../../../core/logging/loggerFactory.js';

type Line = Record<string, unknown>;
const context: GuardrailContext = { userId: 'user-1', sessionId: 'session-1' };
/** A three-byte image whose bytes are all `byte`. */
const png = (byte: number): VisionInputData => ({ type: 'base64', data: Buffer.from([byte, byte, byte]).toString('base64'), mimeType: 'image/png' });
const check = (id: string, kind: ImageCheck['kind'], run: ImageCheck['check'], extra: Partial<ImageCheck> = {}): ImageCheck & { check: Mock } =>
  ({ id, kind, ...extra, check: vi.fn(run) });
const passing = (id: string, kind: ImageCheck['kind']) => check(id, kind, async () => ({ verdict: 'pass' }));
const failing = (id: string, extra: Partial<ImageCheck> = {}) => check(id, 'classify', async () => { throw new Error('the vendor is down'); }, extra);
function capture(): Line[] {
  const lines: Line[] = [];
  setLogger(pino({ level: 'debug', base: undefined }, { write(line: string) { lines.push(JSON.parse(line)); } }));
  return lines;
}
const events = (lines: Line[], event: string): Line[] => lines.filter((line) => line.event === event);
const UNAVAILABLE = { outcome: 'refuse', unavailable: true, deciding: { reasonCode: 'IMAGE_CHECK_UNAVAILABLE', metadata: { failClosed: true } } };

afterEach(() => { resetLoggerFactory(); vi.restoreAllMocks(); });

describe('the image guard: known material first', () => {
  it('(a) a quarantine on any image ends the evaluation before any model check, and keeps the text from the guard behind it', async () => {
    const lines = capture();
    const hash = check('hash', 'match', async (image) => (image.index === 1 ? { verdict: 'block', reasonCode: 'KNOWN_MATERIAL', quarantine: true } : { verdict: 'pass' }), { reasonCodes: ['KNOWN_MATERIAL'] });
    const model = passing('model', 'classify');
    const textGuard = vi.fn(async () => null);
    const guard = ImageGuardrail.create({ id: 'images', checks: [hash, model], requireMatch: true, sequential: true });
    const decision = await moderateContent({ text: 'look at these', images: [png(1), png(2)] }, { guards: [guard, { id: 'vendor-text', evaluateInput: textGuard }], context });
    expect(decision).toMatchObject({ outcome: 'refuse', unavailable: false, deciding: { reasonCode: 'KNOWN_MATERIAL', metadata: { guardrailId: 'images', imageIndex: 1, checkId: 'hash', quarantine: true } } });
    expect(hash.check).toHaveBeenCalledTimes(2);
    expect(model.check).not.toHaveBeenCalled();
    expect(textGuard).not.toHaveBeenCalled();
    expect(events(lines, 'guardrail.verdict')).toEqual([expect.objectContaining({ guardrailId: 'images', action: 'block', code: 'KNOWN_MATERIAL' })]);
  });

  it('(b) (f) (g) refuses to be built in an order or a shape that could send an upload to a model unchecked', () => {
    const model = passing('model', 'classify');
    const hash = passing('hash', 'match');
    expect(() => ImageGuardrail.create({ id: 'images', checks: [model, hash] })).toThrow(TypeError);                           // (b) a model check before a match check
    expect(() => ImageGuardrail.create({ id: 'images', checks: [model], requireMatch: true })).toThrow(TypeError);            // (f) no match check where one is required
    expect(() => ImageGuardrail.create({ id: 'images', checks: [hash] })).toThrow(TypeError);                                  // (g) match checks alone judge nothing
    expect(() => ImageGuardrail.create({ id: 'images', checks: [] })).toThrow(TypeError);
    expect(() => ImageGuardrail.create({ id: 'images', checks: [{ ...hash, onError: 'skip' }, model] })).toThrow(TypeError);   // a match check is never a signal
    expect(() => ImageGuardrail.create({ id: 'images', checks: [model] })).not.toThrow();                                      // a host's own generated images
    // options that would make a guard that cannot judge what it lets through
    expect(() => ImageGuardrail.create({ id: 'images', checks: [model], maxImages: 0 })).toThrow(TypeError);
    expect(() => ImageGuardrail.create({ id: 'images', checks: [model], timeoutMs: 1.5 })).toThrow(TypeError);
    expect(() => ImageGuardrail.create({ id: 'images', checks: [{ ...model, check: undefined as never }] })).toThrow(TypeError);
    expect(() => ImageGuardrail.create({ id: 'images', checks: [model], loadImage: 'https://images.example/' as never })).toThrow(TypeError);
  });

  it('(h) captures an image once and hands every check its own copy of the same bytes, never the URL', async () => {
    const lines = capture();
    const loadImage = vi.fn(async (_url: string) => ({ bytes: new Uint8Array([7, 8, 9]), mimeType: 'image/jpeg' }));
    const seen: ImageUnderReview[] = [];
    const hash = check('hash', 'match', async (image) => { seen.push({ ...image, bytes: new Uint8Array(image.bytes) }); image.bytes.fill(0); return { verdict: 'pass' }; });
    const model = check('model', 'classify', async (image) => { seen.push(image); return { verdict: 'pass' }; });
    const url: VisionInputData = { type: 'image_url', data: 'https://images.example/one.jpg' };

    const decision = await moderateContent({ images: [url] }, { guards: [ImageGuardrail.create({ id: 'images', checks: [hash, model], loadImage })], context });
    expect(decision.outcome).toBe('allow');
    expect(loadImage).toHaveBeenCalledTimes(1);
    expect(loadImage.mock.calls[0][0]).toBe(url.data);
    // the first check emptied its copy; the second still received the bytes as they were captured
    expect(seen.map((image) => [...image.bytes])).toEqual([[7, 8, 9], [7, 8, 9]]);
    expect(seen.map((image) => [image.index, image.mimeType])).toEqual([[0, 'image/jpeg'], [0, 'image/jpeg']]);
    expect(JSON.stringify(seen.map((image) => ({ ...image, bytes: undefined })))).not.toContain('images.example');

    const withoutLoader = await moderateContent({ images: [url] }, { guards: [ImageGuardrail.create({ id: 'images', checks: [hash, model] })], context });
    expect(withoutLoader).toMatchObject(UNAVAILABLE);
    expect(hash.check).toHaveBeenCalledTimes(1);
    expect(events(lines, 'image_guard.check_failed')).toEqual([expect.objectContaining({ guardrailId: 'images', checkId: 'load', posture: 'refuse' })]);
    expect(JSON.stringify([decision, withoutLoader, lines])).not.toContain('images.example');
  });
});

describe('the image guard: a check that cannot answer', () => {
  it('(c) a check that throws refuses the image as unavailable, with one line that holds no error text', async () => {
    const lines = capture();
    const decision = await moderateContent({ images: [png(1)] }, { guards: [ImageGuardrail.create({ id: 'images', checks: [failing('model')] })], context });
    expect(decision).toMatchObject({ ...UNAVAILABLE, deciding: { reasonCode: 'IMAGE_CHECK_UNAVAILABLE', metadata: { failClosed: true, checkId: 'model', imageIndex: 0 } } });
    expect(events(lines, 'image_guard.check_failed')).toEqual([expect.objectContaining({ guardrailId: 'images', checkId: 'model', posture: 'refuse', type: 'Error', code: 'unknown' })]);
    expect(JSON.stringify(lines)).not.toContain('vendor is down');
  });

  it('(e) a signal that fails is skipped when another check judges the image, and refuses it when none does', async () => {
    const lines = capture();
    const signal = failing('signal', { onError: 'skip' });
    const judge = check('judge', 'classify', async () => ({ verdict: 'flag', reasonCode: 'IMAGE_SUGGESTIVE', scores: { sexual: 0.6 } }), { reasonCodes: ['IMAGE_SUGGESTIVE'] });
    const judged = await moderateContent({ images: [png(1)] }, { guards: [ImageGuardrail.create({ id: 'images', checks: [signal, judge] })], context });
    expect(judged).toMatchObject({ outcome: 'flag', unavailable: false, deciding: { reasonCode: 'IMAGE_SUGGESTIVE', metadata: { checkId: 'judge', scores: { sexual: 0.6 } } } });
    expect(events(lines, 'image_guard.check_failed')).toEqual([expect.objectContaining({ checkId: 'signal', posture: 'skip' })]);
    const alone = await moderateContent({ images: [png(1)] }, { guards: [ImageGuardrail.create({ id: 'images', checks: [signal] })], context });
    expect(alone).toMatchObject(UNAVAILABLE);
  });

  it('a check that answers no verdict counts as a check that threw: refused, or skipped when it is a signal', async () => {
    const lines = capture();
    const noVerdict = (id: string, extra: Partial<ImageCheck> = {}) => check(id, 'classify', async () => ({}) as never, extra);
    const refused = await moderateContent({ images: [png(1)] }, { guards: [ImageGuardrail.create({ id: 'images', checks: [noVerdict('model')] })], context });
    expect(refused).toMatchObject({ ...UNAVAILABLE, deciding: { reasonCode: 'IMAGE_CHECK_UNAVAILABLE', metadata: { checkId: 'model', imageIndex: 0 } } });
    const judge = passing('judge', 'classify');
    const skipped = await moderateContent({ images: [png(1)] }, { guards: [ImageGuardrail.create({ id: 'images', checks: [noVerdict('signal', { onError: 'skip' }), judge] })], context });
    expect(skipped.outcome).toBe('allow');
    expect(judge.check).toHaveBeenCalledTimes(1);
    expect(events(lines, 'image_guard.check_failed').map((line) => [line.checkId, line.posture])).toEqual([['model', 'refuse'], ['signal', 'skip']]);
  });

  it('(g) a passing match check does not judge an image: with the only model check skipped, the image is refused', async () => {
    const guard = ImageGuardrail.create({ id: 'images', checks: [passing('hash', 'match'), failing('signal', { onError: 'skip' })], requireMatch: true });
    const decision = await moderateContent({ images: [png(1)] }, { guards: [guard], context });
    expect(decision).toMatchObject(UNAVAILABLE);
    expect(decision.outcome).not.toBe('allow');
  });

  it('(d) more images than the guard takes are refused with no check run', async () => {
    const model = passing('model', 'classify');
    const guard = ImageGuardrail.create({ id: 'images', checks: [model], maxImages: 4 });
    const decision = await moderateContent({ images: [png(1), png(2), png(3), png(4), png(5)] }, { guards: [guard], context });
    expect(decision).toMatchObject({ outcome: 'refuse', unavailable: false, deciding: { reasonCode: 'IMAGE_LIMIT' } });
    expect(model.check).not.toHaveBeenCalled();
    expect((await moderateContent({ text: 'no image at all' }, { guards: [guard], context })).outcome).toBe('allow');
  });
});

describe('the image guard: what ends a chain', () => {
  it('a hold ends its image\'s chain, the other images go on, and the hold outranks an image nobody could judge', async () => {
    const first = check('first', 'classify', async (image) => (image.index === 0 ? { verdict: 'hold', reviewCode: 'IMAGE_REVIEW' } : { verdict: 'pass' }), { reasonCodes: ['IMAGE_REVIEW'] });
    const second = check('second', 'classify', async (image) => { if (image.index === 2) throw new Error('down'); return { verdict: 'pass' }; });
    const decision = await moderateContent({ images: [png(1), png(2), png(3)] }, { guards: [ImageGuardrail.create({ id: 'images', checks: [first, second] })], context });
    expect(decision).toMatchObject({ outcome: 'hold', unavailable: false, hold: { reviewCode: 'IMAGE_REVIEW' }, deciding: { metadata: { imageIndex: 0, checkId: 'first' } } });
    expect(second.check.mock.calls.map(([image]) => (image as ImageUnderReview).index)).toEqual([1, 2]);
  });

  it('a model check\'s quarantine ends the evaluation too: no further check runs on that image or any other', async () => {
    const first = check('first', 'classify', async (image) => (image.index === 0 ? { verdict: 'block', reasonCode: 'KNOWN_MATERIAL', quarantine: true } : { verdict: 'pass' }), { reasonCodes: ['KNOWN_MATERIAL'] });
    const second = passing('second', 'classify');
    const decision = await moderateContent({ images: [png(1), png(2)] }, { guards: [ImageGuardrail.create({ id: 'images', checks: [first, second] })], context });
    expect(decision).toMatchObject({ outcome: 'refuse', unavailable: false, deciding: { reasonCode: 'KNOWN_MATERIAL', metadata: { imageIndex: 0, checkId: 'first', quarantine: true } } });
    expect(first.check).toHaveBeenCalledTimes(1);
    expect(second.check).not.toHaveBeenCalled();
  });

  it('an image of a kind the guard cannot capture is refused at load and never handed to loadImage', async () => {
    const lines = capture();
    const loadImage = vi.fn(async () => ({ bytes: new Uint8Array([1]), mimeType: 'image/png' }));
    const model = passing('model', 'classify');
    const decision = await moderateContent({ images: [{ type: 'file', data: '/etc/hosts' } as unknown as VisionInputData] }, { guards: [ImageGuardrail.create({ id: 'images', checks: [model], loadImage })], context });
    expect(decision).toMatchObject({ ...UNAVAILABLE, deciding: { reasonCode: 'IMAGE_CHECK_UNAVAILABLE', metadata: { checkId: 'load', imageIndex: 0 } } });
    expect(loadImage).not.toHaveBeenCalled();
    expect(model.check).not.toHaveBeenCalled();
    expect(events(lines, 'image_guard.check_failed')).toEqual([expect.objectContaining({ checkId: 'load', posture: 'refuse' })]);
  });

  it('a code the host listed in stopVendorsOn stops every further model check, and the hold decides', async () => {
    const slowHash = check('hash', 'match', async () => { await new Promise((resolve) => setTimeout(resolve, 20)); return { verdict: 'pass' }; });
    const model = passing('model', 'classify');
    const signal: IGuardrailService = { id: 'signal', evaluateInput: async () => holdResult('STOP') };
    const guard = ImageGuardrail.create({ id: 'images', checks: [slowHash, model] });
    const stopped = await moderateContent({ text: 'a message', images: [png(1)] }, { guards: [signal, guard], context, stopVendorsOn: ['STOP'] });
    expect(stopped).toMatchObject({ outcome: 'hold', unavailable: false, hold: { reviewCode: 'STOP' } });
    expect(model.check).not.toHaveBeenCalled();
    await moderateContent({ text: 'a message', images: [png(1)] }, { guards: [signal, guard], context });
    expect(model.check).toHaveBeenCalledTimes(1);
  });

  it('every match check runs on an image after an earlier one held, blocked or failed on it, so a later quarantine is never missed', async () => {
    const model = passing('model', 'classify');
    const earlier: ImageCheck['check'][] = [
      async () => ({ verdict: 'hold', reviewCode: 'IMAGE_REVIEW' }),
      async () => ({ verdict: 'block', reasonCode: 'OWN_LIST' }),
      async () => { throw new Error('the list is down'); },
    ];
    for (const answer of earlier) {
      const ownList = check('own_list', 'match', answer, { reasonCodes: ['IMAGE_REVIEW', 'OWN_LIST'] });
      const hash = check('hash', 'match', async () => ({ verdict: 'block', reasonCode: 'KNOWN_MATERIAL', quarantine: true }), { reasonCodes: ['KNOWN_MATERIAL'] });
      const guard = ImageGuardrail.create({ id: 'images', checks: [ownList, hash, model], requireMatch: true });
      const decision = await moderateContent({ images: [png(1)] }, { guards: [guard], context });
      expect(decision).toMatchObject({ outcome: 'refuse', unavailable: false, deciding: { reasonCode: 'KNOWN_MATERIAL', metadata: { imageIndex: 0, checkId: 'hash', quarantine: true } } });
      expect(hash.check).toHaveBeenCalledTimes(1);
    }
    expect(model.check).not.toHaveBeenCalled();
  });

  it('a match check\'s block or failure still keeps its image from every model check, and the first block decides', async () => {
    const model = passing('model', 'classify');
    const ownList = check('own_list', 'match', async () => ({ verdict: 'block', reasonCode: 'OWN_LIST' }), { reasonCodes: ['OWN_LIST'] });
    const secondList = check('second_list', 'match', async () => ({ verdict: 'block', reasonCode: 'SECOND_LIST' }), { reasonCodes: ['SECOND_LIST'] });
    const blocked = await moderateContent({ images: [png(1)] }, { guards: [ImageGuardrail.create({ id: 'images', checks: [ownList, secondList, model] })], context });
    expect(blocked).toMatchObject({ outcome: 'refuse', unavailable: false, deciding: { reasonCode: 'OWN_LIST', metadata: { checkId: 'own_list' } } });
    expect(secondList.check).toHaveBeenCalledTimes(1);

    const down = check('own_list', 'match', async () => { throw new Error('the list is down'); });
    const hash = passing('hash', 'match');
    const refused = await moderateContent({ images: [png(1)] }, { guards: [ImageGuardrail.create({ id: 'images', checks: [down, hash, model] })], context });
    expect(refused).toMatchObject({ ...UNAVAILABLE, deciding: { metadata: { imageIndex: 0, checkId: 'own_list' } } });
    expect(hash.check).toHaveBeenCalledTimes(1);
    expect(model.check).not.toHaveBeenCalled();
  });
});

describe('the image guard: what an input or a check may carry', () => {
  const sized = (length: number): VisionInputData => ({ type: 'base64', data: Buffer.alloc(length, 1).toString('base64'), mimeType: 'image/png' });

  it('refuses an image over maxBytes with IMAGE_LIMIT and runs no check on it, while the other images are still checked', async () => {
    const hash = passing('hash', 'match');
    const model = passing('model', 'classify');
    const guard = ImageGuardrail.create({ id: 'images', checks: [hash, model], maxBytes: 8 });
    expect((await moderateContent({ images: [sized(8)] }, { guards: [guard], context })).outcome).toBe('allow');
    hash.check.mockClear();
    const decision = await moderateContent({ images: [png(1), sized(9)] }, { guards: [guard], context });
    expect(decision).toMatchObject({ outcome: 'refuse', unavailable: false, deciding: { reasonCode: 'IMAGE_LIMIT', metadata: { guardrailId: 'images', imageIndex: 1 } } });
    expect(hash.check.mock.calls.map(([image]) => (image as ImageUnderReview).index)).toEqual([0]);

    // the bytes a host's loadImage returns are held to the same limit
    const loadImage = vi.fn(async () => ({ bytes: new Uint8Array(9), mimeType: 'image/png' }));
    const loaded = await moderateContent({ images: [{ type: 'image_url', data: 'https://images.example/big.png' }] }, { guards: [ImageGuardrail.create({ id: 'images', checks: [model], loadImage, maxBytes: 8 })], context });
    expect(loaded).toMatchObject({ outcome: 'refuse', unavailable: false, deciding: { reasonCode: 'IMAGE_LIMIT', metadata: { imageIndex: 0 } } });
    expect(() => ImageGuardrail.create({ id: 'images', checks: [model], maxBytes: 0 })).toThrow(TypeError);
  });

  it('counts a block, a flag or a hold without a code that is a word as a check that could not answer', async () => {
    const answers = [
      { verdict: 'hold' },
      { verdict: 'block', reasonCode: 42 },
      { verdict: 'flag', reasonCode: '' },
    ];
    for (const answer of answers) {
      const model = check('model', 'classify', async () => answer as never);
      const refused = await moderateContent({ images: [png(1)] }, { guards: [ImageGuardrail.create({ id: 'images', checks: [model] })], context });
      expect(refused).toMatchObject({ ...UNAVAILABLE, deciding: { metadata: { checkId: 'model', imageIndex: 0 } } });
    }
    const judge = passing('judge', 'classify');
    const skipped = await moderateContent({ images: [png(1)] }, { guards: [ImageGuardrail.create({ id: 'images', checks: [check('signal', 'classify', async () => ({ verdict: 'hold' }) as never, { onError: 'skip' }), judge] })], context });
    expect(skipped.outcome).toBe('allow');
  });

  it('refuses to be built with reason codes that are not words or an onError it does not know', () => {
    const model = passing('model', 'classify');
    expect(() => ImageGuardrail.create({ id: 'images', checks: [{ ...model, reasonCodes: [''] }] })).toThrow(TypeError);
    expect(() => ImageGuardrail.create({ id: 'images', checks: [{ ...model, reasonCodes: ['X'.repeat(65)] }] })).toThrow(TypeError);
    expect(() => ImageGuardrail.create({ id: 'images', checks: [{ ...model, onError: 'ignore' as never }] })).toThrow(TypeError);
    expect(() => ImageGuardrail.create({ id: 'images', checks: [{ ...model, reasonCodes: ['IMAGE_SUGGESTIVE'], onError: 'skip' }, passing('judge', 'classify')] })).not.toThrow();
  });

  it('keeps the checks as they were when it was built: a later edit of a check object changes nothing', async () => {
    const quarantining = async () => ({ verdict: 'block', reasonCode: 'KNOWN_MATERIAL', quarantine: true }) as const;
    const hash = check('hash', 'match', quarantining, { reasonCodes: ['KNOWN_MATERIAL'] });
    const original = hash.check;
    const model = passing('model', 'classify');
    const checks: ImageCheck[] = [hash, model];
    const guard = ImageGuardrail.create({ id: 'images', checks, requireMatch: true });
    // the host edits the objects it handed over, and the list
    Object.assign(hash, { kind: 'classify', onError: 'skip', reasonCodes: [], check: vi.fn(async () => ({ verdict: 'pass' })) });
    checks.length = 0;
    const decision = await moderateContent({ images: [png(1)] }, { guards: [guard], context });
    expect(decision).toMatchObject({ outcome: 'refuse', unavailable: false, deciding: { reasonCode: 'KNOWN_MATERIAL', metadata: { checkId: 'hash', quarantine: true } } });
    expect(original).toHaveBeenCalledTimes(1);
    expect(model.check).not.toHaveBeenCalled();
    expect(guard.config.reasonCodes).toContain('KNOWN_MATERIAL');
  });

  it('keeps only a flag\'s scores that are finite numbers under word keys', async () => {
    const judge = check('judge', 'classify', async () => ({ verdict: 'flag', reasonCode: 'IMAGE_SUGGESTIVE', scores: { sexual: 0.6, 'a red car on a beach': 0.9, nan: Number.NaN, label: 'beach' as never } }), { reasonCodes: ['IMAGE_SUGGESTIVE'] });
    const decision = await moderateContent({ images: [png(1)] }, { guards: [ImageGuardrail.create({ id: 'images', checks: [judge] })], context });
    expect(decision.outcome).toBe('flag');
    expect((decision as unknown as { deciding: { metadata: Record<string, unknown> } }).deciding.metadata.scores).toEqual({ sexual: 0.6 });
  });

  it('decodes a data URL as base64 only when it says ;base64', async () => {
    const model = passing('model', 'classify');
    const guard = ImageGuardrail.create({ id: 'images', checks: [model] });
    const plain = await moderateContent({ images: [{ type: 'base64', data: 'data:image/png,AAAA' }] }, { guards: [guard], context });
    expect(plain).toMatchObject({ ...UNAVAILABLE, deciding: { metadata: { checkId: 'load' } } });
    expect(model.check).not.toHaveBeenCalled();
    const encoded = await moderateContent({ images: [{ type: 'base64', data: 'data:image/png;base64,AAAA' }] }, { guards: [guard], context });
    expect(encoded.outcome).toBe('allow');
    expect([...(model.check.mock.calls[0][0] as ImageUnderReview).bytes]).toEqual([0, 0, 0]);
  });
});

describe('the image guard: its deadline', () => {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it('starts no capture or check past its deadline, though the dispatcher answered and stopped waiting for it', async () => {
    const loadImage = vi.fn(async () => { await sleep(120); return { bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/png' }; });
    const hash = passing('hash', 'match');
    const model = passing('model', 'classify');
    const guard = ImageGuardrail.create({ id: 'images', checks: [hash, model], loadImage, timeoutMs: 40 });
    const slow: VisionInputData = { type: 'image_url', data: 'https://images.example/slow.jpg' };
    const decision = await moderateContent({ images: [slow, png(1)] }, { guards: [guard], context });
    expect(decision).toMatchObject({ outcome: 'refuse', unavailable: true, deciding: { reasonCode: 'GUARDRAIL_ERROR', metadata: { cause: 'timeout' } } });
    // the load resolves at 120 ms; the evaluation runs on to its end with nobody waiting
    await sleep(200);
    expect(loadImage).toHaveBeenCalledTimes(1);
    expect(hash.check).not.toHaveBeenCalled();
    expect(model.check).not.toHaveBeenCalled();
  });

  it('starts nothing once the dispatcher stops waiting, when a required guard\'s shorter deadline replaced its own', async () => {
    const loadImage = vi.fn(async () => { await sleep(120); return { bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/png' }; });
    const hash = passing('hash', 'match');
    const model = passing('model', 'classify');
    // the guard's own deadline is the default 15 s; as a required guard it runs under 40 ms
    const guard = withRequiredPosture('images', ImageGuardrail.create({ id: 'images', checks: [hash, model], loadImage }), { id: 'images', stages: ['input'], timeoutMs: 40 });
    const input = { userId: 'user-1', sessionId: 'session-1', textInput: null, visionInputs: [{ type: 'image_url', data: 'https://images.example/slow.jpg' }, png(1)] } as unknown as AgentOSInput;
    const outcome = await ParallelGuardrailDispatcher.evaluateInput([guard], input, context);
    expect(outcome.evaluation).toMatchObject({ action: 'block', reasonCode: 'GUARDRAIL_ERROR', metadata: { cause: 'timeout' } });
    await sleep(200);
    expect(loadImage).toHaveBeenCalledTimes(1);
    expect(hash.check).not.toHaveBeenCalled();
    expect(model.check).not.toHaveBeenCalled();
  });

  it('refuses as unavailable an image whose model checks had not all run by its deadline, a flag already given included', async () => {
    const first = check('first', 'classify', async () => { await sleep(60); return { verdict: 'flag', reasonCode: 'IMAGE_SUGGESTIVE' }; }, { reasonCodes: ['IMAGE_SUGGESTIVE'] });
    const strict = passing('strict', 'classify');
    const guard = ImageGuardrail.create({ id: 'images', checks: [first, strict], timeoutMs: 40 });
    // the guard's own answer, as a dispatcher with a longer deadline (a required guard's) reads it
    const input = { userId: 'user-1', sessionId: 'session-1', textInput: null, visionInputs: [png(1)] } as unknown as AgentOSInput;
    const answer = await guard.evaluateInput({ context, input });
    expect(answer).toMatchObject({ action: 'block', reasonCode: 'IMAGE_CHECK_UNAVAILABLE', metadata: { failClosed: true, imageIndex: 0, checkId: 'strict' } });
    expect(strict.check).not.toHaveBeenCalled();
  });
});

describe('the image guard: the deadline every check receives', () => {
  // The clock is the test's own: a deadline passes only when the test moves it, and only once the step it means to stop
  // has started, so a slow runner cannot pass a deadline before a check begins.
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const timedOut = { action: 'block', reasonCode: 'GUARDRAIL_ERROR', metadata: { cause: 'timeout' } };
  const oneImage = () => ({ userId: 'user-1', sessionId: 'session-1', textInput: null, visionInputs: [png(1)] }) as unknown as AgentOSInput;
  /** The guard as a required guard runs it, under a dispatcher deadline of `timeoutMs`. */
  const required = (guard: ImageGuardrail, timeoutMs: number) => withRequiredPosture('images', guard, { id: 'images', stages: ['input'], timeoutMs });
  /** Counts the times a step is reached; `reached(n)` settles once it has been reached n times, whatever the clock says. */
  function arrivals() {
    let count = 0;
    const waiting: { n: number; resolve: () => void }[] = [];
    return {
      arrive(): void { count += 1; for (const wait of waiting) if (wait.n <= count) wait.resolve(); },
      reached(n: number): Promise<void> { return n <= count ? Promise.resolve() : new Promise((resolve) => { waiting.push({ n, resolve }); }); },
    };
  }
  /** The vendor's endpoint: answers 100 ms after a request, or at once refuses one whose signal aborts. */
  function vendor() {
    let stopped = 0;
    const sent = arrivals();
    const requests = vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => new Promise<Response>((resolve, reject) => {
      const answer = setTimeout(() => resolve(new Response('{"flagged":false}')), 100);
      init?.signal?.addEventListener('abort', () => { stopped += 1; clearTimeout(answer); reject(new Error('the request was stopped')); }, { once: true });
      sent.arrive();
    }));
    return { requests, stopped: () => stopped, sent };
  }
  /** A model check that waits 100 ms (a key lookup) and then sends the image, unless its deadline stopped first. */
  const lateSender = (told: boolean[], begun: ReturnType<typeof arrivals>, signals: (AbortSignal | undefined)[] = []) => check('model', 'classify', async (image) => {
    signals.push(image.deadlineSignal);
    begun.arrive();
    await sleep(100);
    const deadline = image.deadlineSignal;
    told.push(deadline?.aborted === true);
    if (deadline?.aborted) throw new Error('stopped before sending');
    await fetch('https://vendor.example/moderate', { method: 'POST', signal: deadline });
    return { verdict: 'pass' };
  });

  it('stops at the deadline: a check still waiting when the dispatcher answered sends nothing, and a request in flight is stopped', async () => {
    const { requests, stopped, sent } = vendor();
    const begun = arrivals();
    const told: boolean[] = [];

    // the guard's own deadline, which the dispatcher's equals: either answer is a refusal nobody could judge
    const own = moderateContent({ images: [png(1)] }, { guards: [ImageGuardrail.create({ id: 'images', timeoutMs: 10, checks: [lateSender(told, begun)] })], context });
    await begun.reached(1);
    await vi.advanceTimersByTimeAsync(10);
    expect(await own).toMatchObject({ outcome: 'refuse', unavailable: true });

    // a required guard's shorter deadline, the dispatcher's: the guard's own is the default 15 s
    const answered = ParallelGuardrailDispatcher.evaluateInput([required(ImageGuardrail.create({ id: 'images', checks: [lateSender(told, begun)] }), 10)], oneImage(), context);
    await begun.reached(2);
    await vi.advanceTimersByTimeAsync(10);
    expect((await answered).evaluation).toMatchObject(timedOut);

    // both checks wake 100 ms after they started, after the dispatcher answered: told to stop, they send nothing
    await vi.advanceTimersByTimeAsync(100);
    expect(told).toEqual([true, true]);
    expect(requests).not.toHaveBeenCalled();

    // a check that hands the signal to its request: the request already sent is stopped at the deadline
    const inFlight = check('model', 'classify', async (image) => {
      await fetch('https://vendor.example/moderate', { method: 'POST', signal: image.deadlineSignal });
      return { verdict: 'pass' };
    });
    const decision = moderateContent({ images: [png(1)] }, { guards: [ImageGuardrail.create({ id: 'images', timeoutMs: 10, checks: [inFlight] })], context });
    await sent.reached(1);
    await vi.advanceTimersByTimeAsync(10);
    // the stopped request throws, so the guard may answer the image unavailable before the dispatcher's timeout does
    expect(await decision).toMatchObject({ outcome: 'refuse', unavailable: true });
    expect(requests).toHaveBeenCalledTimes(1);
    expect(stopped()).toBe(1);
  });

  it('stops a check at the guard\'s own deadline when the dispatcher would wait longer', async () => {
    const { requests } = vendor();
    const begun = arrivals();
    const told: boolean[] = [];
    const signals: (AbortSignal | undefined)[] = [];
    // the guard's own deadline is 10 ms; as a required guard the dispatcher waits 1 s for it
    const answered = ParallelGuardrailDispatcher.evaluateInput([required(ImageGuardrail.create({ id: 'images', timeoutMs: 10, checks: [lateSender(told, begun, signals)] }), 1_000)], oneImage(), context);
    await begun.reached(1);
    await vi.advanceTimersByTimeAsync(9);
    expect(signals[0]?.aborted).toBe(false);
    // the guard's own deadline passes, long before the dispatcher's and before the check wakes to send
    await vi.advanceTimersByTimeAsync(1);
    expect(signals[0]?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(90);
    // the guard answers itself, ahead of the dispatcher's deadline: the image is refused, and nothing was sent
    expect((await answered).evaluation).toMatchObject({ action: 'block', reasonCode: 'IMAGE_CHECK_UNAVAILABLE', metadata: { failClosed: true, imageIndex: 0, checkId: 'model' } });
    expect(told).toEqual([true]);
    expect(requests).not.toHaveBeenCalled();
  });

  it('lets go of its own timer once the dispatcher has answered, though a check never settles', async () => {
    capture();
    const begun = arrivals();
    const signals: (AbortSignal | undefined)[] = [];
    const stuck = check('model', 'classify', (image) => {
      signals.push(image.deadlineSignal);
      begun.arrive();
      return new Promise<never>(() => undefined);
    });
    // the guard's own deadline is the default 15 s; as a required guard it runs under 10 ms
    const answered = ParallelGuardrailDispatcher.evaluateInput([required(ImageGuardrail.create({ id: 'images', checks: [stuck] }), 10)], oneImage(), context);
    await begun.reached(1);
    await vi.advanceTimersByTimeAsync(10);
    expect((await answered).evaluation).toMatchObject(timedOut);
    expect(signals[0]?.aborted).toBe(true);
    // nothing of the evaluation is left on the clock to keep a process alive: the guard's 15 s timer went with the answer
    expect(vi.getTimerCount()).toBe(0);
  });

  it('is live while the checks run and stopped once the guard has answered', async () => {
    const seen: { signal: AbortSignal | undefined; stoppedThen: boolean }[] = [];
    const recording: ImageCheck['check'] = async (image) => {
      const signal = image.deadlineSignal;
      seen.push({ signal, stoppedThen: signal?.aborted === true });
      return { verdict: 'pass' };
    };
    const guard = ImageGuardrail.create({ id: 'images', checks: [check('hash', 'match', recording), check('model', 'classify', recording)] });
    const decision = await moderateContent({ images: [png(1), png(2)] }, { guards: [guard], context });
    expect(decision.outcome).toBe('allow');
    expect(seen).toHaveLength(4);
    expect(seen.every(({ signal }) => signal instanceof AbortSignal)).toBe(true);
    expect(seen.map(({ stoppedThen }) => stoppedThen)).toEqual([false, false, false, false]);
    expect(seen.every(({ signal }) => signal?.aborted === true)).toBe(true);
  });

  it('refuses as unavailable an image whose last check the deadline stopped, though an earlier check passed it', async () => {
    const { requests, stopped, sent } = vendor();
    const first = passing('first', 'classify');
    // a signal whose stopped request throws and is skipped, and a check that answers pass once its request is stopped
    const skipped = check('signal', 'classify', async (image) => {
      await fetch('https://vendor.example/moderate', { method: 'POST', signal: image.deadlineSignal });
      return { verdict: 'pass' };
    }, { onError: 'skip' });
    const lenient = check('lenient', 'classify', async (image) => {
      try { await fetch('https://vendor.example/moderate', { method: 'POST', signal: image.deadlineSignal }); } catch { /* stopped */ }
      return { verdict: 'pass' };
    });
    for (const [n, last] of [skipped, lenient].entries()) {
      // the guard's own 10 ms deadline; the dispatcher waits 1 s, so what is read is the guard's own answer
      const answered = ParallelGuardrailDispatcher.evaluateInput([required(ImageGuardrail.create({ id: 'images', timeoutMs: 10, checks: [first, last] }), 1_000)], oneImage(), context);
      await sent.reached(n + 1);
      await vi.advanceTimersByTimeAsync(10);
      // past its deadline the guard's own answer is never an allow
      expect((await answered).evaluation).toMatchObject({ action: 'block', reasonCode: 'IMAGE_CHECK_UNAVAILABLE', metadata: { failClosed: true, imageIndex: 0, checkId: last.id } });
    }
    expect(requests).toHaveBeenCalledTimes(2);
    expect(stopped()).toBe(2);
  });

  it('keeps a block or a hold the last check answers past the deadline, and refuses a flag it answers then', async () => {
    const begun = arrivals();
    const stoppedThen: boolean[] = [];
    // checks that ignore the signal: each answers 100 ms after it starts, long past the guard's own 10 ms deadline
    const lateAnswer = (id: string, answer: Awaited<ReturnType<ImageCheck['check']>>, code: string) => check(id, 'classify', async (image) => {
      begun.arrive();
      await sleep(100);
      stoppedThen.push(image.deadlineSignal?.aborted === true);
      return answer;
    }, { reasonCodes: [code] });
    const first = passing('first', 'classify');
    const cases: [ImageCheck, Record<string, unknown>][] = [
      [lateAnswer('blocking', { verdict: 'block', reasonCode: 'IMAGE_EXPLICIT' }, 'IMAGE_EXPLICIT'), { action: 'block', reasonCode: 'IMAGE_EXPLICIT', metadata: { imageIndex: 0, checkId: 'blocking' } }],
      [lateAnswer('holding', { verdict: 'hold', reviewCode: 'IMAGE_REVIEW' }, 'IMAGE_REVIEW'), { action: 'block', hold: { reviewCode: 'IMAGE_REVIEW' }, metadata: { imageIndex: 0, checkId: 'holding' } }],
      [lateAnswer('flagging', { verdict: 'flag', reasonCode: 'IMAGE_SUGGESTIVE' }, 'IMAGE_SUGGESTIVE'), { action: 'block', reasonCode: 'IMAGE_CHECK_UNAVAILABLE', metadata: { failClosed: true, imageIndex: 0, checkId: 'flagging' } }],
    ];
    for (const [n, [last, expected]] of cases.entries()) {
      // the dispatcher waits 1 s, so what is read is the guard's own answer, given 100 ms in
      const answered = ParallelGuardrailDispatcher.evaluateInput([required(ImageGuardrail.create({ id: 'images', timeoutMs: 10, checks: [first, last] }), 1_000)], oneImage(), context);
      await begun.reached(n + 1);
      await vi.advanceTimersByTimeAsync(100);
      // a check's block or hold outranks an image nobody could judge; a flag past the deadline is no judgment
      expect((await answered).evaluation).toMatchObject(expected);
    }
    // every answer came after the deadline had stopped its check
    expect(stoppedThen).toEqual([true, true, true]);
  });
});
