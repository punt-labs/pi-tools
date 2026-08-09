import { describe, it, expect } from "vitest";
import { timeSince, formatKept, formatList, stripWatchHeader } from "../lib/format.js";
import type { Kept } from "../lib/registry.js";

const BASE = new Date("2026-01-01T00:00:00Z").getTime();

describe("stripWatchHeader", () => {
	it("strips header and blank line", () => {
		const input = "Every 300.0s: gh pr checks 203  host: Sat Aug  8\n\ncheck1  pass\ncheck2  pass";
		expect(stripWatchHeader(input)).toBe("check1  pass\ncheck2  pass");
	});

	it("strips header without blank line", () => {
		const input = "Every 5.0s: echo hi  host: Sat Aug  8\nhi";
		expect(stripWatchHeader(input)).toBe("hi");
	});

	it("returns text unchanged when no watch header", () => {
		const input = "just some output";
		expect(stripWatchHeader(input)).toBe("just some output");
	});

	it("handles empty string", () => {
		expect(stripWatchHeader("")).toBe("");
	});
});

describe("timeSince", () => {
	it("formats seconds", () => {
		expect(timeSince("2026-01-01T00:00:00Z", BASE + 30_000)).toBe("30s");
	});

	it("formats minutes", () => {
		expect(timeSince("2026-01-01T00:00:00Z", BASE + 150_000)).toBe("2m");
	});

	it("formats hours and minutes", () => {
		expect(timeSince("2026-01-01T00:00:00Z", BASE + 3_900_000)).toBe("1h5m");
	});
});

describe("formatKept", () => {
	it("formats watch entry", () => {
		const kept: Kept = {
			name: "pr",
			session: "keep-pr",
			mode: "watch",
			command: "gh pr checks",
			interval: 300,
			startedAt: "2026-01-01T00:00:00Z",
		};
		const text = formatKept(kept, BASE + 60_000);
		expect(text).toBe("pr [watch 300s] 1m — gh pr checks");
	});

	it("formats run entry", () => {
		const kept: Kept = {
			name: "biff",
			session: "keep-biff",
			mode: "run",
			command: "biff",
			startedAt: "2026-01-01T00:00:00Z",
		};
		const text = formatKept(kept, BASE + 5_000);
		expect(text).toBe("biff [run] 5s — biff");
	});
});

describe("formatList", () => {
	it("returns empty message for no entries", () => {
		expect(formatList([])).toBe("No active keep sessions");
	});

	it("formats multiple entries", () => {
		const items: Kept[] = [
			{
				name: "pr",
				session: "keep-pr",
				mode: "watch",
				command: "gh pr checks",
				interval: 300,
				startedAt: "2026-01-01T00:00:00Z",
			},
			{
				name: "biff",
				session: "keep-biff",
				mode: "run",
				command: "biff",
				startedAt: "2026-01-01T00:00:00Z",
			},
		];
		const text = formatList(items, BASE + 120_000);
		expect(text).toContain("pr [watch 300s]");
		expect(text).toContain("biff [run]");
	});
});
