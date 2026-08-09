import { describe, expect, it } from "vitest";
import { completedCommandOutput } from "../lib/tmux-wait.js";

const prompt = /▶\s*$/;

describe("completedCommandOutput", () => {
	it("returns output between an exact command echo and the next prompt", () => {
		const pane = [
			"agent:tty1 ▶ read",
			"▶  FROM   MESSAGE",
			"   jim    GREEN",
			"agent:tty1 ▶",
			"",
		].join("\n");

		expect(completedCommandOutput(pane, "read", prompt, 0)).toBe(
			"▶  FROM   MESSAGE\n   jim    GREEN",
		);
	});

	it("does not mistake unread status text for the read command", () => {
		const pane = ["agent:tty1 ▶ status", "unread: 2 messages", "agent:tty1 ▶", ""].join("\n");

		expect(completedCommandOutput(pane, "read", prompt, 0)).toBeUndefined();
	});

	it("waits for an occurrence newer than the baseline", () => {
		const pane = ["agent:tty1 ▶ status", "unread: 0 messages", "agent:tty1 ▶", ""].join("\n");

		expect(completedCommandOutput(pane, "status", prompt, 1)).toBeUndefined();
	});

	it("returns undefined until the completion prompt appears", () => {
		const pane = "agent:tty1 ▶ read\n▶  FROM   MESSAGE\n   jim    GREEN\n";

		expect(completedCommandOutput(pane, "read", prompt, 0)).toBeUndefined();
	});
});
