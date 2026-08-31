#!/usr/bin/env bash
set -Eeuo pipefail

umask 022

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
SOURCE_DIR=$(cd -- "$SCRIPT_DIR/.." && pwd -P)
DESTDIR=${DESTDIR:-}
INSTALL_DIR=/opt/zashboard-helper
ENV_FILE=/etc/zashboard-helper/zashboard-helper.env
SERVICE_FILE=/etc/systemd/system/zashboard-helper.service
UI_DIR=/usr/share/zashboard
MIHOMO_CONFIG_PATH=${MIHOMO_CONFIG_PATH:-}
MIHOMO_BINARY=${MIHOMO_BINARY:-}
MIHOMO_RULES_DIR=${MIHOMO_RULES_DIR:-}
MIHOMO_CUSTOM_RULES_DIR=${MIHOMO_CUSTOM_RULES_DIR:-}
LOCAL_HELPER_HOST=${LOCAL_HELPER_HOST:-127.0.0.1}
LOCAL_HELPER_PORT=${LOCAL_HELPER_PORT:-8787}
LOCAL_HELPER_ALLOWED_ORIGINS=${LOCAL_HELPER_ALLOWED_ORIGINS:-}
LOCAL_HELPER_MAX_PROVIDER_BYTES=${LOCAL_HELPER_MAX_PROVIDER_BYTES:-8388608}
LOCAL_HELPER_MRS_TIMEOUT_MS=${LOCAL_HELPER_MRS_TIMEOUT_MS:-15000}
LOCAL_HELPER_CONFIG_VALIDATION_TIMEOUT_MS=${LOCAL_HELPER_CONFIG_VALIDATION_TIMEOUT_MS:-20000}
LOCAL_HELPER_CUSTOM_RULES_BACKUPS=${LOCAL_HELPER_CUSTOM_RULES_BACKUPS:-3}
LOCAL_HELPER_MAX_REQUEST_BYTES=${LOCAL_HELPER_MAX_REQUEST_BYTES:-524288}
NODE_BIN=${NODE_BIN:-}
UPGRADE=0
RECONFIGURE=0
REPLACE_UI=0
NO_START=0

log() {
  printf '[zashboard] %s\n' "$*"
}

fail() {
  printf '[zashboard] ERROR: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Install a built Zashboard checkout and Local Helper on a Linux systemd host.

Usage: sudo bash deploy/install.sh [options]

  --source DIR             Built repository checkout (default: repository root)
  --mihomo-config FILE     Mihomo source config; auto-detected when omitted
  --mihomo-binary FILE     Mihomo executable; auto-detected when omitted
  --rules-dir DIR          Provider rules root (default: CONFIG_DIR/rules)
  --custom-rules-dir DIR   Helper-managed output (default: CONFIG_DIR/custom)
  --ui-dir DIR             Static UI destination (default: /usr/share/zashboard)
  --helper-host ADDRESS    Helper listen address (default: 127.0.0.1)
  --helper-port PORT       Helper listen port (default: 8787)
  --allowed-origins LIST   Comma-separated exact dashboard Origins
  --node FILE              Node.js executable (default: node from PATH)
  --upgrade                Upgrade an existing installer-managed deployment
  --reconfigure            Replace the existing Helper environment on upgrade
  --replace-ui             Back up and replace a non-managed UI directory
  --no-start               Install files without invoking systemctl
  --destdir DIR            Stage filesystem writes below DIR (requires --no-start)
  --help                    Show this help

Environment variables with the same names as deploy/zashboard-helper.env.example
can set limits and timeouts. DESTDIR is intended for package and integration tests.
EOF
}

need_value() {
  (($# >= 2)) || fail "$1 requires a value"
}

while (($#)); do
  case "$1" in
    --source) need_value "$@"; SOURCE_DIR=$2; shift 2 ;;
    --mihomo-config) need_value "$@"; MIHOMO_CONFIG_PATH=$2; shift 2 ;;
    --mihomo-binary) need_value "$@"; MIHOMO_BINARY=$2; shift 2 ;;
    --rules-dir) need_value "$@"; MIHOMO_RULES_DIR=$2; shift 2 ;;
    --custom-rules-dir) need_value "$@"; MIHOMO_CUSTOM_RULES_DIR=$2; shift 2 ;;
    --ui-dir) need_value "$@"; UI_DIR=$2; shift 2 ;;
    --helper-host) need_value "$@"; LOCAL_HELPER_HOST=$2; shift 2 ;;
    --helper-port) need_value "$@"; LOCAL_HELPER_PORT=$2; shift 2 ;;
    --allowed-origins) need_value "$@"; LOCAL_HELPER_ALLOWED_ORIGINS=$2; shift 2 ;;
    --node) need_value "$@"; NODE_BIN=$2; shift 2 ;;
    --upgrade) UPGRADE=1; shift ;;
    --reconfigure) RECONFIGURE=1; shift ;;
    --replace-ui) REPLACE_UI=1; shift ;;
    --no-start) NO_START=1; shift ;;
    --destdir) need_value "$@"; DESTDIR=$2; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) fail "unknown option: $1" ;;
  esac
