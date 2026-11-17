import { describe, expect, it } from "vitest";
import { formatBiffStatus, parseBiffStatus, type StatusStyle } from "../lib/biff-status.js";

const STATUS = [
	"biff 1.23.0",
	"relay: tls://biff-relay.punt-labs.com:4222 (connected)",
	"user: jmf-pobox",
	"session: pi-2813 (4bb65756), idle 0m",
	"unread: 0 messages",
	"wall: (none)",
	"jmf-pobox:pi-2813 ▶",
].join("\n");

const TAGS: StatusStyle = {
	unread: (t) => `<u>${t}</u>`,
	wall: (t) => `<w>${t}</w>`,
	dim: (t) => `<d>${t}</d>`,
};

describe("parseBiffStatus", () => {
	it("reads user, session, unread and no wall", () => {
		expect(parseBiffStatus(STATUS)).toEqual({
			user: "jmf-pobox",
			tty: "pi-2813",
			unread: 0,
			wall: "",
		});
	});

	it("joins a wrapped wall and stops at the prompt", () => {
		const out = STATUS.replace(
			"unread: 0 messages\nwall: (none)",
			"unread: 2 messages\nwall: kai: deploy freeze until\n           noon (1h left)",
		);
		expect(parseBiffStatus(out)).toEqual({
			user: "jmf-pobox",
			tty: "pi-2813",
			unread: 2,
			wall: "kai: deploy freeze until noon (1h left)",
		});
	});

	it("returns undefined for other output", () => {
		expect(parseBiffStatus("Unknown command")).toBeUndefined();
	});
});

describe("formatBiffStatus", () => {
	const base = { user: "jmf-pobox", tty: "pi-2813", unread: 0, wall: "" };
	const on = { mesgOn: true, demoRelay: false };

	it("shows user:tty(0) plain with no unread", () => {
		expect(formatBiffStatus(base, on, TAGS)).toBe("jmf-pobox:pi-2813(0)");
	});

	it("highlights a nonzero count", () => {
		expect(formatBiffStatus({ ...base, unread: 3 }, on, TAGS)).toBe("<u>jmf-pobox:pi-2813(3)</u>");
	});

	it("shows (n) when messages are off, whatever the count", () => {
		expect(formatBiffStatus({ ...base, unread: 3 }, { ...on, mesgOn: false }, TAGS)).toBe(
			"jmf-pobox:pi-2813(n)",
		);
	});

	it("adds the demo relay flag and the wall", () => {
		const status = { ...base, wall: "kai: freeze (1h left)" };
		expect(formatBiffStatus(status, { mesgOn: true, demoRelay: true }, TAGS)).toBe(
			"jmf-pobox:pi-2813(0) <d>(demo relay)</d> <w>▶ kai: freeze (1h left)</w>",
		);
	});

	it("strips escape sequences from relay text", () => {
		const status = { ...base, wall: "kai: \x1b[31mred\x1b[0m" };
		expect(formatBiffStatus(status, on)).toBe("jmf-pobox:pi-2813(0) ▶ kai: red");
	});
});
