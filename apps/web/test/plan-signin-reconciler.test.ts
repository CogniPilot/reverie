import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OfficeSignInCopy } from '../src/plan-signin-office-copy.js';
import {
  PlanSignInReconciler,
  SIGNED_OUT_PASSES,
  describePlanSignInNotice,
  laptopSignInHolderId,
  type PlanSignInLimits,
  type PlanSignInNotice,
  type SignInHolderPort,
  type SignInWriteOutcome,
} from '../src/plan-signin-reconciler.js';
import { signInView, type SignInView } from '../src/plan-signin-sync.js';

const HOUR = 60 * 60_000;
const START = 1_800_000_000_000;
const GRANT = START + 500 * HOUR;
const plan = 'anthropic-898367f5';
function file(expiresAt: number, serial = 0, grant = GRANT): string {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: 'SYNTHETIC_ACCESS_' + serial,
      refreshToken: 'SYNTHETIC_REFRESH_' + serial,
      expiresAt,
      refreshTokenExpiresAt: grant,
    },
  });
}
const emptied = JSON.stringify({
  claudeAiOauth: { accessToken: '', refreshToken: '', expiresAt: 0, refreshTokenExpiresAt: GRANT },
});
const short = (text: string) => signInView(text).digest!.slice(0, 12);

/** A holder in memory, with the same compare-and-replace rule the real ones keep. */
class Copy implements SignInHolderPort {
  readonly office: boolean;
  readonly label: string;
  writes = 0;
  reads = 0;
  next: SignInWriteOutcome | undefined;
  constructor(
    readonly id: string,
    public text: string | undefined,
    public reachable = true
  ) {
    this.office = id === 'office';
    this.label = this.office ? 'the office' : id.replace('laptop:', '');
  }
  async observe(): Promise<SignInView | undefined> {
    return this.reachable ? signInView(this.text) : undefined;
  }
  async read(digest: string): Promise<string | undefined> {
    this.reads++;
    return this.text !== undefined && signInView(this.text).digest === digest ? this.text : undefined;
  }
  async write(text: string, expected: SignInView): Promise<SignInWriteOutcome> {
    if (this.next) return this.next;
    if (signInView(this.text).digest !== expected.digest) return 'changed';
    this.writes++;
    this.text = text;
    return 'written';
  }
}
const LIMITS: PlanSignInLimits = { idleMs: 60_000, fastMs: 5_000, renewalLeadMs: 7 * 60_000, renewalTailMs: 2 * 60_000 };
function setup(holders: Copy[]) {
  const state = { now: START, ready: true, lines: [] as string[], listed: 0 };
  const reconciler = new PlanSignInReconciler(
    {
      now: () => state.now,
      ready: () => state.ready,
      plans: async () => {
        state.listed++;
        return [{ accountId: plan, holders }];
      },
      log: (line) => state.lines.push(line),
    },
    LIMITS
  );
  return { state, reconciler };
}

