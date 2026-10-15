/**
 * @module voice-pipeline/AudioWindowRing
 *
 * The fixed eight-second sample window an audio endpoint model evaluates.
 * It is separate from the recognition replay ring ({@link AudioRingBuffer}):
 * it truncates at sample granularity and pads a short window on the side the
 * model's manifest names.
 */

/** Exactly eight seconds of normalized mono input for an audio endpoint model. */
export class AudioWindowRing {
  private readonly samples = new Float32Array(128000);
  private cursor = 0;
  private count = 0;

  /** Retained sample count, never including manifest padding. */
  get length(): number {
    return this.count;
  }

  /** Copies the newest samples and truncates at sample granularity, even for an oversized frame. */
  push(input: Float32Array): void {
    for (let i = Math.max(0, input.length - this.samples.length); i < input.length; i++) {
      this.samples[this.cursor] = input[i]!;
      this.cursor = (this.cursor + 1) % this.samples.length;
      this.count = Math.min(this.count + 1, this.samples.length);
    }
  }

  /** Returns a private fixed-size model input. The model manifest chooses the padding side. */
  window(padding: 'left' | 'right'): Float32Array {
    if (padding !== 'left' && padding !== 'right') throw new Error('invalid window padding');
    const out = new Float32Array(this.samples.length);
    const offset = padding === 'left' ? out.length - this.count : 0;
    const start = (this.cursor - this.count + this.samples.length) % this.samples.length;
    for (let i = 0; i < this.count; i++) out[offset + i] = this.samples[(start + i) % this.samples.length]!;
    return out;
  }

  /** Erases retained audio on turn completion, interruption, gap, detach and disposal. */
  reset(): void {
    this.samples.fill(0);
    this.cursor = 0;
    this.count = 0;
  }
}
