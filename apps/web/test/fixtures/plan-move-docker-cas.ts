/** Store-CAS test port only: no Docker or provider effect. */
import { PlanMoveStore } from '../../src/plan-move-store.js';
const [file, id, epoch] = process.argv.slice(2);
if (!file || !id || !epoch) throw Error('Missing private fixture arguments');
const store = new PlanMoveStore(file),
  record = await store.dockerRecord(id);
if (!record.dockerReplacement) throw Error('Fixture has no journal');
try {
  await store.dockerClaim(
    id,
    record.dockerReplacement,
    epoch,
    () => {},
    () => {}
  );
  process.stdout.write('claimed\n');
} catch {
  process.stdout.write('refused\n');
}
