/**
 * Cloudflare Worker - 定时任务调度平台
 * 支持配置调度规则、API 参数配置和 POST 请求
 */

import { getAllTasks, getTask, saveTask, deleteTask } from './config.js';
import { getMatchingTasks, matchesCron } from './cron-parser.js';

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
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      // API 路由
      if (path === '/api/tasks' && request.method === 'GET') {
        // 获取所有任务
        const tasks = await getAllTasks(env.TASKS_KV);
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

        const success = await saveTask(env.TASKS_KV, taskId, config);
        if (success) {
          return jsonResponse({ success: true, data: config }, corsHeaders, 201);
        } else {
          return jsonResponse(
            { success: false, error: '保存任务失败' },
            corsHeaders,
            500
          );
        }
      }

      if (path.startsWith('/api/tasks/') && request.method === 'GET') {
        // 获取单个任务
        const taskId = path.split('/').pop();
        const task = await getTask(env.TASKS_KV, taskId);
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
        
        const existingTask = await getTask(env.TASKS_KV, taskId);
        if (!existingTask) {
          return jsonResponse(
            { success: false, error: '任务不存在' },
            corsHeaders,
            404
          );
        }

        const config = {
          ...existingTask,
          ...taskConfig,
          id: taskId,
          updatedAt: new Date().toISOString(),
        };

        const success = await saveTask(env.TASKS_KV, taskId, config);
        if (success) {
          return jsonResponse({ success: true, data: config }, corsHeaders);
        } else {
          return jsonResponse(
            { success: false, error: '更新任务失败' },
            corsHeaders,
            500
          );
        }
      }

      if (path.startsWith('/api/tasks/') && request.method === 'DELETE') {
        // 删除任务
        const taskId = path.split('/').pop();
        const success = await deleteTask(env.TASKS_KV, taskId);
        if (success) {
          return jsonResponse({ success: true, message: '任务已删除' }, corsHeaders);
        } else {
          return jsonResponse(
            { success: false, error: '删除任务失败' },
            corsHeaders,
            500
          );
        }
      }

      if (path.startsWith('/api/tasks/') && path.endsWith('/trigger') && request.method === 'POST') {
        // 手动触发任务
        const taskId = path.split('/')[3];
        const task = await getTask(env.TASKS_KV, taskId);
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
        // 测试 cron 表达式
        const { cron, date } = await request.json();
        if (!cron) {
          return jsonResponse(
            { success: false, error: '缺少 cron 参数' },
            corsHeaders,
            400
          );
        }

        const testDate = date ? new Date(date) : new Date();
        const matches = matchesCron(cron, testDate);

        return jsonResponse({
          success: true,
          data: {
            cron,
            testDate: testDate.toISOString(),
            matches,
            currentTime: {
              minute: testDate.getUTCMinutes(),
              hour: testDate.getUTCHours(),
              day: testDate.getUTCDate(),
              month: testDate.getUTCMonth() + 1,
              weekday: testDate.getUTCDay(),
            },
          },
        }, corsHeaders);
      }

      // 默认返回 API 文档
      return jsonResponse({
        success: true,
        message: '定时任务调度平台 API',
        endpoints: {
          'GET /api/tasks': '获取所有任务',
          'POST /api/tasks': '创建新任务',
          'GET /api/tasks/:id': '获取单个任务',
          'PUT /api/tasks/:id': '更新任务',
          'DELETE /api/tasks/:id': '删除任务',
          'POST /api/tasks/:id/trigger': '手动触发任务',
        },
      }, corsHeaders);
    } catch (error) {
      console.error('API 错误:', error);
      return jsonResponse(
        { success: false, error: error.message },
        corsHeaders,
        500
      );
    }
  },
};

/**
 * 处理定时任务触发
 * @param {ScheduledEvent} event - 定时事件对象
 * @param {Env} env - 环境变量
 */
async function handleScheduledTask(event, env) {
  try {
    const now = new Date();
    console.log(`[${now.toISOString()}] 定时任务触发器执行，检查匹配的任务...`);

    // 获取所有任务
    const allTasks = await getAllTasks(env.TASKS_KV);
    
    if (allTasks.length === 0) {
      console.log(`[${now.toISOString()}] 没有配置任何任务`);
      return;
    }

    // 使用 cron 解析器获取匹配当前时间的任务
    const matchingTasks = getMatchingTasks(allTasks, now);
    
    // 记录所有任务的检查结果（用于调试）
    console.log(`[${now.toISOString()}] 检查 ${allTasks.length} 个任务`);
    allTasks.forEach(task => {
      const matches = matchesCron(task.cron, now);
      console.log(`[${now.toISOString()}] 任务 ${task.name} (${task.cron}): ${matches ? '匹配' : '不匹配'}`);
    });
    
    if (matchingTasks.length === 0) {
      console.log(`[${now.toISOString()}] 当前时间没有匹配的任务`);
      return;
    }

    console.log(`[${now.toISOString()}] 找到 ${matchingTasks.length} 个匹配的任务`);

    // 执行所有匹配的任务
    const promises = matchingTasks.map(task => executeTask(task));
    const results = await Promise.allSettled(promises);

    // 记录执行结果
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        console.log(`[${now.toISOString()}] 任务执行成功: ${matchingTasks[index].name}`);
      } else {
        console.error(`[${now.toISOString()}] 任务执行失败: ${matchingTasks[index].name}`, result.reason);
      }
    });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] 处理定时任务失败:`, error);
  }
}

/**
 * 执行任务
 * @param {Object} task - 任务配置
 */
async function executeTask(task) {
  try {
    console.log(`[${new Date().toISOString()}] 开始执行任务: ${task.name} (${task.id})`);

    // 构建 URL
    let url = new URL(task.url);
    
    // 添加 GET 参数（仅 GET 请求）
    if (task.method === 'GET' && task.params) {
      Object.entries(task.params).forEach(([key, value]) => {
        url.searchParams.append(key, value);
      });
    }

    // 构建请求选项
    const options = {
      method: task.method || 'GET',
      headers: {
        'User-Agent': 'Cloudflare-Worker-Scheduler/1.0',
        ...task.headers,
      },
    };

    // 添加请求体（POST/PUT 等）
    if ((task.method === 'POST' || task.method === 'PUT' || task.method === 'PATCH') && task.body) {
      if (typeof task.body === 'string') {
        options.body = task.body;
      } else {
        options.body = JSON.stringify(task.body);
        options.headers['Content-Type'] = options.headers['Content-Type'] || 'application/json';
      }
    }

    // 发送请求
    const response = await fetch(url.toString(), options);

    if (!response.ok) {
      throw new Error(`API 调用失败: ${response.status} ${response.statusText}`);
    }

    const result = await response.text();
    console.log(`[${new Date().toISOString()}] 任务执行成功: ${task.name}`, result);

    return {
      success: true,
      taskId: task.id,
      taskName: task.name,
      timestamp: new Date().toISOString(),
      status: response.status,
      result: result,
    };
  } catch (error) {
    console.error(`[${new Date().toISOString()}] 任务执行失败: ${task.name}`, error.message);
    throw error;
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
