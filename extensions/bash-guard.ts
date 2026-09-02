/**
 * Replaces pi's bash tool with one that time-bounds every command.
 *
 * Load alongside any long-running or unattended agent:
 *
 *     pi -e extensions/bash-guard.ts ...
 *
 * Rationale and the incident that motivated it: see lib/bash-guard.ts.
 */

import { createBashTool } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_COMMAND_TIMEOUT_S, withTimeout } from "../lib/bash-guard.js";

/** Override with PI_BASH_TIMEOUT_S; falls back to the default on bad input. */
function timeoutSeconds(): number {
	const raw = Number(process.env.PI_BASH_TIMEOUT_S);
	return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_COMMAND_TIMEOUT_S;
}

export default function bashGuardExtension(pi: ExtensionAPI): void {
	const limit = timeoutSeconds();
	const bashTool = createBashTool(process.cwd(), {
		spawnHook: ({ command, cwd, env }) => ({
			command: withTimeout(command, limit),
			cwd,
			env: { ...env, PI_BASH_TIMEOUT_S: String(limit) },
		}),
	});
	pi.registerTool(bashTool);
}
