import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import type {
	BashSpawnHook,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import bashGuardExtension from "../extensions/bash-guard.js";

vi.mock("@earendil-works/pi-coding-agent", () => ({
	createBashToolDefinition: vi.fn(() => ({
		name: "bash",
		execute: vi.fn(() => Promise.resolve({ content: [] })),
	})),
	getShellConfig: vi.fn(() => ({ shell: "bash", args: ["-c"] })),
}));

const execFileAsync = promisify(execFile);

function registeredHook(): BashSpawnHook {
	const registerTool = vi.fn();
	bashGuardExtension({ registerTool, getSettings: () => ({}) } as unknown as ExtensionAPI);
	const registered = registerTool.mock.calls[0]?.[0] as ReturnType<typeof createBashToolDefinition>;
	void registered.execute("hook", { command: "ignored" }, undefined, undefined, {
		cwd: process.cwd(),
	} as ExtensionContext);
	const hook = vi.mocked(createBashToolDefinition).mock.calls.at(-1)?.[1]?.spawnHook;
	if (!hook) throw new Error("The registered bash tool has no spawn hook");
	return hook;
}

afterEach(() => {
	vi.clearAllMocks();
	vi.unstubAllEnvs();
});

describe("bash guard extension", () => {
	it.each(["fake-coder-key", undefined])(
		"keeps credential %s out of a real child without changing the parent",
		async (credential) => {
			vi.stubEnv("PI_CODER_API_KEY", credential);
			vi.stubEnv("PI_BASH_TIMEOUT_S", undefined);
			const env: NodeJS.ProcessEnv = Object.freeze({
				PATH: process.env.PATH,
				UNRELATED_SETTING: "kept",
				...(credential === undefined ? {} : { PI_CODER_API_KEY: credential }),
			});
			const context = {
				command:
					'printf "%s\\n" "${PI_CODER_API_KEY-unset}" "$UNRELATED_SETTING" "$PI_BASH_TIMEOUT_S"',
				cwd: process.cwd(),
				env,
			};
			const guarded = registeredHook()(context);
			const child = await execFileAsync("bash", ["-c", guarded.command], {
				cwd: guarded.cwd,
				env: guarded.env,
				timeout: 5_000,
			});

			expect(child.stdout).toBe("unset\nkept\n120\n");
			expect(child.stderr).toBe("");
			expect(guarded.env).not.toBe(env);
			expect(guarded.env).not.toHaveProperty("PI_CODER_API_KEY");
			expect(env.PI_CODER_API_KEY).toBe(credential);
			expect(env).not.toHaveProperty("PI_BASH_TIMEOUT_S");
			expect(process.env.PI_CODER_API_KEY).toBe(credential);
			expect(process.env.PI_BASH_TIMEOUT_S).toBeUndefined();
			expect(guarded.cwd).toBe(context.cwd);
		},
	);

	it.each([undefined, "", "0", "-1", "invalid", "Infinity", "2147484"])(
		"uses the 120-second limit for invalid override %s",
		(override) => {
			vi.stubEnv("PI_BASH_TIMEOUT_S", override);
			const guarded = registeredHook()({ command: "echo ok", cwd: "/", env: {} });
			expect(guarded.command).toBe("echo ok");
			expect(guarded.env.PI_BASH_TIMEOUT_S).toBe("120");
			expect(process.env.PI_BASH_TIMEOUT_S).toBe(override);
		},
	);

	it("propagates the configured timeout to a real child without changing the parent", async () => {
		vi.stubEnv("PI_BASH_TIMEOUT_S", "3.5");
		const env = Object.freeze({ PATH: process.env.PATH, PI_BASH_TIMEOUT_S: "99" });
		const guarded = registeredHook()({
			command: 'printf "%s" "$PI_BASH_TIMEOUT_S"',
			cwd: process.cwd(),
			env,
		});
		const child = await execFileAsync("bash", ["-c", guarded.command], {
			env: guarded.env,
			timeout: 5_000,
		});
		expect(child.stdout).toBe("3.5");
		expect(guarded.command).toBe('printf "%s" "$PI_BASH_TIMEOUT_S"');
		expect(env.PI_BASH_TIMEOUT_S).toBe("99");
		expect(process.env.PI_BASH_TIMEOUT_S).toBe("3.5");
	});
});
