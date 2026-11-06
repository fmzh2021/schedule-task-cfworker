# schedule-task-cfworker 修复交接

2026-11-05 已完成源码修复、首次生产部署与三个任务迁移，详见[上线记录](first-release.md)。修复对象仅为本工程、`schedule-task-cfworker` 和 `TASKS_KV`。未修改 `cloud-mail` / `foxhello_mail`；没有手动触发生产任务，Cron 仍为每分钟。

## 说明原因

原始源码可在本工程 `d381bc4` 查看。`src/config.js` 的 `getAllTasks()` 缓存失效后调用 List，再逐个 Get；10 分钟模块缓存不是配额保证。最坏每分钟一个新实例，就会达到 1,440 List/UTC 日，而不是理想复用下的约 144 List/日。

交接材料记录 2026-11-04 UTC 日有 549 List（免费日额度 1,000 的 54.9%），并观察到全部 Worker 调用的执行地区分散。地区变化只能支持缓存复用率下降的推断；没有按 HTTP/Cron 拆分的历史缓存日志，不能断言平台故障、升级或调度策略变更。历史附件、截图及生产指标未在本次测试中重新读取；本地修复依据为工程源码，测试不依赖这些附件。

## 当前代码问题点

- 配额取决于 Worker 实例复用；旧 List 还没有处理分页。
- 读取失败返回 `[]` / `null`，混淆未初始化、故障、合法空任务和不存在的单任务。
- 原 PUT 在 Worker 内先读取再合并，并发局部更新可能覆盖其他字段。
- 调度使用实际开始时间；延迟跨分钟会错过原定分钟。
- 原执行日志输出任务名称、外部响应正文及原始异常，可能带出敏感信息。

## 代码错误位置

原始 `d381bc4:src/config.js`：`getAllTasks/getTask/saveTask/deleteTask`；原始 `src/index.js`：PUT 路由、`handleScheduledTask/executeTask`。`src/cron-parser.js` 原 UTC+8 换算还依赖宿主时区；现已改成从时间戳直接加八小时，保持 Worker 的 UTC+8 含义，也使本地验证不受系统时区影响。Cron 字段的原有匹配规则保持不变。

## 修改方案

### 存储选择与一致性

采用单个 SQLite Durable Object **统一管理全部读写和调度读取**。

| 方案 | 每日 1,440 次冷启动调度的 KV 用量 | 修改可见性 | 取舍 |
| --- | --- | --- | --- |
| KV 固定集合键 + DO 串行写入 | 约 1,440 Get、0 List | KV 跨节点传播延迟 | 读便宜，但禁用/删除仍可能短时执行旧配置；还需可靠发布队列 |
| 本次实现：DO 统一读写 | **0 Get、0 List、0 Put、0 Delete** | DO 提交后，后续读取取得已提交状态 | 每分钟一次 DO 请求，增加 DO 依赖及集中访问延迟 |

当前源码将任务保存在 **DO SQLite** 的显式 `tasks` 表，每个任务一行；`scheduler_state` 保存运行状态、数量、revision 和摘要。v3 支持 Data Studio 直接编辑任务列，SQLite 触发器同步 JSON 并标记待校验变更，下次 DO 读取事务更新数量、摘要和 revision；正常 SQL 删除视为合法删除，表结构/元数据丢失仍报错，详见 [直接编辑说明](datastudio-editing.md)。最初修复版本使用的 DO storage 键 `scheduler:tasks:v1` 会在首次访问时自动完整转换并备份，不读取过时的旧 Workers KV。详见 [SQL 表升级及 Data Studio 说明](sqlite-tables.md)。`TASKS_KV` 只保存旧 `task:*` 和不可变管理备份；CRUD 和 Cron 没有 KV 回退分支。特意不保留应用层任务缓存；日志 `cacheHit:false` 指应用层没有缓存，不代表平台内部 storage 缓存。

