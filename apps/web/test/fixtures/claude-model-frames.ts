/**
 * Claude Code pane frames for the employee model tests.
 *
 * The idle and working frames keep the chrome of real Claude Code panes captured read-only from the
 * office on 2026-11-24 (rule rows, composer `❯` + no-break space, the statusline exporter's model row
 * and the permissions footer); only the transcript rows above them are replaced. The limit notice,
 * menu and footer wording is the text the owner read off live panes that night; their layout around
 * the composer is reconstructed, since no pane showed one while these frames were captured.
 */
const RULE = '─'.repeat(120);
const NAMED_RULE = `${'─'.repeat(113)} Stan ─`;
const IDLE_FOOTER = '  ⏵⏵ bypass permissions on · 1 shell · ↓ to manage';
export const WORKING_FOOTER = '  ⏵⏵ bypass permissions on · 1 shell · esc to interrupt · ↓ to manage';
export const glyph = '❯';

export function frame(
  above: string[],
  options: { composer?: string; model?: string; footer?: string; below?: string[] } = {}
): string {
  return [
    ...above,
    NAMED_RULE,
    `❯ ${options.composer ?? ''}`,
    RULE,
    `  ${options.model ?? 'Fable 5.2'}  in:657,617 out:127  ctx:66%  cache:until 01:00`,
    options.footer ?? IDLE_FOOTER,
    ...(options.below ?? []),
    '',
    '',
  ].join('\n');
}

export const IDLE = frame([
  '● Work summary.',
  '✻ Sautéed for 8s · done 12:00 AM · 1 shell still running',
  ' '.repeat(99) + '◎ /goal active (3h)',
]);
export const WORKING = frame(['● Reading the newest messages', '✻ Actualizing… (4s · ↓ 66 tokens)'], {
  footer: WORKING_FOOTER,
  model: 'Opus 5.5',
});
export const DRAFT = frame(['✻ Brewed for 6s · done 12:00 AM'], { composer: 'half a sentence the owner is typing' });
export const NOTICE = frame([
  "  ⎿  You've hit your Fable limit · resets Nov 26, 4am (UTC)",
  "  ⎿  You've reached your Fable limit. Run /usage-credits to continue or switch models with /model.",
]);
export const MENU = [
  "  ⎿  You've hit your Fable limit · resets Nov 26, 4am (UTC)",
  '',
  ' What do you want to do?',
  '',
  ' ❯ 1. Stop and wait for limit to reset',
  '   2. Wait here, then continue automatically at Nov 26, 4am',
  '   3. Add funds to continue with usage credits',
  '',
  ' Enter to confirm · Esc to cancel',
  '',
].join('\n');
export const FOOTER = frame(["  ⎿  You've hit your Fable limit · resets 9am"], {
  below: [
    '  ⚠ Usage limit reached · limit resets 9am',
    '  Continuing automatically at 9am · Esc to cancel · /usage-credits to continue now',
  ],
});
export const ACCOUNT_LIMIT = frame(["  ⎿  You've hit your limit · resets 1:40pm (America/New_York)"]);
export const NOW = Date.UTC(2026, 10, 25, 0, 0);
