import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveCoderConfig, type CoderConfig } from "../lib/coder-config.js";
import {
	CODER_SYSTEM,
	buildCoderArgs,
	buildCoderPrompt,
	parseCoderOutput,
	resolveTargetPath,
} from "../lib/pi-coder.js";

const PREVIEW_BYTES = 400;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/** Time-bounds every command the coder runs. See lib/bash-guard.ts. */
const BASH_GUARD = join(dirname(fileURLToPath(import.meta.url)), "bash-guard.ts");

interface CoderResult {
	stdout: string;
	stderr: string;
	code: number;
}

function runCoder(
	config: CoderConfig,
	prompt: string,
	cwd: string,
	signal: AbortSignal,
	onProgress: (bytes: number) => void,
): Promise<CoderResult> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) {
			reject(new Error("Coder delegation cancelled."));
			return;
		}
		const child = spawn(
			"pi",
			buildCoderArgs(config.provider, config.model, prompt, BASH_GUARD, config.thinking),
			{
				cwd,
				stdio: ["ignore", "pipe", "pipe"],
				detached: process.platform !== "win32",
			},
		);
		let stdout: Buffer[] = [];
		let stderr: Buffer[] = [];
		let stdoutBytes = 0;
		let outputBytes = 0;
		let outputError: Error | undefined;
		let killTimer: ReturnType<typeof setTimeout> | undefined;
		const signalChild = (signalName: NodeJS.Signals): void => {
			if (process.platform !== "win32" && child.pid !== undefined) {
				try {
					process.kill(-child.pid, signalName);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill(signalName);
				}
			} else child.kill(signalName);
		};
		const cancel = (): void => {
			if (killTimer) return;
			signalChild("SIGTERM");
			killTimer = setTimeout(() => signalChild("SIGKILL"), 1000);
			killTimer.unref();
		};
		const cleanup = (): void => {
			signal.removeEventListener("abort", cancel);
			if (killTimer) {
				// The leader may have exited while descendants without inherited pipes remain.
				if (process.platform !== "win32") signalChild("SIGKILL");
				clearTimeout(killTimer);
			}
		};
		const collect = (buf: Buffer): boolean => {
			if (outputError) return false;
			outputBytes += buf.length;
			if (outputBytes <= MAX_OUTPUT_BYTES) return true;
			outputError = new Error("Coder output exceeded the 8 MiB limit; delegation terminated.");
			stdout = [];
			stderr = [];
			cancel();
			return false;
		};
		child.stdout.on("data", (buf: Buffer) => {
			if (!collect(buf)) return;
			stdout.push(buf);
			stdoutBytes += buf.length;
			onProgress(stdoutBytes);
		});
		child.stderr.on("data", (buf: Buffer) => {
			if (!collect(buf)) return;
			stderr.push(buf);
		});
		child.on("error", (error) => {
			cleanup();
			reject(error);
		});
		child.on("close", (code) => {
			cleanup();
			if (signal.aborted) reject(new Error("Coder delegation cancelled."));
			else if (outputError) reject(outputError);
			else
				resolve({
					stdout: redactCredential(Buffer.concat(stdout).toString("utf8")),
					stderr: redactCredential(Buffer.concat(stderr).toString("utf8")),
					code: code ?? -1,
				});
		});
		signal.addEventListener("abort", cancel, { once: true });
	});
}

function redactCredential(text: string): string {
	const credential = process.env.PI_CODER_API_KEY;
	if (!credential) return text;
	// Redact the JSON representation before the literal can change overlapping matches.
	return text
		.replaceAll(JSON.stringify(credential).slice(1, -1), "[REDACTED]")
		.replaceAll(credential, "[REDACTED]");
}

function textResult(text: string, details: Record<string, unknown> = {}) {
	return { content: [{ type: "text" as const, text: redactCredential(text) }], details };
}

