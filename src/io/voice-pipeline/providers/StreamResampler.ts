/**
 * @module voice-pipeline/providers/StreamResampler
 *
 * Phase-preserving mono resampling shared by the streaming adapters, so live
 * frames and a chain's replayed frames take the same conversion path.
 */

/**
 * Linear-interpolation resampler for a stream of mono Float32 frames. It keeps
 * its place across frames: output sample `k` lies at input position
 * `k * fromRate / toRate`, counted from the first frame at the current rate,
 * and is produced once the input reaches that position. So the audio it
 * produces stays as long as the audio it was given, at most one input sample
 * behind, however the frames are cut. Rounding each frame's length on its own
 * drifts instead: 128 samples at 44.1 kHz would become 70 at 24 kHz every
 * time where 69.66 are due, 0.49 percent more audio than was pushed.
 */
export class StreamResampler {
  /** Rate of the frames so far; a frame at another rate starts the count again. */
  private fromRate = 0;
  /** Input samples taken at the current rate. */
  private consumed = 0;
  /** Output samples produced at the current rate. */
  private produced = 0;
  /** The last sample of the previous frame, for an output that falls between two frames. */
  private previous = 0;

  /**
   * @param toRate - The output rate, in samples per second.
   * @throws {RangeError} For a rate that is not a positive whole number.
   */
  constructor(private readonly toRate: number) {
    if (!Number.isSafeInteger(toRate) || toRate <= 0) throw new RangeError('invalid output sample rate');
  }

  /**
   * Resamples one frame. Its output's length follows the audio given so far,
   * not the frame alone, so it varies by a sample from frame to frame; a rate
   * change starts a new input timeline.
   *
   * @param input - Mono samples in [-1, 1].
   * @param fromRate - The frame's rate, in samples per second.
   * @returns The samples at the output rate: the input itself when the rates match.
   * @throws {RangeError} For a rate that is not a positive whole number, or a sample that is not finite.
   */
  process(input: Float32Array, fromRate: number): Float32Array {
    if (!Number.isSafeInteger(fromRate) || fromRate <= 0) throw new RangeError('invalid input sample rate');
    for (const sample of input) if (!Number.isFinite(sample)) throw new RangeError('invalid PCM sample');
    if (input.length === 0) return input;
    if (fromRate !== this.fromRate) {
      this.fromRate = fromRate;
      this.consumed = 0;
      this.produced = 0;
    }
    if (fromRate === this.toRate) return input;
    const first = this.consumed;
    const last = first + input.length - 1;
    // Output sample k is due once the input reaches k * fromRate / toRate (whole numbers, so exact).
    const due = Math.floor((last * this.toRate) / fromRate) + 1;
    const output = new Float32Array(Math.max(0, due - this.produced));
    for (let i = 0; i < output.length; i++) {
      const scaled = (this.produced + i) * fromRate;
      const left = Math.floor(scaled / this.toRate);
      const fraction = (scaled - left * this.toRate) / this.toRate;
      const a = left < first ? this.previous : input[left - first]!;
      const b = fraction === 0 ? a : input[left + 1 - first]!;
      output[i] = a + (b - a) * fraction;
    }
    this.produced += output.length;
    this.consumed = last + 1;
    this.previous = input[input.length - 1]!;
    return output;
  }
}
