import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const run = promisify(execFile);
const repo = resolve(import.meta.dirname, "..");
let fixture: string;
let env: NodeJS.ProcessEnv;

beforeEach(async () => {
	await mkdir(join(repo, ".tmp"), { recursive: true });
	fixture = await mkdtemp(join(repo, ".tmp", "keep-smoke-test-"));
	const bin = join(fixture, "bin");
	await mkdir(bin);
	await writeFile(join(bin, "package.json"), '{"type":"commonjs"}');
	await writeFile(
		join(bin, "pi"),
		`#!${process.execPath}
const fs = require("node:fs");
fs.writeFileSync(process.env.FIXTURE + "/pi.pid", String(process.pid));
fs.writeFileSync(process.env.FIXTURE + "/pi.args", JSON.stringify(process.argv.slice(2)));
const names = ["keep_run", "keep_capture", "keep_stop", "keep_list"];
const scenario = process.env.SCENARIO;
if (scenario === "timeout") {
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
} else {
  console.log(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:names.join(" ")}]}}));
  if (scenario !== "narration") {
    for (const name of names) {
      if (scenario === "missing-call" && name === "keep_list") continue;
      console.log(JSON.stringify({type:"tool_execution_end",toolName:name,isError:scenario === "tool-error" && name === "keep_capture",result:{content:[{type:"text",text:"keep-smoke-ok"}]}}));
    }
  }
  process.exit(scenario === "pi-failure" ? 7 : 0);
}
`,
		{ mode: 0o755 },
	);
	await writeFile(
		join(bin, "tmux"),
		`#!${process.execPath}
require("node:fs").appendFileSync(process.env.FIXTURE + "/tmux.calls", JSON.stringify(process.argv.slice(2)) + "\\n");
`,
		{ mode: 0o755 },
	);
	// Deliberately supply no model credentials or inherited HOME configuration.
	env = {
		PATH: bin + ":" + (process.env.PATH ?? ""),
		HOME: fixture,
		FIXTURE: fixture,
		PI_KEEP_SMOKE_TIMEOUT_S: "0.5",
	};
});

afterEach(async () => {
	await rm(fixture, { recursive: true, force: true });
});

async function smoke(scenario: string) {
	try {
		const result = await run("bash", [join(repo, "tests", "smoke-pi.sh")], {
			cwd: fixture,
			env: { ...env, SCENARIO: scenario },
			timeout: 8_000,
		});
		return { ...result, code: 0 };
	} catch (error) {
		const failure = error as Error & { code: number; stdout: string; stderr: string };
		return { code: failure.code, stdout: failure.stdout, stderr: failure.stderr };
	}
}

describe("keep smoke entry point", () => {
	it("accepts completed tool events, creates artifacts, and cleans only its unique session", async () => {
		const first = await smoke("success");
		expect(first.code, first.stdout + first.stderr).toBe(0);
		expect(first.stdout).toContain("All smoke tests passed");
		const artifactPath = /^Artifacts: (.+)$/m.exec(first.stdout)?.[1];
		expect(artifactPath).toBeDefined();
		if (!artifactPath) throw new Error("missing artifact path");
		expect(await readFile(join(artifactPath, "pi.jsonl"), "utf8")).toContain("tool_execution_end");
		expect(await readFile(join(artifactPath, "pi.stderr"), "utf8")).toBe("");
		const args = JSON.parse(await readFile(join(fixture, "pi.args"), "utf8")) as string[];
		expect(args).toContain("json");
		expect(args).toContain("--no-extensions");
		const extension = args[args.indexOf("-e") + 1];
		expect(extension).toBe(join(repo, "extensions", "keep.ts"));
		const calls = (await readFile(join(fixture, "tmux.calls"), "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as string[]);
		expect(calls).toHaveLength(1);
		expect(calls[0].slice(0, 2)).toEqual(["kill-session", "-t"]);
		expect(calls[0][2]).toMatch(/^=keep-smoke-[A-Za-z0-9_-]+$/);
		const prompt = args[args.indexOf("-p") + 1];
		expect(prompt).toContain(calls[0][2].slice("=keep-".length));
		const second = await smoke("success");
		expect(second.code, second.stdout + second.stderr).toBe(0);
		const finalCalls = (await readFile(join(fixture, "tmux.calls"), "utf8")).trim().split("\n");
		expect(JSON.parse(finalCalls[1])).not.toEqual(calls[0]);
	});

	it.each(["missing-call", "narration", "tool-error"])(
		"rejects %s despite tool names in narration",
		async (scenario) => {
			const result = await smoke(scenario);
			expect(result.code).toBe(1);
			expect(result.stdout + result.stderr).toMatch(/missing|failed|successful/i);
			expect(result.stdout).not.toContain("All smoke tests passed");
		},
	);

	it("preserves a nonzero Pi exit even when all tool events are present", async () => {
		const result = await smoke("pi-failure");
		expect(result.code, result.stdout + result.stderr).toBe(7);
		expect(result.stdout + result.stderr).toContain("exit 7");
		expect(await readFile(join(fixture, "tmux.calls"), "utf8")).toContain("kill-session");
	});

	it("bounds actual Pi execution and kills the child before returning", async () => {
		const result = await smoke("timeout");
		expect(result.code, result.stdout + result.stderr).toBe(124);
		expect(result.stdout + result.stderr).toContain("timed out");
		const pid = Number(await readFile(join(fixture, "pi.pid"), "utf8"));
		assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
		expect(await readFile(join(fixture, "tmux.calls"), "utf8")).toContain("kill-session");
	}, 10_000);

	it("keeps make smoke-pi as the public entry point without contacting real tools", async () => {
		const result = await run("make", ["smoke-pi"], {
			cwd: repo,
			env: { ...env, SCENARIO: "success" },
			timeout: 8_000,
		});
		expect(result.stdout).toContain("All smoke tests passed");
		const artifactPath = /^Artifacts: (.+)$/m.exec(result.stdout)?.[1];
		expect(artifactPath).toBeDefined();
		if (artifactPath) await rm(artifactPath, { recursive: true, force: true });
	});
});
