#!/usr/bin/env bash
set -Eeuo pipefail

umask 022

DESTDIR=${DESTDIR:-}
INSTALL_DIR=/opt/zashboard-helper
ENV_FILE=/etc/zashboard-helper/zashboard-helper.env
SERVICE_FILE=/etc/systemd/system/zashboard-helper.service
UI_DIR=/usr/share/zashboard
REMOVE_UI=0
PURGE_CONFIG=0
NO_STOP=0

log() {
  printf '[zashboard] %s\n' "$*"
}

fail() {
  printf '[zashboard] ERROR: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Remove files created by deploy/install.sh.

Usage: sudo bash deploy/uninstall.sh [options]

  --remove-ui       Move the installer-managed UI into /var/backups/zashboard
  --purge-config    Remove the Helper environment file
  --ui-dir DIR      UI path used at installation (default: /usr/share/zashboard)
  --no-stop         Do not call systemctl (required with --destdir)
  --destdir DIR     Operate on a staged filesystem below DIR
  --help            Show this help

Mihomo config, providers, managed custom rules, and UI backups are never deleted.
The Helper environment is preserved unless --purge-config is supplied.
EOF
}

need_value() {
  (($# >= 2)) || fail "$1 requires a value"
}

while (($#)); do
  case "$1" in
    --remove-ui) REMOVE_UI=1; shift ;;
    --purge-config) PURGE_CONFIG=1; shift ;;
    --ui-dir) need_value "$@"; UI_DIR=$2; shift 2 ;;
    --no-stop) NO_STOP=1; shift ;;
    --destdir) need_value "$@"; DESTDIR=$2; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) fail "unknown option: $1" ;;
  esac
done

case "$UI_DIR" in
  /*) ;;
  *) fail "UI directory must be an absolute path" ;;
esac
[[ "$UI_DIR" != / ]] || fail "UI directory cannot be /"
[[ "$UI_DIR" != *$'\n'* && "$UI_DIR" != *$'\r'* ]] || fail "UI directory contains a newline"
case "$UI_DIR" in
  /bin|/boot|/dev|/etc|/home|/lib|/lib64|/opt|/proc|/root|/run|/sbin|/srv|/sys|/tmp|/usr|/usr/bin|/usr/lib|/usr/lib64|/usr/local|/usr/local/bin|/usr/local/lib|/usr/sbin|/usr/share|/var|/var/lib|/var/log|/var/tmp)
    fail "UI directory cannot be a system root: $UI_DIR"
    ;;
esac

fs_path() {
  printf '%s%s' "$DESTDIR" "$1"
}

if [[ -n "$DESTDIR" ]]; then
  DESTDIR=$(cd -- "$DESTDIR" 2>/dev/null && pwd -P) || fail "staging directory not found"
  ((NO_STOP == 1)) || fail "--destdir requires --no-stop"
elif ((EUID != 0)); then
  fail "run as root, or use --destdir with --no-stop for staging"
fi

INSTALL_ROOT=$(fs_path "$INSTALL_DIR")
ENV_TARGET=$(fs_path "$ENV_FILE")
ENV_MARKER_TARGET=$(fs_path "/etc/zashboard-helper/.zashboard-managed")
SERVICE_TARGET=$(fs_path "$SERVICE_FILE")
UI_TARGET=$(fs_path "$UI_DIR")
MANAGED_MARKER=.zashboard-managed

SERVICE_IS_MANAGED=0
if [[ -f "$SERVICE_TARGET" ]] && grep -Fq 'Managed by zashboard public installer' "$SERVICE_TARGET"; then
  SERVICE_IS_MANAGED=1
fi

if [[ -e "$SERVICE_TARGET" && $SERVICE_IS_MANAGED -ne 1 ]]; then
  fail "$SERVICE_FILE is not managed by this installer; refusing to remove it"
fi
if [[ -e "$INSTALL_ROOT" && ! -f "$INSTALL_ROOT/$MANAGED_MARKER" ]]; then
  fail "$INSTALL_DIR is not managed by this installer; refusing to remove it"
fi
if ((PURGE_CONFIG == 1)) && [[ -e "$ENV_TARGET" && ! -f "$ENV_MARKER_TARGET" && ! -f "$INSTALL_ROOT/$MANAGED_MARKER" ]]; then
  fail "$ENV_FILE is not managed by this installer; refusing to remove it"
fi
if ((REMOVE_UI == 1)) && [[ -e "$UI_TARGET" && ! -f "$UI_TARGET/$MANAGED_MARKER" ]]; then
  fail "$UI_DIR is not managed by this installer; refusing to move it"
fi

if ((NO_STOP == 0 && SERVICE_IS_MANAGED == 1)); then
  systemctl disable --now zashboard-helper.service || true
fi

if [[ -e "$SERVICE_TARGET" ]]; then
  rm -f -- "$SERVICE_TARGET"
fi

if [[ -e "$INSTALL_ROOT" ]]; then
  rm -rf -- "$INSTALL_ROOT"
fi

if ((REMOVE_UI == 1)) && [[ -e "$UI_TARGET" ]]; then
  BACKUP_ROOT=$(fs_path /var/backups/zashboard)
  mkdir -p -- "$BACKUP_ROOT"
  UI_BACKUP=$BACKUP_ROOT/uninstalled-ui-$(date -u +%Y%m%dT%H%M%SZ)
  BACKUP_SUFFIX=0
  while [[ -e "$UI_BACKUP" ]]; do
    BACKUP_SUFFIX=$((BACKUP_SUFFIX + 1))
    UI_BACKUP=$BACKUP_ROOT/uninstalled-ui-$(date -u +%Y%m%dT%H%M%SZ)-$BACKUP_SUFFIX
  done
  mv -- "$UI_TARGET" "$UI_BACKUP"
  log "moved UI to ${UI_BACKUP#$DESTDIR}"
fi

if ((PURGE_CONFIG == 1)); then
  rm -f -- "$ENV_TARGET" "$ENV_MARKER_TARGET"
  rmdir --ignore-fail-on-non-empty -- "$(dirname -- "$ENV_TARGET")" 2>/dev/null || true
else
  [[ ! -f "$ENV_TARGET" ]] || log "preserved $ENV_FILE"
fi

if ((NO_STOP == 0)); then
  systemctl daemon-reload
fi

log "uninstalled Local Helper files"
log "Mihomo config, providers, custom rules, and backups were preserved"
