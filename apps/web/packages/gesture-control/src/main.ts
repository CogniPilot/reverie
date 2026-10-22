// Phase 3 demo wiring.
//
// - Start button (camera requires a user gesture) + live camera picker.
// - Mirrored video preview + debug overlay (skeleton + per-hand cursors).
// - Live HUD: fps / hands / pinch distance / gesture.
// - Tab board: pinch-drag session tabs between Screen columns.

import { GestureController } from './gesture/GestureController.ts';
import { Overlay, type CursorMark } from './demo/overlay.ts';
import { TabsBoard } from './demo/tabs.ts';
import type { HandState } from './gesture/types.ts';

// Cyan for the left hand, violet for the right; green takes over while pinching.
const handColor = (handedness: string): string => (handedness === 'Right' ? '#a78bfa' : '#38bdf8');

const video = document.getElementById('cam') as HTMLVideoElement;
const canvas = document.getElementById('overlay') as HTMLCanvasElement;
const stage = document.getElementById('stage') as HTMLDivElement;
const boardEl = document.getElementById('board') as HTMLDivElement;
const startBtn = document.getElementById('start') as HTMLButtonElement;
const stopBtn = document.getElementById('stop') as HTMLButtonElement;
const fullscreenBtn = document.getElementById('fullscreen') as HTMLButtonElement;
const cameraSel = document.getElementById('camera') as HTMLSelectElement;
const fpsEl = document.getElementById('fps') as HTMLSpanElement;
const handEl = document.getElementById('hand') as HTMLSpanElement;
const pinchEl = document.getElementById('pinch') as HTMLSpanElement;
const gestureEl = document.getElementById('gesture') as HTMLSpanElement;
const statusEl = document.getElementById('status-msg') as HTMLParagraphElement;

const overlay = new Overlay(canvas, video);
// Coords map against the stage rect (the board overlays it exactly).
const gc = new GestureController({ video, surface: stage, numHands: 2 });

const board = new TabsBoard(boardEl, (tabId, columnId) => {
  statusEl.textContent = columnId
    ? `Moved “${tabId}” → ${columnId}`
    : `“${tabId}” dropped outside a column — returned.`;
});

// The board drives off discrete grab/drag/drop; hover highlight off `status`.
gc.on('grab', ({ hand, x, y }) => board.grab(hand, x, y));
gc.on('drag', ({ hand, x, y }) => board.drag(hand, x, y));
gc.on('drop', ({ hand, x, y }) => board.drop(hand, x, y));

// Discrete gesture commands (halt-all / approve / new-session) are intentionally
// not wired up here — this build is pinch-drag only. The controller still emits
// `command`/`haltProgress`, but nothing consumes them, so an open palm, thumb,
// or victory sign does nothing.

// Cached from `status` so the `results` handler draws the same frame's cursors.
let cursors: CursorMark[] = [];
let started = false;

gc.on('results', ({ result }) => {
  overlay.draw(result, cursors);
});

gc.on('status', ({ fps, hands }) => {
  cursors = hands.map((h) => ({
    x: h.cursor.x,
    y: h.cursor.y,
    color: handColor(h.handedness),
    pinching: h.pinching,
  }));

  // Hover highlights from the full per-frame snapshot (surface px, X mirrored).
  const rect = stage.getBoundingClientRect();
  board.hover(
    hands.map((h) => ({
      x: (1 - h.cursor.x) * rect.width,
      y: h.cursor.y * rect.height,
      pinching: h.pinching,
    }))
  );

  fpsEl.textContent = String(fps);
  fpsEl.style.color = fps >= 25 ? '#4ade80' : fps > 0 ? '#fbbf24' : '#f87171';

  const anyPinching = hands.some((h) => h.pinching);
  handEl.textContent = hands.length ? hands.map((h) => h.handedness).join(' + ') : 'no';
  handEl.style.color = hands.length ? '#4ade80' : '#94a3b8';
  pinchEl.textContent = hands.length ? hands.map(pinchLabel).join('  ') : '—';
  pinchEl.style.color = anyPinching ? '#4ade80' : '#94a3b8';
  gestureEl.textContent =
    hands
      .filter((h) => h.gesture)
      .map((h) => h.gesture)
      .join(', ') || '—';
});

