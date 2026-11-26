import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { execFileSync, spawn } from "node:child_process";
import { constants } from "node:os";
import { DEFAULT_COMMAND_TIMEOUT_S, KILL_GRACE_S } from "./bash-guard.js";

/** Largest duration supported by Node's timer API without overflow. */
export const MAX_COMMAND_TIMEOUT_S = 2_147_483_647 / 1000;

function validateTimeout(seconds: number): void {
	if (!Number.isFinite(seconds) || seconds <= 0 || seconds > MAX_COMMAND_TIMEOUT_S) {
		throw new Error(`Invalid timeout: ${String(seconds)}`);
	}
}

/**
 * Supervise each command in its own POSIX process group. The deadline sends
 * SIGTERM, then SIGKILL after ten seconds if group members are still running.
 * Normal command exit kills background members; deadline exits retain TERM grace.
 * This does not contain processes that deliberately create another session.
 */
export function createGuardedBashOperations(
	timeoutSeconds = DEFAULT_COMMAND_TIMEOUT_S,
	shellConfig: { shell: string; args: readonly string[] } = { shell: "bash", args: ["-c"] },
): BashOperations {
	validateTimeout(timeoutSeconds);
	return {
		async exec(command, cwd, { onData, signal, timeout, env }) {
			if (process.platform === "win32") {
				throw new Error("The bash guard requires POSIX process groups (Linux or macOS).");
			}
			if (timeout !== undefined) validateTimeout(timeout);
			if (signal?.aborted) throw new Error("aborted");
			const perCallTimeout = timeout !== undefined && timeout < timeoutSeconds;
			const limit = Math.min(timeout ?? timeoutSeconds, timeoutSeconds);
			return new Promise((resolve, reject) => {
				const child = spawn(shellConfig.shell, [...shellConfig.args, command], {
					cwd,
					env,
					detached: true,
					stdio: ["ignore", "pipe", "pipe"],
				});
				let settled = false;
				let timedOut = false;
				let forced = false;
				let leaderExited = false;
				let exitCode: number | null = null;
				let escalation: ReturnType<typeof setTimeout> | undefined;
				let drain: ReturnType<typeof setTimeout> | undefined;
				let groupCheck: ReturnType<typeof setTimeout> | undefined;

				const hasLiveGroup = (): boolean => {
					// An exited leader can leave live children or only unreaped zombies.
					// POSIX ps distinguishes those cases without inspecting commands.
					const states = execFileSync("ps", ["-A", "-o", "pgid=", "-o", "stat="], {
						encoding: "utf8",
						timeout: 1000,
					});
					return states.split("\n").some((line) => {
						const [group, state] = line.trim().split(/\s+/);
						return group === String(child.pid) && !state.startsWith("Z");
					});
				};

				const killGroup = (terminationSignal: NodeJS.Signals): Error | undefined => {
					if (child.pid === undefined) return;
					try {
						// detached:true gives this child its own process group. Never
						// signal our inherited group or fall back to the parent PID.
						process.kill(-child.pid, terminationSignal);
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code !== "ESRCH") return error as Error;
					}
				};
				const finish = (error?: Error): void => {
					if (settled) return;
					settled = true;
					clearTimeout(deadline);
					clearTimeout(escalation);
					clearTimeout(drain);
					clearTimeout(groupCheck);
					signal?.removeEventListener("abort", onAbort);
					child.stdout.destroy();
					child.stderr.destroy();
					if (error) reject(error);
					else if (signal?.aborted) reject(new Error("aborted"));
					else if (timedOut && perCallTimeout) reject(new Error(`timeout:${String(timeout)}`));
					else resolve({ exitCode: timedOut ? (forced ? 137 : 124) : exitCode });
				};
				const waitForGroup = (): void => {
					if (settled) return;
					clearTimeout(groupCheck);
					try {
						if (!hasLiveGroup()) {
							finish();
							return;
						}
						groupCheck = setTimeout(waitForGroup, 50);
					} catch (error) {
						killGroup("SIGKILL");
						finish(
							new Error("Cannot inspect the timed-out Bash group; POSIX ps is required.", {
								cause: error,
							}),
						);
					}
				};
				const onAbort = (): void => {
					const error = killGroup("SIGKILL");
					if (error) finish(error);
					else if (leaderExited) finish();
				};
				const onDataChunk = (data: Buffer): void => {
					if (settled) return;
					try {
						onData(data);
					} catch (error) {
						killGroup("SIGKILL");
						finish(error as Error);
					}
				};
				child.stdout.on("data", onDataChunk);
				child.stderr.on("data", onDataChunk);
				child.once("error", (error) => {
					finish(
						new Error(`Cannot start bash in ${cwd}: ${error.message}. Bash must be on PATH.`, {
							cause: error,
						}),
					);
				});
				child.once("exit", (code, terminationSignal) => {
					if (settled) return;
					leaderExited = true;
					exitCode =
						code ?? (terminationSignal ? 128 + constants.signals[terminationSignal] : null);
					clearTimeout(deadline);
					if (timedOut && !forced) {
						waitForGroup();
						return;
					}
					clearTimeout(escalation);
					const error = killGroup("SIGKILL");
					if (error) {
						finish(error);
						return;
					}
					// Drain buffered output, but never wait indefinitely for a pipe
					// retained by a descendant that deliberately escaped the group.
					drain = setTimeout(() => finish(), 100);
				});
				child.once("close", () => {
					if (timedOut && !forced) waitForGroup();
					else finish();
				});
				const deadline = setTimeout(() => {
					timedOut = true;
					const error = killGroup("SIGTERM");
					if (error) {
						finish(error);
						return;
					}
					escalation = setTimeout(() => {
						try {
							forced = hasLiveGroup();
						} catch (error) {
							killGroup("SIGKILL");
							finish(
								new Error("Cannot inspect the timed-out Bash group; POSIX ps is required.", {
									cause: error,
								}),
							);
							return;
						}
						const killError = killGroup("SIGKILL");
						if (killError) finish(killError);
						else if (leaderExited) finish();
					}, KILL_GRACE_S * 1000);
				}, limit * 1000);
				signal?.addEventListener("abort", onAbort, { once: true });
				if (signal?.aborted) onAbort();
			});
		},
	};
}
