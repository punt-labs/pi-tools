#!/usr/bin/env bash
# Pi RPC smoke test for the keep extension.
# Requires: pi binary, model API key, tmux.
# Exits 0 on success, 1 on failure.
set -euo pipefail

TIMEOUT=30
SESSION="keep-smoke-test"

fail() { echo "FAIL: $1" >&2; exit 1; }
pass() { echo "PASS: $1"; }

# Start pi in RPC mode with this extension loaded
PI_PID=""
cleanup() {
  if [ -n "$PI_PID" ]; then
    kill "$PI_PID" 2>/dev/null || true
    wait "$PI_PID" 2>/dev/null || true
  fi
  tmux kill-session -t "$SESSION" 2>/dev/null || true
}
trap cleanup EXIT

echo "Starting pi in RPC mode..."
pi --mode json --approve -e ./extensions/keep.ts -p "Use the keep_run tool to start a tmux session named smoke-test running the command 'echo keep-smoke-ok'. Then use keep_capture to read its output. Then use keep_stop to stop it. Then use keep_list to confirm it is gone. Report each step result." < /dev/null > .tmp/smoke-pi-output.jsonl 2>&1 &
PI_PID=$!

# Wait for pi to finish (it runs in print mode)
if ! timeout "$TIMEOUT" wait "$PI_PID" 2>/dev/null; then
  fail "pi did not finish within ${TIMEOUT}s"
fi
PI_PID=""

# Check output for expected tool calls
if grep -q "keep_run" .tmp/smoke-pi-output.jsonl; then
  pass "keep_run was called"
else
  fail "keep_run was not called"
fi

if grep -q "keep_capture" .tmp/smoke-pi-output.jsonl; then
  pass "keep_capture was called"
else
  fail "keep_capture was not called"
fi

if grep -q "keep_stop" .tmp/smoke-pi-output.jsonl; then
  pass "keep_stop was called"
else
  fail "keep_stop was not called"
fi

if grep -q "keep_list" .tmp/smoke-pi-output.jsonl; then
  pass "keep_list was called"
else
  fail "keep_list was not called"
fi

echo "All smoke tests passed."
