/**
 * 任务配置管理模块
 * 使用 KV 存储来保存和管理任务配置
 */

/**
 * 获取所有任务配置
 * @param {KVNamespace} kv - KV 命名空间
 * @returns {Promise<Array>} 任务配置列表
 */
export async function getAllTasks(kv) {
  try {
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
    
    return tasks;
  } catch (error) {
    console.error('获取任务列表失败:', error);
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

