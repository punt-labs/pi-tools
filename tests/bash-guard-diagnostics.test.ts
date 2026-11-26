import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createGuardedBashOperations } from "../lib/bash-operations.js";

describe("real TERM diagnostics", () => {
	it.each([128, 65536])(
		"delivers all Node TERM diagnostics (%s bytes per stream)",
		async (size) => {
			const directory = mkdtempSync(join(process.cwd(), ".tmp", "term-diagnostics-"));
			const script = join(directory, "child.cjs");
			writeFileSync(
				script,
				`const fs = require('node:fs');
process.on('SIGTERM', () => { fs.writeSync(1, 'OUT:' + 'o'.repeat(${String(size)}) + '\\n'); fs.writeSync(2, 'ERR:' + 'e'.repeat(${String(size)}) + '\\n'); process.exit(0); });
setInterval(() => {}, 1000);
`,
			);
			const chunks: Buffer[] = [];
			try {
				const result = await createGuardedBashOperations(0.5).exec(
					`${JSON.stringify(process.execPath)} ${JSON.stringify(script)}; :`,
					process.cwd(),
					{ onData: (data) => chunks.push(data) },
				);
				const output = Buffer.concat(chunks).toString();
				console.log(
					JSON.stringify({
						kind: "node",
						size,
						exitCode: result.exitCode,
						bytes: output.length,
						expected: 2 * (size + 5),
						out: output.match(/o/g)?.length ?? 0,
						err: output.match(/e/g)?.length ?? 0,
					}),
				);
				expect(result.exitCode).toBe(124);
				expect(output.length).toBe(2 * (size + 5));
				expect(output.match(/o/g)?.length ?? 0).toBe(size);
				expect(output.match(/e/g)?.length ?? 0).toBe(size);
			} finally {
				rmSync(directory, { recursive: true, force: true });
			}
		},
	);

	it("delivers small Bash TERM diagnostics", async () => {
		const chunks: Buffer[] = [];
		const result = await createGuardedBashOperations(0.5).exec(
			"trap 'printf OUT:done; printf ERR:done >&2; exit 0' TERM; while :; do :; done",
			process.cwd(),
			{ onData: (data) => chunks.push(data) },
		);
		const output = Buffer.concat(chunks).toString();
		console.log(
			JSON.stringify({
				kind: "bash",
				exitCode: result.exitCode,
				output,
				bytes: output.length,
				expected: 16,
			}),
		);
		expect(result.exitCode).toBe(124);
		expect(output).toContain("OUT:done");
		expect(output).toContain("ERR:done");
		expect(output.length).toBe(16);
	});
});