function failCoder(text: string): never {
	// Pi marks a tool failure only when execute rejects, not from a result property.
	throw new Error(redactCredential(text));
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** File contents if the coder produced it, else null. */
async function readIfPresent(path: string): Promise<string | null> {
	try {
		return await readFile(path, "utf8");
	} catch {
		return null;
	}
}

function previewBody(body: string): string {
	if (body.length <= PREVIEW_BYTES) return body;
	return body.slice(0, PREVIEW_BYTES) + "\n... (" + String(body.length - PREVIEW_BYTES) + " more)";
}

export default function piCoderExtension(pi: ExtensionAPI): void {
	let configured = true;
	try {
		resolveCoderConfig(process.env);
	} catch {
		configured = false;
	}
	pi.registerTool({
		name: "pi_coder",
		label: "Pi Coder",
		description: configured
			? "Delegate a code-writing task to the configured Pi provider and model. " +
				"Use for ALL source-file writes: the planner should never emit code inline. " +
				"The coder can read and write the actual filesystem, compile, run, and test. " +
				"It receives the task and target path, not your conversation history. " +
				"Specify the work precisely and keep each request small; delegate fixes " +
				"with the observed failure and required behavior. A successful result includes the " +
				"coder's self-test report, awaiting boss verification, not acceptance. " +
				"The boss independently reviews the diff and runs required tests and integration checks."
			: "Configure PI_CODER_PROVIDER and PI_CODER_MODEL, with an optional valid PI_CODER_THINKING, to use pi_coder. " +
				"Other editing tools remain available; delegation is not required.",
		promptSnippet: configured
			? "Delegate source-file writes to pi_coder, the configured coding agent. It has tools " +
				"to write, compile, and test. Break work into small, fully-specified " +
				"files and send failures back as explicit correction requests."
			: "Optional coding delegation is not configured.",
		promptGuidelines: configured
			? [
					"Always call pi_coder to create or fully rewrite a source file.",
					"Never use bash to write source-file contents inline (no heredoc, tee, echo>, printf>).",
					"Specify the contract, not the implementation. You own the architecture: the file " +
						"boundaries, the decomposition, the signatures, and the behaviour each piece must " +
						"exhibit. The coder owns the implementation — it writes the algorithm. If you find " +
						"yourself dictating code line by line, you are doing its job and wasting it.",
					"The coder can inspect the actual filesystem and run commands. It has no conversation " +
						"history; supply requirements and earlier failures in the task text.",
					"Prefer several small, tightly-scoped calls over one call for a large file. Split by " +
						"concern and give each call an exact, self-contained specification.",
					"Be exact about the interface and silent about the internals: give function signatures, " +
						"the precise I/O contract (stdin/stdout format, exit codes), edge cases, and compile " +
						'flags. Name the algorithm where it matters ("use minimax"), but do not write it out.',
					"The coder self-tests its own file to shorten iteration, not to provide independent verification. On failure, " +
						"send a new call naming the specific defect and the exact required behaviour rather " +
						"than repeating the original request.",
					"Never call pi_coder only to inspect, build, test, or verify an existing file: it is a " +
						"file-writing tool and may rewrite target_path. The boss must independently review the diff " +
						"and run required tests and integration checks before acceptance.",
					"target_path is relative to the current working directory unless absolute.",
				]
			: [],
		parameters: {
			type: "object",
			properties: {
				task: {
					type: "string",
					description:
						"Full, self-contained instruction for the coder — it sees no other context. State " +
						"the file's purpose, exact function signatures, the precise I/O " +
						"contract, edge cases, and constraints (strict compile flags, no external deps). " +
						"Keep the scope small: one focused file per call beats one large one.",
				},
				target_path: {
					type: "string",
					description: "Path where the file will be written. Relative resolves against cwd.",
				},
			},
			required: ["task", "target_path"],
		},
		async execute(_toolCallId, rawParams, signal, onUpdate, ctx) {
			const params = rawParams as { task: string; target_path: string };
			const target = resolveTargetPath(ctx.cwd, params.target_path, isAbsolute, join);
			const prompt = buildCoderPrompt(CODER_SYSTEM, params.task, target);
			const abort = signal ?? new AbortController().signal;
			const started = Date.now();
			try {
				const config = resolveCoderConfig(process.env);
				const { stdout, stderr, code } = await runCoder(config, prompt, ctx.cwd, abort, (bytes) => {
					onUpdate?.({
						content: [
							{
								type: "text",
								text: redactCredential(
									"pi_coder streaming " + String(bytes) + " bytes → " + params.target_path,
								),
							},
						],
						details: {},
					});
				});
				if (code !== 0) {
					const compatibility = /\b(?:unknown|unsupported)\s+(?:cli\s+)?option\b/i.test(
						stderr + "\n" + stdout,
					)
						? "A compatible Pi CLI is required; tested with Pi 1.6.1. " +
							"Ensure the correct pi executable is on PATH. Required isolation flags will not be disabled.\n"
						: "";
					return failCoder(
						"pi_coder FAILED (exit=" +
							String(code) +
							"):\n" +
							compatibility +
							(stderr || stdout).slice(0, 800),
					);
				}
				// The coder writes the file itself -- it has tools. The extension
				// only reports what landed. Writing the coder's stdout here would
				// clobber that file with the agent's narration.
				const wallMs = Date.now() - started;
				const coderOutput = parseCoderOutput(stdout);
				if (coderOutput.error) return failCoder("pi_coder FAILED: " + coderOutput.error);
				if (!coderOutput.report.trim()) {
					return failCoder(
						"pi_coder FAILED: no final assistant report; awaiting boss verification.",
					);
				}
				if (coderOutput.stopReason !== "stop") {
					return failCoder(
						"pi_coder FAILED: final assistant did not complete; awaiting boss verification.",
					);
				}
				const written = await readIfPresent(target);
				if (written === null) {
					return failCoder(
						"pi_coder produced no file at " +
							params.target_path +
							" (" +
							String(wallMs) +
							"ms). Coder transcript tail:\n" +
							coderOutput.report.slice(-800),
					);
				}
				const report = coderOutput.report.slice(-800);
				return textResult(
					"pi_coder target contains " +
						String(Buffer.byteLength(written, "utf8")) +
						" bytes at " +
						params.target_path +
						" (" +
						String(wallMs) +
						"ms); awaiting boss verification, not accepted.\n\nCoder self-test report (not independent proof):\n" +
						report +
						"\n--- file head ---\n" +
						previewBody(redactCredential(written)),
					{
						coderUsage: {
							inputTokens: coderOutput.inputTokens,
							outputTokens: coderOutput.outputTokens,
							reasoningTokens: coderOutput.reasoningTokens,
						},
					},
				);
			} catch (error) {
				return failCoder("pi_coder ERROR: " + errorMessage(error));
			}
		},
	});
}
