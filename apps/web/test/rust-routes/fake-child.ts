/** An in-process route handler child that a test scripts in route-frames-v1. */
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { FrameReader, encode, type Body, type Frame } from '../../src/rust-routes/frames.js';

/** A child whose replies the test scripts; `kill` only works when `killable`. */
export class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  pid = 4242;
  killable = true;
  kills = 0;
  received: Frame[] = [];
  written = 0;
  private reader = new FrameReader('to_handler');

  constructor(
    readonly generation: number,
    private readonly script: (child: FakeChild, frame: Frame) => void
  ) {
    super();
    this.stdin.on('data', (chunk: Buffer) => {
      this.written += chunk.length;
      for (const frame of this.reader.push(chunk)) {
        this.received.push(frame);
        this.script(this, frame);
      }
    });
  }

  reply(id: bigint, body: Body, generation = BigInt(this.generation)): void {
    this.stdout.write(encode({ generation, id, body }));
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.kills += 1;
    if (this.killable) this.exit(signal);
    return true;
  }

  exit(signal: NodeJS.Signals | null = null): void {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.signalCode = signal;
    this.exitCode = signal ? null : 0;
    queueMicrotask(() => this.emit('exit', this.exitCode, signal));
  }
}
