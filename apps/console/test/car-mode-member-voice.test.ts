/**
 * Car mode: each voice member gets its own speaking voice. A stable default per member
 * (hash of its session id over the English voices), a saved choice per member, and the
 * choice of one member never changes another's.
 */
import { describe, expect, it } from 'vitest';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

type Voice = { name: string; lang: string };
const VOICES: Voice[] = [
  { name: 'Google Deutsch', lang: 'de-DE' },
  { name: 'English United States', lang: 'en-US' },
  { name: 'English United Kingdom', lang: 'en-GB' },
  { name: 'English Australia', lang: 'en-AU' },
  { name: 'English India', lang: 'en-IN' },
  { name: 'en-us-x-iom-local', lang: 'en-US' },
  { name: 'en-gb-x-rjs-local', lang: 'en-GB' },
];

function load(voices: Voice[] = VOICES) {
  const store = new Map<string, string>();
  const localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
  };
  class Option {
    constructor(
      public text: string,
      public value: string
    ) {}
  }
  const context = vm.createContext({
    CodemanApp: class {},
    localStorage,
    Option,
    window: { speechSynthesis: { getVoices: () => voices } },
  });
  vm.runInContext(readFileSync(resolve(import.meta.dirname, '../src/web/public/voice-chat.js'), 'utf8'), context);
  vm.runInContext(readFileSync(resolve(import.meta.dirname, '../src/web/public/car-mode.js'), 'utf8'), context);
  const get = (name: string) => vm.runInContext(name, context);
  return { get, store, Proto: get('CodemanApp').prototype };
}

/** An app with a car screen holding just the voice select, talking to `member`. */
function app(Proto: object, member: { sessionId: string } | null) {
  const select = {
    hidden: false,
    value: '',
    options: [] as { value: string }[],
    replaceChildren(...opts: { value: string }[]) {
      this.options = opts;
    },
    onchange: null as null | (() => void),
  };
  const a = Object.create(Proto);
  a._carScreen = { querySelector: (q: string) => (q === '.car-voice' ? select : null) };
  a._carVoiceMember = () => member;
  return { a, select };
}

describe('car mode per-member voice', () => {
  it('gives each member a stable English voice from any English locale', () => {
    const { get } = load();
    const pick = get('carModePickVoice') as (v: Voice[], s?: string | null, id?: string) => Voice | null;
    const ids = Array.from({ length: 24 }, (_, i) => `member-${i}`);
    const names = ids.map((id) => pick(VOICES, null, id)?.name);
    expect(names.every((n) => n && n !== 'Google Deutsch')).toBe(true);
    // Stable: the same id gives the same voice, whatever order the platform lists them in.
    expect(ids.map((id) => pick([...VOICES].reverse(), null, id)?.name)).toEqual(names);
    // Spread: two dozen members do not all collapse onto one voice; non US/UK locales are used.
    expect(new Set(names).size).toBeGreaterThan(3);
    expect(names.some((n) => n === 'English Australia' || n === 'English India')).toBe(true);
  });

  it('a saved choice wins; an unknown or non-English saved name falls back to the member default', () => {
    const { get } = load();
    const pick = get('carModePickVoice') as (v: Voice[], s?: string | null, id?: string) => Voice | null;
    const dflt = pick(VOICES, null, 'coordinator')?.name;
    expect(pick(VOICES, 'en-us-x-iom-local', 'coordinator')?.name).toBe('en-us-x-iom-local');
    expect(pick(VOICES, 'Gone Voice', 'coordinator')?.name).toBe(dflt);
    expect(pick(VOICES, 'Google Deutsch', 'coordinator')?.name).toBe(dflt);
    expect(pick([{ name: 'X', lang: 'fr-FR' }], null, 'coordinator')).toBeNull();
    expect(pick([], null, 'coordinator')).toBeNull();
  });

  it('keeps the old default when no member is known', () => {
    const { get } = load();
    const pick = get('carModePickVoice') as (v: Voice[], s?: string | null, id?: string) => Voice | null;
    // US/UK only, first one when nothing sounds female.
    expect(pick(VOICES)?.name).toBe('English United States');
  });

  it('stores the choice per member and fills the picker from that member only', () => {
    const { Proto, store, get } = load();
    const key = get('carModeVoiceKey') as (id: string) => string;
    const coordinator = app(Proto, { sessionId: 'coordinator-id' });
    coordinator.a._fillCarVoices();
    // The team (server) voice first and chosen by default, then only English phone voices.
    const team = get('CAR_TEAM_VOICE') as string;
    expect(coordinator.select.options[0].value).toBe(team);
    expect(coordinator.select.value).toBe(team);
    expect(coordinator.select.options.map((o) => o.value)).not.toContain('Google Deutsch');
    expect(coordinator.select.options.length).toBe(7);
    // A phone voice saved for Coordinator earlier: still the team voice, and that is Coordinator's backup only.
    store.set(key('coordinator-id'), 'en-us-x-iom-local');
    coordinator.a._fillCarVoices();
    expect(coordinator.select.value).toBe(team);
    expect(coordinator.a._carVoice()?.name).toBe('en-us-x-iom-local');
    // Worker is unaffected by Coordinator's choice: her own default (or her own saved choice).
    const worker = app(Proto, { sessionId: 'worker-id' });
    worker.a._fillCarVoices();
    const pick = get('carModePickVoice') as (v: Voice[], s?: string | null, id?: string) => Voice | null;
    expect(worker.select.value).toBe(team);
    // With the team voice chosen, her phone fallback is still her own member default.
    expect(worker.a._carVoice()?.name).toBe(pick(VOICES, null, 'worker-id')?.name);
    expect([...store.keys()]).toEqual([key('coordinator-id')]);
    // No legacy shared key is read or written.
    store.set('codeman:carVoice', 'English India');
    worker.a._fillCarVoices();
    expect(worker.select.value).toBe(team);
  });

  it('speaks with the member default before the picker is filled', () => {
    const { Proto, get } = load();
    const pick = get('carModePickVoice') as (v: Voice[], s?: string | null, id?: string) => Voice | null;
    // A member whose default differs from the no-member default, so the two cannot be confused.
    const id = Array.from({ length: 50 }, (_, i) => `m-${i}`).find(
      (x) => pick(VOICES, null, x)?.name !== pick(VOICES)?.name
    )!;
    const { a } = app(Proto, { sessionId: id });
    expect(a._carVoice()?.name).toBe(pick(VOICES, null, id)?.name);
  });

  it('the voice select change handler saves under the current member key', () => {
    const src = readFileSync(resolve(import.meta.dirname, '../src/web/public/car-mode.js'), 'utf8');
    expect(src).toContain('localStorage.setItem(carModeVoiceKey(id), voice.value)');
    // Owner 10-20: the menu is not shown in the car.
    expect(src).toContain('voice.hidden = true;');
    expect(src).not.toContain("'codeman:carVoice'");
  });
});

