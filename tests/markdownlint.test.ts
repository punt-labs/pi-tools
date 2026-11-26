import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const repo = fileURLToPath(new URL("..", import.meta.url));
const cli = fileURLToPath(
	new URL("../node_modules/markdownlint-cli2/markdownlint-cli2-bin.mjs", import.meta.url),
);
const invalidMarkdown = "# Repeated heading\n\n# Repeated heading\n";
let fixture: string;

function writeMarkdown(path: string, content: string): void {
	const target = join(fixture, path);
	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, content);
}

function lint() {
	return spawnSync(process.execPath, [cli, "**/*.md", "#node_modules", "#.direnv"], {
		cwd: fixture,
		encoding: "utf8",
		timeout: 10_000,
	});
}

beforeEach(() => {
	fixture = mkdtempSync(join(repo, ".tmp", "markdownlint-"));
	execFileSync("git", ["init", "--quiet", fixture]);
	copyFileSync(join(repo, ".gitignore"), join(fixture, ".gitignore"));
	copyFileSync(join(repo, ".markdownlint-cli2.jsonc"), join(fixture, ".markdownlint-cli2.jsonc"));
	writeMarkdown("README.md", "# Repository documentation\n");
	execFileSync("git", ["add", "README.md", ".gitignore", ".markdownlint-cli2.jsonc"], {
		cwd: fixture,
	});
});

afterEach(() => {
	rmSync(fixture, { recursive: true, force: true });
});

describe("Markdown lint file selection", () => {
	it("ignores malformed runtime captures and scratch files using repository gitignore rules", () => {
		writeMarkdown(".punt-labs/quarry/captures/fixture.md", invalidMarkdown);
		writeMarkdown(".tmp/fixture.md", invalidMarkdown);
		writeMarkdown(".punt-labs/punt/fixture.md", invalidMarkdown);
		const result = lint();
		expect(result.status, result.stdout + result.stderr).toBe(0);
		expect(result.stdout).toContain("Linting: 1 file\n");
		expect(result.stdout).toContain("Summary: 0 issues");
	});

	it.each(["README.md", "docs/guide.md", ".punt-labs/guide.md"])(
		"rejects malformed tracked repository Markdown at %s",
		(path) => {
			writeMarkdown(path, invalidMarkdown);
			execFileSync("git", ["add", path], { cwd: fixture });
			const result = lint();
			expect(result.status, result.stdout + result.stderr).toBe(1);
			expect(result.stderr).toContain(path);
			expect(result.stderr).toContain("MD025");
		},
	);
});
