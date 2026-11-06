/**
 * The TS side of a Rust route handler child: one generation at a time, one dispatched request at a time.
 *
 * A call is admitted into a FIFO of at most QUEUE_LIMIT tickets, including the dispatched head. The
 * head's state alone decides which frame may come next; anything else ends the generation. A
 * generation ends by settling every admitted ticket as unavailable, killing the child and waiting for
 * its `exit`; only then can the next call spawn a successor. A child that does not exit leaves the
 * channel unavailable for the rest of the process. Nothing from an ended generation is ever accepted,
 * and no ticket moves to a later generation.
 */
import { spawn as spawnProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { FrameError, FrameReader, MEDIA, encode, type Body, type Frame, type Media, type Provider } from './frames.js';

export const QUEUE_LIMIT = 8;
export const TIMEOUT_MS = 10_000;
export const RESPAWN_THROTTLE_MS = 5_000;
export const REAP_MS = 5_000;
export const SHUTDOWN_GRACE_MS = 2_000;
export const STDERR_LINE_BYTES = 1024;
export const STDERR_LINES = 200;

export type Outcome =
  /** `contentType` is set for a typed route's response; a plain route's is fixed by its forwarder. */
  | { kind: 'response'; generation: number; id: number; status: number; body: Buffer; contentType?: string }
  | { kind: 'unavailable'; generation: number; id: number; reason: string };
export type Step = { kind: 'observe'; providers: Provider[] } | { kind: 'done'; outcome: Outcome };

type State = 'unspawned' | 'live' | 'reaping' | 'unconfirmed' | 'closing';
type HeadState = 'pending' | 'observing' | 'canceled';

export interface ChannelOptions {
  handlerPath: string;
  /** Allowed statuses per route key, from the route table. */
  statuses: Record<string, readonly number[]>;
  /** The routes answered with typed responses, and the media each may name. Every other route
   * answers with plain responses only. */
  media?: Record<string, readonly Media[]>;
  log: (message: string) => void;
  spawn?: (path: string, args: string[]) => ChildProcessWithoutNullStreams;
  now?: () => number;
}

export class Ticket {
  generation = 0;
  id = 0;
  head: HeadState = 'pending';
  observed = false;
  settled = false;
  private waiting: ((step: Step) => void) | undefined;
  private ready: Step | undefined;
  /** Armed at admission and cleared only when the ticket leaves the channel, never by settling it:
   * an abandoned head stays dispatched until its child answers or this deadline ends the generation. */
  timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly channel: RouteChannel,
    readonly route: string,
    readonly request: Buffer
  ) {}

  /** The next step: an observation the route must answer, or the final outcome. */
  next(): Promise<Step> {
    const ready = this.ready;
    if (ready) {
      this.ready = undefined;
      return Promise.resolve(ready);
    }
    return new Promise((resolve) => {
      this.waiting = resolve;
    });
  }

  /** Answers this ticket's observation with TS-owned `json`, then waits for its outcome. */
  answer(json: Buffer): Promise<Step> {
    this.channel.observed(this, json);
    return this.next();
  }

  /** The caller no longer wants the outcome: a queued ticket leaves, a dispatched one is canceled. */
  abandon(): void {
    this.channel.abandon(this);
  }

  deliver(step: Step): void {
    const waiting = this.waiting;
    this.waiting = undefined;
    if (waiting) waiting(step);
    else this.ready = step;
  }
}

export class RouteChannel {
  private state: State = 'unspawned';
  private generation = 0;
  private counter = 0;
  private queue: Ticket[] = [];
  private head: Ticket | undefined;
  private child: ChildProcessWithoutNullStreams | undefined;
  private lastSpawn = Number.NEGATIVE_INFINITY;
  private stderrLines = 0;
  private stderrLine = Buffer.alloc(0);
  private reaping: Promise<boolean> | undefined;
  private closing: Promise<{ terminated: boolean }> | undefined;
  private readonly now: () => number;
  private readonly spawn: (path: string, args: string[]) => ChildProcessWithoutNullStreams;

