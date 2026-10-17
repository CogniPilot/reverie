// GestureController — core input layer.
//
// Phase 0/1 scope (this file currently implements):
//   - Open the webcam (getUserMedia) and attach it to a <video>.
//   - Load MediaPipe GestureRecognizer in VIDEO mode (wasm + .task from CDN).
//   - Run a requestAnimationFrame loop calling recognizeForVideo().
//   - Emit `status` (fps / handPresent / gesture) and `results` (raw, debug).
//
// Later phases add the cursor (One-Euro filtered), pinch hysteresis, the
// hover/grab/drag/drop state machine, and the discrete gesture command bus.
// The event surface in types.ts already declares those so the API is stable.

import { FilesetResolver, GestureRecognizer, type GestureRecognizerResult } from '@mediapipe/tasks-vision';
import type {
  GestureControllerOptions,
  GestureEventHandler,
  GestureEventMap,
  GestureEventName,
  HandState,
} from './types.ts';
import { LANDMARK, midpoint } from './landmarks.ts';
import { OneEuroFilter } from './OneEuroFilter.ts';
import { PinchDetector, pinchDistance } from './pinch.ts';
import { CommandDetector } from './commands.ts';

const DEFAULTS = {
  numHands: 1,
  deviceId: '',
  pinchOn: 0.35,
  pinchOff: 0.5,
  minCutoff: 1.0,
  beta: 0.01,
  palmHoldMs: 1000,
  minDetectionConfidence: 0.6,
  minTrackingConfidence: 0.6,
  // Pinned to the @mediapipe/tasks-vision version in package.json.
  wasmBase: 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21/wasm',
  modelUrl:
    'https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task',
} as const;

interface PerHandState {
  cursorX: OneEuroFilter;
  cursorY: OneEuroFilter;
  pinch: PinchDetector;
  /** Original handedness label (the map key may be disambiguated). */
  label: string;
  /** Last emitted surface-pixel position, so we can drop on a vanished hand. */
  lastX: number;
  lastY: number;
}

export class GestureController {
  private readonly opts: Required<GestureControllerOptions>;
  private recognizer: GestureRecognizer | null = null;
  private stream: MediaStream | null = null;
  private rafId: number | null = null;
  private running = false;

  // Timestamps must be strictly increasing for recognizeForVideo.
  private lastVideoTime = -1;
  private lastTimestamp = -1;

  // FPS tracking (rolling over a short window).
  private frameTimes: number[] = [];

  // Per-hand smoothing + pinch state, keyed by handedness ("Left"/"Right") so a
  // hand keeps its own filters even when MediaPipe reorders the hands array.
  private readonly handStates = new Map<string, PerHandState>();

  // Discrete gesture → command bus (debounced; Open_Palm held = halt-all).
  private readonly commands: CommandDetector;

  // Internal storage is intentionally loose; the public on/off/emit signatures
  // below keep callers fully type-safe per event name.
  private listeners: Partial<Record<GestureEventName, Set<(payload: unknown) => void>>> = {};

  constructor(options: GestureControllerOptions) {
    this.opts = {
      surface: options.surface ?? options.video,
      numHands: options.numHands ?? DEFAULTS.numHands,
      deviceId: options.deviceId ?? DEFAULTS.deviceId,
      pinchOn: options.pinchOn ?? DEFAULTS.pinchOn,
      pinchOff: options.pinchOff ?? DEFAULTS.pinchOff,
      minCutoff: options.minCutoff ?? DEFAULTS.minCutoff,
      beta: options.beta ?? DEFAULTS.beta,
      palmHoldMs: options.palmHoldMs ?? DEFAULTS.palmHoldMs,
      minDetectionConfidence: options.minDetectionConfidence ?? DEFAULTS.minDetectionConfidence,
      minTrackingConfidence: options.minTrackingConfidence ?? DEFAULTS.minTrackingConfidence,
      wasmBase: options.wasmBase ?? DEFAULTS.wasmBase,
      modelUrl: options.modelUrl ?? DEFAULTS.modelUrl,
      video: options.video,
    };

    this.commands = new CommandDetector(this.opts.palmHoldMs);
  }

  /** Get (or lazily create) the smoothing + pinch state for one hand. */
  private handState(key: string): PerHandState {
    let state = this.handStates.get(key);
    if (!state) {
      state = {
        cursorX: new OneEuroFilter(this.opts.minCutoff, this.opts.beta),
        cursorY: new OneEuroFilter(this.opts.minCutoff, this.opts.beta),
        pinch: new PinchDetector(this.opts.pinchOn, this.opts.pinchOff),
        label: key,
        lastX: 0,
        lastY: 0,
      };
      this.handStates.set(key, state);
    }
    return state;
  }

