/**
 * Replaces pi's bash tool with one that time-bounds every command.
 *
 * Load alongside any long-running or unattended agent:
 *
 *     pi -e extensions/bash-guard.ts ...
 *
 * Rationale and the incident that motivated it: see lib/bash-guard.ts.
 */

import { createBashToolDefinition, getShellConfig } from "@earendil-works/pi-coding-agent";
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
	// getSettings is public in Pi 1.6.1, but absent from the older dev SDK's
	// declarations. Read the host's effective settings only once execution begins.
	const host = pi as ExtensionAPI & {
		getSettings?: () => { shellCommandPrefix?: string; shellPath?: string };
	};
	pi.registerTool({
		...createBashToolDefinition("."),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			if (typeof host.getSettings !== "function") {
				throw new Error("The bash guard requires Pi 1.6.1's public getSettings API.");
			}
			const settings = host.getSettings();
			const bashTool = createBashToolDefinition(ctx.cwd, {
				commandPrefix: settings.shellCommandPrefix,
				shellPath: settings.shellPath,
				operations: createGuardedBashOperations(limit, getShellConfig(settings.shellPath)),
				spawnHook: ({ command, cwd, env }) => {
					const childEnv: NodeJS.ProcessEnv = { ...env, PI_BASH_TIMEOUT_S: String(limit) };
					// Trusted-host environment hygiene, not same-user isolation.
					delete childEnv.PI_CODER_API_KEY;
					return { command, cwd, env: childEnv };
				},
			});
			return bashTool.execute(toolCallId, params, signal, onUpdate, ctx);
		},
	});
}
