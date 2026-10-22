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

# PIDs of the runner user's processes whose working directory is inside runner N's dir. The service
# host (node ./bin/RunnerService.js) and run-helper.sh are started with relative paths, so matching
# on the command line would miss them; the working directory does not. (The listener itself shows
# its absolute path in ps, which toggle.sh relies on; it needs no root.)
runner_pids() {
  local pid cwd
  for pid in $(pgrep -u "$RUNNER_USER" 2>/dev/null || true); do
    cwd="$(readlink "/proc/${pid}/cwd" 2>/dev/null)" || continue
    case "$cwd" in
      "${RUNNERS_DIR}/${1}" | "${RUNNERS_DIR}/${1}/"*) echo "$pid" ;;
    esac
  done
}

# Sends a signal to every process of runner N at once, so the service host cannot restart a listener
# that was just stopped.
signal_runner() {
  local sig="$1" n="$2" pids
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '[dry-run] kill -%s <processes of runner %s>\n' "$sig" "$n"
    return
  fi
  pids="$(runner_pids "$n")"
  # shellcheck disable=SC2086 # one word per pid
  [ -z "$pids" ] || kill "-${sig}" $pids 2>/dev/null || true
}

# Stops the service, then ends any process of that runner the service manager lost track of (an
# orphaned run-helper.sh or Runner.Listener keeps its registration and takes jobs).
stop_runner() {
  local n="$1"
  run rc-service "gh-runner-${n}" stop || true
  signal_runner TERM "$n"
  run sleep 3
  signal_runner KILL "$n"
  run sleep 1
  [ "$DRY_RUN" -eq 1 ] || [ -z "$(runner_pids "$n")" ] || die "runner ${n} still has processes after SIGKILL; stop them by hand"
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
# The owner's gh token, if given as GH_TOKEN. setup.sh and uninstall.sh then unset GH_TOKEN, so
# nothing they spawn (config.sh runs as ghrunner) inherits it; toggle.sh keeps it for its own gh calls.
OWNER_GH_TOKEN="${GH_TOKEN:-}"

fetch_runner_token() {
  local kind="$1"
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '[dry-run] sudo -u <owner> gh api -X POST repos/%s/actions/runners/%s-token\n' "$REPO" "$kind" >&2
    printf 'DRY-RUN-TOKEN'
    return
  fi
  # gh keeps its token in the desktop keyring for many owners, and `sudo -u` has no session bus to
  # reach it; the owner can pass it as GH_TOKEN. setup.sh and uninstall.sh removed it from the
  # environment, so only this gh call sees it, and never on a command line.
  if [ -n "$OWNER_GH_TOKEN" ]; then
    GH_TOKEN="$OWNER_GH_TOKEN" sudo -u "$SUDO_USER" -H --preserve-env=GH_TOKEN \
      gh api -X POST "repos/${REPO}/actions/runners/${kind}-token" --jq .token
  else
    sudo -u "$SUDO_USER" -H gh api -X POST "repos/${REPO}/actions/runners/${kind}-token" --jq .token
  fi
}
