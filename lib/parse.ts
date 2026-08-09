export function parseTwoArgs(raw: string): { first: string; rest: string } | null {
	const trimmed = raw.trim();
	const idx = trimmed.indexOf(" ");
	if (idx < 0) return null;
	const first = trimmed.slice(0, idx);
	const rest = trimmed.slice(idx + 1).trim();
	if (!rest) return null;
	return { first, rest };
}

export function parseThreeArgs(raw: string): { first: string; second: string; rest: string } | null {
	const a = parseTwoArgs(raw);
	if (!a) return null;
	const b = parseTwoArgs(a.rest);
	if (!b) return null;
	return { first: a.first, second: b.first, rest: b.rest };
}
