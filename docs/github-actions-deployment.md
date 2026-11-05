# GitHub Actions 自动部署

## 当前部署方式与核查范围

工程的发布入口是 `package.json` 中的 `npm run deploy`，实际执行 `wrangler deploy`。Wrangler 根据根目录 `wrangler.toml` 打包 `src/index.js`，发布到 `schedule-task-cfworker`，同时应用 `TASKS_KV`、`SCHEDULER_STORE`、SQLite DO migration 和每分钟 Cron 配置。`npm run build` 只是 `--dry-run`，不会发布。

修改前仓库没有 `.github/workflows` 或 `.gitlab-ci.yml`；README 给出 `wrangler login` 后手动发布的步骤。只凭仓库不能判断历史版本究竟通过 CLI 还是 Dashboard 上传，也没有查询 Cloudflare Dashboard 的 Workers Builds 配置。

2026-11-05 只读核查 GitHub：仓库为 `fmzh2021/schedule-task-cfworker`，首次核查没有已有 workflow/run；默认分支已从 `feature/f-20251206-alertPlatform` 改为 `master`。本地 Git 远端 `github` 指向该仓库，`origin` 仍是 GitLab。核查时 `master` 还停留在旧代码，需要将完整修复分支合入，而不能只复制本 workflow 到旧版 master。

当前凭据查询 GitHub Actions Secrets 名称时返回 403，因此**没有确认 Secrets 是否已经配置**，也没有读取密钥值、修改 GitHub 设置或触发生产发布。

## 自动部署流程

文件：`.github/workflows/deploy.yml`。

```text
向 GitHub master 推送 / 向 master 合并 PR
    → npm ci
    → 39 项模拟测试
    → dry-run 打包 + 本地 workerd / SQLite 集成测试
    → 检查首次迁移开关
    → 检查该提交仍是 master 最新提交
    → wrangler deploy --keep-vars
```

