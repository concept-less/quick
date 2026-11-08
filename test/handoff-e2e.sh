#!/usr/bin/env bash
# End-to-end handoff test between two isolated hubs on this machine (uses a real, cheap worker model).
#   test/handoff-e2e.sh            # sets up /tmp/qa-ho, runs A→B, B→A, a failing handoff (rollback), tears down
# Never touches the real hub (~/.quick-agent) or its tmux session.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT=${QA_HO_ROOT:-/tmp/qa-ho}
export QA_HO_ROOT=$ROOT
source "$HERE/handoff-env.sh" vars
set +e
fail() { echo "FAIL: $*"; exit 1; }
ok() { echo "ok - $*"; }
wsfp() { (cd "$1" && git ls-files -co --exclude-standard | sort | while read -r f; do
	if [ -L "$f" ]; then echo "L $(readlink "$f") $f"; elif [ -e "$f" ]; then echo "$(sha256sum "$f" | cut -c1-16) $(stat -c %a "$f") $f"; fi; done
	git write-tree; git rev-parse HEAD; git symbolic-ref -q HEAD); }
waitfor() { for _ in $(seq 1 "$2"); do eval "$1" && return 0; sleep 2; done; return 1; }

"$HERE/handoff-env.sh" down >/dev/null 2>&1; rm -rf "$ROOT"; mkdir -p "$ROOT/A/proj"
(cd "$ROOT/A/proj" && git init -q -b main && git config user.email t@t && git config user.name t &&
	printf 'one\n' > a.txt && printf 'keep\n' > b.txt && mkdir sub && echo s > sub/s.txt && echo 'node_modules/' > .gitignore &&
	git add -A && git commit -qm init)
QA_TEST_HOOKS=1 "$HERE/handoff-env.sh" up >/dev/null || fail "hubs did not start"

A new --cwd "$ROOT/A/proj" "e2e" "测试任务。记住暗号 PINEAPPLE-42。不要修改文件、不要运行命令，直接 qa_report status=done summary='记住了'。" >/dev/null
id=$(A ls -a | grep -o 't[0-9a-f]\{4\}' | head -1)
waitfor '[ "$(A ls -a | grep -c "done")" -ge 1 ]' 60 || fail "worker did not finish"
ok "task $id done on ma"

# uncommitted work: staged, unstaged, deletion, untracked, symlink, ignored dir
(cd "$ROOT/A/proj" && echo st >> b.txt && git add b.txt && echo un >> b.txt && echo wt >> a.txt && git rm -q sub/s.txt &&
	echo "note MANGO-7" > notes.txt && ln -s a.txt link && mkdir -p node_modules && echo j > node_modules/j.js)
A handoff "$id" mb || fail "handoff A→B"
diff <(wsfp "$ROOT/A/proj") <(wsfp "$ROOT/B/proj") >/dev/null || fail "workspace differs"
ok "workspace identical (hash, mode, index tree, HEAD, branch)"
sa=$(ls "$ROOT"/piA/sessions/--*-A-proj--/*.jsonl); sb=$(ls "$ROOT"/piB/sessions/--*-B-proj--/*.jsonl)
diff <(tail -n +2 "$sa") <(tail -n +2 "$sb") >/dev/null || fail "session body differs"
head -1 "$sb" | grep -q "\"cwd\":\"$ROOT/B/proj\"" || fail "session header cwd not rewritten"
ok "session history identical, header cwd rewritten"
B show "$id" | grep -q "created e2e" || fail "events lost"
tmux list-windows -t "=qa-hoA" -F '#W' | grep -qx "$id" && fail "source window still open"
ok "id + events kept, source window closed"

B send "$id" "暗号是什么？notes.txt 的内容是什么？用 qa_report done 汇报，summary 包含两者。" >/dev/null
waitfor 'B show "$id" | grep -q "MANGO-7" && B show "$id" | grep -q "PINEAPPLE-42"' 60 || fail "resumed worker lost history or workspace"
ok "resumed worker on mb sees full history and workspace"

A handoff "$id" ma || fail "handoff B→A"
diff <(wsfp "$ROOT/A/proj") <(wsfp "$ROOT/B/proj") >/dev/null || fail "workspace differs after hand back"
ok "handed back to ma (leftover state on ma recognised and replaced)"

before=$(cd "$ROOT/B/proj" && git status --porcelain; git stash list)
A handoff "$id" mb --test-fail verify && fail "handoff with corrupted target should fail"
A ls -a | grep "$id" | grep -q "@" && fail "task left ma after failed handoff"
after=$(cd "$ROOT/B/proj" && git status --porcelain; git stash list)
[ "$before" = "$after" ] || fail "target not restored after failed handoff"
A send "$id" "回复 STILL-HERE，qa_report done。" >/dev/null
waitfor 'A show "$id" | grep -q "STILL-HERE"' 60 || fail "task not usable after rollback"
ok "failed handoff rolled back; target restored; task still usable on ma"

[ "${KEEP:-}" ] || "$HERE/handoff-env.sh" down >/dev/null
echo "ALL PASSED"
