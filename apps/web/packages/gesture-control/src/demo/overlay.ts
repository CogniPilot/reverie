// Debug overlay: draws the 21-point hand skeleton over the (mirrored) video.
//
// The <video> is mirrored via CSS (transform: scaleX(-1)). To make the drawn
// skeleton line up with what you see, we mirror the X coordinate here
// (x_draw = (1 - x) * width) rather than CSS-mirroring the canvas — that keeps
// any future text we draw readable.

import type { GestureRecognizerResult } from '@mediapipe/tasks-vision';
import { HAND_CONNECTIONS } from '../gesture/landmarks.ts';

/** A cursor to draw: raw normalized position + base color + pinch state. */
export interface CursorMark {
  x: number;
  y: number;
  color: string;
  pinching: boolean;
}

export class Overlay {
  private ctx: CanvasRenderingContext2D;

  constructor(
    private canvas: HTMLCanvasElement,
    private video: HTMLVideoElement
  ) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not get 2D context for overlay canvas');
    this.ctx = ctx;
  }

  /** Match the canvas backing-store resolution to the displayed video size. */
  private syncSize(): void {
    const w = this.video.videoWidth || this.video.clientWidth;
    const h = this.video.videoHeight || this.video.clientHeight;
    if (w && h && (this.canvas.width !== w || this.canvas.height !== h)) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  clear(): void {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  /**
   * Draw the detected hands' skeletons plus one smoothed cursor per hand.
   * Cursor coords are raw normalized [0,1] (mirrored here, like the skeleton).
   */
  draw(result: GestureRecognizerResult, cursors: CursorMark[] = []): void {
    this.syncSize();
    const { width: w, height: h } = this.canvas;
    const ctx = this.ctx;
    ctx.clearRect(0, 0, w, h);

    const hands = result.landmarks ?? [];
    for (const landmarks of hands) {
      // Connections (bones)
      ctx.strokeStyle = 'rgba(80, 220, 255, 0.9)';
      ctx.lineWidth = 3;
      for (const [a, b] of HAND_CONNECTIONS) {
        const pa = landmarks[a];
        const pb = landmarks[b];
        if (!pa || !pb) continue;
        ctx.beginPath();
        ctx.moveTo((1 - pa.x) * w, pa.y * h);
        ctx.lineTo((1 - pb.x) * w, pb.y * h);
        ctx.stroke();
      }

      // Joints (points)
      for (let i = 0; i < landmarks.length; i++) {
        const p = landmarks[i];
        const x = (1 - p.x) * w;
        const y = p.y * h;
        // Highlight thumb tip (4) + index tip (8) — these drive the cursor later.
        const isPinchPoint = i === 4 || i === 8;
        ctx.fillStyle = isPinchPoint ? '#ffd166' : '#ff5d8f';
        ctx.beginPath();
        ctx.arc(x, y, isPinchPoint ? 7 : 4, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    for (const c of cursors) this.drawCursor(c, w, h);
  }

  /** A ring + crosshair at the cursor; green + filled while pinching. */
  private drawCursor(cursor: CursorMark, w: number, h: number): void {
    const ctx = this.ctx;
    const cx = (1 - cursor.x) * w; // mirror X to match the displayed video
    const cy = cursor.y * h;
    const pinching = cursor.pinching;
    const r = pinching ? 16 : 12;
    const color = pinching ? '#4ade80' : cursor.color;

    if (pinching) {
      ctx.fillStyle = 'rgba(74, 222, 128, 0.25)';
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(cx - r - 5, cy);
    ctx.lineTo(cx - r + 4, cy);
    ctx.moveTo(cx + r - 4, cy);
    ctx.lineTo(cx + r + 5, cy);
    ctx.moveTo(cx, cy - r - 5);
    ctx.lineTo(cx, cy - r + 4);
    ctx.moveTo(cx, cy + r - 4);
    ctx.lineTo(cx, cy + r + 5);
    ctx.stroke();
  }
}
