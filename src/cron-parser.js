/**
 * Cron expression parser
 * Used to check if current time matches cron expression
 */

// Parse a single cron field
// field: cron field, e.g. 0,10,30 or * or */5
// current: current value
// min: minimum value
// max: maximum value
// returns: whether it matches
function parseCronField(field, current, min, max) {
  // Wildcard
  if (field === '*') {
    return true;
  }

  // Exact value
  if (/^\d+$/.test(field)) {
    return parseInt(field) === current;
  }

  // List values, e.g. "0,10,30"
  if (field.includes(',')) {
    const values = field.split(',').map(v => parseInt(v.trim()));
    return values.includes(current);
  }

  // Range values, e.g. "0-5"
  if (field.includes('-')) {
    const [start, end] = field.split('-').map(v => parseInt(v.trim()));
    return current >= start && current <= end;
  }

  // Step values, e.g. "*/5" or "0-30/5"
  if (field.includes('/')) {
    const [range, step] = field.split('/');
    const stepValue = parseInt(step.trim());
    
    if (range === '*') {
      return current % stepValue === 0;
    }
    
    if (range.includes('-')) {
      const [start, end] = range.split('-').map(v => parseInt(v.trim()));
      if (current >= start && current <= end) {
        return (current - start) % stepValue === 0;
      }
      return false;
    }
    
    // Step from specified value
    const startValue = parseInt(range);
    return current >= startValue && (current - startValue) % stepValue === 0;
  }

  return false;
}

// Get time parts in UTC+8 (China Standard Time)
function getCSTTimeParts(date) {
  // Convert to UTC+8 timezone
  const cstOffset = 8 * 60; // UTC+8 in minutes
  const utcTime = date.getTime();
  const cstTime = new Date(utcTime + (cstOffset * 60000));
  
  return {
    minute: cstTime.getUTCMinutes(),
    hour: cstTime.getUTCHours(),
    day: cstTime.getUTCDate(),
    month: cstTime.getUTCMonth() + 1, // getUTCMonth() returns 0-11
    weekday: cstTime.getUTCDay(), // 0 (Sunday) to 6 (Saturday)
  };
}

// Check if current time matches cron expression
// cron: Cron expression, format: minute hour day month weekday
// date: Date to check, defaults to current time
// returns: whether it matches (using UTC+8 timezone)
export function matchesCron(cron, date = new Date()) {
  try {
    const parts = cron.trim().split(/\s+/);
    if (parts.length !== 5) {
      console.error('Invalid cron expression');
      return false;
    }

    const [minute, hour, day, month, weekday] = parts;
    
    // Get current time parts in UTC+8 (China Standard Time)
    const timeParts = getCSTTimeParts(date);
    const currentMinute = timeParts.minute;
    const currentHour = timeParts.hour;
    const currentDay = timeParts.day;
    const currentMonth = timeParts.month;
    const currentWeekday = timeParts.weekday;

    // Check each field
    const minuteMatch = parseCronField(minute, currentMinute, 0, 59);
    const hourMatch = parseCronField(hour, currentHour, 0, 23);
    const dayMatch = parseCronField(day, currentDay, 1, 31);
    const monthMatch = parseCronField(month, currentMonth, 1, 12);
    
    // Weekday field: 0 and 7 both mean Sunday
    let weekdayMatch = false;
    if (weekday === '0' || weekday === '7') {
      weekdayMatch = currentWeekday === 0;
    } else if (weekday === '*') {
      weekdayMatch = true;
    } else {
      weekdayMatch = parseCronField(weekday, currentWeekday, 0, 6);
    }

    return minuteMatch && hourMatch && dayMatch && monthMatch && weekdayMatch;
  } catch (error) {
    console.error('Failed to parse cron expression');
    return false;
  }
}

// Get all tasks that match current time
// tasks: task list
// date: date to check, defaults to current time
// returns: matching tasks
export function getMatchingTasks(tasks, date = new Date()) {
  return tasks.filter(task => {
    if (!task.cron || task.enabled === false) {
      return false;
    }
    return matchesCron(task.cron, date);
  });
}

/**
 * 计算 cron 表达式的下一个触发时间
 * @param {string} cron - Cron 表达式
 * @param {Date} startDate - 起始时间，默认为当前时间
 * @returns {Date|null} 下一个触发时间，如果找不到则返回 null
 */
export function getNextCronTime(cron, startDate = new Date()) {
  try {
    const parts = cron.trim().split(/\s+/);
    if (parts.length !== 5) {
      return null;
    }

    // 从起始时间的下一分钟开始检查
    let checkDate = new Date(startDate);
    checkDate.setUTCSeconds(0, 0);
    checkDate.setUTCMinutes(checkDate.getUTCMinutes() + 1);

    // 最多检查一年（避免无限循环）
    const maxIterations = 365 * 24 * 60;
    let iterations = 0;

    while (iterations < maxIterations) {
      if (matchesCron(cron, checkDate)) {
        return checkDate;
      }

      // 增加1分钟
      checkDate = new Date(checkDate.getTime() + 60 * 1000);
      iterations++;
    }

    return null; // 在一年内未找到匹配时间
  } catch (error) {
    console.error('计算下一个触发时间失败');
    return null;
  }
}

/**
 * 获取 cron 表达式的最近 N 个触发时间
 * @param {string} cron - Cron 表达式
 * @param {number} count - 需要获取的触发时间数量，默认5个
 * @param {Date} startDate - 起始时间，默认为当前时间
 * @returns {Array<Date>} 触发时间数组
 */
export function getNextCronTimes(cron, count = 5, startDate = new Date()) {
  const times = [];
  let currentDate = new Date(startDate);

  for (let i = 0; i < count; i++) {
    const nextTime = getNextCronTime(cron, currentDate);
    if (!nextTime) {
      break; // 无法找到更多触发时间
    }
    times.push(nextTime);
    // 从找到的时间开始查找下一个
    currentDate = new Date(nextTime);
  }

  return times;
}
