# 本地与生产验证结果

日期：2026-11-05（Asia/Shanghai）。本记录包含显式 SQL 表 v2 发布核验，以及后续 v3 可编辑列的本地测试。v2 生产核验没有调用任务 CRUD、手动触发或写入 SQL；自然 Cron 两次均未匹配任务，没有真实通知请求。v3 本轮仅本地与功能分支验证，没有部署或编辑生产任务。

## 执行结果

| 命令 | 结果 |
| --- | --- |
| `npm test` | **64 / 64 通过，0 失败**；本轮运行约 18.56 秒 |
| `npm run test:runtime` | **4 / 4 通过，0 失败**；本轮 workerd 测试约 3.87 秒（不含前置打包） |
| 前置 `wrangler deploy --dry-run --outdir dist` | 成功；55.77 KiB / gzip 13.60 KiB；识别 `SCHEDULER_STORE:SchedulerStore` 与 `TASKS_KV`；输出明确为 `--dry-run: exiting now` |
| `git diff --check` | 退出码 0，无空白错误 |

环境：Node.js 22.22.0、Wrangler 3.114.15、Miniflare 3.20250718.2。新增的模拟 SQL 使用 Node 内置 `node:sqlite`（会有 ExperimentalWarning），没有新增依赖。现有 Wrangler 会显示版本提示，本次没有升级依赖、修改锁文件或改变部署工作流。

## v3 可编辑列的本地核验

`test/datastudio.test.js` 验证直接修改名称、Cron、开关、方法、请求头和 JSON 请求体；开/关 SQLite 递归触发器两种情况下，多列修改均与完整 JSON/API 同步。原未知字段、缺省值、JSON null/布尔/数字/字符串/数组/对象全部保留。直接 JSON 编辑也同步回对应列；冲突的列/JSON 值、非法 JSON、非法开关及 ID 修改均被拒绝。

直接 SQL 修改后，下一次 DO 读取事务更新数量、摘要和 revision；重复读取不重复递增。直接删除允许位置空隙及合法空集合，SQL 新增任务的历史 ID 持久保留；最新回滚备份包含 SQL 修改，冻结时 SQL 增删改同样被拒绝。损坏的元数据/表继续明确报错；合法编辑通过触发器记录，不再被当成摘要损坏。

真实 workerd 新增两项验证：一项将 12 个 API 局部更新与直接 SQL 多列编辑并发，所有 API 字段、SQL 新 Cron/headers/body 和原未知字段均保留；按 UTC+8 原定分钟恰好发出一次模拟 POST，禁用后同一分钟再次检查不发请求。另一项先用旧代码建立与生产一致的 v2 表，在安装触发器时注入失败，确认事务回到完整 v2 状态；重试升级后直接改相同的 `cron` 列即可读取生效。另在持久化重启测试中，把未读取的直接 SQL 修改留到整个 workerd 退出后，重启仍能完成校验、读取新值。所有出站请求由模拟处理，未透传真实网络。

## v2 生产发布后的核验（历史记录）

