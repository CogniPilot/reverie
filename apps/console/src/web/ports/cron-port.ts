/**
 * @fileoverview Cron port — exposes the CronService to
 * route handlers via the shared route context.
 */

import type { CronService } from '../../cron/cron-service.js';
import type { RoutinesGrants } from '../../routines-grants.js';

/** What the post-job routes need to let a delegated employee (not only the owner) author post jobs. */
export interface RoutinesPolicy {
  readonly grants: RoutinesGrants;
  /** The employee whose session id the agent header carries. */
  findEmployee(sessionId: string): { id: string; name: string; position: string } | undefined;
  /** The boardroom channel, or undefined when there is none. */
  boardroomId(): string | undefined;
  /** Post a one-line system notice in a room; false when it could not be posted. */
  notify(roomId: string, text: string): boolean;
}

export interface CronPort {
  readonly cron: CronService;
  /** Set once the company and chat services exist; without it only the owner authors post jobs. */
  routines?: RoutinesPolicy;
}
