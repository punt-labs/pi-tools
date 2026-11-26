/** Test-only runner for the real-Pi keep smoke. No GNU timeout dependency. */
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { promisify } from "node:util";

const EXPECTED_TOOLS = ["keep_run", "keep_capture", "keep_stop", "keep_list"];
const OUTPUT_LIMIT = 1024 * 1024;

function redactCredential(text: string): string {
	const credential = process.env.PI_CODER_API_KEY;
	if (!credential) return text;
	// JSON output can escape quotes and backslashes in an echoed credential.
	return text
		.replaceAll(JSON.stringify(credential).slice(1, -1), "[REDACTED]")
		.replaceAll(credential, "[REDACTED]");
}

function checkToolEvents(stdout: string, name: string): void {
	const expectedText: Record<string, string> = {
		keep_run: "Started: " + name,
		keep_stop: "Stopped: " + name,
		keep_list: "No active keep sessions",
	};
	const completed = new Set<string>();
	let assistantError: string | undefined;
	for (const line of stdout.split("\n")) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue;
		}
		if (typeof parsed !== "object" || parsed === null) continue;
		const event = parsed as Record<string, unknown>;
		if (
			event.type === "message_end" &&
			typeof event.message === "object" &&
			event.message !== null
		) {
			const message = event.message as Record<string, unknown>;
			if (message.role === "assistant") {
				assistantError =
					message.stopReason === "error" ||
					message.stopReason === "aborted" ||
					message.stopReason === "length"
						? "Pi assistant " +
							message.stopReason +
							(typeof message.errorMessage === "string" ? ": " + message.errorMessage : "")
						: message.stopReason === "stop"
							? undefined
							: assistantError;
			}
		}
		if (
			event.type !== "tool_execution_end" ||
			typeof event.toolName !== "string" ||
			!EXPECTED_TOOLS.includes(event.toolName)
		)
			continue;
		if (event.isError === true) throw new Error(event.toolName + " failed");
		if (event.isError !== false) continue;
		const result = event.result;
		const content =
			typeof result === "object" && result !== null
				? (result as Record<string, unknown>).content
				: undefined;
		const text = Array.isArray(content)
			? content
					.filter(
						(part): part is Record<string, unknown> => typeof part === "object" && part !== null,
					)
					.filter((part) => part.type === "text" && typeof part.text === "string")
					.map((part) => String(part.text))
					.join("\n")
					.trim()
			: "";
		const valid =
			event.toolName === "keep_capture"
				? text.split(/\r?\n/).includes("keep-smoke-ok")
				: text === expectedText[event.toolName];
		if (!valid) throw new Error(event.toolName + " returned an unexpected or failed result");
		if (event.toolName === EXPECTED_TOOLS[completed.size]) completed.add(event.toolName);
	}
	if (assistantError) throw new Error(assistantError);
	for (const tool of EXPECTED_TOOLS) {
		if (!completed.has(tool)) throw new Error("Missing successful tool event: " + tool);
		console.log(redactCredential("PASS: " + tool + " completed"));
	}
}

