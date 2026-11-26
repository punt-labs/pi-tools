/** Test-only runner for the real-Pi keep smoke. No GNU timeout dependency. */
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";

const EXPECTED_TOOLS = ["keep_run", "keep_capture", "keep_stop", "keep_list"];
const OUTPUT_LIMIT = 1024 * 1024;

function checkToolEvents(stdout: string): void {
	const completed = new Set<string>();
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
			event.type !== "tool_execution_end" ||
			typeof event.toolName !== "string" ||
			!EXPECTED_TOOLS.includes(event.toolName)
		)
			continue;
		if (event.isError === true) throw new Error(event.toolName + " failed");
		if (event.isError === false) completed.add(event.toolName);
	}
	for (const tool of EXPECTED_TOOLS) {
		if (!completed.has(tool)) throw new Error("Missing successful tool event: " + tool);
		console.log("PASS: " + tool + " completed");
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
	console.log("Starting Pi in JSON print mode...");
	console.log("Artifacts: " + artifacts);
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
	process.once("SIGINT", interrupt);
	process.once("SIGTERM", terminate);
	const deadline = setTimeout(
		() => stop("Pi timed out after " + String(seconds) + "s", 124),
		seconds * 1000,
	);
	child.stdout.on("data", (data: Buffer) => {
		stdout = (stdout + data.toString("utf8")).slice(0, OUTPUT_LIMIT);
		if (stdout.length === OUTPUT_LIMIT) stop("Pi stdout exceeded the smoke output limit", 1);
	});
	child.stderr.on("data", (data: Buffer) => {
		stderr = (stderr + data.toString("utf8")).slice(0, OUTPUT_LIMIT);
		if (stderr.length === OUTPUT_LIMIT) stop("Pi stderr exceeded the smoke output limit", 1);
	});
	try {
		const code = await new Promise<number>((resolveExit, reject) => {
			child.once("error", reject);
			child.once("close", (exitCode) => resolveExit(exitCode ?? 1));
		});
		await writeFile(join(artifacts, "pi.jsonl"), stdout);
		await writeFile(join(artifacts, "pi.stderr"), stderr);
		if (failure) {
			console.error("FAIL: " + failure);
			return failureCode;
		}
		if (code !== 0) {
			console.error("FAIL: Pi exited with exit " + String(code));
			return code;
		}
		checkToolEvents(stdout);
		console.log("All smoke tests passed.");
		return 0;
	} finally {
		clearTimeout(deadline);
		if (escalation) clearTimeout(escalation);
		process.removeListener("SIGINT", interrupt);
		process.removeListener("SIGTERM", terminate);
		killGroup("SIGKILL");
		// Exact matching prevents a unique name from becoming a tmux prefix match.
		await promisify(execFile)("tmux", ["kill-session", "-t", "=keep-" + name], {
			timeout: 2000,
		}).catch(() => undefined);
	}
}

main()
	.then((code) => {
		process.exitCode = code;
	})
	.catch((error: unknown) => {
		console.error("FAIL: " + (error instanceof Error ? error.message : String(error)));
		process.exitCode = 1;
	});
