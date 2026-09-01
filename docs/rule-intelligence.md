# Rule Intelligence 架构与使用说明

本文说明 Rule Intelligence 的功能、Local Helper API、安全边界和已知限制。安装、升级、卸载、
网络模式及所有环境变量以根目录 `README.md` 和 `deploy/` 示例为准。

## 范围

Rule Intelligence 在不引入数据库、SSH 或第二套 Mihomo Controller 代理的前提下，为 zashboard 提供：

- MATCH / FINAL 兜底规则识别；
- 域名、IP 和关键词规则搜索；
- Text、YAML 和部分 MRS Rule Provider 查询；
- Rule Provider 内容浏览、分类、搜索、排序与分页，并管理本地 Text/YAML file Provider；
- 实际规则命中、策略链和最终出口解析；
- 裸 Mihomo 的 Pre / Post 自定义规则与 Fake-IP Filter 管理。

## 总体架构

```text
Mihomo Controller API                  Local Helper (loopback)
  /rules, /proxies, /configs             source config + provider files
          |                                custom/pre-rules.yaml
          |                                custom/post-rules.yaml
          |                                custom/fake-ip-filter.yaml
          v                                custom/runtime-config.yaml
zashboard assembly/store  <---------->  scoped /api/local/*
          |
          v
Fallback -> Search -> Penetration -> Custom Rules UI
```

浏览器继续使用 zashboard 现有的 Mihomo axios client。Local Helper 只弥补浏览器无法安全完成的本地文件读取、配置生成和 CLI 校验，不转发 Controller 请求。

## 数据流

1. zashboard 从 `/rules` 取得当前有效规则，从 `/proxies` 取得策略、节点和当前选择。
2. Local Helper 解析源配置中的 `rule-providers`，仅在 `MIHOMO_RULES_DIR` 内读取本地 Provider。
3. Rule Search 将直接规则和 Provider 条目归一化后查询，最多展示 200 条。
4. Rule Provider Explorer 复用同一份归一化结果和元数据缓存，在 Helper 侧分类、搜索、排序并按 100 条分页返回；浏览器不会一次渲染整个大 Provider。本地 `type: file` 的 Text/YAML Provider 可按原始序号增删改，远端与 MRS Provider 保持只读。
5. Rule Penetration 按 Mihomo 的自上而下规则顺序找第一个可生效匹配，再通过唯一的 Proxy Chain 解析器跟踪到最终出口。
6. 本地 Provider 修改会先经版本检查、临时文件与 `mihomo -t`，原子保存后调用现有 Provider 更新 API；自定义规则或 Fake-IP Filter 则调用现有 `PUT /configs?force=true` 加载托管配置。两条链路都在 reload 失败时恢复 Helper 生成的备份，并刷新 `/rules`、`/proxies` 与 Provider 缓存。

## Local Helper

Helper 默认监听 `127.0.0.1:8787`。建议通过与 zashboard 同源的反向代理暴露 `/api/local/*`，不要直接对公网监听。

### API

```text
GET  /api/local/health
GET  /api/local/config-info
GET  /api/local/rule-providers
GET  /api/local/rule-provider/:name/info
GET  /api/local/rule-provider/:name/rules
PUT  /api/local/rule-provider/:name/rules
POST /api/local/rule-provider/:name/rules/rollback
GET  /api/local/custom-rules
POST /api/local/custom-rules/validate
PUT  /api/local/custom-rules
POST /api/local/custom-rules/rollback
POST /api/local/custom-rules/restore
```

写入 API 只接受 Provider 名称、单条规则操作、结构化自定义规则、Fake-IP Filter 字符串数组和 Helper 生成的版本/备份 ID，不接受文件路径。

`GET /api/local/rule-provider/:name/rules` 不带查询参数时继续返回完整归一化条目，供 Rule Search/Rule Penetration 使用。Explorer 使用以下有界查询：

