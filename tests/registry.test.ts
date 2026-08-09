import { describe, it, expect, beforeEach } from "vitest";
import * as registry from "../lib/registry.js";

beforeEach(() => {
	registry.clear();
});

describe("sessionName", () => {
	it("prefixes with keep-", () => {
		expect(registry.sessionName("pr")).toBe("keep-pr");
	});
});

describe("add", () => {
	it("returns null on success", () => {
		const err = registry.add({
			name: "pr",
			session: "keep-pr",
			mode: "watch",
			command: "gh pr checks",
			interval: 300,
			startedAt: "2026-01-01T00:00:00Z",
		});
		expect(err).toBeNull();
	});

	it("returns error for duplicate name", () => {
		registry.add({
			name: "pr",
			session: "keep-pr",
			mode: "watch",
			command: "gh pr checks",
			interval: 300,
			startedAt: "2026-01-01T00:00:00Z",
		});
		const err = registry.add({
			name: "pr",
			session: "keep-pr",
			mode: "watch",
			command: "other",
			interval: 60,
			startedAt: "2026-01-01T00:00:00Z",
		});
		expect(err).toContain("already running");
	});
});

describe("remove", () => {
	it("returns true when entry existed", () => {
		registry.add({
			name: "pr",
			session: "keep-pr",
			mode: "watch",
			command: "cmd",
			startedAt: "2026-01-01T00:00:00Z",
		});
		expect(registry.remove("pr")).toBe(true);
	});

	it("returns false when entry did not exist", () => {
		expect(registry.remove("missing")).toBe(false);
	});
});

describe("has", () => {
	it("returns false for empty registry", () => {
		expect(registry.has("pr")).toBe(false);
	});

	it("returns true after add", () => {
		registry.add({
			name: "pr",
			session: "keep-pr",
			mode: "run",
			command: "cmd",
			startedAt: "2026-01-01T00:00:00Z",
		});
		expect(registry.has("pr")).toBe(true);
	});

	it("returns false after remove", () => {
		registry.add({
			name: "pr",
			session: "keep-pr",
			mode: "run",
			command: "cmd",
			startedAt: "2026-01-01T00:00:00Z",
		});
		registry.remove("pr");
		expect(registry.has("pr")).toBe(false);
	});
});

describe("list", () => {
	it("returns empty array for empty registry", () => {
		expect(registry.list()).toEqual([]);
	});

	it("returns all entries", () => {
		registry.add({
			name: "a",
			session: "keep-a",
			mode: "run",
			command: "cmd-a",
			startedAt: "2026-01-01T00:00:00Z",
		});
		registry.add({
			name: "b",
			session: "keep-b",
			mode: "watch",
			command: "cmd-b",
			interval: 60,
			startedAt: "2026-01-01T00:00:00Z",
		});
		expect(registry.list()).toHaveLength(2);
	});
});
