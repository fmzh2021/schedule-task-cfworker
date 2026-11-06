# 显式 SQLite 任务表与 Data Studio

本次升级让同一个 SQLite Durable Object 中的任务从 `storage.get/put` 内部键值记录，转为 SQL API 管理的显式表。`tasks` **每个任务一行**，Data Studio 可查看和查询。现有 API、鉴权、任务 ID、分钟 Cron、UTC+8 及手动触发行为保持不变。

本文记录最初的 **v2 表结构**。后续新增的 **v3 可编辑表**支持直接改 `cron/enabled` 等列，列与 JSON 自动同步、摘要自动维护；以 [Data Studio 编辑说明](datastudio-editing.md) 为准。是否已上线 v3，查看管理状态的 `schemaVersion:3, dataStudioEditing:true`。

## 发布与自动转换

当前生产环境的三个任务已在 DO 中；原 `TASKS_KV` 不再是最新数据源。**不需要再次执行旧 KV 的 prepare/commit，也不要重新导入旧 `task:*`。**

将本次代码按现有流程合并、推送到 GitHub `master`，Actions 验证通过后自动部署。当前功能分支仅验证，不发布。无需新增 Secrets、绑定、namespace 或 Wrangler 类迁移；继续使用 `SchedulerStore`、`SCHEDULER_STORE`、`v1-scheduler-store` migration，以及固定对象名 `scheduler-tasks-v1`。

新代码第一次收到此对象的 API 或 Cron 请求时，自动执行一次转换：

1. 读取并校验**当前 DO** 的 `scheduler:tasks:v1`，包括全部任务、ID、数量和摘要。
2. 在一个 `storage.transaction()` 内建表、保存完整原记录备份、逐任务写入、重建并校验完整记录。保留任务顺序、revision、原迁移 ID、历史任务 ID 和回滚冻结状态；任务 JSON 的未知字段、缺省字段、headers/params/body 全部保留。
3. 同一事务将旧 DO 键改为明确的 SQLite 格式标记，并写入独立激活标记。旧版代码会拒绝这个标记，避免误回退时静默使用过时快照。
4. 事务完成后，所有 CRUD、查询和调度只读取 SQL 表。失败则表、行、备份、旧键和标记全部撤销；请求报错，下次请求可重试。不会启用部分任务，也不回退 List。

之后每次对象重启只校验已有结构，不重复导入备份。SQL 缺行、内容与摘要不符、元数据或整表丢失都报 `DATA_CORRUPT`，不会从旧数据自动重建。新环境没有旧 DO 数据时保持 `NOT_MIGRATED`，仍需按原有流程完成真正的首次 KV 迁移；合法空集合与未迁移不同。

转换位于同一个固定 DO 的请求队列和持久事务中，常规 API 写入排在转换完成后进行；同 ID 的局部 PUT 在事务中合并，跨 Worker 实例不会覆盖其他字段。发布沿用关闭旧预览 URL 的配置，不应另开旧版本写入入口。

发布后可通过现有管理脚本安全核验，不调用手动触发接口：

```sh
# 沿用已有的 SCHEDULER_URL、SCHEDULER_API_KEY 环境变量。
node scripts/scheduler-admin.mjs status
node scripts/scheduler-admin.mjs export ~/.scheduler-private/after-sql-upgrade.json
```

状态新增 `storageBackend:"sqlite", schemaVersion:2`。生产正常应仍为 `migrated:true, mode:active, taskCount:3`，转换本身不增加 revision。实际数量和 revision 以发布时最新任务为准。导出文件含完整凭据，保存在私有目录，不提交到 Git。

## 在哪里看任务

