/** Small discovery metadata. Importing it performs no runtime or filesystem work. */
export interface ToolHelpEntry {
  description: string;
  helpCommand: string;
}

const topics: readonly Readonly<ToolHelpEntry>[] = Object.freeze([
  { description: 'Check current permissions', helpCommand: 'reverie agent capabilities --help' },
  { description: 'Read and send company messages', helpCommand: 'reverie agent chat --help' },
  { description: 'Track work and decisions', helpCommand: 'reverie board --help' },
  { description: 'Inspect account usage', helpCommand: 'reverie plans --help' },
  { description: 'Request safe account or runtime changes', helpCommand: 'reverie agent plan-move --help' },
  { description: 'Inspect current profile and core context', helpCommand: 'reverie agent context --help' },
  { description: 'Use granted publication credentials', helpCommand: 'reverie agent credentials --help' },
  { description: 'Read and update managed goals', helpCommand: 'reverie agent goal --help' },
  { description: 'Recall or store scoped memory', helpCommand: 'reverie-memory --help' },
].map(entry => Object.freeze(entry)));

/** Descriptions and help commands only: availability is a separate current query. */
export function toolHelpIndex(): ToolHelpEntry[] {
  return topics.map(entry => ({ ...entry }));
}
