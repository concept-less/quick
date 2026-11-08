#!/usr/bin/env bash
# End-to-end test of scheduled jobs (quick cron) against an isolated hub (own QA_HOME, port, tmux session).
# Workers are a fake `pi` on PATH (sleeps SLEEP=<n> seconds from the brief, then reports done), so the
# test is fast, free and deterministic. Never touches the real hub (~/.quick-agent) or its tmux session.
#   test/cron-e2e.sh            KEEP=1 test/cron-e2e.sh   (leave the hub running for inspection)
set -uo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT=${QA_CRON_ROOT:-/tmp/qa-cron}
PORT=${QA_CRON_PORT:-17795}
SESSION=qa-cronT
TOKEN=tok-cron-e2e
export QA_HOME=$ROOT/home QA_PORT=$PORT QA_UPDATE=off NODE_NO_WARNINGS=1
fail() { echo "FAIL: $*"; echo "--- hub.log"; tail -n 30 "$QA_HOME/hub.log"; down; exit 1; }
ok() { echo "ok - $*"; }
Q() { node "$REPO/cli/quick.ts" "$@"; }
api() { curl -sf -H "authorization: Bearer $TOKEN" "http://127.0.0.1:$PORT$1"; }
job() { api "/api/cron/$1" | jq -r ".job | $2"; }
task() { api "/api/tasks/$1?events=0" | jq -r ".task | $2"; }
waitfor() { for _ in $(seq 1 "$2"); do eval "$1" && return 0; sleep 1; done; return 1; }
start() { PATH="$ROOT/bin:$PATH" nohup node "$REPO/hub/server.ts" >> "$QA_HOME/hub.log" 2>&1 & waitfor 'api /health >/dev/null' 20 || fail "hub did not start"; }
stop() { [ -f "$QA_HOME/hub.pid" ] && kill "$(cat "$QA_HOME/hub.pid")" 2>/dev/null; waitfor '! api /health >/dev/null' 20; }
down() { [ "${KEEP:-}" ] && return; stop; tmux kill-session -t "=$SESSION" 2>/dev/null || true; }

stop >/dev/null 2>&1; tmux kill-session -t "=$SESSION" 2>/dev/null; rm -rf "$ROOT"; mkdir -p "$QA_HOME" "$ROOT/bin" "$ROOT/work"
cat > "$QA_HOME/config.json" <<J
{ "host": "127.0.0.1", "port": $PORT, "token": "$TOKEN", "model": "fake/fake", "tmuxSession": "$SESSION",
  "defaultCwd": "$ROOT/work", "machine": { "id": "mcron" }, "update": { "enabled": false } }
