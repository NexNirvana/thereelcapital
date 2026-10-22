#!/usr/bin/env bash
# Runs toggle.sh against a fake `gh` on PATH. No network, no sudo.
#
#   scripts/ci-runner/toggle.test.sh
set -euo pipefail

command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# The fake answers the three calls toggle.sh makes and records variable writes.
cat >"${work}/gh" <<'FAKE'
#!/usr/bin/env bash
case "$*" in
  *contents/.github/workflows/ci.yml*) echo 'head.repo.full_name' | base64 ;;
  *actions/runners*) # apply the caller'"'"'s own --jq filter to the fixture
    while [ $# -gt 0 ] && [ "$1" != --jq ]; do shift; done
    jq -r "$2" "$FIXTURE" ;;
  "variable set"*) echo "$*" >>"$SET_LOG" ;;
  "variable list"*)
    [ "${FAKE_GH_FAIL:-}" = variable-list ] && { echo 'HTTP 403' >&2; exit 1; }
    printf '%s' "${FAKE_GH_VALUE:-}" ;;
esac
FAKE
chmod +x "${work}/gh"
export PATH="${work}:${PATH}" SET_LOG="${work}/set.log" FIXTURE="${work}/runners.json"

fail=0
expect() { # name, expected exit ("ok"|"refuse"), expected var writes
  local name="$1" want="$2" writes="$3" code=0 got=0
  : >"$SET_LOG"
  "${here}/toggle.sh" on >"${work}/out" 2>&1 || code=$?
  got="$(grep -c . "$SET_LOG" || true)"
  if { [ "$want" = ok ] && [ "$code" -eq 0 ]; } || { [ "$want" = refuse ] && [ "$code" -ne 0 ]; }; then
    [ "$got" -eq "$writes" ] && { echo "ok   $name"; return; }
  fi
  echo "FAIL $name (exit ${code}, writes ${got})"; cat "${work}/out"; fail=1
}

echo '{"runners":[]}' >"$FIXTURE"
expect "no runners: refuses" refuse 0

echo '{"runners":[{"name":"reel-local-1 online","status":"offline","busy":false,"labels":[{"name":"reel-local"}]},{"name":"other","status":"online","busy":false,"labels":[{"name":"x"}]}]}' >"$FIXTURE"
expect "offline reel-local only: refuses" refuse 0

echo '{"runners":[{"name":"reel-local-1","status":"offline","busy":false,"labels":[{"name":"reel-local"}]},{"name":"reel-local-2","status":"online","busy":true,"labels":[{"name":"reel-local"}]}]}' >"$FIXTURE"
expect "one online: sets the variable" ok 1

out="$("${here}/toggle.sh" status)"
grep -q '^  online'$'\t''reel-local-2'$'\t''busy=true' <<<"$out" || { echo "FAIL status"; fail=1; }
out="$(FAKE_GH_VALUE='["self-hosted","reel-local"]' "${here}/toggle.sh" status)"
grep -q 'self-hosted' <<<"$out" || { echo "FAIL status prints the variable"; fail=1; }
for cmd in status off; do
  if FAKE_GH_FAIL=variable-list "${here}/toggle.sh" "$cmd" >/dev/null 2>&1; then
    echo "FAIL ${cmd} must fail when gh variable list fails"; fail=1
  else
    echo "ok   ${cmd}: gh failure surfaces"
  fi
done
exit "$fail"
