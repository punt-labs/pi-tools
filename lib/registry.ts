export interface Kept {
	name: string;
	session: string;
	mode: "watch" | "run";
	command: string;
	interval?: number;
	startedAt: string;
}

const PREFIX = "keep-";

// Kept-session names become part of a tmux target (`keep-<name>`). tmux target
// syntax uses `:` (window/pane) and `.` (pane index), so an unrestricted name
// could address a window in another session even while registered under that
// name. Restrict names to a documented safe set: ASCII letters, digits, hyphen,
// and underscore, 1..64 characters. See ADR-002 in DESIGN.md.
const NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const entries = new Map<string, Kept>();

export function isValidName(name: string): boolean {
	return NAME_PATTERN.test(name);
}

export function sessionName(name: string): string {
	return PREFIX + name;
}

export function add(kept: Kept): string | null {
	if (!isValidName(kept.name)) {
		return `Invalid name '${kept.name}': use 1-64 characters from A-Z, a-z, 0-9, - and _`;
	}
	if (entries.has(kept.name)) {
		return `${kept.name} is already running`;
	}
	entries.set(kept.name, kept);
	return null;
}

export function remove(name: string): boolean {
	return entries.delete(name);
}

export function has(name: string): boolean {
	return entries.has(name);
}

export function get(name: string): Kept | undefined {
	return entries.get(name);
}

export function list(): Kept[] {
	return [...entries.values()];
}

export function clear(): void {
	entries.clear();
}
