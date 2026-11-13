/** Closed terminal protocol selection. This is behavior data, never an input grant. */
import { getCli } from './config/cli-registry/registry.js';
import { isDeepStrictEqual } from 'node:util';

interface InputProtocol {
  readonly requiresEmptyComposer: boolean;
  readonly shellKeyGuard: boolean;
  readonly keyBurstMaxChars?: number;
}
export function cliInputProtocol(mode: string): InputProtocol {
  const input = getCli(mode)?.capabilities.terminalInput;
  return Object.freeze({
    requiresEmptyComposer: input?.requiresEmptyComposer ?? false,
    shellKeyGuard: input?.shellKeyGuard === 'bang-shell',
    ...(input?.keyBurstMaxChars === undefined ? {} : { keyBurstMaxChars: input.keyBurstMaxChars }),
  });
}

/** Retain this write's protocol; an observed change permanently revokes its witness. */
export function captureCliInputProtocol(mode: string): { readonly protocol: InputProtocol; current(): boolean } {
  const protocol = cliInputProtocol(mode);
  let changed = false;
  return Object.freeze({ protocol, current: () => {
    if (!isDeepStrictEqual(protocol, cliInputProtocol(mode))) changed = true;
    return !changed;
  } });
}
