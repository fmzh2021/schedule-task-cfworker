# Schedule Task Cloudflare Worker

Cloudflare Worker 定时任务调度项目，用于在指定时间自动调用 API 接口发送通知。

## 功能说明

- **定时任务**：每月 6 日 10 点的 0、10、30 分自动执行
- **API 调用**：自动调用 `notice.xmwefun.cn` 接口发送通知
- **测试接口**：可通过访问 `/trigger` 路径手动触发任务

## 项目结构

```
schedule-task-cfworker/
├── src/
│   └── index.js          # Worker 主文件，实现定时任务逻辑
├── wrangler.toml         # Cloudflare Worker 配置文件
├── package.json          # 项目配置和依赖
├── .gitignore           # Git 忽略文件
└── README.md            # 项目说明文档
```

## 使用方法

### 1. 安装依赖

```bash
npm install
```

### 2. 本地开发测试

```bash
npm run dev
```

启动后，可以通过访问 `http://localhost:8787/trigger` 来手动触发任务进行测试。

### 3. 部署到 Cloudflare

#### 首次部署

首次部署需要先登录 Cloudflare 账号：

```bash
npx wrangler login
```

然后执行部署：

```bash
npm run deploy
```

#### 后续部署

直接执行：

```bash
npm run deploy
```

## 配置说明

### Cron 表达式

定时任务配置在 `wrangler.toml` 文件中：

```toml
[[triggers.crons]]
cron = "0,10,30 10 6 * *"
```

- `0,10,30` - 分钟（0分、10分、30分）
- `10` - 小时（10点）
- `6` - 日期（每月6日）
- `*` - 月份（每月）
- `*` - 星期（任意）

### 修改 API 地址

如需修改 API 地址或参数，请编辑 `src/index.js` 文件中的 `apiUrl` 变量：

```javascript
const apiUrl = 'https://notice.xmwefun.cn?type=xchat&bot=weiliao-personal&title=...';
```

## 注意事项

1. 确保已安装 Node.js 和 npm
2. 需要拥有 Cloudflare 账号才能部署
3. 定时任务会在部署后自动生效
4. 可以通过 Cloudflare Dashboard 查看任务执行日志

## 开发

- 本地开发：`npm run dev`
- 部署生产：`npm run deploy`

