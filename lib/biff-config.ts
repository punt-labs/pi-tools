// Where the biff REPL should start, so it reads the right relay config.
//
// Biff reads relay and team settings from `.punt-labs/biff/config.yaml` and
// `config.local.yaml` at the git root of the directory it starts in, and exits
// when that directory isn't inside a git repository. With no config there it
// silently uses its public demo relay, which is not the team's relay.

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const BIFF_CONFIG_FILES = ["config.yaml", "config.local.yaml"];

/** The git root biff would use for `dir` (biff's own find_git_root rule). */
export function gitRoot(dir: string): string | undefined {
	let current = resolve(dir);
	for (;;) {
		if (existsSync(join(current, ".git"))) return current;
		const parent = dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

/** Whether biff started in `dir` would find a relay config (not the demo relay). */
export function hasBiffConfig(dir: string): boolean {
	const root = gitRoot(dir);
	return (
		root !== undefined &&
		BIFF_CONFIG_FILES.some((f) => existsSync(join(root, ".punt-labs", "biff", f)))
	);
}

/**
 * The nearest repository root, from `start` upward, whose biff config biff
 * would read. A configured directory that isn't a repository root is
 * skipped: biff never reads it, and can't start there if it's outside a repo.
 */
export function findBiffCwd(start: string): string | undefined {
	let dir = gitRoot(start);
	while (dir !== undefined) {
		if (hasBiffConfig(dir)) return dir;
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = gitRoot(parent);
	}
	return undefined;
}
