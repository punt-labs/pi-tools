#!/usr/bin/env -S node --experimental-strip-types
/** Real installed Pi processes; deterministic loopback models; no paid model calls. */
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const DEFAULT_REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FAKE_KEY = "pi-coder-smoke-fake-key-not-a-credential";
const PROVIDER = "loopback-coder-smoke";
const FILE_BODY = 'export const answer = 42;\nconsole.log("fixture:42");\n';
const MAX_OUTPUT = 1024 * 1024;
const DEADLINE_MS = 45_000;
let interrupted = false;
let nextToolCallId = 0;
const ISOLATION_FLAGS = [
	"--offline",
	"--no-session",
	"--no-extensions",
	"--no-context-files",
	"--no-skills",
	"--no-prompt-templates",
	"--no-mcp",
	"--no-approve",
];

type Scenario = "success" | "missing-file" | "missing-provider" | "missing-model";
interface ChatMessage {
	role: string;
	content?: unknown;
	name?: string;
	tool_call_id?: string;
}
interface ChatRequest {
	model: string;
	messages: ChatMessage[];
	stream: boolean;
	tools?: { function: { name: string } }[];
}
interface Call {
	name: string;
	args: Record<string, unknown>;
}
interface FixtureState {
	planner: number;
	coder: number;
	requests: ChatRequest[];
	errors: string[];
	commands: string[][];
}
interface ProcessRecord {
	pid: number;
	argv: string[];
}

