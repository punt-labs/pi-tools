import { describe, it, expect } from "vitest";
import {
	biffLine,
	checkToken,
	flattenText,
	hasControlChars,
	shlexQuote,
} from "../lib/biff-args.js";

// A minimal POSIX shlex.split, enough to check that quoting round-trips the way
// biff's dispatcher (Python shlex.split) will read it. Covers unquoted words,
// single quotes, double quotes and backslash escapes outside quotes.
function shlexSplit(line: string): string[] {
	const out: string[] = [];
	let cur = "";
	let inWord = false;
	let i = 0;
	while (i < line.length) {
		const c = line[i];
		if (c === "'") {
			const end = line.indexOf("'", i + 1);
			if (end < 0) throw new Error("No closing quotation");
			cur += line.slice(i + 1, end);
			inWord = true;
			i = end + 1;
		} else if (c === '"') {
			let j = i + 1;
			while (j < line.length && line[j] !== '"') {
				if (line[j] === "\\" && j + 1 < line.length && '\\"$`'.includes(line[j + 1])) j += 1;
				cur += line[j];
				j += 1;
			}
			if (j >= line.length) throw new Error("No closing quotation");
			inWord = true;
			i = j + 1;
		} else if (c === "\\") {
			cur += line[i + 1] ?? "";
			inWord = true;
			i += 2;
		} else if (/\s/.test(c)) {
			if (inWord) out.push(cur);
			cur = "";
			inWord = false;
			i += 1;
		} else {
			cur += c;
			inWord = true;
			i += 1;
		}
	}
	if (inWord) out.push(cur);
	return out;
}

describe("shlexQuote", () => {
	it("passes safe tokens through", () => {
		expect(shlexQuote("claude:tty17")).toBe("claude:tty17");
		expect(shlexQuote("pi-2212")).toBe("pi-2212");
	});

	it("quotes empty strings", () => {
		expect(shlexQuote("")).toBe("''");
	});

	it.each([
		["Jim's OK"],
		["don't stop: it's fine"],
		['a "double" quote'],
		["a 'b c' d"],
		["back\\slash and $HOME and `cmd`"],
		["  two  spaces  "],
		["emoji 🙂 and café"],
		["semicolon; ampersand & pipe |"],
	])("round-trips %j through shlex.split", (value) => {
		expect(shlexSplit(shlexQuote(value))).toEqual([value]);
	});
});

describe("biffLine", () => {
	it("produces exactly the intended arguments", () => {
		const line = biffLine("write", "claude:tty17", "From pi: Jim's OK, it's done");
		expect(shlexSplit(line)).toEqual(["write", "claude:tty17", "From pi: Jim's OK, it's done"]);
	});

	it("keeps a message with quotes as one argument", () => {
		expect(shlexSplit(biffLine("plan", "a 'b c' d"))).toEqual(["plan", "a 'b c' d"]);
	});
});

describe("flattenText", () => {
	it("turns line breaks into a visible separator", () => {
		expect(flattenText("line one\nline two\r\nthree")).toEqual({
			text: "line one / line two / three",
		});
	});

	it("turns tabs into spaces and trims", () => {
		expect(flattenText("\ta\tb\n")).toEqual({ text: "a b" });
	});

	it("still rejects other control characters", () => {
		expect(flattenText("bell\u0007")).toEqual({ error: "contains control characters" });
		expect(flattenText("esc\u001b[2J")).toEqual({ error: "contains control characters" });
	});

	it("leaves ordinary text alone", () => {
		expect(flattenText("Jim's OK")).toEqual({ text: "Jim's OK" });
	});
});

describe("checkToken", () => {
	it("accepts plain identifiers", () => {
		expect(checkToken("claude:tty17", "to")).toBeUndefined();
	});

	it.each([
		["", "to must not be empty."],
		["   ", "to must not be empty."],
		["a b", "to must not contain spaces."],
		["a\nb", "to must not contain control characters."],
	])("rejects %j", (value, message) => {
		expect(checkToken(value, "to")).toBe(message);
	});
});

describe("hasControlChars", () => {
	it("detects newlines and escapes", () => {
		expect(hasControlChars("a\nb")).toBe(true);
		expect(hasControlChars("a\u001bb")).toBe(true);
		expect(hasControlChars("plain")).toBe(false);
	});
});
