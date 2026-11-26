import { execFileSync, spawnSync } from "node:child_process";

// Select files from this worktree's index, not filesystem globs or ancestor
// ignore rules. Captured sessions and other untracked state are never visited.
const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const files = execFileSync("git", ["ls-files", "-z", "--", "*.md"], {
	cwd: root,
	encoding: "utf8",
})
	.split("\0")
	.filter(Boolean);

const [command, ...args] = process.argv.slice(2);
if (files.length === 0) {
	console.error("No tracked Markdown files found; refusing an empty documentation check.");
	process.exitCode = 1;
} else if (!command) {
	console.error("Pass the Markdown lint executable and its arguments.");
	process.exitCode = 1;
} else {
	// The CLI accepts globs, so escape names and prefix ./ to protect leading
	// ! or # characters. Each path remains a separate argument, including spaces.
	const paths = files.map((file) => `./${file.replace(/[\\*?[\]{}()!+@]/g, "\\$&")}`);
	console.log(`Checking ${String(files.length)} tracked Markdown files from ${root}`);
	const result = spawnSync(command, [...args, ...paths], { cwd: root, stdio: "inherit" });
	if (result.error) console.error(`Cannot start Markdown linter: ${result.error.message}`);
	process.exitCode = result.status ?? 1;
}
