import { describe, expect, it } from "vitest";
import { parseEvery } from "../extensions/every.js";

describe("parseEvery", () => {
	it("parses seconds and a bounded arbitrary instruction", () => {
		expect(parseEvery('30s vox say "What\'s up?" 5')).toEqual({
			intervalMs: 30_000,
			intervalLabel: "30s",
			instruction: 'vox say "What\'s up?"',
			maximumRuns: 5,
		});
	});

	it("parses minutes and hours", () => {
		expect(parseEvery("2m check deployment 12")).toMatchObject({
			intervalMs: 120_000,
			maximumRuns: 12,
		});
		expect(parseEvery("1h summarize progress 3")).toMatchObject({
			intervalMs: 3_600_000,
			maximumRuns: 3,
		});
	});

	it("rejects missing units, commands, and maximums", () => {
		expect(parseEvery("30 say hello 2")).toBeTypeOf("string");
		expect(parseEvery("30s 2")).toBeTypeOf("string");
		expect(parseEvery("30s say hello")).toBeTypeOf("string");
	});

	it("rejects zero intervals and maximums", () => {
		expect(parseEvery("0s say hello 2")).toBeTypeOf("string");
		expect(parseEvery("30s say hello 0")).toBeTypeOf("string");
	});
});