describe('PlanSignInReconciler', () => {
  it('heals the morning of 2026-11-24 in one pass and logs digests only', async () => {
    const live = file(START + 8 * HOUR, 2);
    const office = new Copy('office', emptied),
      ada = new Copy('laptop:ada', live),
      burt = new Copy('laptop:burt', emptied);
    const { state, reconciler } = setup([office, ada, burt]);
    await reconciler.tick();
    expect(burt.text).toBe(live);
    expect(office.text).toBe(live);
    expect(ada.writes).toBe(0);
    // The winning copy is read once, however many holders receive it.
    expect(ada.reads).toBe(1);
    expect(state.lines).toEqual([
      `[signin-sync] ${plan}: burt now has the sign-in ada holds (it had none it could use; ${short(live)})`,
      `[signin-sync] ${plan}: the office now has the sign-in ada holds (it had none it could use; ${short(live)})`,
    ]);
    expect(state.lines.join('\n')).not.toContain('SYNTHETIC');
    expect(reconciler.report(plan)).toMatchObject({
      usable: true,
      holders: [
        { id: 'office', state: 'usable' },
        { id: 'laptop:ada', state: 'usable' },
        { id: 'laptop:burt', state: 'usable' },
      ],
    });
  });

  it('writes nothing when the copies agree, and reads again only once a minute', async () => {
    const text = file(START + 4 * HOUR, 1);
    const holders = [new Copy('office', text), new Copy('laptop:a', text)];
    const { state, reconciler } = setup(holders);
    await reconciler.tick();
    state.now += 5_000;
    await reconciler.tick();
    state.now += 54_000;
    await reconciler.tick();
    expect(state.listed).toBe(1);
    state.now += 1_000;
    await reconciler.tick();
    expect(state.listed).toBe(2);
    expect(holders.map((holder) => holder.writes)).toEqual([0, 0]);
    expect(state.lines).toEqual([]);
  });

  it('reads every few seconds around the moment a shared sign-in is renewed, and passes the renewal on', async () => {
    const text = file(START + 6 * 60_000, 1);
    const office = new Copy('office', text),
      laptop = new Copy('laptop:a', text);
    const { state, reconciler } = setup([office, laptop]);
    await reconciler.tick();
    // The laptop's client renews; four seconds later nothing is read yet, one second after that it is.
    const renewed = file(START + 8 * HOUR, 2);
    laptop.text = renewed;
    state.now += 4_000;
    await reconciler.tick();
    expect(office.text).toBe(text);
    state.now += 1_000;
    await reconciler.tick();
    expect(office.text).toBe(renewed);
    expect(state.listed).toBe(2);
  });

  it('leaves a separate sign-in of the same plan alone', async () => {
    const office = new Copy('office', file(START + 8 * HOUR, 1, GRANT + 30 * HOUR)),
      rex = new Copy('laptop:rex', file(START + HOUR, 2));
    const { state, reconciler } = setup([office, rex]);
    await reconciler.tick();
    expect([office.writes, rex.writes, office.reads, rex.reads]).toEqual([0, 0, 0, 0]);
    expect(state.lines).toEqual([]);
  });

  it('skips a holder it cannot read and still repairs the others', async () => {
    const live = file(START + 8 * HOUR, 2);
    const away = new Copy('laptop:away', emptied, false),
      burt = new Copy('laptop:burt', emptied);
    const { reconciler } = setup([new Copy('office', live), away, burt]);
    await reconciler.tick();
    expect(burt.text).toBe(live);
    expect(away.text).toBe(emptied);
    expect(reconciler.report(plan)!.holders.map((holder) => holder.id)).toEqual(['office', 'laptop:burt']);
  });

  it('remembers a copy the provider refused and never places it again', async () => {
    const stale = file(START + 3 * HOUR, 1);
    const office = new Copy('office', stale),
      burt = new Copy('laptop:burt', emptied);
    const { state, reconciler } = setup([office, burt]);
    await reconciler.tick();
    expect(burt.text).toBe(stale);
    // Burt's client presents it, is refused, and empties the file again.
    burt.text = emptied;
    state.now += 5_000;
    await reconciler.tick();
    state.now += 60_000;
    await reconciler.tick();
    expect(burt.writes).toBe(1);
    expect(burt.text).toBe(emptied);
    expect(state.lines.slice(1)).toEqual([
      `[signin-sync] ${plan}: the sign-in burt had (${short(stale)}) was refused by the provider`,
      `[signin-sync] ${plan}: no holder has a usable sign-in. Sign the plan in at the office (Plans).`,
    ]);
    expect(reconciler.report(plan)!.usable).toBe(false);
    // The owner signs the plan in again at the office: that one is placed.
    const fresh = file(state.now + 8 * HOUR, 5, GRANT + 100 * HOUR);
    office.text = fresh;
    state.now += 60_000;
    await reconciler.tick();
    expect(burt.text).toBe(fresh);
    expect(state.lines.at(-1)).toBe(`[signin-sync] ${plan}: a usable sign-in is held again`);
  });

  it('does not hand a laptop the same bytes its client was just refused with', async () => {
    // Both hold one copy. The laptop's client is refused with it and empties its file: the office's identical
    // copy is refused too, so it is not placed back, and the office is told to sign in.
    const shared = file(START + 3 * HOUR, 1);
    const office = new Copy('office', shared),
      burt = new Copy('laptop:burt', shared);
    const { state, reconciler } = setup([office, burt]);
    await reconciler.tick();
    burt.text = emptied;
    state.now += 60_000;
    await reconciler.tick();
    expect(burt.writes).toBe(0);
    expect(reconciler.report(plan)!.usable).toBe(false);
    expect(state.lines).toEqual([
      `[signin-sync] ${plan}: the sign-in burt had (${short(shared)}) was refused by the provider`,
      `[signin-sync] ${plan}: no holder has a usable sign-in. Sign the plan in at the office (Plans).`,
    ]);
  });

  it('says once that a copy could not be placed, and tries again', async () => {
    const live = file(START + 8 * HOUR, 2);
    const burt = new Copy('laptop:burt', emptied);
    burt.next = 'busy';
    const { state, reconciler } = setup([new Copy('office', live), burt]);
    await reconciler.tick();
    state.now += 5_000;
    await reconciler.tick();
    expect(state.lines).toEqual([
      `[signin-sync] ${plan}: the sign-in the office holds was not placed for burt yet (busy)`,
    ]);
    burt.next = undefined;
    state.now += 5_000;
    await reconciler.tick();
    expect(burt.text).toBe(live);
  });

  it('repairs one plan on request without waiting for the next read, and answers what each holder has', async () => {
    const live = file(START + 8 * HOUR, 2);
    const burt = new Copy(laptopSignInHolderId('994f57d6'), emptied);
    const { state, reconciler } = setup([new Copy('office', live), burt]);
    const report = await reconciler.reconcile(plan);
    expect(burt.text).toBe(live);
    expect(report!.holders).toContainEqual({ id: 'laptop:994f57d6', state: 'usable' });
    expect(report!.transfers).toEqual([
      { from: 'office', to: 'laptop:994f57d6', reason: 'stranded', outcome: 'written' },
    ]);
    expect(await reconciler.reconcile('anthropic-unknown')).toBeUndefined();
    state.ready = false;
    expect(await reconciler.reconcile(plan)).toBeUndefined();
  });

  it('does nothing while the office is not ready or after it closed, and survives a failing listing', async () => {
    const burt = new Copy('laptop:burt', emptied);
    const { state, reconciler } = setup([new Copy('office', file(START + 8 * HOUR, 2)), burt]);
    state.ready = false;
    await reconciler.tick();
    expect(state.listed).toBe(0);
    state.ready = true;
    reconciler.close();
    await reconciler.tick();
    expect(burt.text).toBe(emptied);
    const failing = new PlanSignInReconciler({
      now: () => START,
      ready: () => true,
      plans: async () => {
        throw Object.assign(Error('SYNTHETIC_ACCESS in a message'), { code: 'ENOENT' });
      },
      log: (line) => state.lines.push(line),
    });
    await failing.tick();
    expect(state.lines).toEqual(['[signin-sync] pass failed: ENOENT']);
  });
});

