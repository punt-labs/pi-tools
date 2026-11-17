import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findBiffCwd, hasBiffConfig } from "../lib/biff-config.js";

let root: string;

function makeRepo(dir: string): void {
	mkdirSync(join(dir, ".git"), { recursive: true });
}

function makeConfig(dir: string, file: string): void {
	makeRepo(dir);
	mkdirSync(join(dir, ".punt-labs", "biff"), { recursive: true });
	writeFileSync(join(dir, ".punt-labs", "biff", file), "relay: {}\n");
}

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("findBiffCwd", () => {
	it("returns the directory itself when it has a biff config", () => {
		root = realpathSync(mkdtempSync(join(tmpdir(), "biffcwd-")));
		makeConfig(root, "config.yaml");
		expect(findBiffCwd(root)).toBe(root);
	});

	it("accepts a config.local.yaml alone", () => {
		root = realpathSync(mkdtempSync(join(tmpdir(), "biffcwd-")));
		makeConfig(root, "config.local.yaml");
		expect(hasBiffConfig(root)).toBe(true);
	});

	it("walks up to the nearest configured parent (workspace-level config)", () => {
		root = realpathSync(mkdtempSync(join(tmpdir(), "biffcwd-")));
		makeConfig(root, "config.local.yaml");
		const nested = join(root, "repo", "src", "deep");
		mkdirSync(nested, { recursive: true });
		makeRepo(join(root, "repo"));
		expect(findBiffCwd(nested)).toBe(root);
	});

	it("prefers the nearest config over a parent's", () => {
		root = realpathSync(mkdtempSync(join(tmpdir(), "biffcwd-")));
		makeConfig(root, "config.yaml");
		const repo = join(root, "repo");
		makeConfig(repo, "config.yaml");
		expect(findBiffCwd(join(repo))).toBe(repo);
	});

	it("returns undefined when nothing up the tree is configured", () => {
		root = realpathSync(mkdtempSync(join(tmpdir(), "biffcwd-")));
		const nested = join(root, "a", "b");
		mkdirSync(nested, { recursive: true });
		const found = findBiffCwd(nested);
		// The temp dir's own ancestors are not configured on any normal machine.
		expect(found?.startsWith(root) ?? false).toBe(false);
	});

	it("uses the repository root's config from a subdirectory", () => {
		root = realpathSync(mkdtempSync(join(tmpdir(), "biffcwd-")));
		makeConfig(root, "config.yaml");
		const sub = join(root, "src");
		mkdirSync(sub);
		expect(hasBiffConfig(sub)).toBe(true);
		expect(findBiffCwd(sub)).toBe(root);
	});

	it("skips a configured parent that is not a repository", () => {
		root = realpathSync(mkdtempSync(join(tmpdir(), "biffcwd-")));
		mkdirSync(join(root, ".punt-labs", "biff"), { recursive: true });
		writeFileSync(join(root, ".punt-labs", "biff", "config.yaml"), "relay: {}\n");
		const repo = join(root, "repo");
		makeRepo(repo);
		expect(hasBiffConfig(root)).toBe(false);
		expect(findBiffCwd(repo)?.startsWith(root) ?? false).toBe(false);
	});

	it("ignores a .punt-labs/biff directory with no config file", () => {
		root = realpathSync(mkdtempSync(join(tmpdir(), "biffcwd-")));
		mkdirSync(join(root, ".punt-labs", "biff"), { recursive: true });
		expect(hasBiffConfig(root)).toBe(false);
	});
});
