#!/usr/bin/env bash
# Two isolated quick-agent hubs on this machine ("ma" and "mb") for handoff tests.
# Usage: test/handoff-env.sh up|down     then: A quick …  /  B quick …  (see `source test/handoff-env.sh vars`)
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT=${QA_HO_ROOT:-/tmp/qa-ho}
MODEL=${QA_HO_MODEL:-tokenjoy/claude-haiku-5-5}
SECRET=ho-test-secret-123
A() { QA_HOME=$ROOT/hA PI_CODING_AGENT_DIR=$ROOT/piA node "$REPO/cli/quick.ts" "$@"; }
B() { QA_HOME=$ROOT/hB PI_CODING_AGENT_DIR=$ROOT/piB node "$REPO/cli/quick.ts" "$@"; }
[ "${1:-}" = vars ] && return 0 2>/dev/null

mkpi() { # isolated pi agent dir that loads quick-agent from this worktree
	local d=$1; mkdir -p "$d/sessions"
	for f in auth.json tokenjoy.json models-store.json tokenjoy-models-cache.json extensions bin; do
		[ -e "$HOME/.pi/agent/$f" ] && cp -a "$HOME/.pi/agent/$f" "$d/" ; done
	printf '{"defaultProvider":"tokenjoy","defaultModel":"%s","packages":["%s"]}\n' "${MODEL#*/}" "$REPO" > "$d/settings.json"
}
cfg() { # id port session peers
	mkdir -p "$ROOT/h$1"
	cat > "$ROOT/h$1/config.json" <<J
{ "host": "127.0.0.1", "port": $2, "token": "tok-$1", "model": "$MODEL", "workerModel": "$MODEL",
  "tmuxSession": "$3", "defaultCwd": "$ROOT/$1", "machine": { "id": "m$(echo $1 | tr A-Z a-z)" },
  "mesh": { "secret": "$SECRET", "peers": $4 },
  "projects": [ { "match": "proj", "cwd": "$ROOT/A/proj", "machine": "ma" }, { "match": "proj", "cwd": "$ROOT/B/proj", "machine": "mb" } ] }
J
}
start() { # X
	QA_HOME=$ROOT/h$1 PI_CODING_AGENT_DIR=$ROOT/pi$1 QA_TEST_HOOKS=${QA_TEST_HOOKS:-} NODE_NO_WARNINGS=1 nohup node "$REPO/hub/server.ts" >> "$ROOT/h$1/hub.log" 2>&1 &
}
case "${1:-up}" in
up)
	mkdir -p "$ROOT/A" "$ROOT/B"
	mkpi "$ROOT/piA"; mkpi "$ROOT/piB"
	cfg A 17791 qa-hoA '[{"url":"http://127.0.0.1:17792"}]'
	cfg B 17792 qa-hoB '[]'
	start A; start B; sleep 4
	A machines ;;
restart) # hubs only; worker windows keep running
	for x in A B; do [ -f "$ROOT/h$x/hub.pid" ] && kill "$(cat "$ROOT/h$x/hub.pid")" 2>/dev/null || true; done
	sleep 1; start A; start B; sleep 4; A machines ;;
down)
	for x in A B; do [ -f "$ROOT/h$x/hub.pid" ] && kill "$(cat "$ROOT/h$x/hub.pid")" 2>/dev/null || true; done
	tmux kill-session -t =qa-hoA 2>/dev/null || true; tmux kill-session -t =qa-hoB 2>/dev/null || true ;;
esac
