import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import piCoderExtension from "../extensions/pi-coder.js";

interface Tool {
	execute(
		id: string,
		params: { task: string; target_path: string },
		signal?: AbortSignal,
		onUpdate?: undefined,
		ctx?: { cwd: string },
	): Promise<{
		content: { text: string }[];
	}>;
}

let fixture: string | undefined;
afterEach(async () => {
	vi.unstubAllEnvs();
	if (fixture) await rm(fixture, { recursive: true, force: true });
	fixture = undefined;
});

async function setupFakePi(source: string) {
	const tmp = join(process.cwd(), ".tmp");
	await mkdir(tmp, { recursive: true });
	fixture = await mkdtemp(join(tmp, "coder-process-"));
	await writeFile(join(fixture, "package.json"), JSON.stringify({ type: "commonjs" }));
	await writeFile(join(fixture, "pi"), "#!" + process.execPath + "\n" + source, { mode: 0o755 });
	vi.stubEnv("PATH", fixture + ":" + (process.env.PATH ?? ""));
	vi.stubEnv("PI_CODER_PROVIDER", "fake-provider");
	vi.stubEnv("PI_CODER_MODEL", "fake-model");
	vi.stubEnv("PI_CODER_THINKING", "");
	let tool: Tool | undefined;
	piCoderExtension({
		registerTool: (registered: Tool) => (tool = registered),
	} as unknown as ExtensionAPI);
	if (!tool) throw new Error("tool not registered");
	const registered = tool;
	return {
		execute: (
			id: string,
			params: { task: string; target_path: string },
			signal?: AbortSignal,
			onUpdate?: undefined,
			ctx = { cwd: process.cwd() },
		) => registered.execute(id, params, signal, onUpdate, ctx),
	};
}

async function waitForFile(path: string): Promise<string> {
	const deadline = Date.now() + 2000;
	while (Date.now() < deadline) {
		try {
			return await readFile(path, "utf8");
		} catch {
			/* Wait for the child to write the fixture. */
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error("Child did not write " + path);
}

describe("pi_coder real subprocess boundary", () => {
	it("writes and runs in the SDK execution directory when it differs from process.cwd", async () => {
		const tool = await setupFakePi(`
const fs = require('node:fs');
if (process.cwd() !== require('node:path').join(__dirname, 'sdk-workspace')) { console.error('wrong execution directory'); process.exit(1); }
fs.writeFileSync('context-target.ts', JSON.stringify({ cwd: process.cwd(), prompt: process.argv.at(-1) }));
console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'self-tested in execution directory' }] } }));
`);
		const cwd = join(fixture ?? "", "sdk-workspace");
		await mkdir(cwd);
		await tool.execute(
			"1",
			{ task: "write context-target.ts", target_path: "context-target.ts" },
			undefined,
			undefined,
			{ cwd },
		);
		const target = join(cwd, "context-target.ts");
		const captured = JSON.parse(await readFile(target, "utf8")) as { cwd: string; prompt: string };
		expect(captured.cwd).toBe(cwd);
		expect(captured.prompt).toContain(target);
	});
	it("inherits the fake generic credential without putting it in argv or prompts", async () => {
		vi.stubEnv("PI_CODER_API_KEY", "fake-process-key");
		const tool = await setupFakePi(`
const fs = require('node:fs');
const path = require('node:path');
const target = path.join(__dirname, 'target.ts');
fs.writeFileSync(target, JSON.stringify({ inherited: process.env.PI_CODER_API_KEY === 'fake-process-key', args: process.argv.slice(2) }));
console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'worker self-test claim' }], usage: { input: 4, output: 2 } } }));
`);
		const target = join(fixture ?? "", "target.ts");
		const result = await tool.execute("1", { task: "write the target", target_path: target });
		const captured = JSON.parse(await readFile(target, "utf8")) as {
			inherited: boolean;
			args: string[];
		};
		expect(captured.inherited).toBe(true);
		expect(captured.args.join(" ")).not.toContain("fake-process-key");
		expect(captured.args.at(-1)).toContain(target);
		expect(result.content[0].text).toContain("awaiting boss verification");
	});

	it.skipIf(process.platform === "win32")(
		"cancels descendant processes rather than leaving their pipes open",
		async () => {
			const tool = await setupFakePi(`
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const stopped = path.join(__dirname, 'stopped');
const child = spawn(process.execPath, ['-e', "const fs = require('node:fs'); process.on('SIGTERM', () => { fs.writeFileSync(process.argv[1], 'stopped'); process.exit(0); }); fs.writeFileSync(process.argv[2], String(process.pid)); setInterval(() => {}, 100);", stopped, path.join(__dirname, 'ready')], { stdio: 'inherit' });
setInterval(() => {}, 100);
`);
			const controller = new AbortController();
			const pending = tool
				.execute(
					"1",
					{ task: "wait", target_path: join(fixture ?? "", "out.ts") },
					controller.signal,
				)
				.catch((error: unknown) => error);
			let childPid: number | undefined;
			try {
				childPid = Number(await waitForFile(join(fixture ?? "", "ready")));
				controller.abort();
				expect(await waitForFile(join(fixture ?? "", "stopped"))).toBe("stopped");
				expect(await pending).toBeInstanceOf(Error);
			} finally {
				controller.abort();
				if (childPid) {
					try {
						process.kill(childPid, "SIGKILL");
					} catch {
						/* The process already exited. */
					}
				}
				await pending;
			}
		},
		5000,
	);
});
