# Shared by setup.sh and uninstall.sh (sourced, not executed).
# shellcheck shell=bash
# shellcheck disable=SC2034

REPO="NexNirvana/thereelcapital"
REPO_URL="https://github.com/${REPO}"
RUNNER_USER="ghrunner"
RUNNER_HOME="/var/lib/ghrunner"
CACHE_DIR="/opt/gh-runner"
LOG_DIR="/var/log"
RUNNERS_DIR="${RUNNER_HOME}/runners"
INIT_DIR="/etc/init.d"
DRY_RUN=0

log() { printf '==> %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

# Runs a privileged action, or only prints it in --dry-run mode.
run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '[dry-run] %q' "$1"
    shift
    printf ' %q' "$@"
    printf '\n'
  else
    "$@"
  fi
}

# Writes stdin to a root-owned file with the given mode.
write_file() {
  local path="$1" mode="$2"
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '[dry-run] write %s (mode %s):\n' "$path" "$mode"
    sed 's/^/    | /'
  else
    cat >"$path"
    chmod "$mode" "$path"
  fi
}

# Runs a command as the runner user, with its own HOME and the given directory.
as_runner() {
  local dir="$1"
  shift
  run env -C "$dir" runuser -u "$RUNNER_USER" -- env "HOME=${RUNNER_HOME}" "$@"
}

require_root_via_sudo() {
  if [ "$DRY_RUN" -eq 1 ]; then
    return
  fi
  [ "$(id -u)" -eq 0 ] || die "run this script with sudo"
  [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != root ] ||
    die "run it through sudo from the owner's account (SUDO_USER is needed to call gh)"
}

# Fetches a short-lived runner token ("registration" or "remove") as the invoking
# user, so the runner user never holds a GitHub admin token.
fetch_runner_token() {
  local kind="$1"
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '[dry-run] sudo -u <owner> gh api -X POST repos/%s/actions/runners/%s-token\n' "$REPO" "$kind" >&2
    printf 'DRY-RUN-TOKEN'
    return
  fi
  sudo -u "$SUDO_USER" -H gh api -X POST "repos/${REPO}/actions/runners/${kind}-token" --jq .token
}