type Pick = (v: Voice[], s?: string | null, id?: string, pronouns?: string) => Voice | null;
const MIXED: Voice[] = [
  { name: 'Samantha', lang: 'en-US' },
  { name: 'Google UK English Female', lang: 'en-GB' },
  { name: 'en-us-x-sfg-local', lang: 'en-US' },
  { name: 'en-au-x-afh-network', lang: 'en-AU' },
  { name: 'Daniel', lang: 'en-GB' },
  { name: 'Google UK English Male', lang: 'en-GB' },
  { name: 'en-us-x-iom-local', lang: 'en-US' },
  { name: 'en-gb-x-rjs-local', lang: 'en-GB' },
  { name: 'English India', lang: 'en-IN' },
  { name: 'en-in-x-ahp-local', lang: 'en-IN' },
];
const FEMALE = ['Samantha', 'Google UK English Female', 'en-us-x-sfg-local', 'en-au-x-afh-network'];
const MALE = ['Daniel', 'Google UK English Male', 'en-us-x-iom-local', 'en-gb-x-rjs-local'];
// Decorated or made-up names that contain a listed word: never classified (Inspector voice-by-pronouns-r1 HOLD).
const DECORATED = [
  'Not Samantha',
  'Experimental Female Voice',
  'Daniel Clone',
  'Unknown Male',
  'Female',
  'Male',
  'Samantha Enhanced',
  'Not Samantha (Enhanced)',
  'Samantha (Clone)',
  'Google US English Female',
  'My Google UK English Male',
  'Microsoft Zira Clone - English (United States)',
  'Microsoft Zira - German (Germany)',
  'Microsoft Nobody - English (United States)',
  'x en-us-x-sfg-local',
  'en-us-x-sfg-local-x',
  'en-us-x-sfg',
  'en-us-x-sfgg-local',
  'toString',
  '__proto__',
  'constructor',
];
const IDS = Array.from({ length: 40 }, (_, i) => `member-${i}`);

