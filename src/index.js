/**
 * Cloudflare Worker - 定时任务调度
 * 每月6日10点的0、10、30分执行，调用通知 API
 */

export default {
  /**
   * 处理定时任务触发
   * @param {ScheduledEvent} event - 定时事件对象
   * @param {Env} env - 环境变量
   * @param {ExecutionContext} ctx - 执行上下文
   */
  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleScheduledTask(event));
  },

  /**
   * 处理 HTTP 请求（用于测试）
   */
  async fetch(request, env, ctx) {
    // 允许手动触发测试
    if (request.url.includes('/trigger')) {
      ctx.waitUntil(handleScheduledTask(null));
      return new Response('任务已触发', {
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }

    return new Response('Schedule Task Worker', {
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  },
};

/**
 * 处理定时任务
 * @param {ScheduledEvent} event - 定时事件对象
 */
async function handleScheduledTask(event) {
  try {
    const apiUrl = 'https://notice.xmwefun.cn?type=xchat&bot=weiliao-personal&title=%E6%AF%8F%E6%9C%88%E5%A4%8D%E7%9B%98&msg=%23%23%23%20foxhello%E5%A4%B4%E8%84%91%E9%A3%8E%E6%9A%B4%0A%0A1%2E%20%E6%AF%8F%E6%9C%88%E5%A4%8D%E7%9B%98%0A2%2E%20%E5%A4%B4%E8%84%91%E9%A3%8E%E6%9A%B4%0A3%2E%20%E6%88%AA%E5%9B%BE%E6%B1%87%E6%80%BB%E3%80%81%E6%B8%85%E7%A9%BA%0A4%2E%20%5B%E6%97%A5%E5%BF%97%E6%8A%A5%E5%91%8A%5D%28https%3A%2F%2Fblog%2Efoxhello%2Ecn%29%0A%0A%0A';

    console.log(`[${new Date().toISOString()}] 开始执行定时任务...`);

    const response = await fetch(apiUrl, {
      method: 'GET',
      headers: {
        'User-Agent': 'Cloudflare-Worker/1.0',
      },
    });

    if (!response.ok) {
      throw new Error(`API 调用失败: ${response.status} ${response.statusText}`);
    }

    const result = await response.text();
    console.log(`[${new Date().toISOString()}] 任务执行成功:`, result);

    return {
      success: true,
      timestamp: new Date().toISOString(),
      status: response.status,
      result: result,
    };
  } catch (error) {
    console.error(`[${new Date().toISOString()}] 任务执行失败:`, error.message);
    throw error;
  }
}

