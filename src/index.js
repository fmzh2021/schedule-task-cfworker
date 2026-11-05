/**
 * Cloudflare Worker - 定时任务调度平台
 * 支持配置调度规则、API 参数配置和 POST 请求
 */

import { getAllTasks, getTask, saveTask, updateTask, deleteTask, storeRequest } from './config.js';
import { SchedulerError, safeError } from './storage-format.js';
export { SchedulerStore } from './scheduler-store.js';
import { getMatchingTasks, getNextCronTimes } from './cron-parser.js';

/**
 * 验证 API Key
 * @param {Request} request - HTTP 请求对象
 * @param {Env} env - 环境变量
 * @returns {boolean} 是否验证通过
 */
function verifyApiKey(request, env) {
  // 从环境变量获取 API Key
  const validApiKey = env.API_KEY;
  
  // 如果没有配置 API Key，则允许所有请求（开发模式）
  if (!validApiKey) {
    console.warn('[安全警告] 未配置 API_KEY，所有请求将被允许');
    return true;
  }

  // 方式1: 从 Authorization Header 获取 (Bearer Token)
  const authHeader = request.headers.get('Authorization');
  if (authHeader) {
    const token = authHeader.replace(/^Bearer\s+/i, '').trim();
    if (token === validApiKey) {
      return true;
    }
  }

  // 方式2: 从 X-API-Key Header 获取
  const apiKeyHeader = request.headers.get('X-API-Key');
  if (apiKeyHeader && apiKeyHeader === validApiKey) {
    return true;
  }

  // 方式3: 从查询参数获取（不推荐，但提供兼容性）
  const url = new URL(request.url);
  const apiKeyParam = url.searchParams.get('api_key');
  if (apiKeyParam && apiKeyParam === validApiKey) {
    return true;
  }

  return false;
}

/**
 * 检查路径是否需要鉴权
 * @param {string} path - 请求路径
 * @param {string} method - HTTP 方法
 * @returns {boolean} 是否需要鉴权
 */
function requiresAuth(path, method) {
  // 公开接口（不需要鉴权）
  const publicPaths = [
    '/',  // API 文档
    '/api/test-cron',  // 测试工具
  ];

  // OPTIONS 请求不需要鉴权（CORS 预检）
  if (method === 'OPTIONS') {
    return false;
  }

  // 检查是否为公开路径
  if (publicPaths.includes(path)) {
    return false;
  }

  // 所有 /api/ 路径都需要鉴权（除了公开路径）
  if (path.startsWith('/api/')) {
    return true;
  }

  return false;
}