| 参数            | 值                                               | 默认值    |
| --------------- | ------------------------------------------------ | --------- |
| `page`          | 大于 0 的整数                                    | `1`       |
| `pageSize`      | `1`–`500`                                        | `100`     |
| `family`        | `all` / `domain` / `ip` / `other`                | `all`     |
| `search`        | 类型、内容、参数和 Raw 的内容搜索，最长 512 字符 | 空        |
| `sortKey`       | `type` / `content` / `params` / `raw`            | 无        |
| `sortDirection` | `default` / `asc` / `desc`                       | `default` |

响应包含 `provider`、`version`、`total`、`matched`、`page`、`pageSize`、`hasMore`、四类 `counts`、`items` 和 `cache`。只有可编辑的本地 Provider 才返回版本令牌；`default` 严格保持 Provider 原始顺序，相同排序值也以原始序号稳定排序。

### 环境变量

| 变量                                        | 默认值                    | 用途                                      |
| ------------------------------------------- | ------------------------- | ----------------------------------------- |
| `MIHOMO_CONFIG_PATH`                        | `/etc/mihomo/config.yaml` | 只读源配置                                |
| `MIHOMO_BINARY`                             | `/usr/bin/mihomo`         | 版本检查、MRS 转换、配置校验              |
| `MIHOMO_RULES_DIR`                          | `<源配置目录>/rules`      | 允许读取及本地 file Provider 写入的根目录 |
| `MIHOMO_CUSTOM_RULES_DIR`                   | `<源配置目录>/custom`     | 自定义规则、备份和托管配置                |
| `LOCAL_HELPER_HOST`                         | `127.0.0.1`               | 监听地址                                  |
| `LOCAL_HELPER_PORT`                         | `8787`                    | 监听端口                                  |
| `LOCAL_HELPER_MAX_PROVIDER_BYTES`           | `8388608`                 | 单个 Provider 最大读取字节数              |
| `LOCAL_HELPER_MRS_TIMEOUT_MS`               | `15000`                   | MRS 转换超时                              |
| `LOCAL_HELPER_CONFIG_VALIDATION_TIMEOUT_MS` | `20000`                   | `mihomo -t` 校验超时                      |
| `LOCAL_HELPER_CUSTOM_RULES_BACKUPS`         | `3`                       | 备份保留数，可设 1–20                     |
| `LOCAL_HELPER_MAX_REQUEST_BYTES`            | `524288`                  | 自定义规则 JSON 上限                      |
| `LOCAL_HELPER_ALLOWED_ORIGINS`              | 空                        | 额外 CORS 允许列表                        |
| `VITE_LOCAL_HELPER_URL`                     | 空                        | 前端构建时 Helper 根 URL；空表示同源      |

## Rule Provider 与 MRS

- `text` 与 `yaml` Provider 直接归一化为 `{type, value, raw}`；其中源配置声明为 `type: file`、实际路径位于 `MIHOMO_RULES_DIR` 且文件已存在时可编辑。
- `mrs` 仅支持 Mihomo 可转换的 `domain` 和 `ipcidr` behavior。Helper 将原文件安全复制到临时目录，通过参数数组执行 Mihomo 转换，不拼接 shell 命令。
- HTTP Provider 未显式配置 `path` 时，按 Mihomo 默认规则读取 `<MIHOMO_RULES_DIR>/<md5(url)>`。
- 路径检查使用 `realpath` 和最近存在父目录，防止 `..` 与符号链接越界。
- 解析结果按 Provider 名、路径、size、mtime、behavior 和 format 缓存；配置变更后会自动失效。
- Explorer 刷新会重新检查上述元数据；元数据未变时命中缓存，不会再次执行 MRS 转换。

## Rule Provider Explorer

Rules 页的 Provider 卡片和表格行共用一个 `RuleProviderExplorerDialog`。更新按钮会阻止事件冒泡，因此仍只执行原有 Provider 更新动作。弹窗提供全部、域名、IP、其他四个分类及全局计数；域名族还覆盖 `DOMAIN-REGEX`、`DOMAIN-WILDCARD`、`GEOSITE`，IP 族覆盖 CIDR、IP-SUFFIX、GEOIP、IP-ASN 及对应的来源地址类型。

