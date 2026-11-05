/** Closed, public diagnostics for refusals before a preview dispatches a restart.
 * These codes say nothing about an earlier operation's outcome or host readiness.
 */
export type ResourcePreviewBlocker =
  | 'RESOURCE_PREVIEW_HOST_UNCONFIGURED'
  | 'RESOURCE_PREVIEW_HOST_UNAVAILABLE'
  | 'RESOURCE_PREVIEW_BUSY'
  | 'RESOURCE_PREVIEW_PENDING';

/** Public operation state. The server owns the decision represented by the flag;
 * phase names are for progress display, not a client-side admission policy.
 */
export interface ResourceOperationSummary {
  id: string;
  employeeId: string;
  phase: string;
  blocksFurtherChanges: boolean;
}

export const RESOURCE_PREVIEW_BLOCKERS: Readonly<Record<ResourcePreviewBlocker, string>> = Object.freeze({
  RESOURCE_PREVIEW_HOST_UNCONFIGURED:
    'Laptop memory changes need the host resource service. Complete the supported server setup before previewing a change.',
  RESOURCE_PREVIEW_HOST_UNAVAILABLE:
    'The host resource service could not be verified. Check the server setup and service status. This preview did not dispatch a restart.',
  RESOURCE_PREVIEW_BUSY:
    'This employee is working or a memory change is being prepared. Wait for it to finish before previewing a change.',
  RESOURCE_PREVIEW_PENDING:
    'An earlier memory change is still in progress or needs inspection. Use Check status before starting another change.',
});
