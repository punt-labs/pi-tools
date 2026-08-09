import { describe, expect, it } from "vitest";
import { shouldWakeWatch } from "../extensions/keep.js";

describe("shouldWakeWatch", () => {
	it("wakes for the first change-policy snapshot", () => {
		expect(shouldWakeWatch("change", undefined, "pending")).toBe(true);
	});

	it("wakes only when change-policy output changes", () => {
		expect(shouldWakeWatch("change", "pending", "pending")).toBe(false);
		expect(shouldWakeWatch("change", "pending", "passed")).toBe(true);
	});

	it("always wakes even when output is unchanged", () => {
		expect(shouldWakeWatch("always", "pending", "pending")).toBe(true);
	});

	it("never wakes", () => {
		expect(shouldWakeWatch("never", undefined, "pending")).toBe(false);
		expect(shouldWakeWatch("never", "pending", "passed")).toBe(false);
	});
});