表格显示 Type、Content、Params 和 Raw。表头按升序、降序、原始顺序循环，搜索仅匹配 Provider 内部内容，不声称代表流量命中。每条规则只有一个 Raw 复制入口。桌面端使用宽弹窗，移动端占满可视窗口；Helper 离线、Provider 文件缺失或格式不支持时只在弹窗内降级，不影响 Rules 页已有功能。

可编辑 Provider 会显示新增、编辑、删除入口。保存按条目在源文件中的稳定原始序号操作，Text 文件保留未编辑的注释和空行，YAML 文件保留 `payload` 文档结构。Helper 对候选文件执行完整解析和 `mihomo -t`，再建立有界备份并同目录原子替换；前端随后调用 Mihomo 的 Provider 更新 API。reload 失败会恢复旧文件并再次更新旧 Provider。HTTP 下载 Provider、MRS 以及未知格式只显示查看能力，前端不显示写入口，Helper 也会拒绝绕过 UI 的写请求。

## Rule Search 与 Rule Penetration

Rule Search 对 `DOMAIN`、`DOMAIN-SUFFIX`、`DOMAIN-KEYWORD`、`DOMAIN-WILDCARD`、`DOMAIN-REGEX`、`IP-CIDR`、`IP-CIDR6` 和 `IP-SUFFIX` 做流量语义匹配，并统一 Controller CamelCase 与配置/Provider 大写连字符类型名；关键词模式仅是内容搜索，不声称是实际流量命中。

Rule Penetration 严格遵守顺序。Helper 会投影源配置中 `RULE-SET` 的目标与 `no-resolve` 元数据，因此仅输入域名时可以安全跳过明确禁止 DNS 解析的 IP Provider。如果更早的 `RULE-SET` 不可用，或遇到仍可能需要 DNS 的目标 IP 规则，以及仅凭目标域名/IP 无法判断的 `GEOSITE`、`GEOIP`、`IP-ASN`、来源、端口、进程、入站或逻辑规则，结果是“无法确定”，不会把后方规则误报为有效命中。Provider 中只要存在可证明的匹配仍可确定命中；仅在没有已知匹配且存在不可判定条目时阻断。策略链解析共用 `proxyChain.ts`，支持缺失节点和循环检测。

## Custom Rules

当前 Mihomo 没有可直接将 Pre/Post 列表 include 进主 `rules` 序列的官方多配置机制。`rule-provider` 只能在某个 `RULE-SET` 位置展开规则，不能表达任意类型的 Pre/Post 编辑语义。因此采用：

```text
config.yaml                 # 订阅/人工维护的只读源
custom/pre-rules.yaml       # 可人工查看的面板数据
custom/post-rules.yaml
custom/fake-ip-filter.yaml  # 与规则共用版本、校验、备份和回滚
custom/runtime-config.yaml  # 生成物，供 Mihomo 加载
custom/backups/*            # 有界备份
```

有效顺序固定为：

```text
Pre -> Original non-fallback -> Post -> Original MATCH/FINAL tail
```

编辑器覆盖 Mihomo v1.19.30 定义的域名、地理数据、目标/来源 IP、ASN、端口、进程、入站、网络、UID、Rule Set、子规则与逻辑规则类型；复杂逻辑规则可使用 raw 高级模式，最终仍以本机 `mihomo -t` 为准。Pre 不允许 `MATCH`；Post 的 `MATCH` 必须是最后一条，且当源配置已有 `MATCH/FINAL` 时禁用，避免使原兜底失效。Target 候选来自 `/proxies`，同时保留手动输入。

Fake-IP Filter 不再直接 PATCH Controller 的临时 `/configs` 状态。设置页读取和保存同一份 Helper 托管状态；Helper 从只读源配置继承初值，并只在生成的 runtime 中覆盖 `dns.fake-ip-filter`。保存 Filter 时会携带当前 Pre/Post，保存规则时也会保留当前 Filter，以同一个版本令牌防止页面间静默覆盖。

