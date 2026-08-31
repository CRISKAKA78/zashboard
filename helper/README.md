# zashboard Local Helper

Local Helper is a small, optional Node.js service for file-system operations that a browser cannot
perform. It discovers the active Mihomo configuration, reads local Rule Provider metadata,
normalizes Text/YAML/MRS Provider entries, manages the two fixed custom-rule files, and exposes a
bounded projection of the same parsed entries for the Rule Provider Explorer. It never proxies the
Controller API and does not expose an arbitrary file API.

## Requirements and startup

- Node.js 22.18 or newer
- Project dependencies installed with `pnpm install`

```bash
MIHOMO_CONFIG_PATH=/etc/mihomo/config.yaml \
MIHOMO_BINARY=/usr/bin/mihomo \
MIHOMO_RULES_DIR=/etc/mihomo/rules \
MIHOMO_CUSTOM_RULES_DIR=/etc/mihomo/custom \
pnpm helper:start
```

The service binds to `127.0.0.1:8787` by default. Keeping it on loopback and reverse-proxying
`/api/local/*` through the same origin as zashboard is recommended.

## Environment variables

| Variable                                    | Default                     | Purpose                                                                                  |
| ------------------------------------------- | --------------------------- | ---------------------------------------------------------------------------------------- |
| `MIHOMO_CONFIG_PATH`                        | `/etc/mihomo/config.yaml`   | Source Mihomo YAML configuration                                                         |
| `MIHOMO_BINARY`                             | `/usr/bin/mihomo`           | Mihomo executable used for checks, MRS conversion, and validation                        |
| `MIHOMO_RULES_DIR`                          | `<config directory>/rules`  | Only directory from which provider files may be inspected or local file Providers edited |
| `MIHOMO_CUSTOM_RULES_DIR`                   | `<config directory>/custom` | Fixed storage root for rules, backups, and the generated runtime config                  |
| `LOCAL_HELPER_HOST`                         | `127.0.0.1`                 | Listen address                                                                           |
| `LOCAL_HELPER_PORT`                         | `8787`                      | Listen port                                                                              |
| `LOCAL_HELPER_MAX_PROVIDER_BYTES`           | `8388608`                   | Maximum Text/YAML/MRS Provider file size read by the Helper                              |
| `LOCAL_HELPER_MRS_TIMEOUT_MS`               | `15000`                     | Timeout for one Mihomo MRS conversion, from 100 to 120000 milliseconds                   |
| `LOCAL_HELPER_CONFIG_VALIDATION_TIMEOUT_MS` | `20000`                     | Timeout for `mihomo -t`, from 100 to 120000 milliseconds                                 |
| `LOCAL_HELPER_CUSTOM_RULES_BACKUPS`         | `3`                         | Retained custom-rule backups, from 1 to 20                                               |
| `LOCAL_HELPER_MAX_REQUEST_BYTES`            | `524288`                    | Maximum custom-rule JSON body, from 1024 to 4194304 bytes                                |
| `LOCAL_HELPER_ALLOWED_ORIGINS`              | empty                       | Comma-separated cross-origin allowlist; same-origin requests remain allowed              |
| `VITE_LOCAL_HELPER_URL`                     | empty                       | Optional frontend build-time base URL; empty uses the zashboard origin                   |

## API

```text
GET /api/local/health
GET /api/local/config-info
GET /api/local/rule-providers
GET /api/local/rule-provider/:name/info
GET /api/local/rule-provider/:name/rules
GET /api/local/custom-rules
POST /api/local/custom-rules/validate
PUT /api/local/custom-rules
POST /api/local/custom-rules/rollback
POST /api/local/custom-rules/restore
```

Rule Provider endpoints accept only a configured provider name. There is intentionally no API that
accepts an arbitrary file path. Existing files are resolved with `realpath`, and missing files are
validated through their nearest existing ancestor before the allowed-root check.
For an HTTP Provider that omits `path`, the Helper follows Mihomo's default and looks for
`<MIHOMO_RULES_DIR>/<md5(url)>` while applying the same allowed-root checks.

The `rules` endpoint normalizes local Text/YAML payloads directly. For `domain` and `ipcidr` MRS
Providers, it invokes the configured Mihomo binary with an argument array and converts a secure
temporary copy to text. Parsed entries are cached by Provider name, path, size, modification time,
behavior, and format. Other MRS behaviors and binary formats remain intentionally unsupported.

Without query parameters, the endpoint returns the full normalized entry array for existing Rule
Intelligence consumers. The Explorer sends `page`, `pageSize` (maximum 500), `family`, `search`,
`sortKey`, and `sortDirection`; the Helper then returns counts and only the requested page. Search
is limited to 512 characters and matches type, content, params, and raw text. Refreshing metadata
does not reconvert an unchanged MRS file.

Custom-rule writes accept rule objects only; clients cannot supply a path. The Helper writes
`pre-rules.yaml`, `post-rules.yaml`, and `runtime-config.yaml` under the configured custom directory.
It creates same-directory temporary files with mode `0600`, flushes them, validates the generated
runtime file with `mihomo -t`, creates a bounded backup, and atomically renames the candidates. A
version token and an in-process write lock reject stale concurrent saves. The browser then loads the
managed runtime configuration through zashboard's existing Mihomo client; if that fails, it invokes
the rollback endpoint and reloads the restored runtime file.