所有 Worker 通过 `SCHEDULER_STORE.idFromName('scheduler-tasks-v1')` 访问同一个对象。任务合并与保存放在 storage transaction 内。DO 内的请求队列用于防止管理导出与恢复写入交错；跨实例安全来自固定 DO 身份、持久化状态和事务，绝不是边缘模块锁。重建 DO 实例也不会丢失数据。

状态中包含版本、revision、任务数量、内容摘要及历史 ID 集合。当前方案面向三个小配置；每次事务替换这几个任务行，备份仍用 DO storage KV API 保存完整快照，受单值大小限制，不适合未经评估直接扩大到大量大任务。

DO 后续读取不会受 KV 传播延迟影响。不过在修改之前已经读到旧任务的执行可能继续完成；不提供取消已发请求或全局 exactly-once 保证。Cron 平台重试也可能造成重复执行，任务端应自行幂等。本修复不会补跑迁移维护期间错过的分钟。

KV 仍是最终一致：旧记录、备份写入和旧格式回滚通常可能需要 60 秒或更久才在其他节点可见，包括不存在键的负缓存。重复扫描只能发现差异，无法证明全网即时一致。迁移用**独立完整清单**约束内容，DO 完成原子提交后不再从 KV 加载任务。KV 故障不会影响已迁移后的正常调度。

### 配置与兼容性

`wrangler.toml` 已补充：

```toml
[[durable_objects.bindings]]
name = "SCHEDULER_STORE"
class_name = "SchedulerStore"

[[migrations]]
tag = "v1-scheduler-store"
new_sqlite_classes = ["SchedulerStore"]
```

Cron 保持 `* * * * *`，原 KV binding/id 沿用。原有本地 `wrangler.toml` 未提交的密钥删除改动保留，没有恢复密钥。API_KEY 通过现有环境配置注入。

这是部署时创建的 DO SQLite migration；首次生产部署已经成功创建并绑定此类。其他环境需确认目标账户支持 SQLite DO（可用于支持它的 Workers Free/Paid 账户），独立核算 DO 请求、存储与执行用量。不要更换稳定对象名称、删除绑定、删除导出类或丢弃 migrations 历史，否则可能读到另一个空集合或无法部署。各环境使用自己的 DO namespace。

原 API 的路径、成功响应、ID 生成格式、POST 同 ID upsert、PUT 局部更新、DELETE 不存在 ID 也成功、手动触发禁用任务、三种 API Key 方式和 UTC+8 均保留。原 `/`、`/api/test-cron`、OPTIONS 保持公开；无 API_KEY 时普通接口仍按旧开发模式放行。新增的 `/api/admin/*` **始终要求已配置的 API_KEY**。存储错误响应额外带稳定 `code`；不再返回空集合或假 404。

| 场景 | 行为 |
| --- | --- |
| 合法空集合（迁移时明确确认） | `GET /api/tasks` 返回 `success:true,data:[]`，Cron 成功、匹配 0 |
| 未迁移 | `NOT_MIGRATED`，503；Cron waitUntil 拒绝 |
| 集合格式、数量或摘要损坏 | `DATA_CORRUPT`，500；不执行任务 |
| DO 访问/存储失败 | `STORAGE_UNAVAILABLE`，503 |
| 迁移/回滚 KV 失败 | `KV_UNAVAILABLE`，503；不切换或解除冻结 |
| 旧源与独立清单不一致 | `MIGRATION_MISMATCH`，409 |
| 备份在 KV 尚不可见/内容不符 | `BACKUP_NOT_VISIBLE`，503 |
| 回滚验证不一致 | `ROLLBACK_MISMATCH`，409；不允许宣布回滚就绪 |
| 回滚冻结期间写入 | `WRITES_FROZEN`，409；读取、现有调度仍可用 |
| 任务请求失败 | `TASK_EXECUTION_FAILED`；所有匹配任务执行完后 Cron 明确失败 |

