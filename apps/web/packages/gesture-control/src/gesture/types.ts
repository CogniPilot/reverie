// Shared types for the gesture input layer.
//
// Phase 0/1 scope: only `status` and `results` (debug) events are emitted yet.
// The semantic events (hover/grab/drag/drop/command) are declared here so the
// public API shape is stable, but they are wired in later phases.

import type { GestureRecognizerResult } from '@mediapipe/tasks-vision';

export interface GestureControllerOptions {
  /** The <video> element the camera stream is attached to. */
  video: HTMLVideoElement;
  /** Element whose bounding rect normalized coords are mapped against. Defaults to video. (Used from Phase 2.) */
  surface?: HTMLElement;
  /** Number of hands to track. v1 = 1. */
  numHands?: number;
  /** Pinch hysteresis thresholds (fractions of hand-size). Used from Phase 2. */
  pinchOn?: number;
  pinchOff?: number;
  /** One-Euro cursor smoothing. Lower minCutoff = smoother/laggier when still;
   *  higher beta = less lag during fast moves. Used from Phase 2. */
  minCutoff?: number;
  beta?: number;
  /** How long Open_Palm must be held to fire halt-all. Used from Phase 4. */
  palmHoldMs?: number;
  /** Specific camera to open (from enumerateDevices). Empty = default facingMode "user". */
  deviceId?: string;
  /** MediaPipe detection/tracking confidence. */
  minDetectionConfidence?: number;
  minTrackingConfidence?: number;
  /** CDN base used to load the wasm fileset + .task model. */
  wasmBase?: string;
  modelUrl?: string;
}

export type CommandName = 'halt-all' | 'approve' | 'new-session';

/** Per-hand state for the current frame. */
export interface HandState {
  /** "Left" / "Right" as reported by MediaPipe (image-space). Used to key filters. */
  handedness: string;
  /** Smoothed cursor in raw (unmirrored) normalized [0,1] coords; consumers mirror X. */
  cursor: { x: number; y: number };
  /** Thumb/index distance as a fraction of hand size. */
  pinchDist: number;
  /** Whether this hand is currently pinching (after hysteresis). */
  pinching: boolean;
  /** Top gesture category for this hand, if any. */
  gesture: string | null;
}

/** A pointer sample for one hand, in surface pixel coords (origin = surface
 *  top-left, X already mirrored to match the displayed video). */
export interface HandPointer {
  hand: string;
  x: number;
  y: number;
}

/** Payloads emitted per event name. */
export interface GestureEventMap {
  /** Pinch just closed — start of a drag. */
  grab: HandPointer;
  /** Cursor moved while pinched — emitted every frame during a drag. */
  drag: HandPointer;
  /** Pinch released (or the hand vanished mid-pinch) — end of a drag. */
  drop: HandPointer;
  command: { name: CommandName };
  status: {
    fps: number;
    /** One entry per detected hand (0–`numHands`). */
    hands: HandState[];
    /** 0–1 charge of the held Open_Palm halt-all gesture (Phase 4). */
    haltProgress: number;
  };
  /** Debug-only: the raw recognizer result for the current frame (drives the overlay). */
  results: { result: GestureRecognizerResult; timestampMs: number };
}

export type GestureEventName = keyof GestureEventMap;
export type GestureEventHandler<K extends GestureEventName> = (payload: GestureEventMap[K]) => void;
