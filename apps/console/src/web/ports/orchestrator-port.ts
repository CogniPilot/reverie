/**
 * @fileoverview Orchestrator port — capabilities for orchestrator loop management.
 * Route modules that interact with the orchestrator depend on this port.
 */

import type { OrchestratorLoop } from '../../orchestrator-loop.js';

export interface OrchestratorPort {
  readonly orchestratorLoop: OrchestratorLoop | null;
  initOrchestratorLoop(): OrchestratorLoop;
}
