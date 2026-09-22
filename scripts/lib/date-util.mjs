// 日期工具：严格 UTC 解析、未来隔离、窗口判定、90 天滚动裁剪。
// 设计原则（严格遵循授权）：
//  - 严格按 UTC 解析；NewsData 等无时区字段按「来源即 UTC」处理（不臆造本地时区）。
//  - 无法解析的日期 → 返回 null（调用方排除，绝不伪造「今天」）。
//  - 未来日期（晚于 now + 容差）→ 隔离记录，不进入首页/归档。
//  - 窗口判定用于筛选与裁剪，与「发布日」语义严格区分（不称未来日期为今日发布）。

const FUTURE_SKEW_MS = 60 * 1000; // 1 分钟容差，避免时钟抖动误判

// 严格解析为 UTC Date。
//  - 已是 ISO 8601（含 Z 或 ±hh:mm）→ 直接解析。
//  - 纯日期 2026-09-21 / 2026-09-21 14:00:00（无时区）→ 视为 UTC（补 Z）。
//  - 其它无法解析 → null。
export function parseStrictUTC(raw) {
  if (!raw) return null;
  if (raw instanceof Date) {
    return isNaN(raw.getTime()) ? null : raw;
  }
  const s = String(raw).trim();
  if (!s) return null;

  // 已是带时区指示的 ISO
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/.test(s)) {
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  }
  // 纯日期 2026-09-21
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const d = new Date(s + 'T00:00:00Z');
    return isNaN(d.getTime()) ? null : d;
  }
  // 空格分隔的日期时间（无时区），如 2026-09-21 14:30:00 → 视为 UTC
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(s)) {
    const d = new Date(s.replace(' ', 'T') + 'Z');
    return isNaN(d.getTime()) ? null : d;
  }
  // 含毫秒但无时区
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+$/.test(s)) {
    const d = new Date(s + 'Z');
    return isNaN(d.getTime()) ? null : d;
  }
  // 兜底：浏览器/Node 能解析的再试一次（仅当解析结果合理）
  const d = new Date(s);
  if (!isNaN(d.getTime())) {
    // 避免把明显非日期字符串解析成无效日期；这里仅接受可解析的
    return d;
  }
  return null;
}

export function isFuture(date, now = new Date(), skewMs = FUTURE_SKEW_MS) {
  const t = date instanceof Date ? date.getTime() : parseStrictUTC(date)?.getTime();
  if (t == null) return false;
  return t > now.getTime() + skewMs;
}

// 是否在 [now - days*86400000, now] 内（含边界），且非未来。
export function withinWindow(date, days, now = new Date()) {
  const d = date instanceof Date ? date : parseStrictUTC(date);
  if (!d) return false;
  if (isFuture(d, now)) return false;
  const cutoff = now.getTime() - days * 86400000;
  return d.getTime() >= cutoff;
}

// 距现在天数（用于裁剪/排序），未知返回 Infinity（视为最旧）。
export function ageDays(date, now = new Date()) {
  const d = date instanceof Date ? date : parseStrictUTC(date);
  if (!d) return Infinity;
  return (now.getTime() - d.getTime()) / 86400000;
}

export function toISO(date) {
  const d = date instanceof Date ? date : parseStrictUTC(date);
  return d ? d.toISOString() : null;
}

// 将 Date 规范为 ISO 字符串（供落盘）。
export function asISO(date) {
  if (!date) return null;
  return date instanceof Date ? date.toISOString() : parseStrictUTC(date)?.toISOString() || null;
}
