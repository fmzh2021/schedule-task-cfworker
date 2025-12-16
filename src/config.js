/**
 * 任务配置管理模块
 * 使用 KV 存储来保存和管理任务配置
 */

// 缓存配置
const CACHE_TTL = 10 * 60 * 1000; // 10分钟（毫秒）

// 模块级缓存变量
let cachedTasks = null;
let cacheTimestamp = 0;

/**
 * 清除任务缓存（在保存或删除任务后调用）
 */
export function clearTaskCache() {
  cachedTasks = null;
  cacheTimestamp = 0;
  console.log('[缓存] 任务缓存已清除');
}

/**
 * 获取所有任务配置（带缓存，每10分钟从KV获取一次）
 * @param {KVNamespace} kv - KV 命名空间
 * @param {boolean} forceRefresh - 是否强制刷新缓存
 * @returns {Promise<Array>} 任务配置列表
 */
export async function getAllTasks(kv, forceRefresh = false) {
  try {
    const now = Date.now();
    
    // 检查缓存是否有效（10分钟内且未强制刷新）
    if (!forceRefresh && cachedTasks !== null && (now - cacheTimestamp) < CACHE_TTL) {
      const cacheAge = Math.floor((now - cacheTimestamp) / 1000);
      console.log(`[缓存] 使用缓存的任务列表（缓存年龄: ${cacheAge}秒）`);
      return cachedTasks;
    }
    
    // 从 KV 获取最新数据
    console.log('[缓存] 从 KV 获取任务列表...');
    const keys = await kv.list();
    const tasks = [];
    
    for (const key of keys.keys) {
      if (key.name.startsWith('task:')) {
        const taskData = await kv.get(key.name, 'json');
        if (taskData) {
          tasks.push({
            id: key.name.replace('task:', ''),
            ...taskData,
          });
        }
      }
    }
    
    // 更新缓存
    cachedTasks = tasks;
    cacheTimestamp = now;
    console.log(`[缓存] 任务列表已缓存（共 ${tasks.length} 个任务）`);
    
    return tasks;
  } catch (error) {
    console.error('获取任务列表失败:', error);
    // 如果出错但缓存存在，返回缓存数据
    if (cachedTasks !== null) {
      console.log('[缓存] 获取失败，使用缓存的任务列表');
      return cachedTasks;
    }
    return [];
  }
}

/**
 * 获取单个任务配置
 * @param {KVNamespace} kv - KV 命名空间
 * @param {string} taskId - 任务 ID
 * @returns {Promise<Object|null>} 任务配置
 */
export async function getTask(kv, taskId) {
  try {
    const taskData = await kv.get(`task:${taskId}`, 'json');
    return taskData;
  } catch (error) {
    console.error(`获取任务 ${taskId} 失败:`, error);
    return null;
  }
}

/**
 * 保存任务配置
 * @param {KVNamespace} kv - KV 命名空间
 * @param {string} taskId - 任务 ID
 * @param {Object} taskConfig - 任务配置
 * @returns {Promise<boolean>} 是否成功
 */
export async function saveTask(kv, taskId, taskConfig) {
  try {
    await kv.put(`task:${taskId}`, JSON.stringify(taskConfig));
    // 清除缓存，确保下次获取时获取最新数据
    clearTaskCache();
    return true;
  } catch (error) {
    console.error(`保存任务 ${taskId} 失败:`, error);
    return false;
  }
}

/**
 * 删除任务配置
 * @param {KVNamespace} kv - KV 命名空间
 * @param {string} taskId - 任务 ID
 * @returns {Promise<boolean>} 是否成功
 */
export async function deleteTask(kv, taskId) {
  try {
    await kv.delete(`task:${taskId}`);
    // 清除缓存，确保下次获取时获取最新数据
    clearTaskCache();
    return true;
  } catch (error) {
    console.error(`删除任务 ${taskId} 失败:`, error);
    return false;
  }
}

/**
 * 根据 cron 表达式获取任务
 * @param {KVNamespace} kv - KV 命名空间
 * @param {string} cron - Cron 表达式
 * @returns {Promise<Array>} 匹配的任务列表
 */
export async function getTasksByCron(kv, cron) {
  try {
    const allTasks = await getAllTasks(kv);
    return allTasks.filter(task => task.cron === cron);
  } catch (error) {
    console.error('根据 cron 获取任务失败:', error);
    return [];
  }
}