功能分支 `codex/sqlite-task-tables` 已合并到 master，合并提交为 `d42bea0`。GitHub Actions 的三个 job（测试构建、Cloudflare 只读配置检查、部署）全部成功：[Actions 运行记录](https://github.com/fmzh2021/schedule-task-cfworker/actions/runs/41993793057)。Cloudflare 最新部署版本为 `42a23b1f-2130-41f1-ab41-2109bee83308`，部署时间为 2026-11-05 16:21:51（北京时间）。

发布前和发布后均通过现有管理 API 导出任务快照，3 个任务的完整 JSON、ID、顺序、内容摘要、revision 和鉴权绑定均一致。发布后状态为 `migrated:true`、`mode:active`、`storageBackend:"sqlite"`、`schemaVersion:2`、`taskCount:3`、`revision:1`；转换没有增加 revision。

通过 Cloudflare Durable Objects SQL Query API 对生产对象执行只读查询，结果如下：

```json
{
  "tables": ["_cf_KV", "scheduler_schema", "scheduler_state", "tasks"],
  "taskRows": 3,
  "stateRows": 1,
  "schemaVersion": 2,
  "initialized": 1,
  "mode": "active",
  "revision": 1,
  "quickCheck": "ok",
  "rowsWritten": 0
}
```

`tasks` 的三行 `config_json` 与派生的 `name/cron/enabled` 列逐行核对一致；查询没有写入。连续约 95 秒的线上 tail 观察捕获两个自然 Cron，结果均为 `ok`，任务数均为 3、revision 均为 1、匹配数为 0、失败数为 0；`tasks_loaded` 的 KV `get/list/put/delete` 计数全部为 0。生产核验的私有原始结果保存在 `~/.scheduler-private/2026-11-05-sql-tables-deployment/`，未提交仓库。

## 1,440 次冷实例模拟

输入三条模拟任务，触发分钟分别为 `0`、`10`、`30`，从 `2026-11-04T00:00:00Z` 起连续 1,440 分钟。每轮以不同模块 URL 重新加载 Worker 入口，重建 `SchedulerStore` 实例，只有模拟持久存储保留；没有可复用的任务缓存。入口的共享依赖均无任务内存缓存。这是本地冷启动行为模拟，不是对 Cloudflare 生产节点分配的复现。

```json
{
  "freshInstances": 1440,
  "durableObjectRequests": 1440,
  "kv": { "get": 0, "list": 0, "put": 0, "delete": 0 },
  "mockedTaskFetches": 72
}
```

迁移前置操作计数在开始 1,440 分钟验收前清零。三任务各 24 次，共 72 次外部请求全部由模拟 fetch 返回，不发生网络请求。正常调度的 KV 用量与 Worker/DO 实例是否复用无关；DO 请求和存储用量独立于 KV 免费配额核算。

## 关键覆盖

| 项目 | 实际验证 |
| --- | --- |
| 原 API 与字段 | 创建/列表/详情/更新/删除/缺失 ID/自动 ID/同 ID POST upsert；保留 headers、params、body 和 UTC+8 |
| 手动触发 | 禁用的任务仍可手动触发；删除的任务返回 404；waitUntil 被等待 |
| 并发修改 | 30 个并发创建、30 个对同一任务不同字段的并发 PUT、15 个并发删除；全部字段和其他任务保留；重建实例后仍一致 |
| 调度新状态 | 新建后可立即匹配；禁用/删除后后续读取不再执行；合法空集合正常成功 |
| 延迟触发 | 当前执行时间已远离原定时刻，仍按 `2026-11-04T16:00:00Z` 匹配 UTC+8 的 11 月 5 日零点 |
| 认证 | Bearer、X-API-Key、查询参数；拒绝无钥访问；公开 Cron 工具；OPTIONS CORS；无配置钥的普通开发模式保留而管理接口拒绝 |
| 分页 | 5 条旧任务、每页 2 条，准备阶段两次扫描共 6 List；忽略非 `task:` 键；空中间页继续；重复 cursor 拒绝 |
| 迁移完整性 | 缺任务、多任务、内容改变、ID 不符、非法 JSON、List 后键消失、两次扫描间变化全部拒绝；旧键不动、未切换 |
| 备份 | 缺少旧对象内 id 时由键名补齐；未知字段保留；原始 JSON（包括空白）完整保存；不可变 DO/KV 备份保留 |
| 重复迁移 | 新增/修改之后重复 prepare/commit 不 List、不覆盖，KV 故障也不覆盖新数据 |
| 并发迁移与事务失败 | 同时 prepare/commit 与新建选中同一迁移、不丢新任务；DO 提交失败不激活集合，重试成功 |
| 迁移 KV 故障 | List/Get/Put 故障均明确报错；DO 无活动集合；重建实例后可恢复重试 |
| 状态区分 | 未迁移、合法空集合、集合结构损坏、摘要损坏、DO 存储/连接故障分别验证，调度错误明确拒绝，无 List 回退 |
| KV 传播 | 备份暂不可见阻止 commit；旧源变化阻止 commit；旧格式恢复仍旧时阻止 rollback-ready |
| KV 停机 | 已迁移后的调度成功且不发任何 KV 请求 |
| 最新状态回滚 | 更新后的敏感 headers、新增任务、已删除任务全部正确处理；写入冻结；重建实例可恢复；重复完成请求幂等 |
| 回滚失败 | Get/Put/Delete/List 故障全部保持冻结及最新 DO 快照，重试成功 |
| KV List 漏旧键 | 持久化历史 ID 仍对已删除任务发出明确删除，防止旧任务复活 |
| 安全日志 | 注入任务名、URL/query、认证 header、params、body、外部响应、provider 错误的哨兵字符串，确认日志均不含这些字符串或 API Key |
| 管理脚本 | 独立导出生成清单、重复 ID 拒绝、空清单显式确认；离线操作无 fetch；导出文件 0600；模拟鉴权请求不跟随重定向，敏感内容不打印 |
| DO → SQL 转换 | 两个任务各一行，生成列可查询，完整 JSON、未知字段、缺省值、顺序、revision、历史 ID、迁移 ID 全保留；合法空集合和两种回滚冻结模式保留 |
| 转换失败 | 非法原记录不建表；第二行插入失败或最后激活标记写入失败时，DDL、全部行、内部 KV 备份及旧键变更全部撤销；同一实例重试成功 |
| SQL 事务 | 元数据写入失败时，已删除/替换的任务行整体恢复，重建实例后原 revision 和内容不变 |
| SQL 损坏 | 删除状态、丢 tasks 表、丢全部表、损坏摘要、错误激活标记、表存在但标记丢失均明确拒绝，无旧备份/KV 回退；v3 合法任务编辑与删除使用触发器记录并校验 |
| 防误回退 | 转换后旧 DO 单键是格式标记，旧记录校验明确拒绝；原完整记录仅保留为带摘要备份，修改后重启不会重导入旧数据 |

## workerd / SQLite 验证

使用实际本地 workerd 的 SQLite Durable Object（`useSQLite:true`）及临时本地 KV，加载 dry-run bundle。所有出站请求均由 `outboundService` 拦截并返回模拟响应，包括意外目的地；从不透传真实网络。

验证流程：迁移一条模拟任务 → 12 个并发局部字段更新 → 读取全部 12 个字段 → 使用原定时间触发且只产生一次模拟请求 → 冻结最新快照 → 恢复旧 KV → 读回全部 12 个最新字段。实际 scheduled outcome 为 `ok`。

新增检查：通过 SQL `SELECT` 确认 `tasks` 的真实行及生成列与 API 完全一致；独立测试先在实际 workerd 中故意让混合 SQL DDL/行与 DO storage KV 事务失败，确认全部撤销。再写入模拟的当前 DO 单键集合（revision 23、两个任务），在第二个 SQL 任务行处注入错误，核实没有表、没有备份/标记、旧权威记录未改；重试自动转换成功。API 更新到 revision 24 后，关闭整个 workerd 进程、以同一临时持久目录启动新进程，确认最新 SQL 状态不变、原记录备份不变。此测试的出站请求为 0。

模拟存储也运行真实 SQLite SQL，使用 SAVEPOINT 仅模拟 DO 的事务 API；生产 SQL 不执行 BEGIN/SAVEPOINT。实际 workerd 使用 `storage.transaction()` 证实 SQL 与内部 KV 在一个事务中原子提交/撤销。测试专用 SQL/种子数据入口位于 `test/runtime-entry.mjs`，不被生产入口引用，也不进入 dry-run bundle。

此次单任务 workerd 管理计数：准备迁移 `get:3,list:2,put:1,delete:0`；提交迁移 `get:2,list:1,put:0,delete:0`；回滚恢复 `get:5,list:3,put:2,delete:0`。中间的 12 个更新、详情读取和分钟调度的 KV 操作全部为零。这些管理用量不属于正常每分钟路径。

## 验证边界

本地模拟不能证明真实 KV 跨地区传播时间、历史平台内部原因、目标账户 DO 配额或生产任务端的幂等性。v3 本轮没有读取或修改生产任务；直接编辑能力的实际生效须在 v3 发布后核验 `schemaVersion:3, dataStudioEditing:true`，见 [编辑说明](datastudio-editing.md)。旧 KV → DO 的首次迁移已经完成，不应重跑；其他新环境迁移仍必须有冻结后的独立完整清单。回滚到旧 KV 版本必须继续核验传播，单节点的 `ready:true` 不保证全网即时一致。