describe('OfficeSignInCopy', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });
  function folder(text?: string): string {
    const root = fs.mkdtempSync(join(tmpdir(), 'reverie-office-signin-'));
    roots.push(root);
    if (text !== undefined) fs.writeFileSync(join(root, '.credentials.json'), text, { mode: 0o600 });
    return root;
  }

  it('reads its file without tokens and repairs an emptied one in place, privately', async () => {
    const dir = folder(emptied);
    const copy = new OfficeSignInCopy(async () => dir);
    const before = await copy.observe();
    expect(before).toEqual(signInView(emptied));
    const next = file(START + 8 * HOUR, 3);
    expect(await copy.write(next, before!)).toBe('written');
    expect(fs.readFileSync(join(dir, '.credentials.json'), 'utf8')).toBe(next);
    expect(fs.statSync(join(dir, '.credentials.json')).mode & 0o7777).toBe(0o600);
    expect(fs.statSync(join(dir, '.credentials.json')).nlink).toBe(1);
    expect(fs.readdirSync(dir)).toEqual(['.credentials.json']);
    expect(await copy.read(signInView(next).digest!)).toBe(next);
    expect(await copy.read(signInView(emptied).digest!)).toBeUndefined();
  });

  it('is never created: a signed-out office stays signed out', async () => {
    const dir = folder();
    const copy = new OfficeSignInCopy(async () => dir);
    expect(await copy.observe()).toEqual({ state: 'absent' });
    expect(await copy.write(file(START + 8 * HOUR, 3), { state: 'absent' })).toBe('refused');
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('refuses a file that changed, a renewal in flight, an unusable sign-in and a plan the office dropped', async () => {
    const renewed = file(START + 9 * HOUR, 9);
    const dir = folder(renewed);
    const copy = new OfficeSignInCopy(async () => dir);
    const next = file(START + 8 * HOUR, 3);
    expect(await copy.write(next, signInView(emptied))).toBe('changed');
    expect(await copy.write(emptied, signInView(renewed))).toBe('refused');
    fs.mkdirSync(join(dir, '.oauth_refresh.lock'));
    expect(await copy.write(next, signInView(renewed))).toBe('busy');
    expect(fs.readFileSync(join(dir, '.credentials.json'), 'utf8')).toBe(renewed);
    const gone = new OfficeSignInCopy(async () => undefined);
    expect(await gone.observe()).toBeUndefined();
    expect(await gone.write(next, signInView(renewed))).toBe('refused');
  });

  it('does not read through a link', async () => {
    const elsewhere = folder(file(START + HOUR, 1));
    const dir = folder();
    fs.symlinkSync(join(elsewhere, '.credentials.json'), join(dir, '.credentials.json'));
    expect(await new OfficeSignInCopy(async () => dir).observe()).toBeUndefined();
  });
});

