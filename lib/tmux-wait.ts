import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

/**
 * Send a command to a tmux session and wait for the prompt to reappear,
 * indicating the command has finished. Returns the output between the
 * command echo and the next prompt.
 *
 * @param session  tmux session name
 * @param cmd      command text to send
 * @param prompt   regex matching the session prompt (e.g. /▶\s*$/)
 * @param timeoutMs  maximum wait before giving up
 * @param pollMs  how often to check the pane
 */
export async function sendAndWait(
	session: string,
	cmd: string,
	prompt: RegExp,
	timeoutMs = 10_000,
	pollMs = 150,
): Promise<string> {
	// Capture pane before sending to know where old output ends
	const before = await capturePane(session);
	const beforeLines = before.split("\n").length;

	await exec("tmux", ["send-keys", "-t", session, cmd, "Enter"]);

	const deadline = Date.now() + timeoutMs;

	while (Date.now() < deadline) {
		await sleep(pollMs);
		const pane = await capturePane(session);
		const lines = pane.split("\n");

		// Look for the command echo followed by output followed by a new prompt
		let cmdLineIdx = -1;
		for (let i = Math.max(0, beforeLines - 2); i < lines.length; i++) {
			if (lines[i].includes(cmd)) {
				cmdLineIdx = i;
			}
		}

		if (cmdLineIdx < 0) continue;

		// Check if a prompt appeared after the command
		for (let i = cmdLineIdx + 1; i < lines.length; i++) {
			if (prompt.test(lines[i])) {
				// Output is between command echo and this prompt
				return lines
					.slice(cmdLineIdx + 1, i)
					.join("\n")
					.trim();
			}
		}
	}

	// Timeout — return whatever is in the pane after the command
	const pane = await capturePane(session);
	const lines = pane.split("\n");
	let cmdLineIdx = -1;
	for (let i = lines.length - 1; i >= 0; i--) {
		if (lines[i].includes(cmd)) {
			cmdLineIdx = i;
			break;
		}
	}
	if (cmdLineIdx >= 0) {
		return lines
			.slice(cmdLineIdx + 1)
			.join("\n")
			.trim();
	}
	return pane.trim();
}

async function capturePane(session: string): Promise<string> {
	const r = await exec("tmux", ["capture-pane", "-t", session, "-p"]);
	return r.stdout;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