### 一次性迁移步骤（历史操作流程）

本工程生产环境已按此流程完成迁移，不需要再次执行。以下保留为新环境迁移和恢复操作参考；实际记录与私有备份位置见[首次上线记录](first-release.md)。

迁移是维护窗口操作，不是零停机升级。提交前的新 Worker 不读旧格式，CRUD 写入关闭、调度明确报错；可在维护窗口暂时暂停触发，完成后恢复相同的每分钟配置。不要在此状态长期运行。没有自动兼容模式每分钟 List。

1. 保存当前部署版本、Cron、绑定和环境配置。冻结**所有**旧格式写入：管理客户端、脚本、Dashboard 手工编辑、其他旧部署/路由。部署本修复代码以后，它的未初始化状态会拒绝 CRUD 写入；仍必须确保旧版本请求已经排空，旧预览/版本路由不再接受写入。`--source-frozen` 只是操作员声明，不能替你撤销旧部署。不能只改变模块锁或只停某一实例。
2. 从可信完整源取得三个任务的完整配置与 ID，妥善保存为私有文件。例如冻结后核对 Dashboard 中的三个已知 ID 与内容，或核对已有权威导出。单次 KV List 可能因最终一致性漏项，**不要把迁移端自身扫描结果直接当独立清单**。若没有独立清单，先补齐材料，不能保证完整迁移。
3. 在本修复部署前后都保持旧写入冻结，等待并检查旧数据稳定；不能将“等了 60 秒”当作一致性证明。部署新代码后用状态接口确认未初始化。
4. 使用管理脚本生成本地清单。Node.js 22；输入支持任务对象数组，或 `[{"key":"task:ID","value":"原始 JSON 字符串"}]`。缺少对象内 id 时按键名补齐；键名与 id 不符、重复 ID、非法配置均拒绝。

```sh
mkdir -p ~/.scheduler-private
chmod 700 ~/.scheduler-private
node scripts/scheduler-admin.mjs manifest \
  ~/.scheduler-private/legacy-export.json \
  ~/.scheduler-private/expected.json
```

本例应得到 `taskCount:3`。真正无任务的新部署，必须核实后给 manifest 命令追加 `--allow-empty`；并不是把读故障当成空集合。输出文件请求权限 0600（请使用支持 Unix 权限的本地文件系统），不要放进版本库、公共网盘或日志。

5. 在终端安全设置 `SCHEDULER_URL` 和 `SCHEDULER_API_KEY`。API Key 使用现有配置，不放命令行参数、URL或截图。URL 指向这个调度器。脚本只发往显式配置的地址、不跟随重定向。以下用命令行占位 `<id>` 表示上一步返回值，运行时替换占位本身。

```sh
node scripts/scheduler-admin.mjs status
node scripts/scheduler-admin.mjs prepare \
  ~/.scheduler-private/expected.json --source-frozen
```

准备阶段会：分页 List（只查 `task:` 前缀，包括空中间页）、逐键读取、两遍扫描、对照全部 ID 和内容 SHA-256、构建数量/摘要一致的快照、保存 DO 原始备份，最后向 KV 发布不可变备份。未知字段和原始 JSON 都保留。**此时没有切换，旧任务键不变。** 返回 `id/backupKey/taskCount/revision/digest`，不返回敏感配置。

备份位置：DO storage 与 TASKS_KV 的 `scheduler:backup:v1:<id>`；DO 同时用 `migration-candidate:v1` 保存候选引用。KV 写入失败时保留 DO 候选，可重跑 prepare，不能伪造成功。

6. 下载可审阅备份，再提交同一个候选：

```sh
node scripts/scheduler-admin.mjs backup <id> ~/.scheduler-private/migration-backup.json
node scripts/scheduler-admin.mjs commit <id> --source-frozen
node scripts/scheduler-admin.mjs status
node scripts/scheduler-admin.mjs export ~/.scheduler-private/after-migration.json
```

