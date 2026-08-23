/**
 * Child process used by the lock contention test.
 *
 * Acquires the store lock, appends `<label> enter <ms>` / `<label> exit <ms>`
 * to a log file, and holds it for a while. Two of these running at once must
 * produce strictly non-overlapping intervals.
 */
import { appendFileSync } from "node:fs";
import { withStoreLock } from "../../src/store/lock.ts";

const [storePath, logPath, label, holdMs] = process.argv.slice(2) as [string, string, string, string];

await withStoreLock(storePath, "append", { host: `host-${label}`, timeoutMs: 20_000 }, async () => {
	appendFileSync(logPath, `${label} enter ${Date.now()}\n`);
	await new Promise((resolve) => setTimeout(resolve, Number.parseInt(holdMs, 10)));
	appendFileSync(logPath, `${label} exit ${Date.now()}\n`);
});
