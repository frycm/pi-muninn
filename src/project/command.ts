/** Human-facing project registry commands shared by pi and the standalone CLI. */
import { resolve } from "node:path";
import { linkLogicalProject, type ResolvedProject, resolveLogicalProject, unlinkLogicalProject } from "./resolver.ts";

export const PROJECT_USAGE = [
	"muninn project show [path]",
	"muninn project link [path] [--id UUID] [--name NAME] [--force]",
	"muninn project unlink [path]",
	"muninn project remote [URL|--remove]",
	"muninn project share [path] [--json]",
	"muninn project join JOURNAL-URL [path] [--force] [--json]",
].join("\n");

export interface ProjectCommandContext {
	agentDir: string;
	cwd: string;
	hostId: string;
}

export interface ProjectCommandResult {
	code: number;
	out: string[];
	err: string[];
	changed: boolean;
}

interface ParsedOptions {
	path?: string;
	id?: string;
	name?: string;
	force: boolean;
}

function parseOptions(args: readonly string[]): ParsedOptions {
	const parsed: ParsedOptions = { force: false };
	for (let index = 0; index < args.length; index++) {
		const arg = args[index] as string;
		if (arg === "--force") {
			parsed.force = true;
			continue;
		}
		if (arg === "--id" || arg === "--name") {
			const value = args[index + 1];
			if (!value || value.startsWith("--")) throw new Error(`muninn: ${arg} needs a value`);
			if (arg === "--id") parsed.id = value;
			else parsed.name = value;
			index++;
			continue;
		}
		if (arg.startsWith("--")) throw new Error(`muninn: unknown project option ${arg}`);
		if (parsed.path !== undefined) throw new Error("muninn: project command takes at most one path");
		parsed.path = arg;
	}
	return parsed;
}

export function formatResolvedProject(project: ResolvedProject): string[] {
	const lines = [
		`project   ${project.name} · ${project.id}`,
		`member    ${project.member.name} · ${project.member.id}`,
		`store     ${project.storePath}`,
		`root      ${project.root}`,
	];
	if (project.gitCommonDir) lines.push(`git       ${project.gitCommonDir}`);
	lines.push(`selected  ${project.reasonDetail}`);
	lines.push("aliases");
	if (project.locations.length === 0) {
		lines.push("  none");
	} else {
		for (const location of project.locations) {
			lines.push(`  ${location.root}`);
			if (location.gitCommonDir) lines.push(`    git common dir: ${location.gitCommonDir}`);
		}
	}
	return lines;
}

export async function runProjectCommand(
	argv: readonly string[],
	context: ProjectCommandContext,
): Promise<ProjectCommandResult> {
	const args = [...argv];
	const first = args[0];
	const action =
		first === "--help" || first === "-h"
			? (args.shift() as string)
			: first && !first.startsWith("--")
				? (args.shift() as string)
				: "show";
	if (action === "help" || action === "--help" || action === "-h") {
		return { code: 0, out: [PROJECT_USAGE], err: [], changed: false };
	}
	if (action !== "show" && action !== "link" && action !== "unlink") {
		return {
			code: 2,
			out: [],
			err: [`muninn: unknown project command "${action}"`, "", PROJECT_USAGE],
			changed: false,
		};
	}

	let options: ParsedOptions;
	try {
		options = parseOptions(args);
	} catch (error) {
		return { code: 2, out: [], err: [error instanceof Error ? error.message : String(error)], changed: false };
	}
	if (action !== "link" && (options.id || options.name || options.force)) {
		return { code: 2, out: [], err: [`muninn: ${action} does not accept link options`], changed: false };
	}
	const path = options.path ? resolve(context.cwd, options.path) : context.cwd;

	try {
		if (action === "show") {
			const project = await resolveLogicalProject({ ...context, cwd: path, create: false });
			if (!project) {
				return {
					code: 1,
					out: [],
					err: [`muninn: no logical project is linked for ${path}`],
					changed: false,
				};
			}
			return { code: 0, out: formatResolvedProject(project), err: [], changed: false };
		}

		if (action === "link") {
			const project = await linkLogicalProject({
				...context,
				cwd: path,
				...(options.id ? { projectId: options.id } : {}),
				...(options.name ? { name: options.name } : {}),
				...(options.force ? { force: true } : {}),
			});
			return {
				code: 0,
				out: [`muninn: linked ${project.root}`, ...formatResolvedProject(project)],
				err: [],
				changed: true,
			};
		}

		const unlinked = await unlinkLogicalProject({ ...context, cwd: path });
		if (!unlinked) {
			return {
				code: 1,
				out: [],
				err: [`muninn: no logical project is linked for ${path}`],
				changed: false,
			};
		}
		return {
			code: 0,
			out: [
				`muninn: unlinked ${unlinked.removed.length} local ${unlinked.removed.length === 1 ? "alias" : "aliases"} from ${unlinked.project.name} · ${unlinked.project.id}`,
				"The project store and retained registry record were not deleted.",
			],
			err: [],
			changed: true,
		};
	} catch (error) {
		return {
			code: 1,
			out: [],
			err: [error instanceof Error ? error.message : String(error)],
			changed: false,
		};
	}
}