| 事件 | 测试及打包 | 发布 |
| --- | --- | --- |
| PR 目标为 master | 执行 | 不发布，不提供 Cloudflare 凭据 |
| push 到 feature/** 或 codex/** | 执行 | 不发布，不提供 Cloudflare 凭据 |
| push 到 master，启用变量未设或不是 `true` | 执行 | 跳过，提示首次迁移要求 |
| push 到 master，启用变量为 `true` | 执行 | 验证全部通过后发布 |
| 在 master 手动运行 workflow | 执行 | 同样受启用变量约束 |
| 在其他分支手动运行 workflow | 执行 | 不发布 |
| 只在本地 commit，或只推送 GitLab | 不触发 GitHub 事件 | 不发布 |

一个生产发布结束后才处理下一个发布，不在中途取消部署。若旧提交的验证比新提交晚结束，发布前会检查 GitHub master 当前 SHA，跳过已过期的提交，防止旧版本覆盖新版本。测试及安装阶段不注入 Cloudflare 部署密钥。Actions 固定为已核实的 v6 commit SHA，Node.js 使用项目已验证的 22，Wrangler 使用 `package-lock.json` 锁定的版本。

任务执行仍由 `* * * * *` 触发；GitHub Actions 只部署代码，不执行配置中的 HTTP 任务，也不自动导入旧 KV。Wrangler 的 SQLite class migration 仅创建/升级 DO 存储，并不会迁移 `task:*` 业务数据。

## 需要设置的配置

到 GitHub 仓库 **Settings → Secrets and variables → Actions**：

| 类型 | 名称 | 用途 |
| --- | --- | --- |
| Repository secret | `CLOUDFLARE_API_TOKEN` | Cloudflare 部署 API Token |
| Repository secret | `CLOUDFLARE_ACCOUNT_ID` | `schedule-task-cfworker` 所在账户 ID |
| Repository variable | `SCHEDULER_AUTO_DEPLOY_ENABLED` | 完成首次部署与任务迁移后设为小写 `true`，启用自动发布 |

部署 Token 按 Cloudflare 官方 **Edit Cloudflare Workers** 模板创建，只授权目标账户，并确保能够发布此 Worker、使用现有 KV binding 和创建 DO class migration。不要使用任务接口的 `API_KEY` 作为 Cloudflare 部署 Token；它们用途不同。

Worker 现有的 `API_KEY` 保留在 Cloudflare，推荐使用 Worker Secret 保存；CI 不需要它，也不会输出它。发布带 `--keep-vars`，避免 Wrangler 默认清除 Dashboard 中未写入配置文件的普通变量。该选项保留已有变量，**不会创建缺失的 API_KEY**：首次启用前仍需确认线上已经配置有效 API_KEY。现有 Worker Secret 由 Cloudflare 保留。

本地 `.dev.vars` 被 Git 忽略，不会自动出现在 GitHub runner 或线上环境中。不要把其内容写进 workflow、仓库变量或日志。CI 缺少上述两个部署 Secret 会明确失败，不会进行交互式登录。

## 首次启用步骤

1. 将完整修复分支及 workflow 合入 GitHub 的 `master`。保持 `SCHEDULER_AUTO_DEPLOY_ENABLED` 未设置或为 `false`，这样首次合入只验证，不会切换线上未迁移的任务存储。
2. 配置两个部署 Secret。确认 `wrangler.toml` 中 Worker 名称、KV namespace、DO binding 和 migration 历史属于目标生产环境。已有 namespace 不要重新创建或替换。
3. 若本次 DO 业务数据迁移尚未做，按 [修复交接文档](repair-handoff.md) 安排维护窗口，冻结旧格式写入，核对独立完整清单，完成受控首次部署与 prepare/commit。首次发布可以在本地登录后执行：

   ```sh
   npm ci
   npm test
   npm run test:runtime
   npx wrangler login
   npm run deploy -- --keep-vars
   ```

   这一步会实际发布，应与维护窗口衔接。新版本部署到 prepare/commit 完成之间会报 `NOT_MIGRATED`；不要把 workflow 中的创建 DO migration 当成业务迁移完成。
4. 按交接文档使用管理脚本确认状态为 `migrated:true, mode:active`，任务数和导出内容与独立清单一致，恢复每分钟调度。若已经完成本次迁移，则核实状态后跳过重复迁移。
5. 在 GitHub **Variables** 中将 `SCHEDULER_AUTO_DEPLOY_ENABLED` 设为 `true`。这个变量只是发布开关，不会代替业务迁移或状态检查。以后 push 到 GitHub master 或合并 PR 到 master 即自动验证并发布。

本地两个远端的名称不同。显式推送 GitHub master 的命令是：

```sh
git push github master
```

推送 `origin/master`（GitLab）不会触发本 GitHub workflow。GitHub 默认分支已设为 `master`，与发布分支一致；push 自动触发本身不依赖默认分支。手动 `workflow_dispatch` 要求 workflow 也存在于默认分支，首次合入前可通过推送功能分支或面向 `master` 的 PR 验证。

## 发布结果与暂停方式

- 在 GitHub **Actions → Verify and deploy scheduler** 查看测试与发布结果；门禁关闭时 deploy job 显示跳过，属于预期行为。
- Wrangler 发布输出包含版本/部署结果。代码发布成功后，结合现有管理状态与调度日志核对；本 workflow 不会自动调用手动触发任务的接口。
- 关闭自动部署：把 `SCHEDULER_AUTO_DEPLOY_ENABLED` 设为 `false`。这不会停止当前 Worker 的每分钟调度。
- 已在运行中的发布不会因为变量改为 false 自动取消；需要查看该次运行状态。
- 如果 Cloudflare Dashboard 另有 Workers Builds 或其他发布来源，应明确只使用一个自动发布来源，避免同一 commit 重复部署；本次未调整 Dashboard 设置。
- 回滚时保留 DO 类、binding 和 migrations 历史；恢复旧 KV 入口前先导出最新状态。不要直接部署迁移前的旧 master，步骤见交接文档。

官方参考：[Cloudflare GitHub Actions 部署说明](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)。

## 本次本地验证

2026-11-05：actionlint 1.7.12 检查该 workflow 退出码 0；39 项模拟测试、1 项 workerd / SQLite 集成测试和 dry-run 打包全部通过，`git diff --check` 通过。固定 Action SHA 已通过 GitHub tags API 核对。尚未在 GitHub runner 实际执行这个新 workflow，没有执行生产部署、触发真实任务或自动迁移。
