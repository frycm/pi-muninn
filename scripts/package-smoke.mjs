/** Exercise the tarball as a consumer, without resolving source from this checkout. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { memoryOutcomeReply, startMockProvider } from "../test/fixtures/mock-provider.ts";

const execFileAsync = promisify(execFile);
function execute(...args) {
	const result = execFileAsync(...args);
	// Print-mode pi reads piped stdin before its prompt. No input is intended.
	result.child.stdin?.end();
	return result;
}
const root = fileURLToPath(new URL("..", import.meta.url));
const scratch = await mkdtemp(join(tmpdir(), "muninn-package-"));
let mock;
try {
	const packed = await execute("npm", ["pack", "--json", "--pack-destination", scratch], { cwd: root });
	const [{ filename, files }] = JSON.parse(packed.stdout);
	assert(files.some((file) => file.path === "dist/cli.js"));
	assert(!files.some((file) => file.path.startsWith("src/") || file.path.startsWith("test/")));
	const consumer = join(scratch, "consumer");
	await mkdir(consumer);
	await writeFile(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }));
	await execute(
		"npm",
		["install", "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund", join(scratch, filename)],
		{ cwd: consumer, maxBuffer: 4 * 1024 * 1024 },
	);
	const packageRoot = join(consumer, "node_modules", "pi-muninn");
	const metadata = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
	const agentDir = join(scratch, "agent");
	const code = join(scratch, "project");
	await mkdir(code);
	await writeFile(join(code, "README.md"), "The package smoke test reads this file.\n");
	const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir };
	const cli = join(consumer, "node_modules", ".bin", "muninn");
	assert.match(
		(await execute(cli, ["--version"], { cwd: code, env })).stdout,
		new RegExp(metadata.version.replaceAll(".", "\\.")),
	);
	await execute(cli, ["note", "packaged CLI evidence", "--json"], { cwd: code, env });
	const search = JSON.parse(
		(await execute(cli, ["search", "packaged CLI evidence", "--json"], { cwd: code, env })).stdout,
	);
	assert(search.records.some((record) => record.snippet.includes("packaged CLI evidence")));
	const probe = `import extension from 'pi-muninn'; import { muninnIntegrationEntry } from 'pi-muninn/integration'; const tools=[]; extension({registerTool:t=>tools.push(t.name),registerCommand(){},on(){}}); if(tools.length!==6||typeof muninnIntegrationEntry!=='function') throw Error('bad exports');`;
	await execute(process.execPath, ["--input-type=module", "-e", probe], { cwd: consumer, env });
	// Resolve declarations through the installed export map, including their
	// transitive relative imports, using Node's module rules.
	await writeFile(
		join(consumer, "consumer.mts"),
		`
import extension from "pi-muninn";
import { muninnIntegrationEntry, type IntegrationObservation, type MuninnIntegrationSessionEntry } from "pi-muninn/integration";
const observation: IntegrationObservation = {
  schema: 1, type: "note", channel: "sdk", body: "consumer type check", tags: [], paths: [],
  integration: { provider: "package-smoke", kind: "test", event: "completed", external_id: "one", observed_at: "2026-09-05T00:00:00.000Z", metadata: {} }
};
const entry: MuninnIntegrationSessionEntry = muninnIntegrationEntry(observation);
const recordType: "note" | "checkpoint" | "outcome" = entry.data.type;
void [extension, recordType];
`,
	);
	await execute(
		process.execPath,
		[
			join(root, "node_modules", "typescript", "bin", "tsc"),
			"--noEmit",
			"--strict",
			"--skipLibCheck",
			"--target",
			"ES2023",
			"--module",
			"NodeNext",
			"consumer.mts",
		],
		{ cwd: consumer },
	);
	mock = await startMockProvider((request, call) =>
		request.isOutcomeCall
			? memoryOutcomeReply(request, "The installed extension captured the task.")
			: call > 0
				? "Package read succeeded."
				: { toolCall: { name: "read", arguments: { path: "README.md" } } },
	);
	await execute(
		join(consumer, "node_modules", ".bin", "pi"),
		[
			"-p",
			"Read README.md",
			"--model",
			"muninn-test/mock",
			"-e",
			join(root, "test", "fixtures", "mock-provider-extension.ts"),
			"-e",
			join(packageRoot, metadata.pi.extensions[0]),
		],
		{ cwd: code, env: { ...env, MUNINN_TEST_PROVIDER_URL: mock.url }, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 },
	);
	const outcomes = JSON.parse(
		(await execute(cli, ["search", "--type", "outcome", "--json"], { cwd: code, env })).stdout,
	);
	assert(outcomes.records.length > 0, "installed extension did not capture a real pi task");
	console.log(`Package smoke passed: CLI, exports and real pi capture (${metadata.version}, ${process.version}).`);
} catch (error) {
	console.error(
		`Package pi requests: ${mock?.requests.length ?? 0}; roles: ${
			mock?.requests
				.at(-1)
				?.messages.map((message) => message.role)
				.join(",") ?? "none"
		}`,
	);
	throw error;
} finally {
	await mock?.close();
	await rm(scratch, { recursive: true, force: true });
}