  // ---- Event emitter ---------------------------------------------------

  on<K extends GestureEventName>(event: K, handler: GestureEventHandler<K>): this {
    (this.listeners[event] ??= new Set()).add(handler as (payload: unknown) => void);
    return this;
  }

  off<K extends GestureEventName>(event: K, handler: GestureEventHandler<K>): this {
    this.listeners[event]?.delete(handler as (payload: unknown) => void);
    return this;
  }

  private emit<K extends GestureEventName>(event: K, payload: GestureEventMap[K]): void {
    this.listeners[event]?.forEach((h) => h(payload));
  }

  // ---- Lifecycle -------------------------------------------------------

  /** Request the camera, load the model, and start the recognition loop. */
  async start(): Promise<void> {
    if (this.running) return;

    await this.openCamera();
    await this.loadRecognizer();

    this.running = true;
    this.lastVideoTime = -1;
    this.lastTimestamp = -1;
    this.frameTimes = [];
    this.handStates.clear();
    this.commands.reset();
    this.loop();
  }

  /** Stop the loop, release the camera, and close the recognizer. */
  stop(): void {
    this.running = false;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
    this.opts.video.srcObject = null;
    this.recognizer?.close();
    this.recognizer = null;
  }

  /** The camera currently in use (resolved deviceId), or "" if not started. */
  get deviceId(): string {
    return this.opts.deviceId;
  }

