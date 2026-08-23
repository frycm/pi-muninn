import { describe, expect, it } from "vitest";
import { toArgv } from "../../src/git.ts";

describe("toArgv — the allow-list is the promise", () => {
	it("maps each command to a fixed argv", () => {
		expect(toArgv({ kind: "init" })).toEqual(["init", "--quiet"]);
		expect(toArgv({ kind: "config", key: "user.name", value: "muninn mbp" })).toEqual([
			"config",
			"user.name",
			"muninn mbp",
		]);
		expect(toArgv({ kind: "add", paths: ["journal/"] })).toEqual(["add", "--", "journal/"]);
		expect(toArgv({ kind: "rev-parse", target: "--show-toplevel" })).toEqual(["rev-parse", "--show-toplevel"]);
	});

	it("always limits a commit to a pathspec", () => {
		// Without this an in-repo store would commit whatever the user had staged
		// for their own work the moment Muninn wrote a journal entry.
		const argv = toArgv({ kind: "commit", message: "journal: mbp 2 entries", paths: ["journal/"] });
		expect(argv).toEqual(["commit", "--quiet", "--no-gpg-sign", "-m", "journal: mbp 2 entries", "--", "journal/"]);
		expect(argv).toContain("--");
	});

	it("refuses a commit with no pathspec", () => {
		expect(() => toArgv({ kind: "commit", message: "everything", paths: [] })).toThrow(/pathspec/);
	});

	it("refuses a commit with no message", () => {
		expect(() => toArgv({ kind: "commit", message: "  ", paths: ["journal/"] })).toThrow(/message/);
	});

	it("refuses to stage a path outside the store", () => {
		expect(() => toArgv({ kind: "add", paths: ["../../etc/passwd"] })).toThrow(/outside the store/);
		expect(() => toArgv({ kind: "add", paths: ["/etc/passwd"] })).toThrow(/outside the store/);
	});

	it("refuses to stage a path that is not in the allow-list", () => {
		expect(() => toArgv({ kind: "add", paths: ["src/"] })).toThrow(/allow-list/);
		expect(() => toArgv({ kind: "add", paths: ["."] })).toThrow(/allow-list/);
		expect(() => toArgv({ kind: "add", paths: [".index/"] })).toThrow(/allow-list/);
	});

	it("refuses a path that could be read as a flag", () => {
		expect(() => toArgv({ kind: "add", paths: ["--all"] })).toThrow(/outside the store/);
	});

	it("refuses an empty add", () => {
		expect(() => toArgv({ kind: "add", paths: [] })).toThrow(/at least one path/);
	});

	it("scopes status to a pathspec when one is given", () => {
		expect(toArgv({ kind: "status-porcelain", paths: ["journal/"] })).toEqual([
			"status",
			"--porcelain",
			"--",
			"journal/",
		]);
	});

	it("passes arguments as argv, never as a shell string", () => {
		// Nothing is quoted or escaped anywhere in this module, which is only safe
		// because execFile receives an array. A message full of shell syntax must
		// survive verbatim.
		const nasty = 'journal: $(rm -rf /) && echo "; drop table"';
		const argv = toArgv({ kind: "commit", message: nasty, paths: ["journal/"] });
		expect(argv).toContain(nasty);
	});
});
