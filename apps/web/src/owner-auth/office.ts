/** Shared-office humans. Each login reuses the existing password/2FA/session implementation. */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Socket } from 'node:net';
import { z } from 'zod';
import { writeCompanyStateFile } from '../company-store.js';
import { normalizeUsername } from '../user-store.js';
import { isMultiUserMode } from '../config/multiuser.js';
import { bootstrap, resetPassword } from './admin.js';
import { OwnerAuthStore } from './store.js';
import { sha256 } from './crypto.js';
import {
  OwnerAuthService,
  OwnerAuthError,
  CHALLENGE_TTL_MS,
  type OwnerAuthDeps,
  type HumanIdentity,
  type OwnerSession,
} from './service.js';

const PersonSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().trim().min(1).max(80),
    role: z.enum(['owner', 'limited']),
    rooms: z.array(z.string().min(1).max(100)).max(50),
    disabled: z.boolean().default(false),
    readAt: z
      .record(z.string(), z.number().finite().nonnegative())
      .default({})
      .refine((v) => Object.keys(v).length <= 250),
    avatar: z
      .string()
      .regex(/^\/assets\/avatars\/pack-(?:0[1-9]|[1-9][0-9]|1[0-4][0-9]|15[01])\.png$/)
      .optional(),
  })
  .strict();
export type OfficePerson = z.infer<typeof PersonSchema>;
const PeopleSchema = z.object({ version: z.literal(1), people: z.array(PersonSchema).max(24) }).strict();

export class OfficeAuthService extends OwnerAuthService {
  private people: OfficePerson[];
  private readonly accessChanging = new Set<string>();
  private readonly children = new Map<string, OwnerAuthService>();
  private readonly challengesFor = new Map<string, { id: string; expires: number }>();
  private readonly leases = new Map<string, { id: string; at: number }>();
  private writes: Promise<unknown> = Promise.resolve();
  private logins = 0;
  private readonly peopleFile: string;
  private readonly clock: () => number;

  constructor(
    deps: OwnerAuthDeps,
    private readonly primaryProfile: () => { name?: string; avatar?: string } = () => ({})
  ) {
    super(deps);
    this.clock = deps.now ?? Date.now;
    this.peopleFile = join(dirname(deps.store.file), 'office-people.json');
    try {
      this.people = PeopleSchema.parse(JSON.parse(readFileSync(this.peopleFile, 'utf8'))).people;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.people = [];
    }
    for (const p of this.people)
      this.children.set(
        p.id,
        new OwnerAuthService({
          store: new OwnerAuthStore(join(dirname(deps.store.file), 'people', p.id, 'owner-auth.json')),
          auditFile: join(dirname(deps.store.file), 'people', p.id, 'owner-auth-audit.jsonl'),
          now: deps.now,
        })
      );
  }

  override policy() {
    return this.people?.length ? ('enforce' as const) : super.policy();
  }

  private async write(change: (people: OfficePerson[]) => void): Promise<void> {
    const work = this.writes.then(async () => {
      const next = structuredClone(this.people);
      change(next);
      const state = PeopleSchema.parse({ version: 1, people: next });
      await writeCompanyStateFile(this.peopleFile, JSON.stringify(state));
      this.people = state.people;
    });
    this.writes = work.catch(() => {});
    await work;
  }

  override forSession(token: string | undefined): OwnerAuthService {
    if (!token || super.session(token)) return this;
    for (const p of this.people)
      if (!p.disabled && !this.accessChanging.has(p.id)) {
        const child = this.children.get(p.id)!;
        if (child.session(token)) return child;
      }
    return this;
  }

  override session(token: string | undefined): OwnerSession | undefined {
    const primary = super.session(token);
    if (primary) return { ...primary, role: 'owner' };
    if (!token) return undefined;
    for (const p of this.people)
      if (!p.disabled && !this.accessChanging.has(p.id)) {
        const session = this.children.get(p.id)?.session(token);
        if (session) return { ...session, role: p.role };
      }
    return undefined;
  }

  override identity(token: string | undefined): HumanIdentity | undefined {
    if (super.session(token)) {
      const profile = this.primaryProfile(),
        username = this.account()!.username;
      return {
        id: 'owner',
        username,
        name: profile.name || username,
        role: 'owner',
        primary: true,
        ...(profile.avatar ? { avatar: profile.avatar } : {}),
      };
    }
    for (const p of this.people)
      if (!p.disabled && !this.accessChanging.has(p.id) && this.children.get(p.id)?.session(token))
        return {
          id: p.id,
          username: this.children.get(p.id)!.account()!.username,
          name: p.name,
          role: p.role,
          primary: false,
          ...(p.avatar ? { avatar: p.avatar } : {}),
        };
    return undefined;
  }

