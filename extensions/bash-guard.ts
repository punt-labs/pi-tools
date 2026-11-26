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
import { DEFAULT_COMMAND_TIMEOUT_S } from "../lib/bash-guard.js";
import { createGuardedBashOperations, MAX_COMMAND_TIMEOUT_S } from "../lib/bash-operations.js";

/** Override with PI_BASH_TIMEOUT_S; falls back to the default on bad input. */
function timeoutSeconds(): number {
	const raw = Number(process.env.PI_BASH_TIMEOUT_S);
	return Number.isFinite(raw) && raw > 0 && raw <= MAX_COMMAND_TIMEOUT_S
		? raw
		: DEFAULT_COMMAND_TIMEOUT_S;
}

export default function bashGuardExtension(pi: ExtensionAPI): void {
	const limit = timeoutSeconds();
	const bashTool = createBashTool(process.cwd(), {
		operations: createGuardedBashOperations(limit),
		spawnHook: ({ command, cwd, env }) => {
			const childEnv: NodeJS.ProcessEnv = { ...env, PI_BASH_TIMEOUT_S: String(limit) };
			// Shell commands do not need the model credential. This is environment
			// hygiene on a trusted host, not isolation from same-user access.
			delete childEnv.PI_CODER_API_KEY;
			return {
				command,
				cwd,
				env: childEnv,
			};
		},
	});
	pi.registerTool(bashTool);
}
