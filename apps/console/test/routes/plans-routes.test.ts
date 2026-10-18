/**
 * Plans: accounts merged from Codeman profiles and acct directories, sessions mapped
 * to their accounts, pace and recommendation per row, and the suggestion.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installRouteErrorHandler } from '../../src/web/route-error-handler.js';
import { registerPlansRoutes } from '../../src/web/routes/plans-routes.js';
import { PlanService, type PlanSessionLike } from '../../src/plan-accounts.js';
import { WEEK_MS } from '../../src/plan-pace.js';
import { getDataDir } from '../../src/config/instance.js';
import type { SubscriptionProfile } from '../../src/subscription-profiles.js';

const NOW = Date.UTC(2026, 9, 15, 12, 0, 0);
const RESET = NOW + WEEK_MS / 2; // half the week left: elapsed 50 %

function session(id: string, name: string, mode: string, env?: Record<string, string>): PlanSessionLike {
  return { id, name, mode, status: 'idle', getEnvOverridesForPersist: () => env };
}

describe('plans routes', () => {
  let app: FastifyInstance;
  let home: string;
  const savedHome = process.env.HOME;
  const usage: Record<string, { status: 'ready' | 'signed-out'; five?: number; week?: number }> = {};

  beforeEach(async () => {
    rmSync(join(getDataDir(), 'subscription-profiles.json'), { force: true });
    home = mkdtempSync(join(tmpdir(), 'plans-home-'));
    process.env.HOME = home;
    mkdirSync(join(home, '.claude'));
    mkdirSync(join(home, '.codex'));
    mkdirSync(join(home, '.claude-accounts'));
    mkdirSync(join(home, '.codex-accounts'));
    symlinkSync(join(home, '.claude'), join(home, '.claude-accounts', 'initech'));
    mkdirSync(join(home, '.claude-accounts', 'gmail'));
    mkdirSync(join(home, '.claude-accounts', 'globex'));
    symlinkSync(join(home, '.codex'), join(home, '.codex-accounts', 'gmail'));
    Object.assign(usage, {
      'anthropic-default': { status: 'ready', five: 30, week: 70 }, // pace +20: ease
      'acct-anthropic-gmail': { status: 'ready', five: 5, week: 10 }, // pace -40: push
      'acct-anthropic-globex': { status: 'signed-out' },
      'openai-default': { status: 'ready', five: 96, week: 40 }, // 5 h full: stop
    });
    const reader = {
      read: async (p: SubscriptionProfile) => {
        const u = usage[p.id] ?? { status: 'signed-out' as const };
        return {
          id: p.id,
          label: p.label,
          provider: p.provider,
          status: u.status,
          updatedAt: NOW,
          usage:
            u.status === 'ready'
              ? {
                  fiveHour: { usedPercentage: u.five!, resetAt: NOW + 3600_000 },
                  sevenDay: { usedPercentage: u.week!, resetAt: RESET },
                  ...(p.id === 'openai-default'
                    ? { bankedResets: { availableCount: 2, earliestExpiresAt: NOW + 86_400_000 } }
                    : {}),
                }
              : null,
        };
      },
    };
    const sessions = [
      session('s-default', 'w1-compiler', 'claude'),
      session('s-gmail', 'w2-lean', 'claude', { CLAUDE_CONFIG_DIR: join(home, '.claude-accounts', 'gmail') }),
      session('s-orch', 'w4-orchestrator', 'claude'),
      session('s-codex', 'w1-pr', 'codex'),
      session('s-shell', 'scratch', 'shell'),
    ];
    const service = new PlanService({
      reader: reader as never,
      sessions: () => sessions,
      coordinatorIds: () => ['s-orch'],
      historyFile: join(home, 'plan-history.json'),
      home,
      now: () => NOW,
      gpu: async () => ({
        available: true,
        utilization: 87,
        memoryUsedMb: 20000,
        memoryTotalMb: 24000,
        models: ['qwen.gguf'],
        lastHolder: { role: 'chat', ageS: 3 },
      }),
    });
    app = Fastify({ logger: false });
    registerPlansRoutes(app, service);
    installRouteErrorHandler(app);
    await app.ready();
  });

  afterEach(async () => {
    process.env.HOME = savedHome;
    await app.close();
  });

  it('lists every account once, named by acct, with pace, recommendation and sessions', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/plans' });
    expect(res.statusCode).toBe(200);
    const { accounts, gpu } = res.json().data;
    const byLabel = Object.fromEntries(
      accounts.map((a: { provider: string; label: string }) => [`${a.provider}:${a.label}`, a])
    );
    expect(Object.keys(byLabel).sort()).toEqual([
      'anthropic:globex',
      'anthropic:gmail',
      'anthropic:initech',
      'openai:gmail',
    ]);
    const initech = byLabel['anthropic:initech'];
    expect(initech).toMatchObject({
      id: 'anthropic-default',
      profileId: 'anthropic-default',
      isDefault: true,
      orchestrator: true,
    });
    expect(initech.pace).toMatchObject({ elapsed: 50, pace: 20, recommendation: 'ease' });
    expect(initech.sessions.map((s: { name: string }) => s.name)).toEqual(['w1-compiler', 'w4-orchestrator']);
    expect(byLabel['anthropic:gmail']).toMatchObject({ profileId: null, isDefault: false, orchestrator: false });
    expect(byLabel['anthropic:gmail'].pace.recommendation).toBe('push');
    expect(byLabel['anthropic:gmail'].sessions.map((s: { name: string }) => s.name)).toEqual(['w2-lean']);
    expect(byLabel['anthropic:globex']).toMatchObject({ signedIn: false });
    expect(byLabel['anthropic:globex'].pace.recommendation).toBe('login');
    expect(byLabel['openai:gmail'].pace.recommendation).toBe('stop');
    expect(byLabel['openai:gmail'].sessions.map((s: { name: string }) => s.name)).toEqual(['w1-pr']);
    expect(byLabel['openai:gmail'].bankedResets).toEqual({ availableCount: 2, earliestExpiresAt: NOW + 86_400_000 });
    expect(byLabel['anthropic:initech'].bankedResets).toBeNull();
    expect(gpu).toMatchObject({ utilization: 87, models: ['qwen.gguf'], lastHolder: { role: 'chat' } });
  });

  it('shows an owner-set profile label instead of the directory name', async () => {
    const { renameSubscriptionProfile } = await import('../../src/subscription-profiles.js');
    await renameSubscriptionProfile('openai-default', 'Codex user@example.com');
    const { accounts } = (await app.inject({ method: 'GET', url: '/api/plans' })).json().data;
    const labels = accounts.map((a: { provider: string; label: string }) => `${a.provider}:${a.label}`);
    expect(labels).toContain('openai:Codex user@example.com');
    expect(labels).not.toContain('openai:gmail');
    expect(labels).toContain('anthropic:initech');
  });

  it('suggests the account with the most headroom and how to launch on it', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/plans/suggest', payload: { provider: 'anthropic' } });
    expect(res.statusCode).toBe(200);
    const { account, launch } = res.json().data;
    expect(account.label).toBe('gmail');
    expect(launch).toEqual({ envOverrides: { CLAUDE_CONFIG_DIR: join(home, '.claude-accounts', 'gmail') } });
  });

  it('answers 409 when no account of that provider has room', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/plans/suggest', payload: { provider: 'openai' } });
    expect(res.statusCode).toBe(409);
  });

  it('launches on a default-directory account through its profile with no override', async () => {
    usage['acct-anthropic-gmail'] = { status: 'ready', five: 99, week: 10 }; // gmail must stop
    const res = await app.inject({ method: 'POST', url: '/api/plans/suggest', payload: {} });
    expect(res.json().data).toMatchObject({
      account: { label: 'initech' },
      launch: { subscriptionProfileId: 'anthropic-default', envOverrides: {} },
    });
  });
});