function processRecords(cwd: string): ProcessRecord[] {
	return readFileSync(join(cwd, "node-startup.jsonl"), "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as ProcessRecord);
}
interface ToolEvent {
	type: string;
	toolName?: string;
	isError?: boolean;
	result?: {
		details?: {
			coderUsage?: { inputTokens: number; outputTokens: number; reasoningTokens: number };
		};
	};
}

function bashCheck(who: string): string {
	return (
		"node -e '" +
		'const fs=require("node:fs");' +
		"if(process.env.PI_CODER_API_KEY)process.exit(91);" +
		"if(process.env.OPENAI_API_KEY||process.env.ANTHROPIC_API_KEY)process.exit(92);" +
		"if(!Number(process.env.PI_BASH_TIMEOUT_S))process.exit(93);" +
		'if(fs.readFileSync("answer.js","utf8")!==' +
		JSON.stringify(FILE_BODY) +
		")process.exit(94);" +
		'import("./answer.js").then(m=>{if(m.answer!==42)process.exit(95);' +
		`console.log(\"${who}_VERIFIED_KEY_ABSENT\");});'`
	);
}

function reply(response: ServerResponse, model: string, call?: Call, text?: string): void {
	response.writeHead(200, { "Content-Type": "text/event-stream", Connection: "close" });
	const chunk = (delta: Record<string, unknown>, finish: string | null = null) => {
		response.write(
			"data: " +
				JSON.stringify({
					id: "chatcmpl-smoke",
					object: "chat.completion.chunk",
					created: 1,
					model,
					choices: [{ index: 0, delta, finish_reason: finish }],
				}) +
				"\n\n",
		);
	};
	chunk({ role: "assistant" });
	if (call) {
		chunk({
			tool_calls: [
				{
					index: 0,
					id: "call_" + call.name + "_" + String(++nextToolCallId),
					type: "function",
					function: { name: call.name, arguments: JSON.stringify(call.args) },
				},
			],
		});
	} else {
		chunk({ content: text ?? "FIXTURE_DONE" });
	}
	chunk({}, call ? "tool_calls" : "stop");
	response.write(
		"data: " +
			JSON.stringify({
				id: "chatcmpl-smoke",
				object: "chat.completion.chunk",
				created: 1,
				model,
				choices: [],
				usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
			}) +
			"\n\ndata: [DONE]\n\n",
	);
	response.end();
}

async function handleRequest(
	request: IncomingMessage,
	response: ServerResponse,
	scenario: Scenario,
	state: FixtureState,
): Promise<void> {
	assert.equal(request.method, "POST");
	assert.equal(request.url, "/v1/chat/completions");
	assert.ok(
		request.headers.authorization === "Bearer " + FAKE_KEY,
		"wrong fixture authorization header",
	);
	let body = "";
	for await (const data of request) {
		body += String(data);
		assert.ok(body.length < MAX_OUTPUT, "HTTP request exceeds fixture output cap");
	}
	const chat = JSON.parse(body) as ChatRequest;
	assert.equal(chat.stream, true);
	assert.ok(!body.includes(FAKE_KEY), "credential leaked into model conversation");
	state.requests.push(chat);
	if (chat.model === "planner-fixture") {
		const step = state.planner++;
		assert.ok(step < 3, "planner exceeded scripted request budget");
		if (step === 0) {
			assert.ok(chat.tools?.some((tool) => tool.function.name === "pi_coder"));
			reply(response, chat.model, {
				name: "pi_coder",
				args: {
					task: "Write answer.js exporting answer=42 and printing fixture:42. Verify with bash.",
					target_path: "answer.js",
				},
			});
		} else if (scenario === "success" && step === 1) {
			reply(response, chat.model, { name: "bash", args: { command: bashCheck("BOSS") } });
		} else {
			reply(response, chat.model, undefined, "PLANNER_FIXTURE_DONE");
		}
	} else {
		assert.equal(chat.model, "coder-fixture", "unexpected model: never contact a public model");
		const step = state.coder++;
		assert.ok(step < 4, "coder exceeded scripted request budget");
		if (scenario === "missing-file") {
			reply(response, chat.model, undefined, "I did not write the requested file.");
		} else if (step === 0) {
			assert.ok(chat.tools?.some((tool) => tool.function.name === "write"));
			reply(response, chat.model, {
				name: "write",
				args: { path: "answer.js", content: FILE_BODY },
			});
		} else if (step === 1) {
			reply(response, chat.model, { name: "bash", args: { command: bashCheck("CODER") } });
		} else if (step === 2) {
			// Silent and self-limited even if the guard is broken: no runaway output or process.
			reply(response, chat.model, {
				name: "bash",
				args: { command: "node -e 'setTimeout(()=>process.exit(99),10000)'" },
			});
		} else {
			reply(response, chat.model, undefined, "Wrote answer.js; bounded bash content check passed.");
		}
	}
}

async function runPi(cwd: string, env: NodeJS.ProcessEnv, args: string[], state: FixtureState) {
	assert.ok(!args.join(" ").includes(FAKE_KEY), "credential in parent argv");
	const child = spawn("pi", args, {
		cwd,
		env,
		detached: true,
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	let failure = "";
	let escalation: NodeJS.Timeout | undefined;
	const kill = (signal: NodeJS.Signals) => {
		const groups = new Set<number>();
		if (child.pid) groups.add(child.pid);
		try {
			// Core may detach nested Pi into its own group; reap those groups as well.
			for (const record of processRecords(cwd)) groups.add(record.pid);
		} catch {
			// Startup can fail before the probe writes, or a write may still be in progress.
		}
		for (const pid of groups) {
			try {
				process.kill(-pid, signal);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
			}
		}
	};
	const stop = (reason: string) => {
		if (failure) return;
		failure = reason;
		kill("SIGTERM");
		escalation = setTimeout(() => {
			kill("SIGKILL");
		}, 2000);
	};
	child.stdout.on("data", (data: Buffer) => {
		stdout += data.toString();
		if (stdout.length > MAX_OUTPUT) {
			stdout = stdout.slice(0, MAX_OUTPUT);
			stop("Pi stdout exceeded 1 MiB");
		}
	});
	child.stderr.on("data", (data: Buffer) => {
		stderr += data.toString();
		if (stderr.length > MAX_OUTPUT) {
			stderr = stderr.slice(0, MAX_OUTPUT);
			stop("Pi stderr exceeded 1 MiB");
		}
	});
	const deadline = setTimeout(() => {
		stop("Pi exceeded 45 second smoke deadline");
	}, DEADLINE_MS);
	const interrupt = () => {
		if (interrupted) {
			kill("SIGKILL");
			return;
		}
		interrupted = true;
		stop("Smoke interrupted; terminating owned Pi process group");
	};
	process.on("SIGINT", interrupt);
	process.on("SIGTERM", interrupt);
	try {
		const [code, signal] = (await once(child, "close")) as [number | null, string | null];
		await writeFile(join(cwd, "parent.jsonl"), stdout);
		await writeFile(join(cwd, "parent.stderr"), stderr);
		state.commands = processRecords(cwd).map((record) => record.argv);
		await writeFile(join(cwd, "requests.json"), JSON.stringify(state.requests, null, 2));
		await writeFile(join(cwd, "process-argv.json"), JSON.stringify(state.commands, null, 2));
		await writeFile(join(cwd, "fixture-errors.json"), JSON.stringify(state.errors, null, 2));
		assert.ok(!stdout.includes(FAKE_KEY), "credential in stdout");
		assert.ok(!stderr.includes(FAKE_KEY), "credential in stderr");
		assert.ok(
			!state.commands.some((argv) => argv.join(" ").includes(FAKE_KEY)),
			"credential leaked into process argv",
		);
		assert.deepEqual(state.errors, [], "loopback provider assertions");
		assert.equal(failure, "", failure);
		assert.equal(code, 0, `Pi exited ${String(code)} (${String(signal)}): ${stderr.slice(-2000)}`);
		return stdout;
	} finally {
		process.removeListener("SIGINT", interrupt);
		process.removeListener("SIGTERM", interrupt);
		clearTimeout(deadline);
		if (escalation) clearTimeout(escalation);
		kill("SIGKILL");
	}
}

function toolMessages(requests: ChatRequest[], model: string): string {
	return requests
		.filter((request) => request.model === model)
		.flatMap((request) => request.messages.filter((message) => message.role === "tool"))
		.map((message) => JSON.stringify(message))
		.join("\n");
}

async function runScenario(repo: string, root: string, scenario: Scenario): Promise<void> {
	const cwd = join(root, scenario);
	const home = join(cwd, "home");
	const agent = join(home, ".pi", "agent");
	await mkdir(agent, { recursive: true });
	const probe = join(cwd, "argv-probe.cjs");
	// Pi overwrites process.title, erasing /proc's original argv. Observe Node startup
	// before Pi loads; this does not intercept or replace spawn or the installed CLI.
	await writeFile(
		probe,
		'const fs = require("node:fs");\n' +
			`fs.appendFileSync(${JSON.stringify(join(cwd, "node-startup.jsonl"))}, ` +
			'JSON.stringify({pid: process.pid, argv: process.argv}) + "\\n");\n',
	);
	const state: FixtureState = { planner: 0, coder: 0, requests: [], errors: [], commands: [] };
	const server = createServer((request, response) => {
		void handleRequest(request, response, scenario, state).catch((error: unknown) => {
			state.errors.push(String(error));
			response.writeHead(500);
			response.end("Fixture assertion failed");
		});
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	try {
		const address = server.address();
		assert.ok(address && typeof address !== "string");
		await writeFile(
			join(agent, "models.json"),
			JSON.stringify({
				providers: {
					[PROVIDER]: {
						baseUrl: `http://127.0.0.1:${String(address.port)}/v1`,
						api: "openai-completions",
						apiKey: "$PI_CODER_API_KEY",
						models: ["planner-fixture", "coder-fixture"].map((id) => ({
							id,
							reasoning: false,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						})),
					},
				},
			}),
		);
		// Deliberately do not spread process.env: no real credential or proxy is inherited.
		const env: NodeJS.ProcessEnv = {
			PATH: process.env.PATH,
			LANG: "C.UTF-8",
			HOME: home,
			TMPDIR: cwd,
			XDG_CONFIG_HOME: join(home, ".config"),
			XDG_CACHE_HOME: join(home, ".cache"),
			PI_CODING_AGENT_DIR: agent,
			PI_OFFLINE: "1",
			PI_TELEMETRY: "0",
			PI_CODER_API_KEY: FAKE_KEY,
			PI_BASH_TIMEOUT_S: "2",
			NODE_OPTIONS: "--require " + JSON.stringify(probe),
		};
		if (scenario !== "missing-provider") env.PI_CODER_PROVIDER = PROVIDER;
		if (scenario !== "missing-model") env.PI_CODER_MODEL = "coder-fixture";
		const stdout = await runPi(
			cwd,
			env,
			[
				...ISOLATION_FLAGS,
				"--provider",
				PROVIDER,
				"--model",
				"planner-fixture",
				"--mode",
				"json",
				"-e",
				join(repo, "extensions", "pi-coder.ts"),
				"-e",
				join(repo, "extensions", "bash-guard.ts"),
				"-p",
				"Exercise the pi_coder fixture, then independently verify its output with bash.",
			],
			state,
		);
		const plannerResults = toolMessages(state.requests, "planner-fixture");
		const coderResult = stdout
			.trim()
			.split("\n")
			.map((line, index) => {
				try {
					return JSON.parse(line) as ToolEvent;
				} catch {
					throw new Error(
						`${scenario}: invalid parent JSON line ${String(index + 1)}; inspect parent.jsonl`,
					);
				}
			})
			.find((event) => event.type === "tool_execution_end" && event.toolName === "pi_coder");
		assert.ok(coderResult, "registered pi_coder must execute through real Pi");
		if (scenario === "success") {
			assert.equal(await readFile(join(cwd, "answer.js"), "utf8"), FILE_BODY);
			assert.equal(state.coder, 4, "real nested Pi must complete write/check/timeout/report turns");
			const nestedArgs = state.commands.find((argv) => argv.includes("coder-fixture"));
			assert.ok(nestedArgs, "must observe actual nested Pi process argv");
			for (const flag of ISOLATION_FLAGS) {
				assert.ok(nestedArgs.includes(flag), "nested Pi missing isolation flag " + flag);
			}
			assert.equal(state.planner, 3, "parent must independently verify the file");
			assert.match(toolMessages(state.requests, "coder-fixture"), /CODER_VERIFIED_KEY_ABSENT/);
			assert.match(toolMessages(state.requests, "coder-fixture"), /Command exited with code 124/);
			assert.match(plannerResults, /BOSS_VERIFIED_KEY_ABSENT/);
			assert.match(
				plannerResults,
				/awaiting boss verification|boss.{0,40}verification.{0,40}pending/i,
			);
			assert.equal(coderResult.isError, false);
			assert.deepEqual(coderResult.result?.details?.coderUsage, {
				inputTokens: 44,
				outputTokens: 28,
				reasoningTokens: 0,
			});
		} else if (scenario === "missing-file") {
			assert.equal(state.coder, 1, "real nested Pi must return without writing");
			assert.match(plannerResults, /produced no file/i);
			assert.equal(coderResult.isError, true);
			await assert.rejects(readFile(join(cwd, "answer.js")), { code: "ENOENT" });
		} else {
			assert.equal(state.coder, 0, "missing configuration must not request the coder model");
			assert.match(
				plannerResults,
				new RegExp(scenario === "missing-provider" ? "PI_CODER_PROVIDER" : "PI_CODER_MODEL"),
			);
			assert.equal(coderResult.isError, true);
			await assert.rejects(readFile(join(cwd, "answer.js")), { code: "ENOENT" });
		}
		console.log(`PASS ${scenario}: planner=${String(state.planner)}, coder=${String(state.coder)}`);
	} finally {
		server.closeAllConnections();
		await new Promise<void>((done, reject) => {
			server.close((error) => {
				if (error) reject(error);
				else done();
			});
		});
	}
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	assert.ok(
		args.length === 0 || (args.length === 2 && args[0] === "--repo"),
		"usage: smoke-pi-coder.ts [--repo path]",
	);
	const repo = resolve(args[1] ?? DEFAULT_REPO);
	const version = await promisify(execFile)("pi", ["--version"], {
		timeout: 10_000,
		maxBuffer: 4096,
		env: { PATH: process.env.PATH, LANG: "C.UTF-8", PI_OFFLINE: "1", PI_TELEMETRY: "0" },
	});
	console.log("Installed Pi: " + version.stdout.trim());
	await mkdir(join(DEFAULT_REPO, ".tmp"), { recursive: true });
	const root = await mkdtemp(join(DEFAULT_REPO, ".tmp", "smoke-coder-"));
	console.log("Artifacts: " + root);
	const failures: string[] = [];
	for (const scenario of [
		"success",
		"missing-file",
		"missing-provider",
		"missing-model",
	] as const) {
		try {
			await runScenario(repo, root, scenario);
		} catch (error) {
			failures.push(scenario);
			console.error(`FAIL ${scenario}: ${String(error).slice(0, 2000)}`);
		}
		if (interrupted) break;
	}
	assert.equal(
		failures.length,
		0,
		`${String(failures.length)} smoke scenarios failed: ${failures.join(", ")}`,
	);
	console.log("PASS installed parent + nested Pi; loopback-only fixtures; zero paid model tokens");
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
