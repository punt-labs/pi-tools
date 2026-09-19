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

	it("rejects amounts beyond the safe-integer range", () => {
		const huge = "99999999999999999999";
		expect(parseEvery(`${huge}s say hello 2`)).toBeTypeOf("string");
		expect(parseEvery(`30s say hello ${huge}`)).toBeTypeOf("string");
	});

	it("rejects intervals whose millisecond product overflows the safe range", () => {
		// 2501999793h * 3_600_000 ms exceeds Number.MAX_SAFE_INTEGER (max safe: 2501999792h).
		expect(parseEvery("2501999793h say hello 2")).toBeTypeOf("string");
	});

	it("keeps a large-but-safe interval", () => {
		// 2000000h * 3_600_000 = 7.2e12 ms, well within the safe-integer range.
		const parsed = parseEvery("2000000h say hello 2");
		expect(parsed).not.toBeTypeOf("string");
		expect(parsed).toMatchObject({ intervalMs: 7_200_000_000_000, maximumRuns: 2 });
	});
});
