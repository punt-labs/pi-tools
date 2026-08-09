import type { Kept } from "./registry.js";

export function timeSince(iso: string, now?: number): string {
	const seconds = Math.floor(((now ?? Date.now()) - new Date(iso).getTime()) / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h${minutes % 60}m`;
}

export function formatKept(kept: Kept, now?: number): string {
	const age = timeSince(kept.startedAt, now);
	if (kept.mode === "watch") {
		return `${kept.name} [watch ${kept.interval}s] ${age} — ${kept.command}`;
	}
	return `${kept.name} [run] ${age} — ${kept.command}`;
}

export function formatList(items: Kept[], now?: number): string {
	if (items.length === 0) return "No active keep sessions";
	return items.map((k) => formatKept(k, now)).join("\n");
}
