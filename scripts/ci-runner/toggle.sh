#!/usr/bin/env bash
# Switches CI between the owner's machine and GitHub-hosted runners. No sudo.
#
#   scripts/ci-runner/toggle.sh on|off|status
#
# "off" deletes the CI_RUNNER repository variable, so every job runs on GitHub.
# Use it whenever the machine will be off; otherwise jobs wait for an offline runner.
# "on" refuses unless a reel-local runner is online, and unless ci.yml on main keeps fork pull requests off the runners.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "${here}/lib.sh"

# Prints "status<TAB>name<TAB>busy=..." for each runner labelled reel-local.
list_runners() {
  gh api "repos/${REPO}/actions/runners" --paginate \
    --jq '.runners[] | select(any(.labels[]; .name == "reel-local")) | "\(.status)\t\(.name)\tbusy=\(.busy)"'
}

case "${1:-}" in
  on)
    runners="$(list_runners)"
    online="$(grep -c '^online'$'\t' <<<"$runners" || true)"
    if [ "$online" -lt 1 ]; then
      die "no reel-local runner is online (found: $(grep -c . <<<"$runners" || true) registered); jobs would queue forever. Run: sudo scripts/ci-runner/setup.sh"
    fi
    echo "${online} reel-local runner(s) online"
    ci_yml="$(gh api "repos/${REPO}/contents/.github/workflows/ci.yml" --jq .content | base64 -d)"
    grep -q 'head\.repo\.full_name' <<<"$ci_yml" ||
      die "ci.yml on main does not gate fork pull requests yet; not switching on"
    # deploy holds the Cloudflare secret and runs on push, so it must not use CI_RUNNER.
    if awk '/^  deploy:/{d=1;next} /^  [A-Za-z0-9_-]+:/{d=0} d' <<<"$ci_yml" | grep -q 'CI_RUNNER'; then
      die "ci.yml on main still runs deploy on CI_RUNNER; not switching on"
    fi
    gh variable set CI_RUNNER --repo "$REPO" --body '["self-hosted","reel-local"]'
    echo "WARNING: CI now needs this machine on and the runners online." >&2
    echo "WARNING: if jobs queue, run: scripts/ci-runner/toggle.sh off" >&2
    ;;
  status)
    # Assigned first so a failed gh call trips set -e instead of reading as "unset".
    current="$(gh variable list --repo "$REPO" --json name,value --jq '.[] | select(.name == "CI_RUNNER") | .value')"
    echo "${current:-CI_RUNNER is not set (GitHub-hosted runners)}"
    echo "reel-local runners:"
    list_runners | sed 's/^/  /'
    ;;
  off)
    # Only an absent variable is fine; any other failure must surface.
    names="$(gh variable list --repo "$REPO" --json name --jq '.[].name')"
    if grep -qx CI_RUNNER <<<"$names"; then
      gh variable delete CI_RUNNER --repo "$REPO"
    else
      echo "CI_RUNNER was not set"
    fi
    ;;
  *) echo "usage: toggle.sh on|off|status" >&2; exit 1 ;;
esac
