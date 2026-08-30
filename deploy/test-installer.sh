#!/usr/bin/env bash
set -Eeuo pipefail

ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
INSTALL=$ROOT/deploy/install.sh
UNINSTALL=$ROOT/deploy/uninstall.sh
TMP_ROOT=$(mktemp -d)
HELPER_PID=

cleanup() {
  if [[ -n "$HELPER_PID" ]]; then
    kill "$HELPER_PID" 2>/dev/null || true
    wait "$HELPER_PID" 2>/dev/null || true
  fi
  rm -rf -- "$TMP_ROOT"
}
trap cleanup EXIT

fail() {
  printf '[installer-test] ERROR: %s\n' "$*" >&2
  exit 1
}

assert_file() {
  [[ -f "$1" ]] || fail "expected file: $1"
}

assert_absent() {
  [[ ! -e "$1" ]] || fail "expected absent path: $1"
}

[[ -f "$ROOT/dist/index.html" ]] || fail "run pnpm build before installer tests"
[[ -f "$ROOT/node_modules/yaml/package.json" ]] || fail "run pnpm install before installer tests"

FIXTURE="$TMP_ROOT/fixture with space"
STAGE=$TMP_ROOT/stage
mkdir -p "$FIXTURE/providers" "$FIXTURE/custom" "$STAGE"
printf 'preserve\n' >"$FIXTURE/custom/.keep"
cat >"$FIXTURE/config.yaml" <<'YAML'
external-controller: 127.0.0.1:9090
external-ui: /srv/another-panel
rule-providers: {}
rules: []
YAML
cat >"$FIXTURE/mihomo" <<'SH'
#!/usr/bin/env sh
exit 0
SH
chmod +x "$FIXTURE/mihomo"

PORT=$(node - <<'NODE'
import net from 'node:net'
const server = net.createServer()
server.listen(0, '127.0.0.1', () => {
  console.log(server.address().port)
  server.close()
})
NODE
)

bash -n "$INSTALL" "$UNINSTALL" "$ROOT/deploy/test-installer.sh"

DESTDIR=$STAGE bash "$INSTALL" \
  --source "$ROOT" \
  --mihomo-config "$FIXTURE/config.yaml" \
  --mihomo-binary "$FIXTURE/mihomo" \
  --rules-dir "$FIXTURE/providers" \
  --custom-rules-dir "$FIXTURE/custom" \
  --helper-port "$PORT" \
  --allowed-origins http://127.0.0.1:9090 \
  --ui-dir /srv/zashboard \
  --no-start

assert_file "$STAGE/opt/zashboard-helper/.zashboard-managed"
assert_file "$STAGE/opt/zashboard-helper/current/src/server.mjs"
assert_file "$STAGE/opt/zashboard-helper/current/node_modules/yaml/package.json"
assert_file "$STAGE/etc/zashboard-helper/zashboard-helper.env"
assert_file "$STAGE/etc/zashboard-helper/.zashboard-managed"
assert_file "$STAGE/etc/systemd/system/zashboard-helper.service"
assert_file "$STAGE/srv/zashboard/index.html"

set -a
# shellcheck disable=SC1091
. "$STAGE/etc/zashboard-helper/zashboard-helper.env"
set +a
node "$STAGE/opt/zashboard-helper/current/src/server.mjs" >"$TMP_ROOT/helper.log" 2>&1 &
HELPER_PID=$!

HEALTH_URL="http://127.0.0.1:$PORT/api/local/health"
if ! HEALTH_URL=$HEALTH_URL node - <<'NODE'
const url = process.env.HEALTH_URL
for (let attempt = 0; attempt < 30; attempt += 1) {
  try {
    const response = await fetch(url, { headers: { Origin: 'http://127.0.0.1:9090' } })
    const body = await response.json()
    if (response.ok && body.status === 'ok' &&
        response.headers.get('access-control-allow-origin') === 'http://127.0.0.1:9090') {
      process.exit(0)
    }
  } catch {}
  await new Promise((resolve) => setTimeout(resolve, 100))
}
process.exit(1)
NODE
then
  sed -n '1,80p' "$TMP_ROOT/helper.log" >&2
  fail "installed Helper did not pass its health and allowed-Origin check"
