/** @fileoverview Shared employee identity comparisons and portable, name-derived case components. */
export function employeeNameKey(name: string): string {
  return name.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
}

/** Keep existing ASCII case-path validation. Unicode names retain deterministic
 * code-point spellings after readable Latin accent folding, never random IDs. */
export function employeeCaseName(name: string): string | undefined {
  const normalized = employeeNameKey(name).normalize('NFKD').replace(/\p{M}/gu, '');
  let slug = Array.from(normalized, (character) => {
    if (/[a-z0-9]/.test(character)) return character;
    return character.codePointAt(0)! > 127 ? `-u${character.codePointAt(0)!.toString(16)}-` : '-';
  })
    .join('')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  // Punctuation-only display names were already valid. Give them a safe spelling too.
  if (!slug)
    slug = Array.from(employeeNameKey(name), (character) => `u${character.codePointAt(0)!.toString(16)}`).join('-');
  const component = 'expert-' + slug;
  return slug && component.length <= 255 ? component : undefined;
}

export function employeeNamesConflict(first: string, second: string): boolean {
  if (employeeNameKey(first) === employeeNameKey(second)) return true;
  const component = employeeCaseName(first);
  return component !== undefined && component === employeeCaseName(second);
}
