#!/usr/bin/env bash
# The full gate. Static checks, then 56 browser-driven assertions against both
# backends. The analogue of `pnpm lint && pnpm check && pnpm test:ci`.
set -uo pipefail
cd "$(dirname "$0")"
FAIL=0
step() { printf "\n\033[1m%s\033[0m\n" "$1"; }
ok()   { [ "$1" -eq 0 ] && echo "  ok" || { echo "  FAILED"; FAIL=1; }; }

step "1/6  gofmt"
test -z "$(gofmt -l go/)" ; ok $?

step "2/6  go vet + build"
( cd go && go vet ./... && go build -o /tmp/check-port-go . ) ; ok $?

step "3/6  tsc --noEmit"
( cd ts && bunx tsc --noEmit ) ; ok $?

step "4/6  check-datastar (the attribute layer Datastar does not check)"
bun check-datastar.mjs ; ok $?

step "5/6  booting both backends"
DB_GO=$(mktemp -u /tmp/chk-go-XXXX.db); DB_TS=$(mktemp -u /tmp/chk-ts-XXXX.db)
SHARED="$PWD/shared"
( cd go && PORT=8102 LAB_DB="$DB_GO" LAB_SHARED="$SHARED" /tmp/check-port-go ) >/tmp/chk-go.log 2>&1 &
GO_PID=$!
( cd ts && PORT=8103 LAB_DB="$DB_TS" LAB_SHARED="$SHARED" LAB_DEV_OTP=1 bun server.ts ) >/tmp/chk-ts.log 2>&1 &
TS_PID=$!
cleanup() { kill $GO_PID $TS_PID 2>/dev/null; rm -f "$DB_GO" "$DB_TS"; }
trap cleanup EXIT
for i in $(seq 1 40); do
  curl -sf -o /dev/null http://localhost:8102/login && curl -sf -o /dev/null http://localhost:8103/login && break
  sleep 0.25
done
curl -sf -o /dev/null http://localhost:8102/login && curl -sf -o /dev/null http://localhost:8103/login ; ok $?

# The Go port is FROZEN at four features (see PLAN.md). These four suites still
# run against it, so it cannot silently rot; new suites are TypeScript-only.
BOTH_SUITES="verify-port verify-auth verify-scan verify-embed"
TS_ONLY_SUITES=$(ls verify-*.mjs 2>/dev/null | sed 's/\.mjs$//' | grep -vE "^(verify-port|verify-auth|verify-scan|verify-embed)$" | tr '\n' ' ')

step "6/6  browser suites (Go: 4 frozen suites · TypeScript: all)"
for suite in $BOTH_SUITES; do
  for pair in "Go:8102" "TS:8103"; do
    name=${pair%%:*}; port=${pair##*:}
    printf "  %-14s %-3s " "$suite" "$name"
    if out=$(bun "$suite.mjs" "http://localhost:$port" "/tmp/chk-$suite-$name.png" 2>&1); then
      echo "$(grep -c PASS <<<"$out") passed"
    else
      echo "FAILED"; grep -E "FAIL|CRASH|problem" <<<"$out" | sed 's/^/      /'; FAIL=1
    fi
  done
done
for suite in $TS_ONLY_SUITES; do
  printf "  %-16s TS  " "$suite"
  if out=$(bun "$suite.mjs" "http://localhost:8103" "/tmp/chk-$suite-TS.png" 2>&1); then
    echo "$(grep -c PASS <<<"$out") passed"
  else
    echo "FAILED"; grep -E "FAIL|CRASH|problem" <<<"$out" | sed 's/^/      /'; FAIL=1
  fi
done

printf "\n\033[1m%s\033[0m\n" "$([ $FAIL -eq 0 ] && echo "All checks passed." || echo "Checks FAILED.")"
exit $FAIL
