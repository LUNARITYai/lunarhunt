import { writeLedgerRecord } from "../../../src/ledger/writer.ts";
import { sampleRecord } from "./sample.ts";

/** Usage: node --experimental-strip-types append-worker.ts <home> <worker> <count> */
const [home, worker, count] = process.argv.slice(2);
let failures = 0;
for (let index = 0; index < Number(count); index += 1) {
  const result = writeLedgerRecord(
    sampleRecord({ session_id: `worker-${worker}`, duration_ms: index }),
    { home: home ?? null },
  );
  if (!result.ok) {
    failures += 1;
  }
}
process.exit(failures === 0 ? 0 : 1);
