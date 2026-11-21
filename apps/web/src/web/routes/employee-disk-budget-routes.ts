/**
 * @fileoverview Read-only view of the per-employee disk budget.
 *
 * `GET /api/company/disk-budget`: the latest in-memory measurements for the
 * caller's own company. Owner only, like the other company configuration
 * routes; there is no write endpoint.
 *
 * @module web/routes/employee-disk-budget-routes
 */

import type { FastifyInstance } from 'fastify';
import type { CompanyService } from '../../company-service.js';
import type { EmployeeDiskBudgetService } from '../../employee-disk-budget-service.js';
import { NO_OWNER, type OwnerVerifier } from '../../owner-auth/marks.js';
import { ownerFor } from '../route-helpers.js';

export function registerEmployeeDiskBudgetRoutes(
  app: FastifyInstance,
  company: Pick<CompanyService, 'view'>,
  budget: Pick<EmployeeDiskBudgetService, 'view'>,
  verifiedOwner: OwnerVerifier = NO_OWNER
): void {
  app.get('/api/company/disk-budget', async (req, reply) => {
    if (!verifiedOwner(req)) {
      reply.code(403);
      return { success: false, error: 'Only the company owner may read employee disk budgets' };
    }
    // Company ownership is exact: only the caller's own employees are listed.
    return { success: true, data: budget.view(company.view(ownerFor(req)).employees) };
  });
}