done

SOURCE_DIR=$(cd -- "$SOURCE_DIR" 2>/dev/null && pwd -P) || fail "source directory not found"

require_absolute() {
  case "$2" in
    /*) ;;
    *) fail "$1 must be an absolute path: $2" ;;
  esac
  [[ "$2" != "/" ]] || fail "$1 cannot be /"
  [[ "$2" != *$'\n'* && "$2" != *$'\r'* ]] || fail "$1 contains a newline"
}

fs_path() {
  printf '%s%s' "$DESTDIR" "$1"
}

if [[ -n "$DESTDIR" ]]; then
  DESTDIR=$(mkdir -p -- "$DESTDIR" && cd -- "$DESTDIR" && pwd -P)
  ((NO_START == 1)) || fail "--destdir requires --no-start"
elif ((EUID != 0)); then
  fail "run as root, or use --destdir with --no-start for staging"
fi

[[ "$(uname -s)" == Linux* || -n "$DESTDIR" ]] || fail "only Linux hosts are supported"
[[ -f "$SOURCE_DIR/dist/index.html" ]] || fail "dist/index.html is missing; run pnpm build first"
[[ -f "$SOURCE_DIR/helper/src/server.mjs" ]] || fail "Helper source is missing"
[[ -f "$SOURCE_DIR/node_modules/yaml/package.json" ]] ||
  fail "node_modules/yaml is missing; run pnpm install --frozen-lockfile first"

if [[ -z "$NODE_BIN" ]]; then
  NODE_BIN=$(command -v node || true)
fi
[[ -n "$NODE_BIN" && -x "$NODE_BIN" ]] || fail "Node.js executable not found"
NODE_BIN=$(cd -- "$(dirname -- "$NODE_BIN")" && printf '%s/%s' "$PWD" "$(basename -- "$NODE_BIN")")
NODE_VERSION=$("$NODE_BIN" -p 'process.versions.node') || fail "unable to read Node.js version"
IFS=. read -r NODE_MAJOR NODE_MINOR _ <<<"$NODE_VERSION"
if ((NODE_MAJOR < 22 || (NODE_MAJOR == 22 && NODE_MINOR < 18))); then
  fail "Node.js 22.18 or newer is required; found $NODE_VERSION"
fi

detect_file() {
  local candidate
  for candidate in "${@:2}"; do
    if [[ -f "$candidate" ]]; then
      printf -v "$1" '%s' "$candidate"
      return 0
    fi
  done
  return 1
}

if [[ -z "$MIHOMO_CONFIG_PATH" ]]; then
  detect_file MIHOMO_CONFIG_PATH \
    /etc/mihomo/config.yaml \
    /etc/mihomo/config.yml \
    /usr/local/etc/mihomo/config.yaml \
    /usr/local/etc/mihomo/config.yml ||
    fail "Mihomo config was not found; pass --mihomo-config"
fi
if [[ -z "$MIHOMO_BINARY" ]]; then
  detect_file MIHOMO_BINARY /usr/bin/mihomo /usr/local/bin/mihomo /opt/mihomo/mihomo ||
    fail "Mihomo executable was not found; pass --mihomo-binary"
fi

require_absolute "Mihomo config" "$MIHOMO_CONFIG_PATH"
require_absolute "Mihomo binary" "$MIHOMO_BINARY"
require_absolute "UI directory" "$UI_DIR"
case "$UI_DIR" in
  /bin|/boot|/dev|/etc|/home|/lib|/lib64|/opt|/proc|/root|/run|/sbin|/srv|/sys|/tmp|/usr|/usr/bin|/usr/lib|/usr/lib64|/usr/local|/usr/local/bin|/usr/local/lib|/usr/sbin|/usr/share|/var|/var/lib|/var/log|/var/tmp)
    fail "UI directory cannot be a system root: $UI_DIR"
    ;;
esac
[[ -f "$MIHOMO_CONFIG_PATH" ]] || fail "Mihomo config does not exist: $MIHOMO_CONFIG_PATH"
[[ -x "$MIHOMO_BINARY" ]] || fail "Mihomo binary is not executable: $MIHOMO_BINARY"

CONFIG_DIR=$(cd -- "$(dirname -- "$MIHOMO_CONFIG_PATH")" && pwd -P)
MIHOMO_CONFIG_PATH="$CONFIG_DIR/$(basename -- "$MIHOMO_CONFIG_PATH")"
MIHOMO_BINARY=$(cd -- "$(dirname -- "$MIHOMO_BINARY")" && printf '%s/%s' "$PWD" "$(basename -- "$MIHOMO_BINARY")")
MIHOMO_RULES_DIR=${MIHOMO_RULES_DIR:-$CONFIG_DIR/rules}
MIHOMO_CUSTOM_RULES_DIR=${MIHOMO_CUSTOM_RULES_DIR:-$CONFIG_DIR/custom}
require_absolute "rules directory" "$MIHOMO_RULES_DIR"
require_absolute "custom rules directory" "$MIHOMO_CUSTOM_RULES_DIR"
[[ -d "$MIHOMO_RULES_DIR" ]] || fail "rules directory does not exist: $MIHOMO_RULES_DIR"
MIHOMO_RULES_DIR=$(cd -- "$MIHOMO_RULES_DIR" && pwd -P)
if [[ -e "$MIHOMO_CUSTOM_RULES_DIR" && ! -d "$MIHOMO_CUSTOM_RULES_DIR" ]]; then
  fail "custom rules path exists but is not a directory: $MIHOMO_CUSTOM_RULES_DIR"
fi
[[ ! -L "$MIHOMO_CUSTOM_RULES_DIR" ]] || fail "custom rules directory cannot be a symbolic link"

[[ "$LOCAL_HELPER_PORT" =~ ^[0-9]+$ ]] && ((LOCAL_HELPER_PORT >= 1 && LOCAL_HELPER_PORT <= 65535)) ||
  fail "Helper port must be between 1 and 65535"
[[ "$LOCAL_HELPER_ALLOWED_ORIGINS" != *"*"* ]] || fail "wildcard Origin is not accepted by the installer"
if [[ -n "$LOCAL_HELPER_ALLOWED_ORIGINS" ]]; then
  IFS=, read -ra ORIGINS <<<"$LOCAL_HELPER_ALLOWED_ORIGINS"
  for origin in "${ORIGINS[@]}"; do
    [[ "$origin" =~ ^https?://[^/]+$ ]] ||
      fail "each allowed Origin must be an exact http(s) Origin without a path: $origin"
  done
fi
case "$LOCAL_HELPER_HOST" in
  127.0.0.1|::1|localhost) ;;
  *) [[ -n "$LOCAL_HELPER_ALLOWED_ORIGINS" ]] ||
       fail "a network-accessible Helper requires at least one exact --allowed-origins value" ;;
esac

for numeric in \
  "$LOCAL_HELPER_MAX_PROVIDER_BYTES" \
  "$LOCAL_HELPER_MRS_TIMEOUT_MS" \
  "$LOCAL_HELPER_CONFIG_VALIDATION_TIMEOUT_MS" \
  "$LOCAL_HELPER_CUSTOM_RULES_BACKUPS" \
  "$LOCAL_HELPER_MAX_REQUEST_BYTES"; do
  [[ "$numeric" =~ ^[0-9]+$ ]] || fail "Helper limits and timeouts must be positive integers"
done

INSTALL_ROOT=$(fs_path "$INSTALL_DIR")
ENV_TARGET=$(fs_path "$ENV_FILE")
ENV_MARKER_TARGET=$(fs_path "/etc/zashboard-helper/.zashboard-managed")
SERVICE_TARGET=$(fs_path "$SERVICE_FILE")
UI_TARGET=$(fs_path "$UI_DIR")
MANAGED_MARKER=.zashboard-managed
ENV_EXISTED=0
SERVICE_EXISTED=0
ENV_BACKUP=$ENV_TARGET.rollback.$$
SERVICE_BACKUP=$SERVICE_TARGET.rollback.$$

[[ ! -L "$INSTALL_ROOT" ]] || fail "$INSTALL_DIR cannot be a symbolic link"
if [[ -e "$INSTALL_ROOT" && ! -f "$INSTALL_ROOT/$MANAGED_MARKER" ]]; then
  fail "$INSTALL_DIR exists but is not managed by this installer"
fi
if [[ -e "$SERVICE_TARGET" ]] &&
   ! grep -Fq 'Managed by zashboard public installer' "$SERVICE_TARGET" 2>/dev/null; then
  fail "$SERVICE_FILE exists but is not managed by this installer"
fi
if [[ -e "$ENV_TARGET" && ! -f "$INSTALL_ROOT/$MANAGED_MARKER" && ! -f "$ENV_MARKER_TARGET" ]]; then
  fail "$ENV_FILE exists without a matching installer-managed installation"
fi
if [[ -L "$INSTALL_ROOT/current" || -e "$INSTALL_ROOT/current" ]]; then
  ((UPGRADE == 1)) || fail "an installation already exists; rerun with --upgrade"
fi
if [[ -d "$UI_TARGET" && -n "$(find "$UI_TARGET" -mindepth 1 -maxdepth 1 -print -quit)" &&
      ! -f "$UI_TARGET/$MANAGED_MARKER" && $REPLACE_UI -ne 1 ]]; then
  fail "$UI_DIR contains an unmanaged UI; pass --replace-ui to back it up before replacement"
fi

VERSION=$(git -C "$SOURCE_DIR" rev-parse --verify HEAD 2>/dev/null || date -u +%Y%m%d%H%M%S)
VERSION=${VERSION:0:12}
[[ "$VERSION" =~ ^[A-Za-z0-9._-]+$ ]] || fail "could not derive a safe release identifier"
RELEASE_ROOT="$INSTALL_ROOT/releases/$VERSION"

systemd_quote() {
  local value=$1
  value=${value//\\/\\\\}
  value=${value//\"/\\\"}
  printf '"%s"' "$value"
}

write_environment() {
  local temp=$ENV_TARGET.tmp.$$
  mkdir -p -- "$(dirname -- "$ENV_TARGET")"
  {
    printf 'MIHOMO_CONFIG_PATH=%s\n' "$(systemd_quote "$MIHOMO_CONFIG_PATH")"
    printf 'MIHOMO_BINARY=%s\n' "$(systemd_quote "$MIHOMO_BINARY")"
    printf 'MIHOMO_RULES_DIR=%s\n' "$(systemd_quote "$MIHOMO_RULES_DIR")"
    printf 'MIHOMO_CUSTOM_RULES_DIR=%s\n' "$(systemd_quote "$MIHOMO_CUSTOM_RULES_DIR")"
    printf 'LOCAL_HELPER_HOST=%s\n' "$(systemd_quote "$LOCAL_HELPER_HOST")"
    printf 'LOCAL_HELPER_PORT=%s\n' "$(systemd_quote "$LOCAL_HELPER_PORT")"
    printf 'LOCAL_HELPER_ALLOWED_ORIGINS=%s\n' "$(systemd_quote "$LOCAL_HELPER_ALLOWED_ORIGINS")"
    printf 'LOCAL_HELPER_MAX_PROVIDER_BYTES=%s\n' "$(systemd_quote "$LOCAL_HELPER_MAX_PROVIDER_BYTES")"
    printf 'LOCAL_HELPER_MRS_TIMEOUT_MS=%s\n' "$(systemd_quote "$LOCAL_HELPER_MRS_TIMEOUT_MS")"
    printf 'LOCAL_HELPER_CONFIG_VALIDATION_TIMEOUT_MS=%s\n' \
      "$(systemd_quote "$LOCAL_HELPER_CONFIG_VALIDATION_TIMEOUT_MS")"
    printf 'LOCAL_HELPER_CUSTOM_RULES_BACKUPS=%s\n' \
      "$(systemd_quote "$LOCAL_HELPER_CUSTOM_RULES_BACKUPS")"
    printf 'LOCAL_HELPER_MAX_REQUEST_BYTES=%s\n' "$(systemd_quote "$LOCAL_HELPER_MAX_REQUEST_BYTES")"
  } >"$temp"
  chmod 0600 "$temp"
  mv -f -- "$temp" "$ENV_TARGET"
}

render_service() {
  local template content temp rules_dir custom_rules_dir
  template=$(<"$SOURCE_DIR/deploy/zashboard-helper.service")
  content=${template//@ENV_FILE@/$ENV_FILE}
  content=${content//@INSTALL_DIR@/$INSTALL_DIR}
  content=${content//@NODE_BIN@/$NODE_BIN}
  rules_dir=$(systemd_quote "$MIHOMO_RULES_DIR")
  custom_rules_dir=$(systemd_quote "$MIHOMO_CUSTOM_RULES_DIR")
  content=${content//@RULES_DIR@/$rules_dir}
  content=${content//@CUSTOM_RULES_DIR@/$custom_rules_dir}
  temp=$SERVICE_TARGET.tmp.$$
  mkdir -p -- "$(dirname -- "$SERVICE_TARGET")"
  printf '%s\n' "$content" >"$temp"
  chmod 0644 "$temp"
  mv -f -- "$temp" "$SERVICE_TARGET"
}

mkdir -p -- "$INSTALL_ROOT/releases"
printf 'zashboard public installer\n' >"$INSTALL_ROOT/$MANAGED_MARKER"
if [[ ! -d "$RELEASE_ROOT" ]]; then
  RELEASE_TEMP=$RELEASE_ROOT.tmp.$$
  rm -rf -- "$RELEASE_TEMP"
  mkdir -p -- "$RELEASE_TEMP/node_modules"
  cp -a -- "$SOURCE_DIR/helper/src" "$RELEASE_TEMP/src"
  cp -aL -- "$SOURCE_DIR/node_modules/yaml" "$RELEASE_TEMP/node_modules/yaml"
  cp -a -- "$SOURCE_DIR/package.json" "$RELEASE_TEMP/package.json"
  printf '%s\n' "$VERSION" >"$RELEASE_TEMP/$MANAGED_MARKER"
  mv -- "$RELEASE_TEMP" "$RELEASE_ROOT"
fi

CUSTOM_RULES_TARGET=$(fs_path "$MIHOMO_CUSTOM_RULES_DIR")
if [[ ! -d "$CUSTOM_RULES_TARGET" ]]; then
  mkdir -p -- "$CUSTOM_RULES_TARGET"
  chmod 0700 "$CUSTOM_RULES_TARGET"
fi
if [[ -f "$ENV_TARGET" ]]; then
  ENV_EXISTED=1
  cp -p -- "$ENV_TARGET" "$ENV_BACKUP"
fi
if [[ -f "$SERVICE_TARGET" ]]; then
  SERVICE_EXISTED=1
  cp -p -- "$SERVICE_TARGET" "$SERVICE_BACKUP"
fi
if [[ ! -f "$ENV_TARGET" || $RECONFIGURE -eq 1 ]]; then
  write_environment
elif ((UPGRADE == 1)); then
  log "preserving $ENV_FILE; use --reconfigure to replace it"
fi
printf 'zashboard public installer\n' >"$ENV_MARKER_TARGET"
chmod 0600 "$ENV_MARKER_TARGET"
render_service

PREVIOUS_CURRENT=$(readlink "$INSTALL_ROOT/current" 2>/dev/null || true)
ln -sfn "releases/$VERSION" "$INSTALL_ROOT/current.new"
if [[ -n "$DESTDIR" && -d "$INSTALL_ROOT/current" && ! -L "$INSTALL_ROOT/current" ]]; then
  [[ -f "$INSTALL_ROOT/current/$MANAGED_MARKER" ]] ||
    fail "staged current directory is missing its managed marker"
  rm -rf -- "$INSTALL_ROOT/current"
fi
mv -Tf -- "$INSTALL_ROOT/current.new" "$INSTALL_ROOT/current"

TIMESTAMP=$(date -u +%Y%m%dT%H%M%SZ)
BACKUP_ROOT=$(fs_path "/var/backups/zashboard")
UI_BACKUP=
UI_STAGE=$UI_TARGET.stage.$$
rm -rf -- "$UI_STAGE"
mkdir -p -- "$UI_STAGE"
cp -a -- "$SOURCE_DIR/dist/." "$UI_STAGE/"
printf 'zashboard public installer\n' >"$UI_STAGE/$MANAGED_MARKER"
if [[ -e "$UI_TARGET" ]]; then
  mkdir -p -- "$BACKUP_ROOT"
  UI_BACKUP=$BACKUP_ROOT/ui-$TIMESTAMP
  BACKUP_SUFFIX=0
  while [[ -e "$UI_BACKUP" ]]; do
    BACKUP_SUFFIX=$((BACKUP_SUFFIX + 1))
    UI_BACKUP=$BACKUP_ROOT/ui-$TIMESTAMP-$BACKUP_SUFFIX
  done
  mv -- "$UI_TARGET" "$UI_BACKUP"
fi
mkdir -p -- "$(dirname -- "$UI_TARGET")"
mv -- "$UI_STAGE" "$UI_TARGET"

rollback_activation() {
  log "activation failed; restoring the previous managed files"
  if [[ -n "$PREVIOUS_CURRENT" ]]; then
    ln -sfn "$PREVIOUS_CURRENT" "$INSTALL_ROOT/current.rollback"
    mv -Tf -- "$INSTALL_ROOT/current.rollback" "$INSTALL_ROOT/current"
  else
    rm -f -- "$INSTALL_ROOT/current"
  fi
  if [[ -n "$UI_BACKUP" && -d "$UI_BACKUP" ]]; then
    rm -rf -- "$UI_TARGET"
    mv -- "$UI_BACKUP" "$UI_TARGET"
  elif [[ -f "$UI_TARGET/$MANAGED_MARKER" ]]; then
    rm -rf -- "$UI_TARGET"
  fi
  if ((ENV_EXISTED == 1)); then
    mv -f -- "$ENV_BACKUP" "$ENV_TARGET"
  else
    rm -f -- "$ENV_TARGET" "$ENV_BACKUP"
  fi
  if ((SERVICE_EXISTED == 1)); then
    mv -f -- "$SERVICE_BACKUP" "$SERVICE_TARGET"
  else
    rm -f -- "$SERVICE_TARGET" "$SERVICE_BACKUP"
  fi
  if [[ -z "$DESTDIR" ]]; then
    systemctl daemon-reload >/dev/null 2>&1 || true
    if [[ -n "$PREVIOUS_CURRENT" ]]; then
      systemctl restart zashboard-helper.service >/dev/null 2>&1 || true
    else
      systemctl disable --now zashboard-helper.service >/dev/null 2>&1 || true
    fi
  fi
}

if ((NO_START == 0)); then
  command -v systemctl >/dev/null || fail "systemctl is required; use --no-start only for staging"
  if ! systemctl daemon-reload || ! systemctl enable --now zashboard-helper.service; then
    rollback_activation
    fail "Local Helper did not start"
  fi
  HEALTH_HOST=$LOCAL_HELPER_HOST
  [[ "$HEALTH_HOST" != "0.0.0.0" ]] || HEALTH_HOST=127.0.0.1
  [[ "$HEALTH_HOST" != "::" ]] || HEALTH_HOST=::1
  if [[ "$HEALTH_HOST" == *:* ]]; then
    HEALTH_HOST="[$HEALTH_HOST]"
  fi
  HEALTH_URL="http://$HEALTH_HOST:$LOCAL_HELPER_PORT/api/local/health"
  if ! HEALTH_URL=$HEALTH_URL "$NODE_BIN" - <<'NODE'
const url = process.env.HEALTH_URL
let lastError
for (let attempt = 0; attempt < 20; attempt += 1) {
  try {
    const response = await fetch(url)
    const body = await response.json()
    if (response.ok && body.status === 'ok') process.exit(0)
  } catch (error) {
    lastError = error
  }
  await new Promise((resolve) => setTimeout(resolve, 500))
}
console.error(lastError?.message || 'health response was not OK')
process.exit(1)
NODE
  then
    rollback_activation
    fail "Local Helper health check failed"
  fi
fi

rm -f -- "$ENV_BACKUP" "$SERVICE_BACKUP"

EXTERNAL_UI=$(awk '
  /^[[:space:]]*external-ui[[:space:]]*:/ {
    sub(/^[^:]*:[[:space:]]*/, "")
    gsub(/["'\''[:space:]]/, "")
    print
    exit
  }
' "$MIHOMO_CONFIG_PATH" 2>/dev/null || true)

log "installed Helper release $VERSION"
log "installed UI at $UI_DIR"
if [[ -n "$EXTERNAL_UI" && "$EXTERNAL_UI" != "$UI_DIR" ]]; then
  log "Mihomo external-ui currently points to '$EXTERNAL_UI'; this installer did not change it"
fi
if ((NO_START == 1)); then
  log "files staged without starting systemd"
else
  log "Local Helper is healthy at $HEALTH_URL"
fi
