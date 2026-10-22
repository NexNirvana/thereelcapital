#!/usr/bin/env bash
# Installs N self-hosted GitHub Actions runners for NexNirvana/thereelcapital
# under a separate unprivileged user. Run by the owner with sudo; idempotent.
#
#   sudo scripts/ci-runner/setup.sh [--count N] [--dry-run]
#
# See CONTRIBUTING.md#self-hosted-runner for the safety model.
set -euo pipefail

# Pinned official release (https://github.com/actions/runner/releases/tag/v2.338.0).
# The runner updates itself after registration; the pin covers the first install.
RUNNER_VERSION="2.338.0"
RUNNER_SHA256="af4b794c1bc41d73d40535e3fe092a39f9679cd8d965954c2aca25a05ca41d32"
RUNNER_TARBALL="actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz"
RUNNER_URL="https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/${RUNNER_TARBALL}"
COUNT=4

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "${here}/lib.sh"
# Only fetch_runner_token may use the owner's token (lib.sh keeps it in OWNER_GH_TOKEN).
unset GH_TOKEN

while [ $# -gt 0 ]; do
  case "$1" in
    --count) [ $# -ge 2 ] || die "--count needs a value"; COUNT="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    *) die "usage: setup.sh [--count N] [--dry-run]" ;;
  esac
done
case "$COUNT" in
  '' | *[!0-9]* | 0) die "--count must be a positive integer" ;;
esac

# Libraries Playwright's chromium and the runner itself need on Arch-like systems.
check_prerequisites() {
  command -v pacman >/dev/null || { log "pacman not found; skipping the library check"; return; }
  local missing
  missing="$(pacman -T git jq curl tar icu openssl krb5 zlib nss nspr atk at-spi2-core cups \
    libdrm libxkbcommon libxcomposite libxdamage libxrandr mesa pango cairo alsa-lib \
    libx11 libxext libxfixes libxcb dbus glib2 | tr '\n' ' ')" || true
  if [ -n "$missing" ]; then
    log "missing system packages; install them first:"
    printf '    sudo pacman -S --needed %s\n' "$missing"
    [ "$DRY_RUN" -eq 1 ] || die "install the packages above and run again"
  else
    log "system packages present"
  fi
}

create_user() {
  if id "$RUNNER_USER" >/dev/null 2>&1; then
    log "user ${RUNNER_USER} exists"
  else
    log "creating user ${RUNNER_USER}"
    run useradd --system --home-dir "$RUNNER_HOME" --create-home \
      --shell /usr/bin/nologin --user-group "$RUNNER_USER"
  fi
  run chmod 700 "$RUNNER_HOME"
  run install -d -m 700 -o "$RUNNER_USER" -g "$RUNNER_USER" "$RUNNERS_DIR"
}

download_runner() {
  local tarball="${CACHE_DIR}/${RUNNER_TARBALL}"
  run install -d -m 755 "$CACHE_DIR"
  if [ "$DRY_RUN" -eq 0 ] && [ -f "$tarball" ] &&
    echo "${RUNNER_SHA256}  ${tarball}" | sha256sum --check --status; then
    log "runner ${RUNNER_VERSION} already downloaded"
    return
  fi
  log "downloading runner ${RUNNER_VERSION}"
  run curl -fsSL --output "${tarball}.part" "$RUNNER_URL"
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '[dry-run] verify sha256 %s\n' "$RUNNER_SHA256"
  else
    echo "${RUNNER_SHA256}  ${tarball}.part" | sha256sum --check --status ||
      { rm -f "${tarball}.part"; die "SHA-256 mismatch for ${RUNNER_TARBALL}"; }
  fi
  run mv "${tarball}.part" "$tarball"
}

install_service() {
  local n="$1" dir="$2"
  write_file "${INIT_DIR}/gh-runner-${n}" 755 <<SERVICE
#!/usr/bin/openrc-run
description="GitHub Actions runner reel-local-${n}"
supervisor=supervise-daemon
command="${dir}/run.sh"
command_user="${RUNNER_USER}:${RUNNER_USER}"
directory="${dir}"
respawn_delay=5
respawn_max=0
output_log="${LOG_DIR}/gh-runner-${n}.log"
error_log="${LOG_DIR}/gh-runner-${n}.log"
export HOME="${RUNNER_HOME}"

depend() {
  need net
}

start_pre() {
  # Each start gets a clean workspace.
  find "${dir}/_work" -mindepth 1 -maxdepth 1 -exec rm -rf {} + 2>/dev/null || true
  # Cap the log: keep the last 1000 lines.
  if [ -f "\${output_log}" ]; then
    tail -n 1000 "\${output_log}" >"\${output_log}.tmp" && mv "\${output_log}.tmp" "\${output_log}"
  fi
  # The service opens its log as the runner user, which can't create or write a root-owned file in the
  # log dir; make it exist and belong to that user (also after the cap above replaced it).
  checkpath -f -o ${RUNNER_USER}:${RUNNER_USER} -m 0640 "\${output_log}"
}
SERVICE
}

setup_instance() {
  local n="$1" dir="${RUNNERS_DIR}/$1" token
  log "runner reel-local-${n}"
  if [ "$DRY_RUN" -eq 1 ] || [ ! -f "${dir}/config.sh" ]; then
    run install -d -m 700 -o "$RUNNER_USER" -g "$RUNNER_USER" "$dir"
    as_runner "$dir" tar xzf "${CACHE_DIR}/${RUNNER_TARBALL}" || return 1
  fi
  if [ "$DRY_RUN" -eq 1 ] || [ ! -f "${dir}/.runner" ]; then
    token="$(fetch_runner_token registration)" || return 1
    # self-hosted, linux and x64 are added by the runner itself.
    as_runner "$dir" ./config.sh --unattended --url "$REPO_URL" --token "$token" \
      --name "reel-local-${n}" --labels reel-local --work _work --replace || return 1
  else
    log "already registered"
  fi
  # The || return 1 guards matter: the caller runs this in an || context, where set -e is off.
  install_service "$n" "$dir" || return 1
  run rc-update add "gh-runner-${n}" default || return 1
  run rc-service "gh-runner-${n}" restart || return 1
}

require_root_via_sudo
[ "$DRY_RUN" -eq 1 ] || command -v gh >/dev/null || die "gh is required"
check_prerequisites
create_user
download_runner
failed=0
for n in $(seq 1 "$COUNT"); do
  # A failed instance must not stop the others; the summary reports it.
  setup_instance "$n" || { printf 'error: runner reel-local-%s failed to set up\n' "$n" >&2; failed=$((failed + 1)); }
done

stopped=0
for n in $(seq 1 "$COUNT"); do
  if [ -f "${RUNNERS_DIR}/${n}/.runner" ] || [ "$DRY_RUN" -eq 1 ]; then
    printf '    reel-local-%s registered: ' "$n"
  else
    printf '    reel-local-%s NOT registered: ' "$n"
  fi
  run rc-service "gh-runner-${n}" status || stopped=$((stopped + 1))
done
log "summary: $((COUNT - failed))/${COUNT} runners set up, ${stopped} service(s) not running"
if [ "$failed" -gt 0 ] || [ "$stopped" -gt 0 ]; then
  die "${failed} runner(s) failed to set up, ${stopped} service(s) not running; fix the errors above and run setup.sh again"
fi
log "done; confirm with scripts/ci-runner/toggle.sh status, then run scripts/ci-runner/toggle.sh on"
