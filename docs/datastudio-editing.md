# 在 Data Studio 直接修改任务（schema v3）

**日常修改直接编辑对应列即可。** 修改执行时间用 `cron`；启用/禁用用 `enabled`；不必打开整份任务 JSON。本分支新增此能力；部署后状态接口应显示 `schemaVersion:3, dataStudioEditing:true`。此前已部署的 v2 仍不支持直接编辑，不要在升级完成前按本文操作。

## 改哪一列

| 想修改的内容 | `tasks` 列 | 填写示例 |
| --- | --- | --- |
| 名称 | `name` | 提醒任务 |
| 执行时间 | `cron` | `0 10 * * *`，每天 UTC+8 的 10:00 |
| 是否启用 | `enabled` | `1` 启用、`0` 禁用 |
| 请求地址 | `url` | `https://example.com/task` |
| 请求方法 | `method` | `GET`、`POST`、`PUT`、`PATCH` 等 |
| 请求头 | `headers_json` | JSON 对象，例如 `{"Content-Type":"application/json"}` |
| GET 参数 | `params_json` | JSON 对象，例如 `{"type":"daily"}` |
| 请求体 | `body_json` | JSON，例如 `{"message":"hello"}`；字符串用 `"hello"`，空值用 `null` |
| 其他未知字段或完整配置 | `config_json` | 完整任务 JSON；必须保留原 ID 和必填项 |

`headers_json/params_json/body_json` 是保存 JSON 文本的 SQL 列，双击单元格时填写 JSON 本身，无需再额外包一层引号。在 SQL 中则像普通 SQL 字符串一样引用整段 JSON。`body_json` 中的 JSON `null` 表示请求体字段为 null；SQL `NULL` 表示移除这个可选字段。`enabled` 的 SQL NULL 保持历史的“未设置”含义，调度按原规则默认启用；日常请明确填 1 或 0。

示例，在 Query 中修改某个已有任务的时间并启用：

```sql
UPDATE tasks
SET cron = '0 10 * * *', enabled = 1
WHERE id = '这里填已有任务ID';

SELECT id, name, cron, enabled FROM tasks ORDER BY position;
```

在 Data Studio 中保存修改、SQL 语句成功提交后，后续 API 查询和下一次分钟检查即可读取新值，不需要重新部署。已读取旧配置或已发出的任务不会被撤销；若错过了新规则的匹配分钟，不补跑过去的任务。

## 对应列与 JSON 如何同步

普通列和 `config_json` 两种编辑方式都支持。SQLite 触发器在同一条语句内同步另一种表示，未知字段和没有编辑的可选字段仍保留。通常只编辑对应列最直观；只有需要改额外字段时才编辑完整 JSON。

不要在一条语句中给 `cron` 列和 JSON 的 `cron` 填不同值；冲突会被拒绝，而不是随机取其中一份。任务 ID 不可直接改动。`created_at/updated_at` 也会与 JSON 对应字段同步；直接 SQL 编辑不会自动改任务的 `updatedAt`，需要时可手动设置 `updated_at`。API PUT 仍按原行为自动设置 `updatedAt`。

触发器会持久记录任务变更代次。下次 API/Cron 读取会验证配置，并在 DO 事务中更新任务数量、内容摘要和 revision。读取前的多次直接 SQL 修改会合并为一次 revision；后续重复读取不增加 revision。**无需、也不要手工修改 `scheduler_state`、`scheduler_schema`、触发器或备份键。** 单看尚未重新读取的元数据行可能仍是上一次摘要，可调用 `GET /api/admin/status` 核验最新状态。

API 与 SQL 同时更新时，DO 事务和代次检查防止旧任务集合覆盖新的 SQL 修改；发生代次冲突时重新读取并重试。对同一字段的两次明确修改仍按最终成功的写入决定值，不提供多人编辑界面的冲突合并。

## 新增、删除与错误

新增任务继续推荐原 API，它负责默认字段与 ID；手工 SQL INSERT 时需提供 `id`、未占用的非负整数 `position`、完整有效的 `config_json`，其余列自动填充。SQL DELETE 被当成明确的删除操作，允许删除后集合为空；历史 ID 仍保留，避免恢复旧 KV 时已删除任务复活。不要用 DROP TABLE 代替删除任务。

非法 JSON、非对象的 headers/params、非法启用值、ID 修改和明显的结构问题会被 SQLite 拒绝。其余配置还需通过与 API 相同的应用校验；无效 URL 或 Cron 字段数错误会导致读取明确返回 `DATA_CORRUPT`，不执行任务、不伪装成空集合。修正刚改过的单元格后可再次读取，无需重新迁移。修改任务凭据时，避免公开完整行、截图或查询结果。

回滚流程冻结之后，触发器同样拒绝 Data Studio 的 INSERT/UPDATE/DELETE，避免绕过 API 冻结导致恢复过时数据；执行原 `rollback-resume` 后才恢复写入。

## 自动升级、备份与回滚

现有 v2 对象在新版第一次访问时自动升级。读取的是当前 SQL 表的最新任务，不是过时的 `TASKS_KV` 或原始 DO 备份。完整快照、历史 ID、冻结状态、revision、JSON 的缺省/null/未知字段都保留。

建新表、复制数据、把显示列改为可写列、安装触发器、校验转换结果、保存不可变备份和激活标记放在同一个 DO 事务中；失败时恢复 v2 表，重试不会导入部分任务。备份位于内部 DO 键 `scheduler:sql:v3:backup`，包含原记录和摘要；激活标记为 `scheduler:sql:v3:activated`。首次升级本身不增加 revision，也不访问 Workers KV。对象名、绑定和 Wrangler 类迁移历史不变。

一旦升级成功，旧 v2 代码不认识 v3 schema，会明确拒绝读取。回滚业务代码必须继续保留 v3 存储层和触发器；不能把升级前整个 Worker 直接重新部署。若必须恢复旧 Workers KV 入口，使用已有的冻结、最新导出、rollback-restore 和传播校验流程；它们读取最新 v3 状态，详见 [回滚说明](repair-handoff.md#回滚建议与步骤)。

## 验证

验证仅使用模拟任务与 fetch；包括可编辑列和 JSON 双向同步、多个字段同时编辑、递归触发器开关、空值/布尔值/未知字段、v2 自动升级和失败回滚、API 并发局部更新、进程重启后同步待处理变更、禁用后不再匹配，以及 1,440 次冷启动调度的 KV 操作全为 0。真实本地 workerd 覆盖了与生产一致的 v2 表升级和直接 SQL 编辑；没有编辑生产任务或发送真实通知。
