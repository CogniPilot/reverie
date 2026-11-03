/** Non-authorizing wire facts; kept independent of runtime/service imports. */
export interface ProviderHealth {
  /** Exact canonical company binding at observation acceptance. */
  binding: string;
  employeeId: string;
  sessionId: string;
  sessionGeneration: number;
  state: 'healthy' | 'dead' | 'unknown';
  observedAtEpochMs: number;
  reason: string;
}