提交前再检查 KV 备份的完整内容可见、重新分页核对旧源与原清单一致，然后一次 DO 事务激活集合。提交失败不能激活部分任务；成功后状态应为 `migrated:true,mode:active,taskCount:3`。核对导出内容/摘要后恢复管理客户端和每分钟调度。

7. 如 `BACKUP_NOT_VISIBLE/KV_UNAVAILABLE` 或暂时的源不一致，保持冻结、排查后重试；避免紧密循环（同 KV 键写入还有限速），通常至少间隔 60 秒并再次核验。两次扫描相同但不匹配独立清单也**不能强行提交**。旧源确实需要更改时，在没有激活集合的前提下执行 `discard`，保留全部旧 DO/KV 备份，再用重新核验的独立清单 prepare。已激活之后 discard 被拒绝。

```sh
node scripts/scheduler-admin.mjs discard
```

已激活之后重复 prepare/commit 只返回 `alreadyMigrated:true`，即使传来旧候选或 KV 故障也不会再次 List、覆盖新状态。不要为重跑迁移更换 DO 名称。

### 日志与运行观察

- `schedule_started/finished/failed`：原定 UTC 时间、实际开始时间、延迟毫秒、时间来源、匹配/成功/失败数量。优先使用 `event.scheduledTime`，只有缺少有效时间戳才用当前时间。
- `tasks_loaded`：数据源、revision、任务数、应用缓存状态、KV 操作数（全零）。
- `store_operation`：实际管理请求的 Get/List/Put/Delete 计数；正常读写为全零。
- `task_response/task_failed`：HTTP 状态或稳定错误码。

不记录任务名、任务 URL、ID、请求 headers/params/body、外部响应正文、API Key、查询串或原始异常。认证失败也不输出带用户路径/查询的 URL。带任务数据的导出/备份接口需要鉴权且输出敏感文件，不能当普通日志分享。

## 修改的代码点

| 文件 | 内容 |
| --- | --- |
| `src/config.js` | 固定名称 DO 客户端；所有任务接口共享同一数据源，无模块任务缓存 |
| `src/scheduler-store.js` | SQLite DO、事务化增删改查、迁移状态机、不可变备份、回滚冻结与恢复 |
| `src/sql-task-storage.js` | 显式 tasks/state/schema 表、当前 DO 记录自动转换、完整备份及防止过时回退 |
| `src/editable-task-storage.js` | v3 可编辑列与 JSON 双向同步、代次检查及摘要更新、SQL 冻结、v2 完整升级备份 |
| `src/storage-format.js` | 数据格式、数量/ID/摘要验证、稳定错误码与安全异常 |
| `src/legacy-kv.js` | 仅管理路径使用的分页 KV、操作计数、源数据校验 |
| `src/index.js` | 原 API 接入 DO；PUT 事务内合并；scheduledTime；安全日志；Cron 失败可观察 |
| `src/cron-parser.js` | UTC+8 不依赖宿主时区；避免输出未经处理的 Cron 数据 |
| `scripts/scheduler-admin.mjs` | 离线 manifest 和带鉴权的迁移/导出/回滚客户端，敏感文件权限 |
| `wrangler.toml` | DO binding 与 SQLite migration，保持分钟 Cron |
| `test/` | 模拟 KV/fetch/持久存储、1,440 冷实例、并发与错误覆盖，以及 workerd 集成验证 |
| `package.json/package-lock.json` | ESM、测试与 dry-run 脚本、固定本地 Miniflare 版本 |

## 验证方式与实际结果

仅模拟数据；测试中外部 fetch 全部拦截，无真实通知、生产任务 URL 或 GitHub workflow。workerd 使用临时本地 KV/SQLite，未使用远程 namespace；build 为 `--dry-run`，不是部署。执行环境 Node.js 22.22.0、Wrangler 3.114.15、Miniflare 3.20250718.2。

```sh
npm test
npm run test:runtime
git diff --check
```

