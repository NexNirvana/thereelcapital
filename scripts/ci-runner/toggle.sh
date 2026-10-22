#!/usr/bin/env bash
# Switches CI between the owner's machine and GitHub-hosted runners. No sudo.
#
#   scripts/ci-runner/toggle.sh on|off
#
# "off" deletes the CI_RUNNER repository variable, so every job runs on GitHub.
# Use it whenever the machine will be off; otherwise jobs wait for an offline runner.
# "on" refuses unless ci.yml on main keeps fork pull requests off the runners.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "${here}/lib.sh"

case "${1:-}" in
  on)
    ci_yml="$(gh api "repos/${REPO}/contents/.github/workflows/ci.yml" --jq .content | base64 -d)"
    grep -q 'head\.repo\.full_name' <<<"$ci_yml" ||
      die "ci.yml on main does not gate fork pull requests yet; not switching on"
    # deploy holds the Cloudflare secret and runs on push, so it must not use CI_RUNNER.
    if awk '/^  deploy:/{d=1;next} /^  [A-Za-z0-9_-]+:/{d=0} d' <<<"$ci_yml" | grep -q 'CI_RUNNER'; then
      die "ci.yml on main still runs deploy on CI_RUNNER; not switching on"
    fi
    gh variable set CI_RUNNER --repo "$REPO" --body '["self-hosted","reel-local"]'
    ;;
  off)
    # Only an absent variable is fine; any other failure must surface.
    if gh variable list --repo "$REPO" --json name --jq '.[].name' | grep -qx CI_RUNNER; then
      gh variable delete CI_RUNNER --repo "$REPO"
    else
      echo "CI_RUNNER was not set"
    fi
    ;;
  *) echo "usage: toggle.sh on|off" >&2; exit 1 ;;
esac