export default {
  /**
   * 处理定时任务触发
   * @param {ScheduledEvent} event - 定时事件对象
   * @param {Env} env - 环境变量
   * @param {ExecutionContext} ctx - 执行上下文
   */
  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleScheduledTask(event, env));
  },

  /**
   * 处理 HTTP 请求
   */
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS 处理
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // 接口鉴权检查
    if (requiresAuth(path, request.method)) {
      if (!verifyApiKey(request, env)) {
        console.warn(JSON.stringify({ event: 'auth_failed', method: request.method }));
        return jsonResponse(
          {
            success: false,
            error: '未授权访问',
            message: '请提供有效的 API Key。可以通过以下方式提供：1) Authorization: Bearer <API_KEY> 2) X-API-Key: <API_KEY> 3) ?api_key=<API_KEY>',
          },
          corsHeaders,
          401
        );
      }
    }

    try {
      // Administration always requires a configured key, including development.
      if (path.startsWith('/api/admin/')) {
        if (!env.API_KEY) return jsonResponse({ success: false, error: '管理操作需要配置 API_KEY' }, corsHeaders, 503);
        const adminBody = request.method === 'POST' ? await request.json() : undefined;
        const data = await storeRequest(env, path.slice(4) + url.search, request.method, adminBody);
        return jsonResponse({ success: true, data }, corsHeaders);
      }
      // API 路由
      if (path === '/api/tasks' && request.method === 'GET') {
        // 获取所有任务
        const tasks = await getAllTasks(env);
        return jsonResponse({ success: true, data: tasks }, corsHeaders);
      }

      if (path === '/api/tasks' && request.method === 'POST') {
        // 创建新任务
        const taskConfig = await request.json();
        const taskId = taskConfig.id || generateTaskId();
        
        // 验证必填字段
        if (!taskConfig.url || !taskConfig.cron) {
          return jsonResponse(
            { success: false, error: '缺少必填字段: url 和 cron' },
            corsHeaders,
            400
          );
        }

        const config = {
          id: taskId,
          name: taskConfig.name || `任务-${taskId}`,
          url: taskConfig.url,
          method: taskConfig.method || 'GET',
          cron: taskConfig.cron,
          headers: taskConfig.headers || {},
          params: taskConfig.params || {},
          body: taskConfig.body || null,
          enabled: taskConfig.enabled !== false,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };

        await saveTask(env, taskId, config);
        return jsonResponse({ success: true, data: config }, corsHeaders, 201);
      }

      if (path.startsWith('/api/tasks/') && request.method === 'GET') {
        // 获取单个任务
        const taskId = path.split('/').pop();
        const task = await getTask(env, taskId);
        if (task) {
          return jsonResponse({ success: true, data: task }, corsHeaders);
        } else {
          return jsonResponse(
            { success: false, error: '任务不存在' },
            corsHeaders,
            404
          );
        }
      }

      if (path.startsWith('/api/tasks/') && request.method === 'PUT') {
        // 更新任务
        const taskId = path.split('/').pop();
        const taskConfig = await request.json();
        
        // Read/merge/write all occur inside the singleton DO storage transaction.
        const config = await updateTask(env, taskId, taskConfig);
        if (!config) {
          return jsonResponse({ success: false, error: '任务不存在' }, corsHeaders, 404);
        }
        return jsonResponse({ success: true, data: config }, corsHeaders);
      }

      if (path.startsWith('/api/tasks/') && request.method === 'DELETE') {
        // 删除任务
        const taskId = path.split('/').pop();
        await deleteTask(env, taskId);
        return jsonResponse({ success: true, message: '任务已删除' }, corsHeaders);
      }

      if (path.startsWith('/api/tasks/') && path.endsWith('/trigger') && request.method === 'POST') {
        // 手动触发任务
        const taskId = path.split('/')[3];
        const task = await getTask(env, taskId);
        if (!task) {
          return jsonResponse(
            { success: false, error: '任务不存在' },
            corsHeaders,
            404
          );
        }

        ctx.waitUntil(executeTask(task));
        return jsonResponse({ success: true, message: '任务已触发' }, corsHeaders);
      }

      if (path === '/api/test-cron' && request.method === 'POST') {
        // 测试 cron 表达式，展示最近5个触发时间
        const { cron, startDate } = await request.json();
        if (!cron) {
          return jsonResponse(
            { success: false, error: '缺少 cron 参数' },
            corsHeaders,
            400
          );
        }

        // 解析起始时间，默认为当前时间
        const baseDate = startDate ? new Date(startDate) : new Date();
        
        // 获取最近5个触发时间
        const nextTimes = getNextCronTimes(cron, 5, baseDate);

        // 格式化时间为 CST (UTC+8)
        const cstOffset = 8 * 60;
        const formatCSTTime = (date) => {
          const utcTime = date.getTime();
          const cstTime = new Date(utcTime + (cstOffset * 60000));
          return {
            iso: date.toISOString(),
            cst: cstTime.toISOString().replace('Z', '+08:00'),
            cstFormatted: cstTime.toISOString().replace('T', ' ').replace(/\.\d{3}Z/, '') + ' (CST)',
            timeParts: {
              minute: cstTime.getUTCMinutes(),
              hour: cstTime.getUTCHours(),
              day: cstTime.getUTCDate(),
              month: cstTime.getUTCMonth() + 1,
              weekday: cstTime.getUTCDay(),
              year: cstTime.getUTCFullYear(),
            },
          };
        };

        const baseTimeInfo = formatCSTTime(baseDate);
        
        return jsonResponse({
          success: true,
          data: {
            cron,
            baseTime: {
              iso: baseDate.toISOString(),
              cst: baseTimeInfo.cst,
              cstFormatted: baseTimeInfo.cstFormatted,
            },
            nextTriggerTimes: nextTimes.map((time, index) => ({
              index: index + 1,
              ...formatCSTTime(time),
              // 计算距离基础时间的分钟数
              minutesFromBase: Math.round((time.getTime() - baseDate.getTime()) / (60 * 1000)),
            })),
            count: nextTimes.length,
            timezone: 'UTC+8 (CST)',
            note: nextTimes.length < 5 ? '在一年内未找到足够的触发时间' : null,
          },
        }, corsHeaders);
      }

      // 默认返回 API 文档
      return jsonResponse({
        success: true,
        message: '定时任务调度平台 API',
        authentication: {
          required: true,
          methods: [
            'Authorization: Bearer <API_KEY>',
            'X-API-Key: <API_KEY>',
            '?api_key=<API_KEY> (查询参数，不推荐)',
          ],
          note: '所有 /api/ 路径都需要鉴权（除了 /api/test-cron）',
        },
        endpoints: {
          'GET /api/tasks': '获取所有任务（需要鉴权）',
          'POST /api/tasks': '创建新任务（需要鉴权）',
          'GET /api/tasks/:id': '获取单个任务（需要鉴权）',
          'PUT /api/tasks/:id': '更新任务（需要鉴权）',
          'DELETE /api/tasks/:id': '删除任务（需要鉴权）',
          'POST /api/tasks/:id/trigger': '手动触发任务（需要鉴权）',
          'POST /api/test-cron': '测试 cron 表达式（公开）',
        },
      }, corsHeaders);
    } catch (error) {
      const safe = error instanceof SyntaxError ? new SchedulerError('INVALID_REQUEST', 400) : safeError(error);
      console.error(JSON.stringify({ event: 'api_failed', code: safe.code }));
      return jsonResponse(
        { success: false, error: safe.message, code: safe.code },
        corsHeaders,
        safe.status
      );
    }
  },
};