  constructor(private readonly options: ChannelOptions) {
    this.now = options.now ?? Date.now;
    this.spawn =
      options.spawn ??
      ((path, args) =>
        spawnProcess(path, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: false, env: {} }));
  }

  /** Whether `generation` is the live one; checked again just before a reply is published. */
  isCurrent(generation: number): boolean {
    return this.state === 'live' && this.generation === generation;
  }

  /** Admits one call. Refused admission settles at once and never enqueues. */
  admit(route: string, request: Buffer): Ticket {
    const ticket = new Ticket(this, route, request);
    const refusal = this.admission();
    if (refusal) {
      this.settle(ticket, refusal);
      return ticket;
    }
    this.queue.push(ticket);
    ticket.timer = setTimeout(() => this.timedOut(ticket), TIMEOUT_MS);
    this.dispatch();
    return ticket;
  }

  private admission(): string | undefined {
    if (this.state === 'reaping' || this.state === 'unconfirmed' || this.state === 'closing') return this.state;
    if (this.queue.length >= QUEUE_LIMIT) return 'queue full';
    if (this.state === 'unspawned' && this.now() - this.lastSpawn < RESPAWN_THROTTLE_MS) return 'respawn throttle';
    return undefined;
  }

  private settle(ticket: Ticket, reason: string | Outcome): void {
    if (ticket.settled) return;
    ticket.settled = true;
    const outcome: Outcome =
      typeof reason === 'string'
        ? { kind: 'unavailable', generation: ticket.generation, id: ticket.id, reason }
        : reason;
    if (outcome.kind === 'unavailable') this.options.log(`rust route ${ticket.route}: ${outcome.reason}`);
    ticket.deliver({ kind: 'done', outcome });
  }

  private frame(body: Body, id: number): Buffer {
    const frame: Frame = { generation: BigInt(this.generation), id: BigInt(id), body };
    return encode(frame);
  }

  private write(body: Body, id: number): void {
    this.child?.stdin.write(this.frame(body, id));
  }

  private dispatch(): void {
    if (this.head || this.queue.length === 0) return;
    if (this.state === 'unspawned') this.start();
    if (this.state !== 'live' || !this.child || this.child.stdin.writableNeedDrain) return;
    if (this.counter >= Number.MAX_SAFE_INTEGER) return this.invalidate('id budget exhausted');
    const ticket = this.queue[0];
    let wire: Buffer;
    try {
      wire = this.frame({ kind: 'request', route: ticket.route, json: ticket.request }, this.counter + 1);
    } catch (error) {
      // Encoded before it becomes the head: a request the wire cannot carry is refused alone, takes no
      // id, and the child never sees it.
      this.queue.shift();
      clearTimeout(ticket.timer);
      this.settle(ticket, `request not encodable: ${error instanceof FrameError ? error.code : String(error)}`);
      return this.dispatch();
    }
    this.head = ticket;
    ticket.generation = this.generation;
    ticket.id = ++this.counter;
    this.child.stdin.write(wire);
  }

  private start(): void {
    if (this.generation >= Number.MAX_SAFE_INTEGER) {
      this.state = 'unconfirmed';
      return this.failAll('generation budget exhausted');
    }
    this.generation += 1;
    this.counter = 0;
    this.stderrLines = 0;
    this.stderrLine = Buffer.alloc(0);
    this.lastSpawn = this.now();
    const generation = this.generation;
    const child = this.spawn(this.options.handlerPath, ['--generation', String(generation)]);
    this.child = child;
    this.state = 'live';
    const reader = new FrameReader('to_front');
    const end = (reason: string) => () => this.invalidate(reason, generation);
    child.stdout.on('data', (chunk: Buffer) => {
      if (!this.isCurrent(generation)) return;
      try {
        for (const frame of reader.push(chunk)) this.receive(frame);
      } catch (error) {
        this.invalidate(error instanceof FrameError ? error.code : String(error), generation);
      }
    });
    child.stdout.on('end', end('stdout ended'));
    child.stdout.on('error', end('stdout error'));
    child.stdin.on('error', end('stdin error'));
    child.stdin.on('drain', () => this.dispatch());
    child.stderr.on('data', (chunk: Buffer) => this.stderr(chunk, generation));
    child.on('error', end('child error'));
    child.on('exit', end('child exited'));
  }

  /** Logs at most STDERR_LINES lines of at most STDERR_LINE_BYTES each per generation; drains the rest. */
  private stderr(chunk: Buffer, generation: number): void {
    if (generation !== this.generation) return;
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(0x0a, start);
      const end = newline === -1 ? chunk.length : newline;
      const room = STDERR_LINE_BYTES - this.stderrLine.length;
      if (room > 0)
        this.stderrLine = Buffer.concat([this.stderrLine, chunk.subarray(start, start + Math.min(room, end - start))]);
      if (newline === -1) return;
      if (this.stderrLines < STDERR_LINES) {
        this.stderrLines += 1;
        this.options.log(`rust route handler g${generation}: ${this.stderrLine.toString('utf8')}`);
      }
      this.stderrLine = Buffer.alloc(0);
      start = newline + 1;
    }
  }

  private receive(frame: Frame): void {
    const head = this.head;
    if (frame.generation !== BigInt(this.generation) || !head || frame.id !== BigInt(head.id))
      return this.invalidate('unexpected frame');
    const body = frame.body;
    if (body.kind === 'observe') {
      if (head.observed) return this.invalidate('second observe');
      head.observed = true;
      if (head.head === 'canceled') return;
      head.head = 'observing';
      return head.deliver({ kind: 'observe', providers: body.providers });
    }
    if (body.kind !== 'response' && body.kind !== 'typed_response' && body.kind !== 'refusal')
      return this.invalidate('direction-invalid frame');
    const media = this.options.media?.[head.route];
    if (body.kind === 'response' && media) return this.invalidate('untyped response for a typed route');
    if (body.kind === 'typed_response' && !media?.includes(body.media))
      return this.invalidate('media outside the route table');
    if (body.kind !== 'refusal' && !(this.options.statuses[head.route] ?? []).includes(body.status))
      return this.invalidate('status outside the route table');
    this.head = undefined;
    this.queue.shift();
    clearTimeout(head.timer);
    if (head.head !== 'canceled') {
      if (body.kind === 'refusal') this.settle(head, `refused ${body.code}`);
      else
        this.settle(head, {
          kind: 'response',
          generation: head.generation,
          id: head.id,
          status: body.status,
          body: body.body,
          ...(body.kind === 'typed_response' ? { contentType: MEDIA[body.media] } : {}),
        });
    }
    this.dispatch();
  }

  observed(ticket: Ticket, json: Buffer): void {
    if (ticket !== this.head || ticket.head !== 'observing' || !this.isCurrent(ticket.generation)) return;
    ticket.head = 'pending';
    try {
      this.write({ kind: 'observed', observation: 'subscription_modes', json }, ticket.id);
    } catch {
      this.abandon(ticket);
    }
  }

  abandon(ticket: Ticket): void {
    if (ticket.settled) return;
    if (ticket === this.head) {
      ticket.head = 'canceled';
      this.write({ kind: 'cancel' }, ticket.id);
    } else {
      this.queue = this.queue.filter((queued) => queued !== ticket);
      clearTimeout(ticket.timer);
    }
    this.settle(ticket, 'abandoned');
  }

  private timedOut(ticket: Ticket): void {
    if (ticket === this.head) return this.invalidate('dispatched request timed out');
    this.queue = this.queue.filter((queued) => queued !== ticket);
    this.settle(ticket, 'timed out in queue');
  }

  private failAll(reason: string): void {
    const tickets = this.queue;
    this.queue = [];
    this.head = undefined;
    for (const ticket of tickets) {
      clearTimeout(ticket.timer);
      this.settle(ticket, reason);
    }
  }

  /** Ends the current generation: settle everything, then kill and wait for the child to exit. */
  private invalidate(reason: string, generation = this.generation): void {
    if (generation !== this.generation || this.state !== 'live') return;
    this.state = 'reaping';
    this.failAll(reason);
    const child = this.child;
    this.child = undefined;
    if (!child) {
      this.state = 'unspawned';
      return;
    }
    child.stdout.removeAllListeners('data');
    child.stdout.destroy();
    child.stdin.destroy();
    this.reaping = this.reap(child, REAP_MS);
    void this.reaping.then((exited) => {
      this.reaping = undefined;
      if (this.state !== 'reaping') return;
      if (exited) this.state = 'unspawned';
      else {
        this.state = 'unconfirmed';
        this.options.log(`rust route handler pid ${child.pid} did not exit after SIGKILL; no successor will start`);
      }
    });
  }

  /** Kills `child` unless it already exited, then waits up to `ms` for its exit. */
  private reap(
    child: ChildProcessWithoutNullStreams,
    ms: number,
    signal: NodeJS.Signals = 'SIGKILL'
  ): Promise<boolean> {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), ms);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve(true);
      });
      child.kill(signal);
    });
  }

  /** Server shutdown: no new calls, every admitted one settles, and the child is ended. Every caller
   * gets the one shutdown's result; being in the closing state is not proof the child exited. */
  close(): Promise<{ terminated: boolean }> {
    this.closing ??= this.shutdown();
    return this.closing;
  }

  private async shutdown(): Promise<{ terminated: boolean }> {
    const previous = this.state;
    this.state = 'closing';
    this.failAll('server closing');
    const child = this.child;
    this.child = undefined;
    if (previous === 'unconfirmed') return { terminated: false };
    if (!child) return { terminated: this.reaping ? await this.reaping : true };
    if (child.exitCode !== null || child.signalCode !== null) return { terminated: true };
    child.stdin.end();
    const exited = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), SHUTDOWN_GRACE_MS);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    const terminated = exited || (await this.reap(child, SHUTDOWN_GRACE_MS));
    if (!terminated) this.options.log(`rust route handler pid ${child.pid} termination unconfirmed at shutdown`);
    return { terminated };
  }
}
