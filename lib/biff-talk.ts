// Recognising the end of a talk in the biff REPL's output.
//
// Biff reports the end in two lines: the partner's hangup first, rendered by
// format_talk_end as a whole line "▶  <user:tty> has ended the conversation.",
// then the REPL's own "Talk with <user> ended." (or "cancelled.") once it
// leaves talk mode. A read can land between them, so either line counts.
// Matching only the second left the bridge stuck in talk mode, refusing every
// other biff tool.
//
// Only whole lines in exactly those shapes count. An ordinary talk message is
// rendered as "▶  <user:tty>  <text>" (two spaces before the text), so a
// partner who types "x has ended the conversation." does not end the talk.

const PARTNER_HANGUP = /^▶ {2}\S+ has ended the conversation\.$/;
const REPL_END = /^Talk with \S+ (?:ended|cancelled)\.$/;

// Strip ANSI styling (biff dims the hangup line) and the REPL's line-clearing
// escape before matching.
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;

export function isTalkHangup(text: string): boolean {
	return text
		.replace(ANSI, "")
		.split("\n")
		.map((line) => line.replace(/^\r/, "").trim())
		.some((line) => PARTNER_HANGUP.test(line) || REPL_END.test(line));
}