  override async login(...args: Parameters<OwnerAuthService['login']>) {
    if (this.logins >= 2) throw new OwnerAuthError('Sign-in is busy; try again shortly', 429);
    this.logins++;
    try {
      const username = normalizeUsername(args[0]);
      const person =
        username === this.account()?.username
          ? undefined
          : this.people.find((p) => !p.disabled && this.children.get(p.id)?.account()?.username === username);
      if (person && this.accessChanging.has(person.id))
        throw new OwnerAuthError('Account access is changing; sign in again shortly', 429);
      const result = person ? await this.children.get(person.id)!.login(...args) : await super.login(...args);
      for (const [key, value] of this.challengesFor) if (value.expires <= this.clock()) this.challengesFor.delete(key);
      if (person && result.challenge) {
        if (this.challengesFor.size >= 256) throw new OwnerAuthError('Too many pending sign-ins', 429);
        this.challengesFor.set(sha256(result.challenge), { id: person.id, expires: this.clock() + CHALLENGE_TTL_MS });
      }
      return result;
    } finally {
      this.logins--;
    }
  }

  override async secondFactor(...args: Parameters<OwnerAuthService['secondFactor']>) {
    const route = this.challengesFor.get(sha256(args[0]));
    if (!route) return super.secondFactor(...args);
    if (this.accessChanging.has(route.id))
      throw new OwnerAuthError('Account access is changing; sign in again shortly', 429);
    const p = this.people.find((p) => p.id === route.id && !p.disabled);
    if (!p || route.expires <= this.clock()) throw new OwnerAuthError('Sign in again', 401);
    const result = await this.children.get(p.id)!.secondFactor(...args);
    this.challengesFor.delete(sha256(args[0]));
    return result;
  }

  override status(token: string | undefined): ReturnType<OwnerAuthService['status']> {
    const child = this.forSession(token);
    return child === this ? super.status(token) : child.status(token);
  }
  override track(token: string, socket: Socket): void {
    const child = this.forSession(token);
    if (child === this) super.track(token, socket);
    else child.track(token, socket);
  }
  override closeEnded(): number {
    let count = super.closeEnded();
    for (const child of this.children.values()) count += child.closeEnded();
    return count;
  }
  override logout(token: string | undefined): void {
    const child = this.forSession(token);
    if (child === this) super.logout(token);
    else child.logout(token);
    if (token) this.leases.delete(sha256(token));
  }

  usernameAvailable(username: string, token?: string): boolean {
    const own = this.identity(token)?.id,
      normalized = normalizeUsername(username);
    if (own !== 'owner' && normalized === this.account()?.username) return false;
    return !this.people.some((p) => p.id !== own && this.children.get(p.id)?.account()?.username === normalized);
  }

  async create(
    input: { username: string; name: string; role: 'owner' | 'limited'; rooms: string[] },
    actor = 'office-owner'
  ) {
    if (isMultiUserMode())
      throw new OwnerAuthError('Shared-office accounts are unavailable in separate-workspace mode', 409);
    if (this.policy() !== 'enforce')
      throw new OwnerAuthError('Enable enforced owner sign-in before adding people', 409);
    if (this.people.length >= 24) throw new OwnerAuthError('This office has reached its human-account limit', 409);
    const person = PersonSchema.parse({ name: input.name, role: input.role, rooms: input.rooms, id: randomUUID() });
    if (!this.usernameAvailable(input.username)) throw new OwnerAuthError('That login username is already in use', 409);
    const child = new OwnerAuthService({
      store: new OwnerAuthStore(join(dirname(this.peopleFile), 'people', person.id, 'owner-auth.json')),
      auditFile: join(dirname(this.peopleFile), 'people', person.id, 'owner-auth-audit.jsonl'),
      now: this.clock,
    });
    const result = await bootstrap(child.store, input.username, {
      enforce: true,
      now: this.clock(),
      auditActor: actor,
    });
    this.children.set(person.id, child);
    try {
      await this.write((people) => {
        if (!this.usernameAvailable(input.username))
          throw new OwnerAuthError('That login username is already in use', 409);
        people.push(person);
      });
    } catch (error) {
      this.children.delete(person.id);
      throw error;
    }
    return { person: this.publicPerson(person), oneTimePassword: result.oneTimePassword };
  }

