/**
 * Where pi keeps its agent directory, resolved without loading pi.
 *
 * Inside a session Muninn asks pi (`getAgentDir()`); the headless CLI cannot,
 * because importing the pi package costs about a second of start-up for two
 * strings — and because `muninn sync` running from cron should not stop working
 * the day a pi install is half-upgraded. The rule is copied from pi's
 * `core/config.ts`: `PI_CODING_AGENT_DIR` if set, otherwise `~/.pi/agent`.
 *
 * A test pins the environment variable name, so a drift from pi is a failing
 * test rather than a store nobody can find.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { expandTilde } from "./store/paths.ts";

/** pi's config directory name, as `piConfig.configDir` in its package.json. */
export const CONFIG_DIR = ".pi";

/** The variable pi reads to relocate its agent directory. */
export const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

export function resolveAgentDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
	const configured = env[AGENT_DIR_ENV];
	if (configured && configured.trim() !== "") return expandTilde(configured.trim(), home);
	return join(home, CONFIG_DIR, "agent");
}
