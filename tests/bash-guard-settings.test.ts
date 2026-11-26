import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	SettingsManager,
	type ExtensionAPI,
	type ExtensionContext,
	type createBashToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import bashGuardExtension from "../extensions/bash-guard.js";

const fixtures: string[] = [];

afterEach(() => {
	vi.unstubAllEnvs();
	for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true });
});

function context(cwd: string): ExtensionContext {
	return {
		cwd,
		sessionManager: {
			getSessionId: () => "guard-settings-fixture",
			getSessionFile: () => undefined,
		},
	} as unknown as ExtensionContext;
}

describe("host effective shell settings", () => {
	it("preserves an effective prefix, custom Bash wrapper and execution-context cwd", async () => {
		const directory = mkdtempSync(join(process.cwd(), ".tmp", "guard-settings-"));
		fixtures.push(directory);
		const wrapper = join(directory, "custom-bash");
		writeFileSync(
			wrapper,
			'#!/bin/bash\nexport GUARD_WRAPPER_MARKER=custom-wrapper\nexec /bin/bash "$@"\n',
			{ mode: 0o755 },
		);
		const settings = SettingsManager.inMemory({
			shellCommandPrefix: "export GUARD_ACTIVATION=global-setting",
			shellPath: wrapper,
		});
		const getSettings = vi.fn(() => ({
			shellCommandPrefix: settings.getShellCommandPrefix(),
			shellPath: settings.getShellPath(),
		}));
		const registerTool = vi.fn();
		bashGuardExtension({ registerTool, getSettings } as unknown as ExtensionAPI);
		expect(getSettings).not.toHaveBeenCalled();
		settings.applyOverrides({ shellCommandPrefix: "export GUARD_ACTIVATION=effective-override" });
		vi.stubEnv("PI_CODER_API_KEY", "fake-settings-key");
		const registered = registerTool.mock.calls[0]?.[0] as ReturnType<
			typeof createBashToolDefinition
		>;
		const result = await registered.execute(
			"settings",
			{
				command:
					'printf "%s/%s/%s/%s" "$GUARD_ACTIVATION" "$GUARD_WRAPPER_MARKER" "$PWD" "${PI_CODER_API_KEY-unset}"',
			},
			undefined,
			undefined,
			context(directory),
		);
		expect(result.content).toContainEqual({
			type: "text",
			text: `effective-override/custom-wrapper/${directory}/unset`,
		});
		expect(getSettings).toHaveBeenCalledOnce();
		expect(process.env.PI_CODER_API_KEY).toBe("fake-settings-key");
	});

	it("explains the required public API instead of silently ignoring settings on an older host", async () => {
		const registerTool = vi.fn();
		bashGuardExtension({ registerTool } as unknown as ExtensionAPI);
		const registered = registerTool.mock.calls[0]?.[0] as ReturnType<
			typeof createBashToolDefinition
		>;
		await expect(
			registered.execute(
				"unsupported",
				{ command: "printf should-not-run" },
				undefined,
				undefined,
				context(process.cwd()),
			),
		).rejects.toThrow(/Pi 1\.6\.1.*getSettings/);
	});
});