  async update(id: string, patch: Partial<Pick<OfficePerson, 'name' | 'role' | 'rooms' | 'disabled' | 'avatar'>>) {
    if (!this.people.some((p) => p.id === id)) throw new OwnerAuthError('No such person', 404);
    const accessChange = patch.role !== undefined || patch.rooms !== undefined || patch.disabled !== undefined;
    if (this.accessChanging.has(id)) throw new OwnerAuthError('Account access is already changing', 409);
    if (accessChange) this.accessChanging.add(id);
    try {
      if (accessChange) {
        // Revoke before publishing the new authority; the gate also blocks in-flight re-login.
        await this.children.get(id)!.logoutEverywhere();
        for (const [key, lease] of this.leases) if (lease.id === id) this.leases.delete(key);
      }
      await this.write((people) => {
        const index = people.findIndex((p) => p.id === id);
        people[index] = PersonSchema.parse({ ...people[index], ...patch });
      });
      return this.publicPerson(this.people.find((p) => p.id === id)!);
    } finally {
      if (accessChange) this.accessChanging.delete(id);
    }
  }

  async reset(id: string, actor = 'office-owner') {
    const child = this.children.get(id);
    if (!child) throw new OwnerAuthError('No such person', 404);
    const result = await resetPassword(child.store, this.clock(), actor);
    child.closeEnded();
    for (const [key, lease] of this.leases) if (lease.id === id) this.leases.delete(key);
    return { oneTimePassword: result };
  }
  private publicPerson(p: OfficePerson) {
    const { readAt: _readAt, ...publicFields } = p;
    return { ...publicFields, username: this.children.get(p.id)?.account()?.username ?? '' };
  }
  list() {
    return this.people.map((p) => this.publicPerson(p));
  }
  cursor(id: string, roomId: string): number | undefined {
    return id === 'owner' ? undefined : (this.people.find((p) => p.id === id)?.readAt[roomId] ?? 0);
  }
  async markRead(id: string, roomId: string, at?: number): Promise<number> {
    const now = this.clock();
    await this.write((people) => {
      const person = people.find((p) => p.id === id);
      if (!person) throw new OwnerAuthError('No such person', 404);
      if (!Object.hasOwn(person.readAt, roomId) && Object.keys(person.readAt).length >= 250)
        delete person.readAt[Object.entries(person.readAt).sort((a, b) => a[1] - b[1])[0][0]];
      person.readAt[roomId] = Math.max(person.readAt[roomId] || 0, Math.min(at ?? now, now));
    });
    return this.cursor(id, roomId)!;
  }
  canRead(person: HumanIdentity, room: { id: string; kind?: string; archivedAt?: number; owner?: string }): boolean {
    if (room.kind === 'dm' || room.archivedAt || room.owner !== undefined) return false;
    return (
      person.role === 'owner' ||
      !!this.people.find((p) => p.id === person.id && !p.disabled && p.rooms.includes(room.id))
    );
  }
  heartbeat(token: string): void {
    const person = this.identity(token);
    if (!person || this.session(token)?.restricted) return;
    this.prunePresence();
    if (this.leases.size < 1024 || this.leases.has(sha256(token)))
      this.leases.set(sha256(token), { id: person.id, at: this.clock() });
  }
  private prunePresence() {
    for (const [key, lease] of this.leases) if (this.clock() - lease.at > 65_000) this.leases.delete(key);
  }
  members(room: { id: string; kind?: string; archivedAt?: number; owner?: string }) {
    this.prunePresence();
    const primary = this.account(),
      profile = this.primaryProfile();
    const people: HumanIdentity[] = primary
      ? [
          {
            id: 'owner',
            username: primary.username,
            name: profile.name || primary.username,
            role: 'owner',
            primary: true,
            ...(profile.avatar ? { avatar: profile.avatar } : {}),
          },
        ]
      : [];
    for (const p of this.people)
      if (!p.disabled)
        people.push({
          id: p.id,
          username: this.children.get(p.id)?.account()?.username || '',
          name: p.name,
          role: p.role,
          primary: false,
          ...(p.avatar ? { avatar: p.avatar } : {}),
        });
    return people
      .filter((p) => this.canRead(p, room))
      .map((p) => ({
        id: p.id,
        name: p.name,
        role: p.role,
        avatar: p.avatar,
        online: [...this.leases.values()].some((l) => l.id === p.id),
      }));
  }
}
