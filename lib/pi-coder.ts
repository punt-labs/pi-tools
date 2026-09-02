// This prompt and buildCoderArgs below MUST agree about whether the coder has
// tools. They once disagreed -- `--no-tools` was set while the prompt claimed
// tools and invited a closing sentence -- and that prose was written verbatim
// into the source file, which then could not compile. Change both together.
//
// The coder is a tool-using agent. That is load-bearing for the experiment:
// without the ability to compile and test, every error must round-trip through
// the planner, which INCREASES expensive-model work and would make delegation
// look bad regardless of whether the idea is sound.
export const CODER_SYSTEM: string = [
	"You are a coding agent with tools. Write the file to the path you are given,",
	"then compile it, run it, and fix what breaks. Iterate until it builds and",
	"behaves as specified. Do not stop at a first draft you have not checked.",
	"Implement exactly what the task specifies — no more. Do not add features,",
	"options, or abstractions that were not asked for. Follow every stated",
	"signature and input/output contract literally, including exact output text",
	"and exit codes. If the task is ambiguous, choose the simplest reading that",
	"satisfies it literally rather than inventing behaviour.",
	"Touch only the file you were asked for; leave everything else alone.",
	"Finish with one short line: what you wrote, and whether it compiled and",
	"passed the checks you ran.",
].join(" ");

const LEADING_FENCE = /^\s*```[\w-]*\s*\n?/;
const TRAILING_FENCE = /\n?```\s*$/;

export function stripFences(text: string): string {
	return text.replace(LEADING_FENCE, "").replace(TRAILING_FENCE, "");
}

export function buildCoderPrompt(system: string, task: string): string {
	return system + "\n\nTask:\n" + task;
}

export function resolveTargetPath(
	cwd: string,
	target: string,
	isAbs: (p: string) => boolean,
	join: (a: string, b: string) => string,
): string {
	return isAbs(target) ? target : join(cwd, target);
}

/** Argv for the coder sub-agent.
 *
 * Tools are ENABLED (no `--no-tools`): the coder writes its own file, compiles
 * it, and fixes what breaks, closing the edit-compile-test loop locally instead
 * of routing every error back through the planner.
 *
 * `--no-session` keeps each delegation stateless, so a call is reproducible and
 * carries no history from earlier ones.
 */
export function buildCoderArgs(
	provider: string,
	model: string,
	prompt: string,
	bashGuardPath?: string,
): string[] {
	const args = ["--provider", provider, "--model", model, "--no-session", "--no-approve"];
	// The coder compiles and RUNS the program it just wrote. pi's bash tool has
	// no default timeout, so a program that loops printing runs until the
	// session ends -- one wrote 204 GB to pi's overflow file in under an hour.
	if (bashGuardPath) {
		args.push("-e", bashGuardPath);
	}
	args.push("-p", prompt);
	return args;
}

export function normalizeCoderOutput(stdout: string): string {
	return stripFences(stdout).trimEnd() + "\n";
}
