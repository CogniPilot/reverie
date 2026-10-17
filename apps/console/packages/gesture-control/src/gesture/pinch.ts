// Pinch detection from hand landmarks.
//
// Distance between thumb tip (4) and index tip (8), normalized by hand size
// (wrist 0 → middle-finger MCP 9) so the threshold is robust to how close the
// hand is to the camera. Hysteresis + N-frame persistence keep the grab/release
// edge from flickering — critical for not "dropping" a tab mid-drag.

import { LANDMARK, dist2d, type NormalizedLandmark } from './landmarks.ts';

/**
 * Thumb-tip→index-tip distance as a fraction of hand size. Smaller = more
 * pinched. Roughly in [0, ~1.5]; ~0.35 is a firm pinch, ~0.5+ is open.
 */
export function pinchDistance(landmarks: NormalizedLandmark[]): number {
  const thumb = landmarks[LANDMARK.THUMB_TIP];
  const index = landmarks[LANDMARK.INDEX_TIP];
  const wrist = landmarks[LANDMARK.WRIST];
  const middleMcp = landmarks[LANDMARK.MIDDLE_MCP];
  const handSize = dist2d(wrist, middleMcp) || 1e-6;
  return dist2d(thumb, index) / handSize;
}

/**
 * Tracks pinch state with two thresholds (hysteresis) and a persistence count.
 * Enter a pinch below `onThreshold`; leave it only above `offThreshold`
 * (offThreshold > onThreshold). A flip must hold for `persistFrames` frames
 * before it commits, rejecting single-frame noise.
 */
export class PinchDetector {
  private pinching = false;
  private pendingFrames = 0;

  constructor(
    private onThreshold = 0.35,
    private offThreshold = 0.5,
    private persistFrames = 2
  ) {}

  reset(): void {
    this.pinching = false;
    this.pendingFrames = 0;
  }

  get isPinching(): boolean {
    return this.pinching;
  }

  /** Feed one frame's distance. Returns true if the committed state CHANGED. */
  update(distance: number): boolean {
    const target = this.pinching
      ? distance < this.offThreshold // stay pinched until the hand opens wide
      : distance < this.onThreshold; // start pinching once fingers close

    if (target === this.pinching) {
      this.pendingFrames = 0;
      return false;
    }

    this.pendingFrames += 1;
    if (this.pendingFrames >= this.persistFrames) {
      this.pinching = target;
      this.pendingFrames = 0;
      return true;
    }
    return false;
  }
}
