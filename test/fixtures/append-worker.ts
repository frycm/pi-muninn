/**
 * Child process for the journal concurrency acceptance test.
 *
 * Appends N entries to one store as one host, then prints the ids it wrote as
 * JSON so the parent can check they came back in order and none were lost.
 */
import { appendEntry } from "../../src/journal/append.ts";

const [storePath, hostId, label, countText] = process.argv.slice(2) as [string, string, string, string];
const count = Number.parseInt(countText, 10);

const ids: string[] = [];
for (let i = 0; i < count; i++) {
	const result = await appendEntry(
		{
			source: "agent",
			channel: "sdk",
			task: `task-${label}`,
			prose: `writer ${label} entry ${i}`,
			claims: [`claim ${i} from writer ${label}`],
		},
		{ storePath, hostId },
	);
	ids.push(result.id);
}

process.stdout.write(JSON.stringify(ids));
