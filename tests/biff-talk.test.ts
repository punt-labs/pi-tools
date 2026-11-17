import { describe, expect, it } from "vitest";
import { isTalkHangup } from "../lib/biff-talk.js";

describe("isTalkHangup", () => {
	it.each([
		["▶ jmf-pobox:peer-1 has ended the conversation."],
		["Talk with jmf-pobox:peer-1 ended."],
		["Talk with jmf-pobox:peer-1 cancelled."],
	])("detects %j", (line) => {
		expect(isTalkHangup(line)).toBe(true);
	});

	it.each([
		["Connected to jmf-pobox:peer-1"],
		["peer> the build ended."],
		["No new talk activity."],
	])("ignores %j", (line) => {
		expect(isTalkHangup(line)).toBe(false);
	});
});
