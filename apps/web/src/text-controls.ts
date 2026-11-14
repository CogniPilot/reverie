/** Exact C0/DEL policies. C1 and Unicode format characters remain outside these boundaries. */
const c0OrDel = (code: number) => code < 0x20 || code === 0x7f;
export function containsC0OrDel(text: string): boolean {
  for (const character of text) if (c0OrDel(character.charCodeAt(0))) return true;
  return false;
}
/** Handoff text additionally permits exactly horizontal tab, LF and CR. */
export function containsHandoffControls(text: string): boolean {
  for (const character of text) {
    const code = character.charCodeAt(0);
    if (c0OrDel(code) && ![0x09, 0x0a, 0x0d].includes(code)) return true;
  }
  return false;
}