实际验证结果见同目录 [validation-results.md](validation-results.md)。`npm run test:runtime` 会先打包，然后在 workerd 中使用 `useSQLite:true`；全部外部网络目的地由 `outboundService` 模拟响应拦截。

## 回滚建议与步骤

优先回滚业务代码时继续保留当前 **SQL 存储层**、DO 对象名称和 migration，任务最新状态无需搬迁。SQL 转换后，升级前的 DO 单键代码会明确拒绝格式标记；不要直接发布升级前整个版本。**不能把迁移前保留的旧 `task:*` 或 SQL 转换原始备份直接当最新状态**：它们不会随新 CRUD 自动更新。

如果必须恢复到旧 KV 读写版本，按以下维护流程导出**最新**状态：

1. 保持旧版本和旧写入者关闭，计划维护窗口并暂停定时执行，防止新旧调度重叠；保留当前 DO 绑定和全部备份。
2. 执行 `rollback-prepare`。同一个 DO 事务冻结新写入并保存最新 revision 的不可变备份；此前已经提交的创建、更新、禁用、删除都包含在内。普通读取仍可用，但不能再变更集合。

```sh
node scripts/scheduler-admin.mjs rollback-prepare
node scripts/scheduler-admin.mjs backup <rollback-id> ~/.scheduler-private/latest-rollback-backup.json
node scripts/scheduler-admin.mjs export ~/.scheduler-private/latest-before-rollback.json
node scripts/scheduler-admin.mjs rollback-restore <rollback-id>
```

3. restore 首先发布并确认 KV 备份，然后逐键写回最新 `task:*`；删除历史 ID 和分页枚举中已不属于最新集合的旧键，避免删除任务复活。最后两遍分页清单校验，并点查已删除的历史键应不存在，成功才返回 `ready:true`、将 mode 标为 `rollback-ready`。即使 List 暂时漏了一个旧键，持久化历史 ID 也能发出明确删除。重复成功请求只返回同一份就绪结果，不重复写 KV。
4. 任一失败都保持冻结，最新 DO 集合及备份不变。修复后使用同一 rollback-id 重试，不能切换旧代码。部分写回是可重入的，不靠跨 KV 键事务；失败期间旧代码必须持续关闭。
5. `ready:true` 只表示当前访问路径校验通过，**不证明其他节点 KV 缓存即时更新**。继续等待传播、按已知完整 ID/内容核验计划使用的旧版本读取结果。旧版本部署期间保持 Cron 与写入暂停，核验与最新导出一致后再开放。普通固定等待没有全网一致性保证；若业务不能接受这段不确定性，就保持 DO 读写，不进行旧格式回滚。
6. 回退旧入口时仍需保留 `SchedulerStore` 导出、实现文件、DO binding 和 `v1-scheduler-store` migration 历史；不能直接将整个目录 checkout 到迁移前而丢掉已创建的类。旧 API 入口可以继续访问恢复后的 `TASKS_KV`。若最新集合已超过旧 `getAllTasks()` 的单页上限，旧入口还必须先补齐分页，否则不能回退；本次三任务不触发此上限。
7. 旧 KV 版本重新开放后，原 List 配额风险也会回来，此回滚只作为临时恢复。DO 会保持冻结且保留最新快照，不自动清理。若决定放弃回滚并继续此修复，先确认**没有**旧格式写入者、仍运行修复入口，再执行：

```sh
node scripts/scheduler-admin.mjs rollback-resume
```

resume 按冻结的最新 DO 状态恢复写入；不会重新导入 KV。若旧版本已经接受新写入，DO 中的冻结状态便不再是最新，不能直接 resume；必须再次冻结旧写入、保全新的权威导出并另行审阅同步方案。

迁移原始备份、历次回滚备份和旧任务键默认不自动清理。清理应另开维护事项，先验证私有离线备份可用，不能用 TTL 自动到期代替审阅。
