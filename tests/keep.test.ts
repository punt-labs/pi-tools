import { describe, it, expect } from "vitest";
import { parseTwoArgs, parseThreeArgs } from "../lib/parse.js";

describe("parseTwoArgs", () => {
	it("splits name and rest", () => {
		expect(parseTwoArgs("biff biff")).toEqual({
			first: "biff",
			rest: "biff",
		});
	});

	it("preserves rest with spaces", () => {
		expect(parseTwoArgs("pr gh -R punt-labs/beadle pr checks 203")).toEqual({
			first: "pr",
			rest: "gh -R punt-labs/beadle pr checks 203",
		});
	});

	it("trims leading and trailing whitespace", () => {
		expect(parseTwoArgs("  name  command  ")).toEqual({
			first: "name",
			rest: "command",
		});
	});

	it("returns null for empty input", () => {
		expect(parseTwoArgs("")).toBeNull();
	});

	it("returns null for single word", () => {
		expect(parseTwoArgs("name")).toBeNull();
	});

	it("returns null for name with trailing space only", () => {
		expect(parseTwoArgs("name   ")).toBeNull();
	});
});

describe("parseThreeArgs", () => {
	it("splits name, interval, and command", () => {
		expect(parseThreeArgs("pr 300 gh pr checks 203")).toEqual({
			first: "pr",
			second: "300",
			rest: "gh pr checks 203",
		});
	});

	it("returns null for two words only", () => {
		expect(parseThreeArgs("pr 300")).toBeNull();
	});

	it("returns null for one word", () => {
		expect(parseThreeArgs("pr")).toBeNull();
	});

	it("returns null for empty input", () => {
		expect(parseThreeArgs("")).toBeNull();
	});
});
