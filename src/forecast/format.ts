const TIME_FORMAT = new Intl.DateTimeFormat('zh-CN', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});
const DATE_TIME_FORMAT = new Intl.DateTimeFormat('zh-CN', {
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

export function formatMoney(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return '$0';
  }
  if (value >= 10_000) {
    return `$${(value / 1000).toFixed(1)}k`;
  }
  return `$${Math.round(value).toLocaleString('en-US')}`;
}

/** 当天只显示时分，跨天带上日期 */
export function formatClock(time: number, now: number): string {
  const sameDay = new Date(time).toDateString() === new Date(now).toDateString();
  return sameDay ? TIME_FORMAT.format(time) : DATE_TIME_FORMAT.format(time);
}

/** 距离某个时间点还有多久；不足 1 分钟显示 soonLabel */
export function formatCountdown(ms: number, soonLabel = '即将恢复'): string {
  return ms < 60_000 ? soonLabel : `${formatDuration(ms)} 后`;
}

/** 向上取整到分钟，避免把恢复时间说早 */
export function formatDuration(ms: number): string {
  const minutes = Math.max(0, Math.ceil(ms / 60_000));
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest ? `${hours}h ${rest}m` : `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours ? `${days}d ${restHours}h` : `${days}d`;
}

export function horizonLabel(hours: number): string {
  return hours === 0 ? '现在' : `${hours}h 后`;
}

const BLOCK_LABELS: Record<string, string> = {
  '5h': '5h',
  '7d': '7d',
  temp: '临时',
};

export function blockedLabel(blockedBy: string[]): string {
  return blockedBy.map((key) => BLOCK_LABELS[key] ?? key).join(' + ');
}
