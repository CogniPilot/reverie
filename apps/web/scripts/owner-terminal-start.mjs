// Optional immutable startup. Never a normal CLI fallback or inherited-FD import.
import { connectOwnerTerminal } from './connect-owner-terminal.mjs';
import { installOwnerTerminalSocket } from '../dist/owner-terminal-runtime.js';
installOwnerTerminalSocket(await connectOwnerTerminal());
await import('../dist/index.js');
