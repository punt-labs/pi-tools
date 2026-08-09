export interface Kept {
	name: string;
	session: string;
	mode: "watch" | "run";
	command: string;
	interval?: number;
	startedAt: string;
}

const PREFIX = "keep-";

const entries = new Map<string, Kept>();

export function sessionName(name: string): string {
	return PREFIX + name;
}

export function add(kept: Kept): string | null {
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
