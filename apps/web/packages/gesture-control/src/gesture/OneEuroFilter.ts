// One-Euro filter — low-latency smoothing for noisy interactive signals.
// Heavy smoothing when the value is still (kills jitter), low lag when it moves
// fast. The correct tool for raw landmark streams, which jitter several pixels
// even when the hand is held still.
//
// Reference: Casiez, Roussel, Vogel — "1€ Filter" (CHI 2012),
// http://cristal.univ-lille.fr/~casiez/1euro/
//
// One filter handles a single scalar; use one instance per axis (x, y).

/** Smoothing factor for a low-pass step given a cutoff (Hz) and timestep (s). */
function smoothingAlpha(cutoffHz: number, dtSec: number): number {
  const tau = 1 / (2 * Math.PI * cutoffHz);
  return 1 / (1 + tau / dtSec);
}

/** Exponential low-pass that remembers its last output. */
class LowPass {
  private value: number | null = null;

  filter(x: number, alpha: number): number {
    this.value = this.value === null ? x : alpha * x + (1 - alpha) * this.value;
    return this.value;
  }

  reset(): void {
    this.value = null;
  }

  get initialized(): boolean {
    return this.value !== null;
  }
}

export class OneEuroFilter {
  private readonly signal = new LowPass();
  private readonly derivative = new LowPass();
  private lastTimeSec: number | null = null;
  private lastRaw = 0;

  /**
   * @param minCutoff Baseline cutoff (Hz). Lower → smoother but laggier when still.
   * @param beta      Speed coefficient. Higher → less lag during fast moves.
   * @param dCutoff   Cutoff for the derivative low-pass (Hz). 1.0 is fine.
   */
  constructor(
    private minCutoff = 1.0,
    private beta = 0.01,
    private dCutoff = 1.0
  ) {}

  reset(): void {
    this.signal.reset();
    this.derivative.reset();
    this.lastTimeSec = null;
    this.lastRaw = 0;
  }

  /** @param timeSec strictly-increasing timestamp in seconds. */
  filter(x: number, timeSec: number): number {
    let dt = this.lastTimeSec === null ? 1 / 60 : timeSec - this.lastTimeSec;
    if (dt <= 0) dt = 1 / 60;
    this.lastTimeSec = timeSec;

    // Rate of change, itself low-passed, drives the adaptive cutoff.
    const dRaw = this.signal.initialized ? (x - this.lastRaw) / dt : 0;
    this.lastRaw = x;
    const edRaw = this.derivative.filter(dRaw, smoothingAlpha(this.dCutoff, dt));

    const cutoff = this.minCutoff + this.beta * Math.abs(edRaw);
    return this.signal.filter(x, smoothingAlpha(cutoff, dt));
  }
}
