import { describe, it, expect } from "vitest";
import {
	CODER_SYSTEM,
	buildCoderArgs,
	buildCoderPrompt,
	normalizeCoderOutput,
	resolveTargetPath,
	stripFences,
} from "../lib/pi-coder.js";

describe("stripFences", () => {
	it("leaves fence-free text untouched", () => {
		expect(stripFences("hello world\n")).toBe("hello world\n");
	});

	it("removes a leading language-tagged fence", () => {
		expect(stripFences("```python\nprint(1)\n")).toBe("print(1)\n");
	});

	it("removes a leading bare fence", () => {
		expect(stripFences("```\nprint(1)\n")).toBe("print(1)\n");
	});

	it("removes a trailing fence with newline", () => {
		expect(stripFences("print(1)\n```")).toBe("print(1)");
	});

	it("removes a trailing fence with trailing whitespace", () => {
		expect(stripFences("print(1)\n```   ")).toBe("print(1)");
	});

	it("removes both leading and trailing fences in one pass", () => {
		expect(stripFences("```ts\nconst x = 1;\n```")).toBe("const x = 1;");
	});

	it("preserves inner fences", () => {
		const src = "```py\nprint('```inline```')\n```";
		expect(stripFences(src)).toBe("print('```inline```')");
	});

	it("preserves indentation and blank lines inside", () => {
		const src = "```\ndef f():\n\n    return 1\n```";
		expect(stripFences(src)).toBe("def f():\n\n    return 1");
	});

	it("tolerates leading whitespace before the opening fence", () => {
		expect(stripFences("  ```\nbody\n```")).toBe("body");
	});
});

describe("buildCoderPrompt", () => {
	it("prepends the system prompt with a Task: header", () => {
		expect(buildCoderPrompt("SYS", "do X")).toBe("SYS\n\nTask:\ndo X");
	});

	it("does not mutate the task body", () => {
		const task = "line1\nline2\n\nline3";
		expect(buildCoderPrompt("S", task).endsWith(task)).toBe(true);
	});
});

describe("resolveTargetPath", () => {
	const isAbs = (p: string): boolean => p.startsWith("/");
	const join = (a: string, b: string): string => a.replace(/\/$/, "") + "/" + b;

	it("returns absolute paths unchanged", () => {
		expect(resolveTargetPath("/cwd", "/tmp/out.py", isAbs, join)).toBe("/tmp/out.py");
	});

	it("resolves relative paths against cwd", () => {
		expect(resolveTargetPath("/cwd", "sub/out.py", isAbs, join)).toBe("/cwd/sub/out.py");
	});

	it("resolves bare filenames against cwd", () => {
		expect(resolveTargetPath("/cwd", "out.py", isAbs, join)).toBe("/cwd/out.py");
	});
});

describe("buildCoderArgs", () => {
	it("emits the exact pi CLI argv for a coder subprocess", () => {
		expect(buildCoderArgs("bifrost", "ollama/qwen3-coder:30b", "hello")).toEqual([
			"--provider",
			"bifrost",
			"--model",
			"ollama/qwen3-coder:30b",
			"--no-session",
			"--no-approve",
			"-p",
			"hello",
		]);
	});

	it("leaves tools enabled so the coder can close its own loop", () => {
		// Load-bearing: without compile-and-test the coder cannot fix anything,
		// so every error round-trips through the planner and delegation is
		// guaranteed to look worse than writing the code directly.
		expect(buildCoderArgs("bifrost", "m", "t")).not.toContain("--no-tools");
	});

	it("passes the prompt verbatim so shells cannot re-interpret it", () => {
		const evil = "$(rm -rf /)";
		const args = buildCoderArgs("bifrost", "m", evil);
		expect(args[args.length - 1]).toBe(evil);
	});
});

describe("normalizeCoderOutput", () => {
	it("strips fences and guarantees a single trailing newline", () => {
		expect(normalizeCoderOutput("```py\nprint(1)\n```")).toBe("print(1)\n");
	});

	it("collapses trailing whitespace to one newline", () => {
		expect(normalizeCoderOutput("body\n\n\n")).toBe("body\n");
	});

	it("adds a trailing newline when the coder omits one", () => {
		expect(normalizeCoderOutput("no-newline")).toBe("no-newline\n");
	});
});

describe("CODER_SYSTEM", () => {
	it("tells the coder it has tools and must verify its own work", () => {
		const text = CODER_SYSTEM.toLowerCase();
		expect(text).toContain("tools");
		expect(text).toContain("compile");
	});

	it("constrains the coder to the file it was asked for", () => {
		expect(CODER_SYSTEM.toLowerCase()).toContain("only the file you were asked for");
	});

	it("agrees with buildCoderArgs about tool availability", () => {
		// These two once disagreed: --no-tools was set while the prompt claimed
		// tools, and the coder's narration was written into the source file.
		const claimsTools = CODER_SYSTEM.toLowerCase().includes("you are a coding agent with tools");
		const toolsDisabled = buildCoderArgs("p", "m", "t").includes("--no-tools");
		expect(claimsTools).toBe(!toolsDisabled);
	});
});