describe('car mode voice by pronouns', () => {
  it('knows how listed voices sound and leaves the rest unknown', () => {
    const { get } = load();
    const gender = get('carModeVoiceGender') as (n?: string) => string;
    for (const n of FEMALE) expect(gender(n), n).toBe('female');
    for (const n of MALE) expect(gender(n), n).toBe('male');
    // Unlisted Android codes and plain locale names say nothing, nor do empty names.
    // An unlisted code is never read as a name, even one that spells one (ava, tom).
    for (const n of [
      'English India',
      'en-in-x-ahp-local',
      'en-us-x-ava-local',
      'en-gb-x-tom-local',
      'English United States',
      'Google Deutsch',
      '',
      undefined,
    ])
      expect(gender(n as string), String(n)).toBe('');
  });

  it('reads only exact table entries: decorated names, other shapes and table-looking prefixes say nothing', () => {
    const { get } = load();
    const gender = get('carModeVoiceGender') as (n?: string) => string;
    for (const n of DECORATED) expect(gender(n), n).toBe('');
    // The exact shapes a device reports, case and spacing aside.
    for (const [n, g] of [
      ['Samantha (Enhanced)', 'female'],
      ['Daniel (Premium)', 'male'],
      ['Flo (English (US))', 'female'],
      ['Eddy (English (UK))', 'male'],
      ['  SAMANTHA ', 'female'],
      ['Google US English', 'female'],
      ['Microsoft Zira - English (United States)', 'female'],
      ['Microsoft Aria Online (Natural) - English (United States)', 'female'],
      ['Microsoft Ryan Online (Natural) - English (United Kingdom)', 'male'],
      ['en-US-x-sfg-local', 'female'],
      ['en-us-x-iom-network', 'male'],
    ])
      expect(gender(n), n).toBe(g);
  });

  it('never narrows a pool to decorated names', () => {
    const { get } = load();
    const pick = get('carModePickVoice') as Pick;
    const fakes = DECORATED.map((name) => ({ name, lang: 'en-US' }));
    // Only decorated names on the device: she/he fall back to the plain member pick.
    expect(IDS.map((id) => pick(fakes, null, id, 'she/her')?.name)).toEqual(
      IDS.map((id) => pick(fakes, null, id)?.name)
    );
    expect(IDS.map((id) => pick(fakes, null, id, 'he/him')?.name)).toEqual(
      IDS.map((id) => pick(fakes, null, id)?.name)
    );
    // Mixed in with real voices, she/he only ever pick the real listed ones.
    const both = [...MIXED, ...fakes];
    expect(IDS.every((id) => FEMALE.includes(pick(both, null, id, 'she/her')!.name))).toBe(true);
    expect(IDS.every((id) => MALE.includes(pick(both, null, id, 'he/him')!.name))).toBe(true);
  });

  it('reads she and he from the first pronoun only', () => {
    const { get } = load();
    const want = get('carModePronounGender') as (p?: string) => string;
    expect(want('she/her')).toBe('female');
    expect(want(' She/They')).toBe('female');
    expect(want('(she/her)')).toBe('female');
    expect(want('he/him')).toBe('male');
    expect(want('He/They')).toBe('male');
    for (const p of ['they/them', 'xe/xem', 'any', 'hey', 'shelby', '', undefined]) expect(want(p), String(p)).toBe('');
  });

  it('picks from the matching voices, still one stable voice per member', () => {
    const { get } = load();
    const pick = get('carModePickVoice') as Pick;
    const she = IDS.map((id) => pick(MIXED, null, id, 'she/her')!.name);
    const he = IDS.map((id) => pick(MIXED, null, id, 'he/him')!.name);
    expect(she.every((n) => FEMALE.includes(n))).toBe(true);
    expect(he.every((n) => MALE.includes(n))).toBe(true);
    expect(new Set(she).size).toBeGreaterThan(2);
    expect(new Set(he).size).toBeGreaterThan(2);
    expect(IDS.map((id) => pick([...MIXED].reverse(), null, id, 'she/her')!.name)).toEqual(she);
  });

  it('uses the whole English pool for other pronouns, none, or a device with no matching voice', () => {
    const { get } = load();
    const pick = get('carModePickVoice') as Pick;
    const plain = IDS.map((id) => pick(MIXED, null, id)?.name);
    expect(IDS.map((id) => pick(MIXED, null, id, 'they/them')?.name)).toEqual(plain);
    expect(IDS.map((id) => pick(MIXED, null, id, '')?.name)).toEqual(plain);
    // The plain pool includes voices of every kind, so other pronouns are not narrowed.
    expect(plain.some((n) => FEMALE.includes(n!))).toBe(true);
    expect(plain.some((n) => MALE.includes(n!))).toBe(true);
    // VOICES has no voice known to sound female: she falls back to the member default.
    expect(IDS.map((id) => pick(VOICES, null, id, 'she/her')?.name)).toEqual(
      IDS.map((id) => pick(VOICES, null, id)?.name)
    );
  });

  it('a saved choice still wins over pronouns, and no member keeps the old default', () => {
    const { get } = load();
    const pick = get('carModePickVoice') as Pick;
    expect(pick(MIXED, 'Daniel', 'coordinator', 'she/her')?.name).toBe('Daniel');
    expect(pick(MIXED, null, undefined, 'he/him')?.name).toBe('Samantha');
  });

  it('passes the voice member pronouns to the backup phone voice', () => {
    const { Proto, get } = load(MIXED);
    const pick = get('carModePickVoice') as Pick;
    // A member whose pronoun pick differs from the plain pick, so the wiring cannot pass unseen.
    const id = IDS.find((x) => pick(MIXED, null, x, 'he/him')?.name !== pick(MIXED, null, x)?.name)!;
    const { a } = app(Proto, { sessionId: id, pronouns: 'he/him' } as { sessionId: string });
    expect(a._carVoice()?.name).toBe(pick(MIXED, null, id, 'he/him')?.name);
    expect(MALE).toContain(a._carVoice()?.name);
  });
});
