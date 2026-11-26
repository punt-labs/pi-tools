import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import type * as Fs from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findBiffCwd, hasBiffConfig } from "../lib/biff-config.js";

let root: string;
const fixture = vi.hoisted(() => ({ root: "" }));

vi.mock("node:fs", async (importOriginal) => {
	const actualFs = await importOriginal<typeof Fs>();
	return {
		...actualFs,
		existsSync: (path: Parameters<typeof actualFs.existsSync>[0]): boolean => {
			// Preserve real fixture files without discovering the host's ancestor repositories.
			return (
				typeof path === "string" &&
				(path === fixture.root || path.startsWith(fixture.root + sep)) &&
				actualFs.existsSync(path)
			);
		},
	};
});

function makeRepo(dir: string): void {
	mkdirSync(join(dir, ".git"), { recursive: true });
}

function makeConfig(dir: string, file: string): void {
	makeRepo(dir);
	mkdirSync(join(dir, ".punt-labs", "biff"), { recursive: true });
	writeFileSync(join(dir, ".punt-labs", "biff", file), "relay: {}\n");
}

beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "biffcwd-")));
	fixture.root = root;
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
	fixture.root = "";
});

describe("findBiffCwd", () => {
	it("ignores a configured ancestor outside the fixture but discovers configuration inside it", async () => {
		makeConfig(root, "config.yaml");
		fixture.root = join(root, "isolated-fixture");
		mkdirSync(fixture.root);
		const actualFs = await vi.importActual<typeof Fs>("node:fs");
		expect(actualFs.existsSync(join(root, ".git"))).toBe(true);
		expect(actualFs.existsSync(join(root, ".punt-labs", "biff", "config.yaml"))).toBe(true);
		expect(hasBiffConfig(fixture.root)).toBe(false);
		expect(findBiffCwd(fixture.root)).toBeUndefined();
		makeConfig(fixture.root, "config.local.yaml");
		expect(existsSync(join(fixture.root, ".git"))).toBe(true);
		expect(hasBiffConfig(fixture.root)).toBe(true);
		expect(findBiffCwd(fixture.root)).toBe(fixture.root);
	});
	it("returns the directory itself when it has a biff config", () => {
		makeConfig(root, "config.yaml");
		expect(findBiffCwd(root)).toBe(root);
	});

	it("accepts a config.local.yaml alone", () => {
		makeConfig(root, "config.local.yaml");
		expect(hasBiffConfig(root)).toBe(true);
	});

	it("walks up to the nearest configured parent (workspace-level config)", () => {
		makeConfig(root, "config.local.yaml");
		const nested = join(root, "repo", "src", "deep");
		mkdirSync(nested, { recursive: true });
		makeRepo(join(root, "repo"));
		expect(findBiffCwd(nested)).toBe(root);
	});

	it("prefers the nearest config over a parent's", () => {
		makeConfig(root, "config.yaml");
		const repo = join(root, "repo");
		makeConfig(repo, "config.yaml");
		expect(findBiffCwd(join(repo))).toBe(repo);
	});

	it("returns undefined when nothing up the tree is configured", () => {
		const nested = join(root, "a", "b");
		mkdirSync(nested, { recursive: true });
		expect(findBiffCwd(nested)).toBeUndefined();
	});

	it("uses the repository root's config from a subdirectory", () => {
		makeConfig(root, "config.yaml");
		const sub = join(root, "src");
		mkdirSync(sub);
		expect(hasBiffConfig(sub)).toBe(true);
		expect(findBiffCwd(sub)).toBe(root);
	});

	it("skips a configured parent that is not a repository", () => {
		mkdirSync(join(root, ".punt-labs", "biff"), { recursive: true });
		writeFileSync(join(root, ".punt-labs", "biff", "config.yaml"), "relay: {}\n");
		const repo = join(root, "repo");
		makeRepo(repo);
		expect(hasBiffConfig(root)).toBe(false);
		expect(findBiffCwd(repo)).toBeUndefined();
	});

	it("ignores a .punt-labs/biff directory with no config file", () => {
		mkdirSync(join(root, ".punt-labs", "biff"), { recursive: true });
		expect(hasBiffConfig(root)).toBe(false);
	});
});