打开 [SchedulerStore 控制台](https://dash.cloudflare.com/91f9d5cf3e4591fba1e863bd1269d24f/workers/durable-objects/view/83d6f02b8f9a480a8a82ffc603b796ba/overview)，进入 Data Studio，选择已有对象。按页面输入方式使用唯一对象名 `scheduler-tasks-v1` 或对象 ID：

```text
68dbdc87bff4644fbc498df8e7f6629c81d567ceaa8ac64e9503c770ff01f886
```

该 ID 属于本工程现有生产 namespace。其他环境的 ID 不同；不要用 namespace ID 代替 object ID。表在升级后的首次 API/Cron 请求完成后出现；若没有表，先核实部署版本和上述状态接口，而不是创建另一个对象。

| 表 | 内容 |
| --- | --- |
| `tasks` | 每个任务一行；`id`、原顺序 `position`、完整 `config_json`，以及派生的 `name/url/method/cron/enabled/created_at/updated_at` |
| `scheduler_state` | 单行运行状态、revision、任务数量、内容摘要、原迁移 ID、回滚 ID、历史任务 ID |
| `scheduler_schema` | 单行 schema 版本和初始化状态；`initialized=0` 表示尚未迁移，`1` 表示已有权威集合，允许任务数为 0 |

常用只读 SQL：

```sql
SELECT id, name, cron, enabled, created_at, updated_at
FROM tasks ORDER BY position;

SELECT mode, revision, task_count, sha256 FROM scheduler_state;

SELECT count(*) AS actual_rows,
       (SELECT task_count FROM scheduler_state WHERE singleton = 1) AS expected_rows
FROM tasks;
```

`enabled` 为 SQLite 的 `1/0`；历史配置未设置时显示 NULL，完整 JSON 仍保留其缺省语义。需要排查特定字段时，可查询 `json_extract(config_json, '$.字段名')`。`config_json` 和 URL 可能含任务凭据，不要整行截图或把查询结果写入公共日志。Data Studio 本身需要账户对应的访问权限。

v2 的显示列从同一份 `config_json` 生成，直接 SQL 编辑不能同步摘要，可能返回 `DATA_CORRUPT`。**升级到 v3 后，直接改对应列即可，JSON、摘要和修订号由触发器及 DO 读取事务维护。** 操作方式及错误恢复见 [Data Studio 编辑说明](datastudio-editing.md)。两个版本都不支持手工改元数据或丢弃表结构。

## 备份与回滚

本次转换在 DO 内部保留不可变备份 `scheduler:sql:v2:legacy-backup`，包含原记录及 SHA-256；备份仍使用 DO storage KV API，不出现在 `tasks` 表。原迁移/回滚备份同样保留。`scheduler:sql:v2:activated` 防止误删 SQL 表后重新导入旧快照。它们均不是 Workers KV 的键，转换不访问 `TASKS_KV`。

- **转换事务未成功**：旧权威记录没有改变，可修复问题重试；旧版代码仍可读取原记录。
- **转换已成功**：任务最新状态在 SQL 中，原记录备份此后会过时。回滚业务功能时继续保留 SQL 存储层、同一个 DO、绑定和 migration 历史。不要直接发布升级前的整个版本；旧 DO 键的格式标记会使其明确报错。
- **必须恢复旧 Workers KV 入口**：使用现有 `rollback-prepare` / `backup` / `export` / `rollback-restore` 流程，冻结并从**最新 SQL** 恢复，包括新建、修改、禁用和删除；完整命令及 KV 传播等待见[回滚说明](repair-handoff.md#回滚建议与步骤)。这一恢复流程已经纳入测试。仍需保留 DO 类和历史绑定，不能直接 checkout 原始代码并部署。

本次不提供自动反向转换到旧 DO 单键格式，也不会同步写两份权威任务。旧备份是恢复材料，不能直接覆盖已经接受新修改的 SQL 数据。

## 用量与验证

每分钟一次请求同一 DO，正常调度和 CRUD 的 Workers KV Get/List/Put/Delete 都为 **0**。显式 SQL 表会产生 DO 的 SQL 行读写、请求及存储用量，按账户的 DO 套餐独立计算；不会计入 KV List。当前三个任务、低频修改的场景，每次修改在事务内替换这几个任务行和元数据；不要将该实现直接当成面向大集合的逐行增量数据库。

DO 提交后的后续读取可见最新状态，不受 Workers KV 最终一致性影响；已取走旧配置或已经发出的任务不会被撤销。旧 `TASKS_KV` 数据及管理备份仍有最终一致性延迟。

本地验证使用 Node SQLite 模拟 DO 事务，并用真实 workerd SQLite 验证转换失败、SQL/内部 KV 原子撤销、并发修改和进程重启。测试专用 SQL/种子数据入口仅在 `test/runtime-entry.mjs`，不包含在生产 bundle；全部外部 fetch 被拦截。具体结果见[验证记录](validation-results.md)。

参考：[Cloudflare Data Studio](https://developers.cloudflare.com/durable-objects/observability/data-studio/) · [SQLite API 与事务](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)。