/** e.g. "L 0.34●" — first letter of handedness, distance, dot when pinching. */
function pinchLabel(h: HandState): string {
  return `${h.handedness[0]} ${h.pinchDist.toFixed(2)}${h.pinching ? '●' : ''}`;
}

startBtn.addEventListener('click', async () => {
  startBtn.disabled = true;
  statusEl.textContent = 'Requesting camera + loading model…';
  try {
    await gc.start();
    started = true;
    statusEl.textContent = 'Running. Pinch-drag tabs between Screens.';
    stopBtn.disabled = false;
    await populateCameras();
  } catch (err) {
    console.error(err);
    statusEl.textContent = `Failed to start: ${(err as Error).message}`;
    startBtn.disabled = false;
  }
});

stopBtn.addEventListener('click', () => {
  gc.stop();
  started = false;
  overlay.clear();
  board.hover([]);
  cursors = [];
  statusEl.textContent = 'Stopped.';
  startBtn.disabled = false;
  stopBtn.disabled = true;
  cameraSel.disabled = true;
  fpsEl.textContent = '0';
  handEl.textContent = 'no';
  pinchEl.textContent = '—';
  gestureEl.textContent = '—';
});

// Switch cameras live. On macOS the iPhone (Continuity Camera) shows up as
// "iPhone Camera" plus a separate "Desk View Camera" (the ultra-wide lens).
cameraSel.addEventListener('change', async () => {
  statusEl.textContent = `Switching to ${cameraSel.selectedOptions[0]?.text}…`;
  try {
    await gc.useCamera(cameraSel.value);
    statusEl.textContent = 'Running.';
    // Activating the iPhone can surface its Desk View device — re-check.
    await populateCameras();
  } catch (err) {
    console.error(err);
    statusEl.textContent = `Couldn't switch camera: ${(err as Error).message}`;
  }
});

// Cameras come and go (iPhone mounted/unmounted, Desk View appearing). Keep
// the dropdown in sync whenever the device set changes.
navigator.mediaDevices?.addEventListener('devicechange', () => {
  if (started) void populateCameras();
});

// Fullscreen the stage so the board (and grab targets) fill the display.
// Standard API with a webkit fallback for Safari.
type WebkitEl = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> };
type WebkitDoc = Document & {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void>;
};

function fullscreenElement(): Element | null {
  return document.fullscreenElement ?? (document as WebkitDoc).webkitFullscreenElement ?? null;
}

fullscreenBtn.addEventListener('click', () => {
  if (fullscreenElement()) {
    (document.exitFullscreen ?? (document as WebkitDoc).webkitExitFullscreen)?.call(document);
  } else {
    const el = stage as WebkitEl;
    (el.requestFullscreen ?? el.webkitRequestFullscreen)?.call(el);
  }
});

function syncFullscreenLabel(): void {
  fullscreenBtn.textContent = fullscreenElement() ? '⤢ Exit fullscreen' : '⛶ Fullscreen';
}
document.addEventListener('fullscreenchange', syncFullscreenLabel);
document.addEventListener('webkitfullscreenchange', syncFullscreenLabel);

/** Fill the camera dropdown; labels appear only after camera permission. */
async function populateCameras(): Promise<void> {
  const cams = await gc.listCameras();
  cameraSel.innerHTML = '';
  cams.forEach((cam, i) => {
    const opt = document.createElement('option');
    opt.value = cam.deviceId;
    opt.text = cam.label || `Camera ${i + 1}`;
    if (cam.deviceId === gc.deviceId) opt.selected = true;
    cameraSel.append(opt);
  });
  cameraSel.disabled = cams.length < 2;
}
