# Schedule Task Cloudflare Worker

Cloudflare Worker 定时任务调度平台，支持配置调度规则、API 参数配置和 POST 请求。

## 功能说明

- **配置调度规则**：通过 API 动态配置任务的 cron 表达式
- **API 参数配置**：支持为每个任务配置独立的 API URL、请求方法、请求头、参数和请求体
- **POST 请求支持**：支持 GET、POST、PUT、PATCH 等多种 HTTP 方法
- **任务管理**：提供完整的 RESTful API 用于管理任务（增删改查）
- **手动触发**：支持通过 API 手动触发任务执行

## 项目结构

```
schedule-task-cfworker/
├── src/
│   ├── index.js          # Worker 主文件，实现定时任务逻辑和 API
│   ├── config.js         # 任务配置管理模块
│   └── cron-parser.js    # Cron 表达式解析器
├── examples/
│   └── task-examples.json # 任务配置示例
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

### 2. 创建 KV 命名空间

在部署前，需要创建 KV 命名空间来存储任务配置：

```bash
# 创建生产环境 KV 命名空间
npx wrangler kv:namespace create "TASKS_KV"

# 创建预览环境 KV 命名空间（用于本地开发）
npx wrangler kv:namespace create "TASKS_KV" --preview
```

将返回的 `id` 和 `preview_id` 填入 `wrangler.toml` 文件中。

### 3. 配置说明

系统使用一个通用的 cron 触发器（每分钟执行一次），然后在代码中解析任务的 cron 表达式并判断是否应该执行。这样可以在不超过 Cloudflare Workers 的 5 个 cron 触发器限制的情况下，支持任意数量的任务和 cron 表达式。

**注意**：
- 任务配置存储在 KV 中，通过 API 动态管理
- 不需要在 `wrangler.toml` 中为每个任务配置 cron 表达式
- 系统会自动解析任务的 cron 表达式并判断执行时间

### 4. 本地开发测试

```bash
npm run dev
```

### 5. 部署到 Cloudflare

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

## API 文档

### 获取所有任务

```http
GET /api/tasks
```

**响应示例：**

```json
{
  "success": true,
  "data": [
    {
      "id": "task_1234567890",
      "name": "每月复盘通知",
      "url": "https://notice.xmwefun.cn",
      "method": "GET",
      "cron": "0 10 6 * *",
      "headers": {},
      "params": {
        "type": "xchat",
        "bot": "weiliao-personal",
        "title": "每月复盘"
      },
      "body": null,
      "enabled": true,
      "createdAt": "2024-01-01T00:00:00.000Z",
      "updatedAt": "2024-01-01T00:00:00.000Z"
    }
  ]
}
```

### 创建新任务

```http
POST /api/tasks
Content-Type: application/json
```

**请求体示例：**

```json
{
  "name": "每月复盘通知",
  "url": "https://notice.xmwefun.cn",
  "method": "GET",
  "cron": "0 10 6 * *",
  "headers": {
    "Authorization": "Bearer token"
  },
  "params": {
    "type": "xchat",
    "bot": "weiliao-personal",
    "title": "每月复盘",
    "msg": "### 每月复盘内容"
  },
  "enabled": true
}
```

**POST 请求示例：**

```json
{
  "name": "发送数据报告",
  "url": "https://api.example.com/report",
  "method": "POST",
  "cron": "0 9 * * 1",
  "headers": {
    "Content-Type": "application/json",
    "Authorization": "Bearer token"
  },
  "body": {
    "reportType": "weekly",
    "format": "json"
  },
  "enabled": true
}
```

### 获取单个任务

```http
GET /api/tasks/:id
```

### 更新任务

```http
PUT /api/tasks/:id
Content-Type: application/json
```

**请求体示例：**

```json
{
  "name": "更新后的任务名称",
  "enabled": false
}
```

### 删除任务

```http
DELETE /api/tasks/:id
```

### 手动触发任务

```http
POST /api/tasks/:id/trigger
```

## 任务配置说明

### 必填字段

- `url` - API 地址
- `cron` - Cron 表达式（格式：`分 时 日 月 星期`）

### 可选字段

- `id` - 任务 ID（不提供时自动生成）
- `name` - 任务名称
- `method` - HTTP 方法（默认：`GET`，支持：`GET`、`POST`、`PUT`、`PATCH`、`DELETE`）
- `headers` - 请求头（对象格式）
- `params` - URL 参数（对象格式，仅 GET 请求使用）
- `body` - 请求体（字符串或对象，POST/PUT/PATCH 请求使用）
- `enabled` - 是否启用（默认：`true`）

### Cron 表达式格式

```
分 时 日 月 星期
* * * * *
│ │ │ │ │
│ │ │ │ └── 星期 (0-7, 0和7都表示星期日)
│ │ │ └──── 月份 (1-12)
│ │ └────── 日期 (1-31)
│ └──────── 小时 (0-23)
└────────── 分钟 (0-59)
```

**示例：**

- `0 10 6 * *` - 每月6日10点0分
- `0,10,30 10 6 * *` - 每月6日10点的0、10、30分（需要在 wrangler.toml 中分别配置）
- `0 9 * * 1` - 每周一9点0分
- `*/5 * * * *` - 每5分钟执行一次

## 使用示例

### 创建 GET 请求任务

```bash
curl -X POST https://your-worker.workers.dev/api/tasks \
  -H "Content-Type: application/json" \
  -d '{
    "name": "通知任务",
    "url": "https://notice.xmwefun.cn",
    "method": "GET",
    "cron": "0 10 6 * *",
    "params": {
      "type": "xchat",
      "bot": "weiliao-personal",
      "title": "每月复盘"
    }
  }'
```

### 创建 POST 请求任务

```bash
curl -X POST https://your-worker.workers.dev/api/tasks \
  -H "Content-Type: application/json" \
  -d '{
    "name": "数据上报",
    "url": "https://api.example.com/data",
    "method": "POST",
    "cron": "0 0 * * *",
    "headers": {
      "Content-Type": "application/json"
    },
    "body": {
      "data": "example"
    }
  }'
```

### 手动触发任务

```bash
curl -X POST https://your-worker.workers.dev/api/tasks/task_1234567890/trigger
```

## 注意事项

1. **Cron 触发器限制**：Cloudflare Workers 免费计划限制最多 5 个 cron 触发器。本系统使用一个通用触发器（每分钟执行一次），在代码中解析任务的 cron 表达式，因此不受此限制影响。

2. **KV 存储**：任务配置存储在 Cloudflare KV 中，需要先创建 KV 命名空间。

3. **时区**：Cron 表达式使用 UTC 时区。

4. **任务执行**：系统每分钟检查一次所有任务，如果任务的 cron 表达式匹配当前时间，则执行该任务。如果多个任务使用相同的 cron 表达式，它们会在同一时间执行。

5. **执行频率**：系统每分钟执行一次检查，但只有匹配的任务才会真正执行 API 调用，不会产生不必要的请求。

6. **错误处理**：任务执行失败会在控制台输出错误日志，不会影响其他任务的执行。

7. **Cron 表达式支持**：系统支持标准的 cron 表达式格式，包括：
   - 精确值：`0 10 6 * *`
   - 列表值：`0,10,30 10 6 * *`
   - 范围值：`0-5 10 6 * *`
   - 步长值：`*/5 * * * *`
   - 通配符：`* * * * *`

## 开发

- 本地开发：`npm run dev`
- 部署生产：`npm run deploy`
