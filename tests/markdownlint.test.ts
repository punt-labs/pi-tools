import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const repo = fileURLToPath(new URL("..", import.meta.url));
const cli = fileURLToPath(
	new URL("../node_modules/markdownlint-cli2/markdownlint-cli2-bin.mjs", import.meta.url),
);
const invalidMarkdown = "# Repeated heading\n\n# Repeated heading\n";
const punctuatedPaths = ["docs/What's new!.md", "docs/guide{draft}.md"];
let fixture: string;

function writeMarkdown(path: string, content: string): void {
	const target = join(fixture, path);
	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, content);
}

function copyHelper(cwd: string): void {
	const helper = join(repo, "lib", "lint-docs.ts");
	if (existsSync(helper)) {
		mkdirSync(join(cwd, "lib"), { recursive: true });
		copyFileSync(helper, join(cwd, "lib", "lint-docs.ts"));
	}
}

function lint(cwd = fixture) {
	return spawnSync(
		"make",
		["-f", join(repo, "Makefile"), "check-docs", `MARKDOWNLINT=${process.execPath} ${cli}`],
		{
			cwd,
			encoding: "utf8",
			timeout: 10_000,
		},
	);
}

beforeEach(() => {
	fixture = mkdtempSync(join(repo, ".tmp", "markdownlint-"));
	execFileSync("git", ["init", "--quiet", fixture]);
	copyFileSync(join(repo, ".gitignore"), join(fixture, ".gitignore"));
	copyFileSync(join(repo, ".markdownlint-cli2.jsonc"), join(fixture, ".markdownlint-cli2.jsonc"));
	copyHelper(fixture);
	writeMarkdown("README.md", "# Repository documentation\n");
	execFileSync("git", ["add", "README.md", ".gitignore", ".markdownlint-cli2.jsonc"], {
		cwd: fixture,
	});
});

afterEach(() => {
	rmSync(fixture, { recursive: true, force: true });
});

describe("Markdown lint file selection", () => {
	it("refuses a successful documentation gate when no Markdown is tracked", () => {
		execFileSync("git", ["rm", "--cached", "--", "README.md"], { cwd: fixture });
		const result = lint();
		expect(result.status, result.stdout + result.stderr).toBe(2);
		expect(result.stderr).toContain("refusing an empty documentation check");
	});

	it("checks tracked Markdown only, not an untracked draft", () => {
		writeMarkdown("docs/untracked-draft.md", invalidMarkdown);
		const result = lint();
		expect(result.status, result.stdout + result.stderr).toBe(0);
		expect(result.stdout).toContain("Linting: 1 file\n");
	});

	it("rejects invalid tracked Markdown in a linked worktree inside an ignored parent", () => {
		execFileSync(
			"git",
			[
				"-c",
				"core.hooksPath=/dev/null",
				"-c",
				"user.name=Fixture",
				"-c",
				"user.email=fixture@example.invalid",
				"commit",
				"--quiet",
				"-m",
				"fixture",
			],
			{ cwd: fixture },
		);
		const worktree = join(fixture, ".tmp", "linked-worktree");
		execFileSync("git", ["worktree", "add", "--quiet", "--detach", worktree, "HEAD"], {
			cwd: fixture,
		});
		copyHelper(worktree);
		writeFileSync(join(worktree, "README.md"), invalidMarkdown);
		mkdirSync(join(worktree, ".punt-labs", "quarry", "captures"), { recursive: true });
		writeFileSync(
			join(worktree, ".punt-labs", "quarry", "captures", "fixture.md"),
			invalidMarkdown,
		);
		const result = lint(worktree);
		expect(result.status, result.stdout + result.stderr).not.toBe(0);
		expect(result.stdout).toContain("Linting: 1 file\n");
		expect(result.stderr).toContain("README.md:3 error MD025");
		expect(result.stderr).not.toContain("captures/fixture.md");
	});

	it("ignores malformed runtime captures and scratch files using repository gitignore rules", () => {
		writeMarkdown(".punt-labs/quarry/captures/fixture.md", invalidMarkdown);
		writeMarkdown(".tmp/fixture.md", invalidMarkdown);
		writeMarkdown(".punt-labs/punt/fixture.md", invalidMarkdown);
		const result = lint();
		expect(result.status, result.stdout + result.stderr).toBe(0);
		expect(result.stdout).toContain("Linting: 1 file\n");
		expect(result.stdout).toContain("Summary: 0 issues");
	});

	it("excludes the deployed tracker guide even when it is tracked", () => {
		const path = ".punt-labs/punt/guide!.md";
		writeMarkdown(path, invalidMarkdown);
		execFileSync("git", ["add", "--force", "--", path], { cwd: fixture });
		const result = lint();
		expect(result.status, result.stdout + result.stderr).toBe(0);
		expect(result.stdout).toContain("Summary: 0 issues");
		expect(result.stderr).not.toContain(path);
	});

	it.each(punctuatedPaths)("rejects invalid tracked literal filename %s", (path) => {
		writeMarkdown(path, invalidMarkdown);
		execFileSync("git", ["--literal-pathspecs", "add", "--", path], { cwd: fixture });
		const result = lint();
		expect(result.status, result.stdout + result.stderr).toBe(2);
		expect(result.stderr).toContain(path);
		expect(result.stderr).toContain("MD025");
	});

	it.each(punctuatedPaths)("accepts valid tracked literal filename %s", (path) => {
		writeMarkdown(path, "# Valid repository documentation\n");
		execFileSync("git", ["--literal-pathspecs", "add", "--", path], { cwd: fixture });
		const result = lint();
		expect(result.status, result.stdout + result.stderr).toBe(0);
		expect(result.stdout).toContain("Linting: 2 files\n");
		expect(result.stdout).toContain("Summary: 0 issues");
	});

	it("preserves the Markdown linter command's failure exit code", () => {
		const result = spawnSync(
			process.execPath,
			[join(fixture, "lib", "lint-docs.ts"), process.execPath, "-e", "process.exit(7)"],
			{ cwd: fixture, encoding: "utf8", timeout: 10_000 },
		);
		expect(result.status, result.stdout + result.stderr).toBe(7);
	});

	it.each(["README.md", "docs/guide.md", ".punt-labs/guide.md", "docs/guide [draft].md"])(
		"rejects malformed tracked repository Markdown at %s",
		(path) => {
			writeMarkdown(path, invalidMarkdown);
			execFileSync("git", ["add", path], { cwd: fixture });
			const result = lint();
			expect(result.status, result.stdout + result.stderr).toBe(2);
			expect(result.stderr).toContain(path);
			expect(result.stderr).toContain("MD025");
		},
	);
});
