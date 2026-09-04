import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { newEntryId, newHostId, newMemberId, newProjectId } from "../../src/ids.ts";
import {
	exportTranscript,
	importTranscript,
	locateTranscript,
	transcriptExchangePath,
} from "../../src/integrations/transcript.ts";
import { buildJournalRecord, type JournalRecord } from "../../src/journal/record.ts";

const roots: string[] = [];

function root(name = "muninn transcript "): string {
	const path = mkdtempSync(join(tmpdir(), name));
	roots.push(path);
	return path;
}

afterEach(() => {
	for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture(): { agentDir: string; sessionRoot: string; transcript: string; record: JournalRecord; text: string } {
	const agentDir = root();
	const sessionRoot = join(agentDir, "sessions");
	mkdirSync(sessionRoot, { recursive: true });
	const transcript = join(sessionRoot, "session with spaces.jsonl");
	const text = `${JSON.stringify({ type: "session", id: "session-1" })}\n${JSON.stringify({ type: "message", text: "private transcript evidence" })}\n`;
	writeFileSync(transcript, text, { mode: 0o600 });
	const record = buildJournalRecord(
		{
			type: "outcome",
			source: "agent",
			channel: "rpc",
			body: "Remote work completed.",
			session: { file: transcript, last: "message-1" },
		},
		{ project: newProjectId(), member: newMemberId(), host: newHostId(), id: newEntryId() },
	);
	return { agentDir, sessionRoot, transcript, record, text };
}

/** Reversible test transport; production always invokes the real age executable. */
async function fakeAge(args: readonly string[]): Promise<void> {
	const outputAt = args.indexOf("--output");
	if (outputAt < 0) throw new Error("missing output");
	const output = args[outputAt + 1] as string;
	const input = args.at(-1) as string;
	const bytes = readFileSync(input);
	writeFileSync(output, Buffer.from(bytes.map((byte) => byte ^ 0xa5)), { mode: 0o600 });
}

describe("encrypted transcript exchange", () => {
	it("packages one contained transcript and atomically resolves the recipient-local copy", async () => {
		const source = fixture();
		const bundle = join(source.agentDir, "exchange bundle.age");
		const identity = join(source.agentDir, "identity.txt");
		writeFileSync(identity, "AGE-SECRET-KEY-fixture\n", { mode: 0o600 });
		const exported = await exportTranscript({
			record: source.record,
			transcriptRoots: [source.sessionRoot],
			output: bundle,
			recipients: ["age1fixture"],
			runAge: fakeAge,
		});
		expect(exported).toMatchObject({
			kind: "transcript-export",
			project: source.record.project,
			record: source.record.id,
			bytes: Buffer.byteLength(source.text),
		});
		expect(readFileSync(bundle, "utf-8")).not.toContain("private transcript evidence");

		const recipientAgent = root("muninn recipient ");
		const imported = await importTranscript({
			agentDir: recipientAgent,
			project: source.record.project,
			input: bundle,
			identity,
			findRecord: (id) => (id === source.record.id ? source.record : undefined),
			runAge: fakeAge,
		});
		expect(imported).toMatchObject({ kind: "transcript-import", record: source.record.id, replayed: false });
		expect(readFileSync(imported.path, "utf-8")).toBe(source.text);
		expect(statSync(imported.path).mode & 0o777).toBe(0o600);
		expect(locateTranscript(source.record, [], recipientAgent)).toEqual({
			available: true,
			availability: "exchange",
			local_file: imported.path,
		});
		expect(
			await importTranscript({
				agentDir: recipientAgent,
				project: source.record.project,
				input: bundle,
				identity,
				findRecord: () => source.record,
				runAge: fakeAge,
			}),
		).toMatchObject({ replayed: true, path: imported.path });
	});

	it("refuses an escaped source, mismatched project, tampering, and overwrite", async () => {
		const source = fixture();
		const outside = join(root(), "outside.jsonl");
		writeFileSync(outside, "{}\n");
		const escaped = { ...source.record, session: { file: outside } };
		await expect(
			exportTranscript({
				record: escaped,
				transcriptRoots: [source.sessionRoot],
				output: join(source.agentDir, "escaped.age"),
				recipients: ["age1fixture"],
				runAge: fakeAge,
			}),
		).rejects.toThrow(/no original transcript/);

		const bundle = join(source.agentDir, "valid.age");
		const identity = join(source.agentDir, "identity.txt");
		writeFileSync(identity, "fixture", { mode: 0o600 });
		await exportTranscript({
			record: source.record,
			transcriptRoots: [source.sessionRoot],
			output: bundle,
			recipients: ["age1fixture"],
			runAge: fakeAge,
		});
		await expect(
			importTranscript({
				agentDir: root(),
				project: newProjectId(),
				input: bundle,
				identity,
				findRecord: () => source.record,
				runAge: fakeAge,
			}),
		).rejects.toThrow(/different project/);

		const tampered = Buffer.from(readFileSync(bundle));
		tampered[tampered.length - 1] = (tampered[tampered.length - 1] as number) ^ 1;
		writeFileSync(bundle, tampered);
		await expect(
			importTranscript({
				agentDir: root(),
				project: source.record.project,
				input: bundle,
				identity,
				findRecord: () => source.record,
				runAge: fakeAge,
			}),
		).rejects.toThrow(/hash/);

		const destinationAgent = root();
		const destination = transcriptExchangePath(destinationAgent, source.record.project, source.record.id);
		mkdirSync(join(destinationAgent, "muninn-transcripts", source.record.project), { recursive: true });
		writeFileSync(destination, "different\n", { mode: 0o600 });
		tampered[tampered.length - 1] = (tampered[tampered.length - 1] as number) ^ 1;
		writeFileSync(bundle, tampered);
		await expect(
			importTranscript({
				agentDir: destinationAgent,
				project: source.record.project,
				input: bundle,
				identity,
				findRecord: () => source.record,
				runAge: fakeAge,
			}),
		).rejects.toThrow(/overwrite different/);
	});
});

const hasAge = spawnSync("age", ["--version"]).status === 0 && spawnSync("age-keygen", ["--version"]).status === 0;

describe.runIf(hasAge)("real age compatibility", () => {
	it("round-trips through age and age-keygen", async () => {
		const source = fixture();
		const identity = join(source.agentDir, "age identity.txt");
		execFileSync("age-keygen", ["--output", identity]);
		const publicLine = readFileSync(identity, "utf-8")
			.split("\n")
			.find((line) => line.startsWith("# public key: "));
		if (!publicLine) throw new Error("age-keygen did not write its public key");
		const recipient = publicLine.replace(/^# public key: /, "");
		const bundle = join(source.agentDir, "real.age");
		await exportTranscript({
			record: source.record,
			transcriptRoots: [source.sessionRoot],
			output: bundle,
			recipients: [recipient],
		});
		const wrongIdentity = join(source.agentDir, "wrong identity.txt");
		execFileSync("age-keygen", ["--output", wrongIdentity]);
		await expect(
			importTranscript({
				agentDir: root(),
				project: source.record.project,
				input: bundle,
				identity: wrongIdentity,
				findRecord: () => source.record,
			}),
		).rejects.toThrow(/age|identity|decrypt/i);
		const imported = await importTranscript({
			agentDir: root(),
			project: source.record.project,
			input: bundle,
			identity,
			findRecord: () => source.record,
		});
		expect(readFileSync(imported.path, "utf-8")).toBe(source.text);
	});
});
