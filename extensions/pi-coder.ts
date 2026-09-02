import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	CODER_SYSTEM,
	buildCoderArgs,
	buildCoderPrompt,
	normalizeCoderOutput,
	resolveTargetPath,
} from "../lib/pi-coder.js";

const CODER_PROVIDER = "bifrost";
const CODER_MODEL = "ollama/qwen3-coder:30b-a3b-q4_K_M";
const PREVIEW_BYTES = 400;

/** Time-bounds every command the coder runs. See lib/bash-guard.ts. */
const BASH_GUARD = join(dirname(fileURLToPath(import.meta.url)), "bash-guard.ts");

interface CoderResult {
	stdout: string;
	stderr: string;
	code: number;
}

function runCoder(
	prompt: string,
	signal: AbortSignal,
	onProgress: (bytes: number) => void,
): Promise<CoderResult> {
	return new Promise((resolve, reject) => {
		const child = spawn("pi", buildCoderArgs(CODER_PROVIDER, CODER_MODEL, prompt, BASH_GUARD), {
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (buf: Buffer) => {
			stdout += buf.toString("utf8");
			onProgress(stdout.length);
		});
		child.stderr.on("data", (buf: Buffer) => {
			stderr += buf.toString("utf8");
		});
		child.on("error", reject);
		child.on("close", (code) => {
			resolve({ stdout, stderr, code: code ?? -1 });
		});
		signal.addEventListener("abort", () => child.kill("SIGTERM"));
	});
}

function textResult(text: string) {
	return { content: [{ type: "text" as const, text }], details: {} };
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
	pi.registerTool({
		name: "pi_coder",
		label: "Pi Coder",
		description:
			"Delegate a code-writing task to a SMALL LOCAL coder model (Qwen3-Coder 30B via Bifrost). " +
			"Use for ALL source-file writes: the planner should never emit code inline. " +
			"The coder is substantially less capable than you and works under hard limits: it has " +
			"NO tools, cannot compile, run, test, or inspect anything, cannot read other files, and " +
			"sees ONLY the task text you send — no conversation history, no directory listing, no " +
			"prior attempt. It returns one file's contents, nothing else. Specify the work precisely " +
			"and keep each request small; you remain responsible for compiling, testing, and fixing.",
		promptSnippet:
			"Delegate source-file writes to pi_coder, a small local coder model that is weaker than " +
			"you and has no tools. Break work into small, fully-specified files and verify every " +
			"result yourself. Do not write source files via bash heredoc, echo, tee, or printf " +
			"redirects, sed -i, or awk with output redirection.",
		promptGuidelines: [
			"Always call pi_coder to create or fully rewrite a source file.",
			"Never use bash to write source-file contents inline (no heredoc, tee, echo>, printf>).",
			"Specify the contract, not the implementation. You own the architecture: the file " +
				"boundaries, the decomposition, the signatures, and the behaviour each piece must " +
				"exhibit. The coder owns the implementation — it writes the algorithm. If you find " +
				"yourself dictating code line by line, you are doing its job and wasting it.",
			"The coder has tools but no context. It compiles and tests its own work, but cannot see " +
				"your conversation, the directory, or an earlier call. Anything it needs must be in " +
				"the task text.",
			"Prefer several small, tightly-scoped calls over one call for a large file. Split by " +
				"concern and give each call an exact, self-contained specification.",
			"Be exact about the interface and silent about the internals: give function signatures, " +
				"the precise I/O contract (stdin/stdout format, exit codes), edge cases, and compile " +
				'flags. Name the algorithm where it matters ("use minimax"), but do not write it out.',
			"The coder verifies its own file; you verify that the pieces fit together. On failure, " +
				"send a new call naming the specific defect and the exact required behaviour rather " +
				"than repeating the original request.",
			"target_path is relative to the current working directory unless absolute.",
		],
		parameters: {
			type: "object",
			properties: {
				task: {
					type: "string",
					description:
						"Full, self-contained instruction for the coder — it sees no other context and has " +
						"no tools. State the file's purpose, exact function signatures, the precise I/O " +
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
		async execute(_toolCallId, rawParams, signal, onUpdate) {
			const params = rawParams as { task: string; target_path: string };
			const target = resolveTargetPath(process.cwd(), params.target_path, isAbsolute, join);
			const prompt = buildCoderPrompt(CODER_SYSTEM, params.task);
			const abort = signal ?? new AbortController().signal;
			const started = Date.now();
			try {
				const { stdout, stderr, code } = await runCoder(prompt, abort, (bytes) => {
					onUpdate?.({
						content: [
							{
								type: "text",
								text: "pi_coder streaming " + String(bytes) + " bytes → " + params.target_path,
							},
						],
						details: {},
					});
				});
				if (code !== 0) {
					return textResult(
						"pi_coder FAILED (exit=" + String(code) + "):\n" + (stderr || stdout).slice(0, 800),
					);
				}
				// The coder writes the file itself -- it has tools. The extension
				// only reports what landed. Writing the coder's stdout here would
				// clobber that file with the agent's narration.
				const wallMs = Date.now() - started;
				const written = await readIfPresent(target);
				if (written === null) {
					return textResult(
						"pi_coder produced no file at " +
							params.target_path +
							" (" +
							String(wallMs) +
							"ms). Coder transcript tail:\n" +
							normalizeCoderOutput(stdout).slice(-800),
					);
				}
				return textResult(
					"pi_coder wrote " +
						String(written.length) +
						" bytes to " +
						params.target_path +
						" (" +
						String(wallMs) +
						"ms).\n\n--- head ---\n" +
						previewBody(written),
				);
			} catch (error) {
				return textResult("pi_coder ERROR: " + errorMessage(error));
			}
		},
	});
}
