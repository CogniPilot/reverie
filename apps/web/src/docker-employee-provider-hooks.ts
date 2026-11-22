import { getCli } from './config/cli-registry/registry.js';
import { resolvedStockProtocol } from './utils/resolved-stock-protocol.js';
/** Canonical mode metadata only. Current native/recipe authority remains with the owning view operation. */
import type { CompanyService } from './company-service.js';
import type { StateStore } from './state-store.js';
import type { DockerEmployeeContinuationRecord } from './docker-employee-continuation-data.js';

export function dockerProviderModeReader(
  company: CompanyService,
  states: StateStore
): (row: DockerEmployeeContinuationRecord) => string {
  return (row) => {
    const employees = company.store.view().employees.filter((e) => e.id === row.employeeId),
      employee = employees[0],
      saved = states.getSession(row.request.sessionId);
    const mode = saved?.mode ?? 'claude';
    if (
      employees.length !== 1 ||
      !employee ||
      !saved ||
      employee.owner !== row.owner ||
      employee.sessionId !== row.request.sessionId ||
      employee.sessionGeneration !== row.request.sessionGeneration ||
      (employee.runtimeRecipe !== undefined && employee.runtimeRecipe.mode !== mode)
    )
      throw Error('Original canonical provider mode changed');
    return mode;
  };
}

export function dockerProviderHookPolicy(
  mode: string
): { mode: string; kind: 'none' | 'generation'; capability: 'none' | 'always' | 'supervised' } | undefined {
  const cli = getCli(mode);
  if (!cli) return undefined;
  const stock = resolvedStockProtocol(mode);
  const noHooks =
    cli.capabilities.hooks === 'none' &&
    stock?.entry.capabilities.hooks === 'none' &&
    stock.shipped.capabilities.hooks === 'none';
  return { mode, kind: noHooks ? 'none' : 'generation', capability: cli.capabilities.hooks };
}
