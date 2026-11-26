// Building biff REPL command lines from model-controlled text.
//
// The biff REPL tokenises each command line with Python's shlex.split (POSIX
// mode). Raw text breaks on any unbalanced quote: an apostrophe in "Jim's"
// makes biff reply "Parse error: No closing quotation". It can also be
// misread: "a 'b c' d" collapses into fewer arguments. So every argument is
// passed through shlexQuote.
//
// Commands that join their remaining arguments with single spaces (write,
// wall, plan) get the text as ONE quoted argument, which also preserves
// runs of spaces exactly.

// Control characters can't be sent: tmux literal input still turns newlines
// and carriage returns into Enter, which would submit extra REPL commands.
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const LINE_BREAKS = /\r\n|\r|\n|\u2028|\u2029/g;
const OTHER_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/;
const SHLEX_SAFE = /^[A-Za-z0-9@%+=:,./_-]+$/;

/** True when the value contains any control character. */
export function hasControlChars(value: string): boolean {
	return CONTROL_CHARS.test(value);
}

/**
 * Quote one argument so shlex.split (POSIX) returns it unchanged.
 *
 * Mirrors Python's shlex.quote: safe strings pass through, everything else
 * is wrapped in single quotes, and embedded single quotes become '"'"'.
 */
export function shlexQuote(value: string): string {
	if (value === "") return "''";
	if (SHLEX_SAFE.test(value)) return value;
	return "'" + value.replace(/'/g, `'"'"'`) + "'";
}

/**
 * Normalise free text (a message, plan or wall post) for one REPL line.
 *
 * Line breaks become " / " so multi-paragraph text still reads naturally
 * on one line instead of being rejected. Tabs become a space. Any other
 * control character is still an error, because silently dropping it could
 * change meaning.
 */
export function flattenText(value: string): { text: string } | { error: string } {
	const text = value
		.replace(/\t/g, " ")
		.split(LINE_BREAKS)
		.map((line) => line.trim())
		.filter((line) => line !== "")
		.join(" / ");
	if (OTHER_CONTROL.test(text)) return { error: "contains control characters" };
	return { text };
}

/** An identifier argument (address, user, tty name) must be one plain token. */
export function checkToken(value: string, field: string): string | undefined {
	if (!value.trim()) return `${field} must not be empty.`;
	if (hasControlChars(value)) return `${field} must not contain control characters.`;
	if (/\s/.test(value)) return `${field} must not contain spaces.`;
	return undefined;
}

/** Join a command name and its arguments, quoting each argument. */
export function biffLine(command: string, ...args: string[]): string {
	return [command, ...args.map(shlexQuote)].join(" ");
}
