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
	const before = await capturePane(session);
	const priorOccurrences = commandLineIndexes(before, cmd, prompt).length;

	await exec("tmux", ["send-keys", "-t", session, cmd, "Enter"]);

	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		await sleep(pollMs);
		const output = completedCommandOutput(
			await capturePane(session),
			cmd,
			prompt,
			priorOccurrences,
		);
		if (output !== undefined) return output;
	}

	const pane = await capturePane(session);
	const indexes = commandLineIndexes(pane, cmd, prompt);
	if (indexes.length > priorOccurrences) {
		const lastIndex = indexes.at(-1);
		if (lastIndex !== undefined) {
			return pane
				.split("\n")
				.slice(lastIndex + 1)
				.join("\n")
				.trim();
		}
	}
	return pane.trim();
}

/** Return completed output for a newly echoed command, or undefined while running. */
export function completedCommandOutput(
	pane: string,
	cmd: string,
	prompt: RegExp,
	priorOccurrences: number,
): string | undefined {
	const lines = pane.split("\n");
	const indexes = commandLineIndexes(pane, cmd, prompt);
	if (indexes.length <= priorOccurrences) return undefined;

	const commandIndex = indexes.at(-1);
	if (commandIndex === undefined) return undefined;
	for (let i = commandIndex + 1; i < lines.length; i += 1) {
		if (matches(prompt, lines[i])) {
			return lines
				.slice(commandIndex + 1, i)
				.join("\n")
				.trim();
		}
	}
	return undefined;
}

function commandLineIndexes(pane: string, cmd: string, prompt: RegExp): number[] {
	const indexes: number[] = [];
	for (const [index, line] of pane.split("\n").entries()) {
		if (!line.endsWith(cmd)) continue;
		const prefix = line.slice(0, -cmd.length);
		if (matches(prompt, prefix)) indexes.push(index);
	}
	return indexes;
}

function matches(pattern: RegExp, value: string): boolean {
	pattern.lastIndex = 0;
	return pattern.test(value);
}

async function capturePane(session: string): Promise<string> {
	const r = await exec("tmux", ["capture-pane", "-t", session, "-p", "-S", "-", "-J"]);
	return r.stdout;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
