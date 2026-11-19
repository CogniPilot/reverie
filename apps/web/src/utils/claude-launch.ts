export interface ClaudeResumeCommand { id: string; command: string; }
const SAFE_ID = /^[A-Za-z0-9._-]+$/;
const quote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

export function renderClaudeLaunch(resumes: readonly ClaudeResumeCommand[], fresh: string): string {
  const seen = new Set<string>();
  const candidates = resumes.filter(({ id }) => {
    if (!SAFE_ID.test(id) || seen.has(id)) return false;
    seen.add(id); return true;
  });
  const script = `command -v reverie-backend >/dev/null 2>&1 || { printf '%s\\n' 'Reverie: native Claude transcript selector unavailable; launch withheld.' >&2; exit 78; }\nexec reverie-backend --claude-launch ${quote(JSON.stringify({ resumes: candidates, fresh }))}`;
  return `/bin/sh -c ${quote(script)}`;
}
