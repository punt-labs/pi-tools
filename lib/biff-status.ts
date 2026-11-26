// The bridge's footer status, matching biff's own Claude Code statusline
// (biff/statusline.py `_biff_segment` and `_display_segment`):
//
//   user:tty(N)          unread count, plain when 0, bold warning colour when > 0
//   user:tty(n)          messages turned off with `biff mesg n`
//   ▶ sender: text       the team wall, when one is posted, in the error colour
//
// Pi's footer is a single line, so the wall follows the label rather than
// taking a second line, and the demo relay is flagged after the label.

export interface BiffStatus {
	user: string;
	tty: string;
	unread: number;
	/** Wall text as `sender: text (remaining)`, or "" when there is none. */
	wall: string;
}

export interface StatusStyle {
	unread(text: string): string;
	wall(text: string): string;
	dim(text: string): string;
}

const PLAIN_STYLE: StatusStyle = {
	unread: (text) => text,
	wall: (text) => text,
	dim: (text) => text,
};

/** Parse the REPL's `status` output; undefined when it isn't status output. */
export function parseBiffStatus(output: string): BiffStatus | undefined {
	const user = /^user:\s*(\S+)/m.exec(output)?.[1];
	const tty = /^session:\s*(\S+)/m.exec(output)?.[1];
	const unread = /^unread:\s*(\d+)/m.exec(output)?.[1];
	if (!user || !tty || unread === undefined) return undefined;
	// The wall line is last and may wrap onto indented continuation lines,
	// followed by the REPL's next prompt (`user:tty ▶`), which is not wall text.
	const wallStart = output.search(/^wall:/m);
	let wall = "";
	if (wallStart >= 0) {
		const lines = output.slice(wallStart).split("\n");
		const body = [lines[0].replace(/^wall:\s*/, "")];
		for (const line of lines.slice(1)) {
			if (!/^\s/.test(line) || line.trim() === "") break;
			body.push(line.trim());
		}
		wall = body.join(" ").trim();
		if (wall === "(none)") wall = "";
	}
	return { user, tty, unread: parseInt(unread, 10), wall };
}

/** Strip control characters so relay-supplied text can't restyle the footer. */
function clean(text: string): string {
	return text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/[\x00-\x1f\x7f]/g, "");
}

export function formatBiffStatus(
	status: BiffStatus,
	opts: { mesgOn: boolean; demoRelay: boolean },
	style: StatusStyle = PLAIN_STYLE,
): string {
	const name = `${clean(status.user)}:${clean(status.tty)}`;
	let label: string;
	if (!opts.mesgOn) label = `${name}(n)`;
	else if (status.unread > 0) label = style.unread(`${name}(${String(status.unread)})`);
	else label = `${name}(0)`;
	const parts = [label];
	if (opts.demoRelay) parts.push(style.dim("(demo relay)"));
	if (status.wall) parts.push(style.wall(`▶ ${clean(status.wall)}`));
	return parts.join(" ");
}
