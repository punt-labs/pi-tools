import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const REPO = resolve(fileURLToPath(new URL("..", import.meta.url)));

function killGroup(pid: number | undefined): void {
	if (!pid) return;
	try {
		process.kill(-pid, "SIGKILL");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
	}
}

async function waitForFakePid(root: string): Promise<number> {
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		try {
			return Number(await readFile(join(root, "success", "fake-pi.pid"), "utf8"));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		await delay(20);
	}
	throw new Error("cleanup fixture Pi did not start");
}

it("kills owned process groups when interrupted twice", async () => {
	// This is a harness lifecycle unit test, not product smoke proof. The smoke
	// executable itself always uses real installed Pi for its model/tool proof.
	await mkdir(join(REPO, ".tmp"), { recursive: true });
	const root = await mkdtemp(join(REPO, ".tmp", "smoke-lifecycle-"));
	const bin = join(root, "bin");
	await mkdir(bin);
	await writeFile(
		join(bin, "pi"),
		"#!/usr/bin/env node\n" +
			'import fs from "node:fs";\n' +
			'if (process.argv.includes("--version")) { console.log("lifecycle-unit-fixture"); process.exit(0); }\n' +
			'process.on("SIGTERM", () => {});\n' +
			'fs.writeFileSync("fake-pi.pid", String(process.pid));\n' +
			"setInterval(() => {}, 1000);\n",
		{ mode: 0o755 },
	);
	const harness = spawn(
		process.execPath,
		["--experimental-strip-types", join(REPO, "tests", "smoke-pi-coder.ts")],
		{
			cwd: REPO,
			env: { PATH: bin + ":" + (process.env.PATH ?? ""), LANG: "C.UTF-8" },
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	const closed = once(harness, "close");
	let stdout = "";
	harness.stdout.on("data", (data: Buffer) => {
		stdout = (stdout + data.toString()).slice(-16_384);
	});
	harness.stderr.resume();
	let fixturePid: number | undefined;
	try {
		const deadline = Date.now() + 5000;
		while (!stdout.includes("Artifacts: ") && Date.now() < deadline) await delay(20);
		const artifactRoot = /Artifacts: (.+)/.exec(stdout)?.[1];
		expect(artifactRoot, "harness must report its private artifact directory").toBeDefined();
		fixturePid = await waitForFakePid(artifactRoot ?? "");
		const checkedPid = fixturePid;
		harness.kill("SIGINT");
		await delay(100);
		harness.kill("SIGINT");
		await Promise.race([
			closed,
			delay(5000).then(() => {
				throw new Error("interrupted harness failed to exit");
			}),
		]);
		await delay(100);
		expect(
			() => process.kill(checkedPid, 0),
			"owned Pi must not survive repeated Ctrl-C",
		).toThrow();
	} finally {
		killGroup(fixturePid);
		killGroup(harness.pid);
		await closed;
	}
}, 15_000);
