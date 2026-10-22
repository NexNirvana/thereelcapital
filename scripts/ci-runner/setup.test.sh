#!/usr/bin/env bash
# Checks what `setup.sh --dry-run` would install: the generated service and the order of the
# privileged actions. No root, network or sudo.
#
#   scripts/ci-runner/setup.test.sh
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
out="$("${here}/setup.sh" --count 2 --dry-run 2>&1)"

fail=0
check() { # name, command that must succeed
  local name="$1"
  shift
  if "$@"; then echo "ok   ${name}"; else echo "FAIL ${name}"; fail=1; fi
}
has() { grep -qE "$1" <<<"$out"; }

check "service runs runsvc.sh, not run.sh" has 'command="/var/lib/ghrunner/runners/2/bin/runsvc\.sh"'
check "service never runs run.sh" bash -c '! grep -q "run\.sh\"" <<<"$1"' _ "$out"
check "setup never removes _work" bash -c '! grep -qE "rm -rf|find .*_work" <<<"$1"' _ "$out"

# Per runner: stop, TERM, KILL, then start, in that order.
order="$(grep -nE '^\[dry-run\] (rc-service gh-runner-1 (stop|start)|kill -(TERM|KILL) <processes of runner 1>)$' <<<"$out" |
  sed -E 's/^[0-9]+:\[dry-run\] //' | tr '\n' ';')"
check "runner 1: stop, TERM, KILL, then start" \
  test "$order" = "rc-service gh-runner-1 stop;kill -TERM <processes of runner 1>;kill -KILL <processes of runner 1>;rc-service gh-runner-1 start;"
exit "$fail"