async function main(): Promise<number> {
	const rawTimeout = process.env.PI_KEEP_SMOKE_TIMEOUT_S ?? "30";
	const seconds = Number(rawTimeout);
	if (!Number.isFinite(seconds) || seconds <= 0 || seconds * 1000 > 2_147_483_647) {
		throw new Error(
			"PI_KEEP_SMOKE_TIMEOUT_S must be positive, finite, and within Node timer limits",
		);
	}
	const scratch = join(process.cwd(), ".tmp");
	await mkdir(scratch, { recursive: true });
	const artifacts = await mkdtemp(join(scratch, "keep-smoke-"));
	const name =
		"smoke-" + String(process.pid) + "-" + basename(artifacts).slice("keep-smoke-".length);
	const extension = resolve(import.meta.dirname, "..", "extensions", "keep.ts");
	console.log(redactCredential("Starting Pi in JSON print mode..."));
	console.log(redactCredential("Artifacts: " + artifacts));
	const child = spawn(
		"pi",
		[
			"--offline",
			"--no-session",
			"--no-extensions",
			"--no-context-files",
			"--no-skills",
			"--no-prompt-templates",
			"--no-mcp",
			"--no-approve",
			"--mode",
			"json",
			"-e",
			extension,
			"-p",
			`Use keep_run to start a tmux session named ${name} running 'echo keep-smoke-ok; sleep 3600'. ` +
				`Use keep_capture to read ${name}, then keep_stop to stop ${name}, then keep_list to confirm it is gone. Report each result.`,
		],
		{ detached: true, stdio: ["ignore", "pipe", "pipe"] },
	);
	let stdout = "";
	let stderr = "";
	let failure = "";
	let failureCode = 1;
	let escalation: ReturnType<typeof setTimeout> | undefined;
	function killGroup(signal: NodeJS.Signals): void {
		if (!child.pid) return;
		try {
			process.kill(-child.pid, signal);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
		}
	}
	function stop(message: string, code: number): void {
		if (failure) return;
		failure = message;
		failureCode = code;
		killGroup("SIGTERM");
		escalation = setTimeout(() => killGroup("SIGKILL"), 1000);
	}
	const interrupt = () => stop("Pi smoke interrupted", 130);
	const terminate = () => stop("Pi smoke terminated", 143);
	process.on("SIGINT", interrupt);
	process.on("SIGTERM", terminate);
	const deadline = setTimeout(
		() => stop("Pi timed out after " + String(seconds) + "s", 124),
		seconds * 1000,
	);
	const stdoutDecoder = new StringDecoder("utf8");
	const stderrDecoder = new StringDecoder("utf8");
	const collectStdout = (text: string): void => {
		stdout = (stdout + text).slice(0, OUTPUT_LIMIT);
		if (stdout.length === OUTPUT_LIMIT) stop("Pi stdout exceeded the smoke output limit", 1);
	};
	const collectStderr = (text: string): void => {
		stderr = (stderr + text).slice(0, OUTPUT_LIMIT);
		if (stderr.length === OUTPUT_LIMIT) stop("Pi stderr exceeded the smoke output limit", 1);
	};
	child.stdout.on("data", (data: Buffer) => collectStdout(stdoutDecoder.write(data)));
	child.stdout.on("end", () => collectStdout(stdoutDecoder.end()));
	child.stderr.on("data", (data: Buffer) => collectStderr(stderrDecoder.write(data)));
	child.stderr.on("end", () => collectStderr(stderrDecoder.end()));
	try {
		const code = await new Promise<number>((resolveExit, reject) => {
			child.once("error", reject);
			child.once("close", (exitCode) => resolveExit(exitCode ?? 1));
		});
		await writeFile(join(artifacts, "pi.jsonl"), redactCredential(stdout));
		await writeFile(join(artifacts, "pi.stderr"), redactCredential(stderr));
		if (failure) {
			console.error(redactCredential("FAIL: " + failure));
			return failureCode;
		}
		if (code !== 0) {
			console.error(redactCredential("FAIL: Pi exited with exit " + String(code)));
			if (
				/\b(?:unknown|unsupported|unrecognized)\s+(?:command[- ]line\s+)?(?:option|argument)\b/i.test(
					stderr + "\n" + stdout,
				)
			) {
				console.error(
					redactCredential(
						"Use a compatible Pi CLI (tested: 1.6.1). Ensure the intended pi executable is first on PATH; " +
							"the required isolation flags, including --no-mcp, are not removed or retried.",
					),
				);
			}
			return code;
		}
		checkToolEvents(stdout, name);
		console.log(redactCredential("All smoke tests passed."));
		return 0;
	} finally {
		clearTimeout(deadline);
		killGroup("SIGKILL");
		// Exact matching prevents a unique name from becoming a tmux prefix match.
		await promisify(execFile)("tmux", ["kill-session", "-t", "=keep-" + name], {
			timeout: 2000,
		}).catch(() => undefined);
		if (escalation) clearTimeout(escalation);
		process.removeListener("SIGINT", interrupt);
		process.removeListener("SIGTERM", terminate);
	}
}

main()
	.then((code) => {
		process.exitCode = code;
	})
	.catch((error: unknown) => {
		console.error(
			redactCredential("FAIL: " + (error instanceof Error ? error.message : String(error))),
		);
		process.exitCode = 1;
	});