fi

if ! BLOCKED_ORIGIN_URL=$HEALTH_URL node - <<'NODE'
const response = await fetch(process.env.BLOCKED_ORIGIN_URL, {
  headers: { Origin: 'http://example.invalid' },
})
if (response.status !== 403) process.exit(1)
NODE
then
  fail "installed Helper did not reject a disallowed Origin"
fi

kill "$HELPER_PID"
wait "$HELPER_PID" 2>/dev/null || true
HELPER_PID=

# Same release upgrade is idempotent and preserves the environment by default.
ENV_HASH=$(node -e "const fs=require('fs');const c=require('crypto');process.stdout.write(c.createHash('sha256').update(fs.readFileSync(process.argv[1])).digest('hex'))" \
  "$STAGE/etc/zashboard-helper/zashboard-helper.env")
DESTDIR=$STAGE bash "$INSTALL" \
  --source "$ROOT" \
  --mihomo-config "$FIXTURE/config.yaml" \
  --mihomo-binary "$FIXTURE/mihomo" \
  --rules-dir "$FIXTURE/providers" \
  --custom-rules-dir "$FIXTURE/custom" \
  --helper-port "$PORT" \
  --allowed-origins http://127.0.0.1:9090 \
  --ui-dir /srv/zashboard \
  --upgrade \
  --no-start
ENV_HASH_AFTER=$(node -e "const fs=require('fs');const c=require('crypto');process.stdout.write(c.createHash('sha256').update(fs.readFileSync(process.argv[1])).digest('hex'))" \
  "$STAGE/etc/zashboard-helper/zashboard-helper.env")
[[ "$ENV_HASH" == "$ENV_HASH_AFTER" ]] || fail "upgrade did not preserve Helper environment"

# Default uninstall preserves both the UI and a recognized environment that can be reused on reinstall.
DESTDIR=$STAGE bash "$UNINSTALL" \
  --ui-dir /srv/zashboard \
  --no-stop
assert_absent "$STAGE/opt/zashboard-helper"
assert_absent "$STAGE/etc/systemd/system/zashboard-helper.service"
assert_file "$STAGE/etc/zashboard-helper/zashboard-helper.env"
assert_file "$STAGE/etc/zashboard-helper/.zashboard-managed"
assert_file "$STAGE/srv/zashboard/index.html"

DESTDIR=$STAGE bash "$INSTALL" \
  --source "$ROOT" \
  --mihomo-config "$FIXTURE/config.yaml" \
  --mihomo-binary "$FIXTURE/mihomo" \
  --rules-dir "$FIXTURE/providers" \
  --custom-rules-dir "$FIXTURE/custom" \
  --helper-port "$PORT" \
  --allowed-origins http://127.0.0.1:9090 \
  --ui-dir /srv/zashboard \
  --no-start
ENV_HASH_REINSTALLED=$(node -e "const fs=require('fs');const c=require('crypto');process.stdout.write(c.createHash('sha256').update(fs.readFileSync(process.argv[1])).digest('hex'))" \
  "$STAGE/etc/zashboard-helper/zashboard-helper.env")
[[ "$ENV_HASH_AFTER" == "$ENV_HASH_REINSTALLED" ]] || fail "reinstall did not reuse preserved Helper environment"

# An unmanaged UI and missing Mihomo inputs fail before installation.
UNMANAGED=$TMP_ROOT/unmanaged
mkdir -p "$UNMANAGED/srv/zashboard"
printf 'keep\n' >"$UNMANAGED/srv/zashboard/owner.txt"
if DESTDIR=$UNMANAGED bash "$INSTALL" \
  --source "$ROOT" \
  --mihomo-config "$FIXTURE/config.yaml" \
  --mihomo-binary "$FIXTURE/mihomo" \
  --ui-dir /srv/zashboard \
  --no-start >/dev/null 2>&1; then
  fail "installer replaced an unmanaged UI without --replace-ui"
