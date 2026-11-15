import { readFile } from 'node:fs/promises';
import { DockerPlanMoveJournalState } from '../../src/docker-plan-move-data.js';
/** Store-CAS test port only: no Docker or provider effect. */
import { PlanMoveStore } from '../../src/plan-move-store.js';
const [file, id, epoch, beforeFile] = process.argv.slice(2);
if (!file || !id || !epoch || !beforeFile) throw Error('Missing private fixture arguments');
const store = new PlanMoveStore(file);
const before = DockerPlanMoveJournalState.parse(JSON.parse(await readFile(beforeFile, 'utf8')));
try {
  await store.dockerClaim(
    id,
    before,
    epoch,
    () => {},
    () => {}
  );
  process.stdout.write('claimed\n');
} catch {
  process.stdout.write('refused\n');
}