  /** List available video input devices. Labels are only populated once the
   *  user has granted camera permission (i.e. after the first start()). */
  async listCameras(): Promise<MediaDeviceInfo[]> {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === 'videoinput');
  }

  /** Switch to a different camera. Reopens the stream live if already running. */
  async useCamera(deviceId: string): Promise<void> {
    this.opts.deviceId = deviceId;
    if (!this.running) return;
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
    await this.openCamera();
    // Fresh camera = fresh geometry; drop stale filter state to avoid a snap.
    this.handStates.clear();
    this.lastVideoTime = -1;
  }

  // ---- Setup -----------------------------------------------------------

  private async openCamera(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('getUserMedia is not available (needs a secure context).');
    }
    const videoConstraints: MediaTrackConstraints = {
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 60, max: 60 },
    };
    // A specific device wins; otherwise ask for the user-facing camera.
    if (this.opts.deviceId) videoConstraints.deviceId = { exact: this.opts.deviceId };
    else videoConstraints.facingMode = 'user';

    const stream = await navigator.mediaDevices.getUserMedia({
      video: videoConstraints,
      audio: false,
    });
    this.stream = stream;
    // Record the resolved device so callers can pre-select it in a UI.
    this.opts.deviceId = stream.getVideoTracks()[0]?.getSettings().deviceId ?? this.opts.deviceId;
    const video = this.opts.video;
    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;
    await video.play();

    // Wait until dimensions are known so the overlay can size itself.
    if (!video.videoWidth) {
      await new Promise<void>((resolve) => {
        const onMeta = () => {
          video.removeEventListener('loadedmetadata', onMeta);
          resolve();
        };
        video.addEventListener('loadedmetadata', onMeta);
      });
    }
  }

  private async loadRecognizer(): Promise<void> {
    const fileset = await FilesetResolver.forVisionTasks(this.opts.wasmBase);
    const build = (delegate: 'GPU' | 'CPU') =>
      GestureRecognizer.createFromOptions(fileset, {
        baseOptions: {
          modelAssetPath: this.opts.modelUrl,
          delegate,
        },
        runningMode: 'VIDEO',
        numHands: this.opts.numHands,
        minHandDetectionConfidence: this.opts.minDetectionConfidence,
        minHandPresenceConfidence: this.opts.minDetectionConfidence,
        minTrackingConfidence: this.opts.minTrackingConfidence,
      });
    // GPU is the fast path (60fps on the MacBook). But some environments fail to
    // init the GPU delegate — and MediaPipe/Emscripten often throws a *non-Error*
    // value there (a raw number/string), which surfaces upstream as a useless
    // "failed: undefined". Fall back to CPU so the recognizer still starts.
    try {
      this.recognizer = await build('GPU');
    } catch (err) {
      console.warn('[gesture] GPU delegate failed; falling back to CPU.', err);
      this.recognizer = await build('CPU');
    }
  }

  // ---- Loop ------------------------------------------------------------

  private loop = (): void => {
    if (!this.running || !this.recognizer) return;
    this.rafId = requestAnimationFrame(this.loop);

    const video = this.opts.video;
    if (video.readyState < 2 /* HAVE_CURRENT_DATA */) return;

    // Strictly increasing timestamp in ms.
    let ts = performance.now();
    if (ts <= this.lastTimestamp) ts = this.lastTimestamp + 1;
    this.lastTimestamp = ts;

    // Only re-run inference when the video frame actually advanced.
    if (video.currentTime === this.lastVideoTime) return;
    this.lastVideoTime = video.currentTime;

    let result: GestureRecognizerResult;
    try {
      result = this.recognizer.recognizeForVideo(video, ts);
    } catch (err) {
      console.error('recognizeForVideo failed', err);
      return;
    }

    this.trackFps(ts);
    this.publish(result, ts);
  };

  private trackFps(nowMs: number): void {
    this.frameTimes.push(nowMs);
    const windowStart = nowMs - 1000;
    while (this.frameTimes.length && this.frameTimes[0] < windowStart) {
      this.frameTimes.shift();
    }
  }

  private get fps(): number {
    if (this.frameTimes.length < 2) return 0;
    const span = this.frameTimes[this.frameTimes.length - 1] - this.frameTimes[0];
    if (span <= 0) return 0;
    return Math.round(((this.frameTimes.length - 1) / span) * 1000);
  }

  private publish(result: GestureRecognizerResult, ts: number): void {
    const allLandmarks = result.landmarks ?? [];
    const handedness = result.handedness ?? [];
    const gestures = result.gestures ?? [];
    const tSec = ts / 1000;

    // Surface rect → maps normalized [0,1] coords to surface pixels (X mirrored).
    const rect = this.opts.surface.getBoundingClientRect();

    const hands: HandState[] = [];
    const activeKeys = new Set<string>();

    for (let i = 0; i < allLandmarks.length; i++) {
      const lm = allLandmarks[i];
      if (!lm || lm.length === 0) continue;

      // Key by handedness so each hand keeps its own filters across frames.
      // Fall back to index, and disambiguate if both hands share a label.
      const label = handedness[i]?.[0]?.categoryName ?? `hand${i}`;
      let key = label;
      if (activeKeys.has(key)) key = `${label}#${i}`;
      activeKeys.add(key);

      const state = this.handState(key);
      const mid = midpoint(lm[LANDMARK.THUMB_TIP], lm[LANDMARK.INDEX_TIP]);
      const cursor = {
        x: state.cursorX.filter(mid.x, tSec),
        y: state.cursorY.filter(mid.y, tSec),
      };
      const pinchDist = pinchDistance(lm);
      const changed = state.pinch.update(pinchDist);
      const gesture = gestures[i]?.[0]?.categoryName ?? null;

      // Pinch state machine → discrete drag events in surface pixels.
      const sx = (1 - cursor.x) * rect.width;
      const sy = cursor.y * rect.height;
      state.lastX = sx;
      state.lastY = sy;
      const pointer = { hand: label, x: sx, y: sy };
      if (state.pinch.isPinching) {
        this.emit(changed ? 'grab' : 'drag', pointer);
      } else if (changed) {
        this.emit('drop', pointer);
      }

      hands.push({
        handedness: label,
        cursor,
        pinchDist,
        pinching: state.pinch.isPinching,
        gesture: gesture && gesture !== 'None' ? gesture : null,
      });
    }

    // Drop state for hands that vanished, so a returning hand starts fresh
    // (no snap from a stale filter position) and the map can't grow unbounded.
    // If a vanished hand was mid-pinch, emit a drop so nothing stays grabbed.
    for (const key of [...this.handStates.keys()]) {
      if (activeKeys.has(key)) continue;
      const stale = this.handStates.get(key)!;
      if (stale.pinch.isPinching) {
        this.emit('drop', { hand: stale.label, x: stale.lastX, y: stale.lastY });
      }
      this.handStates.delete(key);
    }

    // Discrete commands come from open-hand gestures; ignore a hand that's
    // pinching (mid-drag) so a drag can't be misread as a command.
    const commandGestures = new Set<string>();
    for (const h of hands) {
      if (!h.pinching && h.gesture) commandGestures.add(h.gesture);
    }
    for (const name of this.commands.update(commandGestures, ts)) {
      this.emit('command', { name });
    }

    // Status first so the overlay can read this frame's cursors in `results`.
    this.emit('status', {
      fps: this.fps,
      hands,
      haltProgress: this.commands.haltProgress(ts),
    });
    this.emit('results', { result, timestampMs: ts });
  }
}