fi
assert_file "$UNMANAGED/srv/zashboard/owner.txt"
assert_absent "$UNMANAGED/opt/zashboard-helper"

FOREIGN_SERVICE=$TMP_ROOT/foreign-service
mkdir -p "$FOREIGN_SERVICE/etc/systemd/system"
printf 'foreign service\n' >"$FOREIGN_SERVICE/etc/systemd/system/zashboard-helper.service"
if DESTDIR=$FOREIGN_SERVICE bash "$INSTALL" \
  --source "$ROOT" \
  --mihomo-config "$FIXTURE/config.yaml" \
  --mihomo-binary "$FIXTURE/mihomo" \
  --rules-dir "$FIXTURE/providers" \
  --no-start >/dev/null 2>&1; then
  fail "installer replaced a foreign systemd unit"
fi
grep -Fxq 'foreign service' "$FOREIGN_SERVICE/etc/systemd/system/zashboard-helper.service" ||
  fail "foreign systemd unit changed"
assert_absent "$FOREIGN_SERVICE/opt/zashboard-helper"

CRITICAL_UI=$TMP_ROOT/critical-ui
mkdir -p "$CRITICAL_UI"
if DESTDIR=$CRITICAL_UI bash "$INSTALL" \
  --source "$ROOT" \
  --mihomo-config "$FIXTURE/config.yaml" \
  --mihomo-binary "$FIXTURE/mihomo" \
  --rules-dir "$FIXTURE/providers" \
  --ui-dir /etc \
  --replace-ui \
  --no-start >/dev/null 2>&1; then
  fail "installer accepted a system root as the UI directory"
fi
assert_absent "$CRITICAL_UI/opt/zashboard-helper"

FOREIGN_ENV=$TMP_ROOT/foreign-env
mkdir -p "$FOREIGN_ENV/etc/zashboard-helper"
printf 'foreign environment\n' >"$FOREIGN_ENV/etc/zashboard-helper/zashboard-helper.env"
if DESTDIR=$FOREIGN_ENV bash "$UNINSTALL" \
  --purge-config \
  --no-stop >/dev/null 2>&1; then
  fail "uninstaller removed a foreign environment file"
fi
grep -Fxq 'foreign environment' "$FOREIGN_ENV/etc/zashboard-helper/zashboard-helper.env" ||
  fail "foreign environment file changed"

MISSING=$TMP_ROOT/missing
mkdir -p "$MISSING"
if DESTDIR=$MISSING bash "$INSTALL" \
  --source "$ROOT" \
  --mihomo-config "$FIXTURE/not-found.yaml" \
  --mihomo-binary "$FIXTURE/mihomo" \
  --no-start >/dev/null 2>&1; then
  fail "installer accepted a missing Mihomo config"
fi
assert_absent "$MISSING/opt/zashboard-helper"

DESTDIR=$STAGE bash "$UNINSTALL" \
  --ui-dir /srv/zashboard \
  --remove-ui \
  --purge-config \
  --no-stop

assert_absent "$STAGE/opt/zashboard-helper"
assert_absent "$STAGE/etc/systemd/system/zashboard-helper.service"
assert_absent "$STAGE/etc/zashboard-helper/zashboard-helper.env"
assert_absent "$STAGE/etc/zashboard-helper/.zashboard-managed"
assert_absent "$STAGE/srv/zashboard"
assert_file "$FIXTURE/config.yaml"
assert_file "$FIXTURE/custom/.keep"
find "$STAGE/var/backups/zashboard" -name index.html -type f -print -quit | grep -q . ||
  fail "uninstaller did not preserve the removed UI as a backup"

printf '[installer-test] PASS\n'
