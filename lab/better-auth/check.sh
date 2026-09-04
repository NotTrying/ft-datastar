#!/usr/bin/env bash
# The better-auth experiment's gate. Same shape as ../port/check.sh: a fresh
# database every run, because a suite that passes only on a virgin database is
# a suite that will pass once and then lie.
set -uo pipefail
cd "$(dirname "$0")"
FAIL=0
step() { printf "\n\033[1m%s\033[0m\n" "$1"; }
ok()   { [ "$1" -eq 0 ] && echo "  ok" || { echo "  FAILED"; FAIL=1; }; }

step "1/4  tsc --noEmit"
bunx tsc --noEmit ; ok $?

step "2/4  schema, migrated from the installed library (not the CLI)"
DB=$(mktemp -u /tmp/chk-ba-XXXX.db)
export LAB_DB="$DB"
bun migrate.ts >/dev/null && bun seed.ts >/dev/null ; ok $?

step "3/4  booting"
PORT=8104 bun server.ts >/tmp/chk-ba.log 2>&1 &
PID=$!
cleanup() { kill $PID 2>/dev/null; rm -f "$DB" "$DB"-shm "$DB"-wal; }
trap cleanup EXIT
for i in $(seq 1 40); do curl -sf -o /dev/null http://localhost:8104/login && break; sleep 0.25; done
curl -sf -o /dev/null http://localhost:8104/login ; ok $?

step "4/4  browser suite"
if out=$(NODE_PATH=/opt/node22/lib/node_modules bun verify-better-auth.mjs http://localhost:8104 /tmp/chk-ba.png 2>&1); then
  echo "  $(grep -c PASS <<<"$out") passed"
else
  echo "  FAILED"; grep -E "FAIL|CRASH|problem|JS errors" -A 3 <<<"$out" | sed 's/^/    /'; FAIL=1
fi

printf "\n"
[ $FAIL -eq 0 ] && echo "All green." || echo "Problems above."
exit $FAIL
