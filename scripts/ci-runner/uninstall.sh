#!/usr/bin/env bash
# Stops and deregisters every runner and deletes the runner user and its files.
#
#   sudo scripts/ci-runner/uninstall.sh [--dry-run]
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "${here}/lib.sh"

case "${1:-}" in
  '') ;;
  --dry-run) DRY_RUN=1 ;;
  *) die "usage: uninstall.sh [--dry-run]" ;;
esac

require_root_via_sudo
[ "$DRY_RUN" -eq 1 ] || command -v gh >/dev/null || die "gh is required"

shopt -s nullglob
for dir in "${RUNNERS_DIR}"/*/; do
  dir="${dir%/}"
  n="${dir##*/}"
  log "removing runner reel-local-${n}"
  if ! run rc-service "gh-runner-${n}" stop; then
    # An already-stopped service is fine; a live runner process is not.
    ! pgrep -u "$RUNNER_USER" -f "${dir}/" >/dev/null || die "runner ${n} is still running; stop it and retry"
  fi
  run rc-update del "gh-runner-${n}" default || true
  if [ -f "${dir}/.runner" ]; then
    if token="$(fetch_runner_token remove)"; then
      as_runner "$dir" ./config.sh remove --token "$token" ||
        log "could not deregister reel-local-${n}; delete it under Settings > Actions > Runners"
    else
      log "no removal token for reel-local-${n}; delete it under Settings > Actions > Runners"
    fi
  fi
  run rm -f "${INIT_DIR}/gh-runner-${n}" "${LOG_DIR}/gh-runner-${n}.log"
done

if id "$RUNNER_USER" >/dev/null 2>&1; then
  run userdel --remove "$RUNNER_USER" || die "could not delete user ${RUNNER_USER}; finish by hand"
fi
run rm -rf "$RUNNER_HOME" "$CACHE_DIR"
log "done; also run scripts/ci-runner/toggle.sh off if you have not"
