import { execFileSync, spawnSync } from "node:child_process";

// Select files from this worktree's index, not filesystem globs or ancestor
// ignore rules. Captured sessions and other untracked state are never visited.
const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const files = execFileSync("git", ["ls-files", "-z", "--", "*.md"], {
	cwd: root,
	encoding: "utf8",
})
	.split("\0")
	// Literal inputs bypass CLI directory ignores; keep the deployed tracker guide excluded.
	.filter((file) => file.length > 0 && !file.startsWith(".punt-labs/punt/"));

const [command, ...args] = process.argv.slice(2);
if (files.length === 0) {
	console.error("No tracked Markdown files found; refusing an empty documentation check.");
	process.exitCode = 1;
} else if (!command) {
	console.error("Pass the Markdown lint executable and its arguments.");
	process.exitCode = 1;
} else {
	// markdownlint-cli2's : prefix identifies literal files, not glob patterns.
	// Each path remains a separate argument, including spaces and punctuation.
	const paths = files.map((file) => `:./${file}`);
	console.log(`Checking ${String(files.length)} tracked Markdown files from ${root}`);
	const result = spawnSync(command, [...args, ...paths], { cwd: root, stdio: "inherit" });
	if (result.error) console.error(`Cannot start Markdown linter: ${result.error.message}`);
	process.exitCode = result.status ?? 1;
}
