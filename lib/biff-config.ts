// Where the biff REPL should start, so it reads the right relay config.
//
// Biff reads relay and team settings from `.punt-labs/biff/config.yaml` and
// `config.local.yaml` in the directory it starts in. Started anywhere else it
// silently uses its public demo relay, which is not the team's relay.

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const BIFF_CONFIG_FILES = ["config.yaml", "config.local.yaml"];

export function hasBiffConfig(dir: string): boolean {
	return BIFF_CONFIG_FILES.some((f) => existsSync(join(dir, ".punt-labs", "biff", f)));
}

export function findBiffCwd(start: string): string | undefined {
	let dir = resolve(start);
	for (;;) {
		if (hasBiffConfig(dir)) return dir;
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}