J
cat > "$ROOT/bin/pi" <<'P'
#!/usr/bin/env bash
# fake worker: --model M --name N @brief.md "message"
brief=""; for a in "$@"; do case $a in @*) brief=${a#@};; esac; done
s=$(grep -o 'SLEEP=[0-9]*' "$brief" | head -1 | cut -d= -f2)
r() { curl -sf -X POST -H "authorization: Bearer __TOKEN__" -H 'content-type: application/json' "http://127.0.0.1:__PORT__/api/tasks/$QA_TASK_ID/report" -d "$1" >/dev/null; }
r '{"status":"running","activity":"fake worker"}'
sleep "${s:-1}"
r '{"status":"done","summary":"fake worker finished."}'
sleep 2
P
sed -i.bak "s/__TOKEN__/$TOKEN/; s/__PORT__/$PORT/" "$ROOT/bin/pi" && rm -f "$ROOT/bin/pi.bak" && chmod +x "$ROOT/bin/pi"
start

# 1. one-shot --in 5s dispatches a task (same path as POST /api/tasks), source = cron
once=$(Q cron add --in 5s --cwd "$ROOT/work" once "SLEEP=1 one-shot run" | grep -o 's[0-9a-f]\{4\}' | head -1)
[ -n "$once" ] || fail "cron add --in failed"
[ "$(job "$once" .nextRunAt)" != null ] || fail "no nextRunAt"
waitfor '[ "$(job "$once" ".runs[0].taskId // empty")" ]' 15 || fail "--in 5s did not dispatch"
t1=$(job "$once" ".runs[0].taskId")
[ "$(task "$t1" .source.kind)" = cron ] && [ "$(task "$t1" .source.cronId)" = "$once" ] || fail "task source is not cron/$once"
waitfor '[ "$(task "$t1" .status)" = done ]' 15 || fail "one-shot task did not finish"
[ "$(task "$t1" .unread)" = true ] || fail "normal run should wait in 待扫 (unread)"
[ "$(job "$once" .finished)" = true ] && [ "$(job "$once" .nextRunAt)" = null ] || fail "one-shot not finished"
ok "--in 5s dispatched $t1 (source cron/$once), done -> 待扫, job finished"

# 2. silent: success is archived right away
sil=$(Q cron add --in 2s --silent --cwd "$ROOT/work" quiet "SLEEP=1 silent run" | grep -o 's[0-9a-f]\{4\}' | head -1)
waitfor '[ "$(job "$sil" ".runs[0].taskId // empty")" ]' 10 || fail "silent job did not fire"
t2=$(job "$sil" ".runs[0].taskId")
waitfor '[ "$(task "$t2" .status)" = done ]' 15 || fail "silent task did not finish"
[ "$(task "$t2" .unread)" = false ] || fail "silent success should be archived (unread=false)"
ok "--silent: done run $t2 archived (not unread)"

# 3. --every 10s with a run longer than the interval: overlap -> skip
rep=$(Q cron add --every 10s --cwd "$ROOT/work" repeat "SLEEP=14 long run" | grep -o 's[0-9a-f]\{4\}' | head -1)
waitfor '[ "$(job "$rep" "[.runs[]|select(.result==\"skipped\")]|length")" -ge 1 ]' 30 || fail "overlap did not skip"
[ "$(job "$rep" "[.runs[]|select(.result==\"dispatched\")]|length")" = 1 ] || fail "overlapping run was dispatched"
[ "$(job "$rep" .running)" = true ] || fail "job should report running"
ok "--every 10s: second slot skipped while the first run is still in progress"

# 4. pause: no more triggers
Q cron pause "$rep" | grep -q '\[OFF\]' || fail "pause output"
n=$(job "$rep" ".runs|length")
sleep 12
[ "$(job "$rep" ".runs|length")" = "$n" ] && [ "$(job "$rep" .nextRunAt)" = null ] || fail "paused job still fired"
ok "paused job did not fire for 12s"

# 5. hub restart: jobs persist; missed slots are caught up once (catch-up latest) or skipped (catch-up skip)
rec=$(Q cron add --every 6s --cwd "$ROOT/work" recover "SLEEP=1 recover" | grep -o 's[0-9a-f]\{4\}' | head -1)
noc=$(Q cron add --every 6s --catch-up skip --cwd "$ROOT/work" nocatch "SLEEP=1 no catch-up" | grep -o 's[0-9a-f]\{4\}' | head -1)
waitfor '[ "$(job "$rec" ".runs|length")" -ge 1 ]' 10 || fail "recover job did not fire"
waitfor '[ "$(job "$rec" .running)" = false ] && [ "$(job "$noc" .running)" = false ]' 10 || fail "first runs did not finish"
stop || fail "hub did not stop"
sleep 14 # >= 2 slots of each job missed
start
waitfor '[ "$(job "$rec" "[.runs[]|select(.trigger==\"catchup\")]|length")" = 1 ]' 6 || fail "missed run not caught up"
[ "$(job "$noc" "[.runs[]|select(.result==\"missed\")]|length")" = 1 ] || fail "catch-up skip did not record a missed run"
[ "$(job "$noc" "[.runs[]|select(.trigger==\"catchup\")]|length")" = 0 ] || fail "catch-up skip still caught up"
ok "after restart: $rec caught up once ($(job "$rec" '.runs[]|select(.trigger=="catchup")|.reason')), $noc recorded the miss without running"
[ "$(job "$rep" .enabled)" = false ] || fail "pause state lost on restart"
[ "$(job "$once" .runCount)" = 1 ] && [ "$(job "$once" .finished)" = true ] || fail "one-shot fired again after restart"
c=$(job "$rec" "[.runs[]|select(.trigger==\"schedule\")]|length")
waitfor '[ "$(job "$rec" "[.runs[]|select(.trigger==\"schedule\")]|length")" -gt "$c" ]' 10 || fail "schedule did not continue after restart"
ok "restart kept state (paused stays paused, one-shot not re-fired) and the schedule continues"

# 6. run now / resume / rm / ls
Q cron run "$rep" | grep -q -- '-> t' || fail "cron run"
Q cron resume "$rep" | grep -q '\[\(ON\|RUN\)\]' || fail "resume"
[ "$(job "$rep" .nextRunAt)" != null ] || fail "resume did not schedule"
for j in "$rec" "$noc" "$rep"; do Q cron rm "$j" >/dev/null || fail "rm $j"; done
Q cron ls -a | grep -q "$rec" && fail "deleted job still listed"
api /api/cron | jq -e '.jobs|length==2' >/dev/null || fail "expected 2 remaining (finished) jobs"
ok "run now, resume, rm, ls"

down
echo "ALL PASSED"
