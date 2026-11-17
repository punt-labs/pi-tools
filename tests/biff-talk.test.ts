import { describe, expect, it } from "vitest";
import { isTalkHangup } from "../lib/biff-talk.js";

describe("isTalkHangup", () => {
	it.each([
		["▶  jmf-pobox:peer-1 has ended the conversation."],
		["\u001b[2m▶  jmf-pobox:peer-1 has ended the conversation.\u001b[0m"],
		["Talk with jmf-pobox:peer-1 ended."],
		["\r\u001b[KTalk with jmf-pobox:peer-1 ended."],
		["Talk with jmf-pobox:peer-1 cancelled."],
		["some earlier output\nTalk with jmf-pobox:peer-1 ended.\njmf-pobox:pi-1 ▶"],
	])("detects %j", (text) => {
		expect(isTalkHangup(text)).toBe(true);
	});

	it.each([
		["Connected to jmf-pobox:peer-1"],
		["No new talk activity."],
		// A partner quoting the phrases in an ordinary talk line (two spaces after
		// the sender, as biff renders talk text) must not end the talk.
		["▶  jmf-pobox:peer-1  x has ended the conversation."],
		["▶  jmf-pobox:peer-1  Talk with bob ended."],
		["▶  [12:01] jmf-pobox:peer-1  has ended the conversation."],
		// Wrapped message: biff indents continuation lines under the body, so a
		// continuation that looks like either end line is still message text.
		[
			"\u001b[36m▶  jmf-pobox:peer-1  a long message that wraps onto\u001b[0m\n" +
				"\u001b[36m                    ▶  x has ended the conversation.\u001b[0m",
		],
		["▶  jmf-pobox:peer-1  first part\n                    Talk with bob ended."],
	])("ignores %j", (text) => {
		expect(isTalkHangup(text)).toBe(false);
	});
});
