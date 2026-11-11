/** Browser journal partition only. This descriptor grants no session or native authority. */
export interface BrowserInputIdentity {
  readonly version: 1;
  readonly kind: 'account' | 'session' | 'anonymous';
  readonly scopeId: string;
  readonly epoch: number;
}
