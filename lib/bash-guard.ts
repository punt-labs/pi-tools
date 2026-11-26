/**
 * Bounds every shell command an agent runs.
 *
 * pi's bash tool takes a per-call `timeout` parameter documented as "optional,
 * no default timeout" — the MODEL decides whether to pass one. When it does
 * not, a runaway command runs until the agent session ends.
 *
 * That is not hypothetical. A benchmarked agent compiled a C program whose read
 * loop did not distinguish EOF from invalid input:
 *
 *     if (scanf("%d %d", &r, &c) != 2) {   // EOF returns -1, also != 2
 *         fprintf(stderr, "invalid move\n");
 *         continue;                         // nothing consumed — spins
 *     }
 *
 * The agent ran the binary to check its work. With no stdin it hit EOF
 * immediately and printed at 69 MB/s. pi faithfully streamed the complete
 * output to its overflow file (`$TMPDIR/pi-bash-<id>.log`, deliberately
 * uncapped so the agent can read back a truncated command's full output), and
 * 204 GB landed on disk in under an hour.
 *
 * The fix belongs at the spawn boundary, not in a cap on the damage: wrap each
 * command so the kernel kills it whether or not the model asked for a timeout.
 */

/** Default wall-clock ceiling for one command. */
export const DEFAULT_COMMAND_TIMEOUT_S = 120;

/** Grace period before SIGKILL after SIGTERM is ignored. */
export const KILL_GRACE_S = 10;

/** True when the guard stopped a command because its deadline expired. */
export function isTimeoutExit(code: number): boolean {
	return code === 124 || code === 137;
}
