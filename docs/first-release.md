# 首次迁移已完成，后续如何发布

## 你现在需要做什么

首次部署和 KV → Durable Object 迁移已经代办完成，修复已合并 GitHub `master`。后续功能分支合并、推送到 `master`，工作流会自动运行测试、打包、Cloudflare 配置检查，通过后发布。**不需要每次再迁移数据，也不需要手工重建任务。**

`SCHEDULER_AUTO_DEPLOY_ENABLED=true` 已由 GitHub runner 确认。这个开关、两个部署 Secrets 和当前 `wrangler.toml` 需继续保留。普通任务增删改由线上 API 写入 DO，和代码发布分开管理。

首次部署使用本地现有的 Cloudflare OAuth 登录；随后 `a1e3e91` 的 [master Actions](https://github.com/fmzh2021/schedule-task-cfworker/actions/runs/41987373248) 已成功完成自动发布，验证了 GitHub 部署凭据的写权限，版本为 `9da4765a-7d45-43df-9fdd-764063dfdef5`。之后的发布仍以 `Deploy schedule-task-cfworker` 成功为准；失败时先看对应 job，不要重复迁移或清空 DO。

当前新增的显式 SQLite 表升级在第一次 API/Cron 访问时自动转换**当前 DO** 的最新记录，不重新读取旧 KV。Data Studio 查看方法和回退限制见 [SQL 表操作说明](sqlite-tables.md)。

## 2026-11-05 实际操作记录

- 北京时间约 15:14，部署提交 `052b0c7`，Cloudflare 版本为 `6840986c-b18d-4c74-98c9-2e7f6630d7ae`。首次部署退出码 0，使用 `--keep-vars` 保留线上鉴权变量。
- 上线前从旧任务 API 导出三个任务，并通过 Cloudflare KV API 分页枚举、逐键读取，核对 ID 和完整内容摘要一致。源码、部署记录、设置、Cron 和任务配置均已私有备份。
- 关闭旧版本预览 URL，避免旧代码入口继续写入 `task:*`；新正式版本占 100% 流量，未初始化期间拒绝任务写入。迁移前已通知用户暂时不要修改任务，未使用模块锁冒充全局冻结。
- prepare 对照独立导出清单校验旧 KV，保存 DO/KV 备份；下载备份再次验证摘要，再 commit 原子激活任务集合。
- 迁移后管理状态为 `migrated:true, mode:active, taskCount:3, revision:1`；DO 导出与迁移前完整清单一致。常规 `GET /api/tasks` 返回 200，三个任务的全部字段再次校验一致。
- 通过 Cloudflare API 核实 Cron 仍是 `* * * * *`。迁移窗口内没有配置任务的匹配分钟，下一次匹配为北京时间 15:30；没有手动调用任务触发接口。
- 原 `task:*` 没有删除。正常任务读写和分钟调度均使用 DO；旧 KV 不再随 CRUD 更新，只保留为迁移历史及恢复材料。

## 备份在哪里

本次私有操作目录：`~/.scheduler-private/2026-11-05-first-migration-verified/`。目录权限为 0700，敏感文件为 0600，未提交 Git。包含原 Worker 模块、原设置与部署记录、旧 API/KV 导出、独立校验清单、DO 原始备份、迁移后导出、状态与发布日志。目录内含现有鉴权信息和任务凭据，不能上传到仓库或公开日志。

DO 和 `TASKS_KV` 中的不可变迁移备份也保留。本地 `migration-prepared.json` 记录备份标识。已准备保留 `SchedulerStore` 类的旧入口回退文件，并通过 dry-run 打包；未实际执行回退。

## 不要直接回退到迁移前版本

迁移前实现可在 Git 历史查看。DO 激活之后，新建、更新、删除的最新状态只在 DO 中；旧 KV 会逐渐过时。直接发布旧代码可能恢复过时配置。显式 SQL 转换成功后也不能直接发布旧 DO 单键版本；保留 SQL 存储层回滚业务修改，或按下述流程恢复最新旧格式。

需要恢复旧 KV 入口时，必须先从 DO 冻结并导出最新状态，再恢复 KV、完整校验，最后发布保留 DO 类和迁移历史的回退入口。详细命令见[修复交接文档的回滚步骤](repair-handoff.md#回滚建议与步骤)。

完整的[首次迁移与回滚操作说明](repair-handoff.md#一次性迁移步骤历史操作流程)、[GitHub Actions 配置说明](github-actions-deployment.md)继续保留，供重建环境或排障时使用。
