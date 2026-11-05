# 本地验证结果

日期：2026-11-05（Asia/Shanghai）。仅本地数据，没有部署，没有操作远程 KV，没有真实通知、线上任务或 GitHub workflow 调用。

## 执行结果

| 命令 | 结果 |
| --- | --- |
| `npm test` | **39 / 39 通过，0 失败**；本次最终运行约 6.34 秒 |
| `npm run test:runtime` | **1 / 1 通过，0 失败**；本次最终 workerd 测试约 1.49 秒（不含前置打包） |
| 前置 `wrangler deploy --dry-run --outdir dist` | 成功；37.70 KiB / gzip 9.62 KiB；识别 `SCHEDULER_STORE:SchedulerStore` 与 `TASKS_KV`；输出明确为 `--dry-run: exiting now` |
| `git diff --check` | 退出码 0，无空白错误 |

环境：Node.js 22.22.0、Wrangler 3.114.15、Miniflare 3.20250718.2。现有 Wrangler 会显示版本提示，本次没有升级或改变部署行为。依赖锁文件使用 `npm install --package-lock-only --ignore-scripts --offline --no-audit --no-fund` 更新，未执行安装脚本。

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

## workerd / SQLite 验证

使用实际本地 workerd 的 SQLite Durable Object（`useSQLite:true`）及临时本地 KV，加载 dry-run bundle。所有出站请求均由 `outboundService` 拦截并返回模拟响应，包括意外目的地；从不透传真实网络。

验证流程：迁移一条模拟任务 → 12 个并发局部字段更新 → 读取全部 12 个字段 → 使用原定时间触发且只产生一次模拟请求 → 冻结最新快照 → 恢复旧 KV → 读回全部 12 个最新字段。实际 scheduled outcome 为 `ok`。

此次单任务 workerd 管理计数：准备迁移 `get:3,list:2,put:1,delete:0`；提交迁移 `get:2,list:1,put:0,delete:0`；回滚恢复 `get:5,list:3,put:2,delete:0`。中间的 12 个更新、详情读取和分钟调度的 KV 操作全部为零。这些管理用量不属于正常每分钟路径。

## 验证边界

本地模拟不能证明真实 KV 跨地区传播时间、历史平台内部原因、目标账户 DO 配额或生产任务端的幂等性。旧任务的真实配置未读取或迁移，部署和生产迁移仍需按 [交接步骤](repair-handoff.md) 在维护窗口执行。迁移必须有冻结后的独立完整清单；回滚到旧 KV 版本必须继续核验传播，单节点的 `ready:true` 不保证全网即时一致。