/**
 * 处理定时任务触发
 * @param {ScheduledEvent} event - 定时事件对象
 * @param {Env} env - 环境变量
 */
export async function handleScheduledTask(event, env) {
  const startedAt = Date.now();
  const timestamp = Number.isFinite(event?.scheduledTime) ? event.scheduledTime : startedAt;
  const scheduledAt = new Date(timestamp);
  const timing = { scheduledAt: scheduledAt.toISOString(), startedAt: new Date(startedAt).toISOString(),
    delayMs: startedAt - timestamp, timeSource: Number.isFinite(event?.scheduledTime) ? 'scheduledTime' : 'wall_clock' };
  console.log(JSON.stringify({ event: 'schedule_started', ...timing }));
  try {
    const tasks = await getAllTasks(env);
    const matching = getMatchingTasks(tasks, scheduledAt);
    const results = await Promise.allSettled(matching.map(task => executeTask(task)));
    const failed = results.filter(result => result.status === 'rejected').length;
    console.log(JSON.stringify({ event: 'schedule_finished', ...timing, taskCount: tasks.length,
      matched: matching.length, succeeded: results.length - failed, failed }));
    if (failed) throw new SchedulerError('TASK_EXECUTION_FAILED', 502);
  } catch (error) {
    const safe = safeError(error);
    console.error(JSON.stringify({ event: 'schedule_failed', ...timing, code: safe.code }));
    throw safe; // Rejected waitUntil is observable as a failed Cron invocation.
  }
}

export async function executeTask(task) {
  try {
    const url = new URL(task.url);
    if (task.method === 'GET' && task.params) {
      Object.entries(task.params).forEach(([key, value]) => url.searchParams.append(key, value));
    }
    const options = { method: task.method || 'GET',
      headers: { 'User-Agent': 'Cloudflare-Worker-Scheduler/1.0', ...task.headers } };
    if (['POST', 'PUT', 'PATCH'].includes(task.method) && task.body) {
      if (typeof task.body === 'string') options.body = task.body;
      else {
        options.body = JSON.stringify(task.body);
        options.headers['Content-Type'] = options.headers['Content-Type'] || 'application/json';
      }
    }
    const response = await fetch(url.toString(), options);
    console.log(JSON.stringify({ event: 'task_response', status: response.status }));
    if (!response.ok) throw new SchedulerError('TASK_EXECUTION_FAILED', 502);
    // Responses can contain credentials, so neither their text nor error text is logged.
    await response.body?.cancel();
    return { success: true, status: response.status };
  } catch {
    console.error(JSON.stringify({ event: 'task_failed', code: 'TASK_EXECUTION_FAILED' }));
    throw new SchedulerError('TASK_EXECUTION_FAILED', 502);
  }
}

/**
 * 生成任务 ID
 * @returns {string} 任务 ID
 */
function generateTaskId() {
  return `task_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * 返回 JSON 响应
 * @param {Object} data - 响应数据
 * @param {Object} headers - 额外头部
 * @param {number} status - HTTP 状态码
 * @returns {Response} Response 对象
 */
function jsonResponse(data, headers = {}, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...headers,
    },
  });
}
