/** Cross-process writer used by the JSONL append concurrency test. */
import { appendJournalRecord } from "../../src/journal/jsonl.ts";

const [storePath, project, member, host, label, countText] = process.argv.slice(2) as [
	string,
	string,
	string,
	string,
	string,
	string,
];
const ids: string[] = [];
for (let index = 0; index < Number.parseInt(countText, 10); index++) {
	const result = await appendJournalRecord(
		{ type: "note", source: "agent", channel: "sdk", body: `${label} ${index}` },
		{ storePath, project, member, host },
	);
	ids.push(result.id);
}
process.stdout.write(JSON.stringify(ids));