describe('a plan that is signed in nowhere', () => {
  function watched(holders: Copy[], notice?: (event: PlanSignInNotice) => void) {
    const state = { now: START, events: [] as PlanSignInNotice[], lines: [] as string[] };
    const reconciler = new PlanSignInReconciler(
      {
        now: () => state.now,
        ready: () => true,
        plans: async () => [{ accountId: plan, holders }],
        log: (line) => state.lines.push(line),
        notice: notice ?? ((event) => state.events.push(event)),
      },
      LIMITS
    );
    const pass = async (passes = 1) => {
      for (let done = 0; done < passes; done++) {
        state.now += LIMITS.idleMs;
        await reconciler.tick();
      }
    };
    return { state, reconciler, pass };
  }

  it('is told once, when two passes in a row read every holder and found no usable sign-in', async () => {
    const office = new Copy('office', emptied),
      burt = new Copy('laptop:burt', emptied);
    const { state, pass } = watched([office, burt]);
    await pass();
    expect(state.events).toEqual([]);
    await pass();
    expect(state.events).toEqual([{ accountId: plan, usable: false }]);
    await pass(30);
    expect(state.events).toHaveLength(1);
    expect(SIGNED_OUT_PASSES).toBe(2);
  });

  it('is known before any employee is asked: a supervisor request counts as a pass like any other', async () => {
    const { state, reconciler, pass } = watched([new Copy('office', undefined), new Copy('laptop:burt', emptied)]);
    await pass();
    expect((await reconciler.reconcile(plan))?.usable).toBe(false);
    expect(state.events).toEqual([{ accountId: plan, usable: false }]);
  });

  it('is told once more when a sign-in is held again, and the laptops get it without anybody asking', async () => {
    const office = new Copy('office', emptied),
      burt = new Copy('laptop:burt', emptied);
    const { state, pass } = watched([office, burt]);
    await pass(3);
    // The account holder signs the plan in at the office.
    const signedIn = file(state.now + 8 * HOUR, 9);
    office.text = signedIn;
    await pass();
    expect(burt.text).toBe(signedIn);
    expect(state.events).toEqual([
      { accountId: plan, usable: false },
      { accountId: plan, usable: true },
    ]);
    await pass(5);
    expect(state.events).toHaveLength(2);
    // And it is told again if the plan is lost again.
    office.text = emptied;
    burt.text = emptied;
    await pass(2);
    expect(state.events.at(-1)).toEqual({ accountId: plan, usable: false });
    expect(state.events).toHaveLength(3);
  });

  it('says nothing for a plan that was never lost, or was lost for one pass only', async () => {
    const live = file(START + 8 * HOUR, 2);
    const office = new Copy('office', live),
      burt = new Copy('laptop:burt', live);
    const { state, pass } = watched([office, burt]);
    await pass(3);
    office.text = emptied;
    burt.text = emptied;
    await pass();
    // The copy both lost was refused by the provider, so only a new sign-in ends it.
    office.text = file(START + 9 * HOUR, 5);
    await pass(3);
    expect(state.events).toEqual([]);
  });

  it('says nothing while a holder cannot be read: that one may hold the sign-in', async () => {
    const burt = new Copy('laptop:burt', emptied),
      ada = new Copy('laptop:ada', file(START + 8 * HOUR, 2), false);
    const { state, pass } = watched([new Copy('office', emptied), burt, ada]);
    await pass(5);
    expect(state.events).toEqual([]);
    // Once it can be read and is empty too, the plan is signed in nowhere.
    ada.reachable = true;
    ada.text = emptied;
    await pass(2);
    expect(state.events).toEqual([{ accountId: plan, usable: false }]);
  });

  it('carries a renewed sign-in both ways, so a renewal in one place never strands another', async () => {
    const first = file(START + HOUR, 1);
    const office = new Copy('office', first),
      ada = new Copy('laptop:ada', first),
      burt = new Copy('laptop:burt', first);
    const { state, pass } = watched([office, ada, burt]);
    await pass();
    // A laptop's client renews: the office and the other laptop hold a refresh token that is now spent.
    const renewedInLaptop = file(START + 9 * HOUR, 2);
    ada.text = renewedInLaptop;
    await pass();
    expect([office.text, burt.text]).toEqual([renewedInLaptop, renewedInLaptop]);
    // The office's own client renews next: both laptops follow.
    const renewedAtOffice = file(START + 17 * HOUR, 3);
    office.text = renewedAtOffice;
    await pass();
    expect([ada.text, burt.text]).toEqual([renewedAtOffice, renewedAtOffice]);
    expect(state.events).toEqual([]);
  });

  it('survives a notice that throws', async () => {
    const burt = new Copy('laptop:burt', emptied);
    const { reconciler, pass } = watched([new Copy('office', emptied), burt], () => {
      throw new Error('room gone');
    });
    await pass(3);
    expect(reconciler.report(plan)).toMatchObject({ usable: false });
  });
});

describe('describePlanSignInNotice', () => {
  it('names the plan and who runs on it, says who can sign it in, and what the office does then', () => {
    const lost = describePlanSignInNotice('Claude CogniPilot', ['Ada', 'Burt'], false);
    expect(lost).toContain('The plan “Claude CogniPilot” is signed in nowhere');
    expect(lost).toContain('2 employees run on it: Ada, Burt.');
    expect(lost).toContain('Only the account holder can sign a plan in (Plans).');
    expect(lost).toContain('starts those agents again by itself');
    expect(describePlanSignInNotice('Max', ['Ada'], false)).toContain('One employee runs on it: Ada.');
    expect(describePlanSignInNotice('Max', [], false)).not.toContain('run on it');
    expect(describePlanSignInNotice('Max', ['Ada'], true)).toBe(
      'The plan “Max” is signed in again. The office is putting the sign-in back into the laptops that use it.'
    );
    // People read this: no holder name, digest or path.
    for (const line of [lost, describePlanSignInNotice('Max', ['Ada'], true)]) expect(line).not.toMatch(/laptop:|[0-9a-f]{12}|\//);
  });
});