保存流程：写同目录临时文件（`0600`）、`fsync`、生成临时运行配置、执行 `mihomo -t -d <source-dir> -f <temp>`、产生有界备份、原子 `rename`、通过现有 API reload。写入期间有进程内锁，版本哈希同时覆盖源配置、Pre、Post、Fake-IP Filter 和 runtime，可检出另一页面或外部进程的更改。

reload 失败时，前端请求 Helper 恢复旧文件，再次 reload 旧运行配置，用于覆盖“Mihomo 已应用但 HTTP 响应丢失”的模糊失败情形。

## 安全模型

- 默认仅 loopback，检查 Origin，CORS 需显式放行。
- Provider API 只接受配置名称；仅源配置声明的本地 Text/YAML file Provider 可写，HTTP/MRS/未知格式只读。自定义规则与 Fake-IP Filter 仍只写固定托管文件，没有通用读写路由。
- Explorer 查询只接受 Provider 名称和有界筛选参数，客户端不能提交路径、URL 或任意文件名。
- 请求体、Provider 文件、规则数量、字段长度、YAML alias、CLI 时间和输出都有上限。
- 拒绝托管文件和存储目录的符号链接，CLI 使用 `execFile` 参数数组。
- 源 `config.yaml` 永不写入；运行配置是可重建生成物。
- 备份数量有界：自定义规则备份包含 Pre/Post/Fake-IP Filter；每个可编辑 Provider 使用独立备份目录。两者恢复都必须重走解析和 Mihomo 校验；旧版只含 Pre/Post 的备份恢复时保留当前 Filter。

## 部署

公开部署先遵循根目录 `README.md`；`deploy/install.sh` 只安装已经构建的 UI 和现有 Helper，默认
loopback，且不会编辑或重启 Mihomo。以下步骤描述通用功能运行条件。

1. 安装 Node.js 22.18+、项目依赖和与运行核心同版本的 Mihomo 可执行文件。
2. 设置 `MIHOMO_CONFIG_PATH`、`MIHOMO_BINARY`、`MIHOMO_RULES_DIR` 和 `MIHOMO_CUSTOM_RULES_DIR`，启动 `pnpm helper:start`。
3. 将 zashboard 的 `/api/local/*` 同源反向代理到 Helper；如果必须跨域，设置 `LOCAL_HELPER_ALLOWED_ORIGINS` 和 `VITE_LOCAL_HELPER_URL`。
4. 首次保存自定义规则会生成 `runtime-config.yaml` 并立即加载。为使重启后仍生效，Mihomo 的 service/launcher 应使用该 runtime 文件启动；Helper 的 `MIHOMO_CONFIG_PATH` 仍指向原始源配置。
5. 订阅更新覆盖源配置后，打开自定义规则并重新保存，Helper 会用新源配置重建 runtime；旧页面的版本会被 409 拒绝。

## 已知限制

- 托管 runtime 是从 YAML 对象重新序列化的生成物，其注释和 anchor 样式不保留；源配置字节不变。
- 只支持 `rules` 为字符串序列的常见 Mihomo YAML；不会修改外部模板或订阅生成器。
- MRS 只支持 `domain` / `ipcidr`，且需要本机 Mihomo 的转换能力。
- Explorer 搜索和排序在 Helper 内存中的已解析条目上执行；响应最多 500 条，界面固定请求 100 条，但 Helper 仍受单 Provider 文件大小上限约束。
- Helper 的写锁是单进程的；Provider 与自定义规则的版本哈希依然可防止多进程静默覆盖，但不提供分布式事务。
- 四个托管文件不可能在所有文件系统上组成单个多文件原子事务；中途 rename 失败会立即从内存中的旧源回写全部文件。
- Helper 没有独立账号系统；安全边界是 loopback/同源代理、Origin 检查和进程文件权限。

## 官方语义依据

- [Mihomo Rules](https://wiki.metacubex.one/en/config/rules/)：规则自上而下匹配。
- [Mihomo Rule Providers](https://wiki.metacubex.one/en/config/rule-providers/)：Provider 通过 `RULE-SET` 引用。
- [MetaCubeX/mihomo #1965](https://github.com/MetaCubeX/mihomo/issues/1965)：多配置/include 仍是未实现的功能请求。
