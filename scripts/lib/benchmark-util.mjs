// 共享工具：北京时间、模型ID规范化、CSV解析、带超时的fetch、数值取整、URL归一
// 纯函数 / 无副作用，便于离线 fixture 测试直接复用。

const BEIJING_OFFSET_MS = 8 * 3600 * 1000;

// 将任意 Date 转为「北京时间」对应的 YYYY-MM-DD 字符串。
// 做法：先把本地时间换算成 UTC 毫秒，再加 8 小时，再用 toISOString 取日期部分。
export function beijingDateString(d = new Date()) {
  const utcMs = d.getTime() + d.getTimezoneOffset() * 60000;
  const bj = new Date(utcMs + BEIJING_OFFSET_MS);
  return bj.toISOString().slice(0, 10);
}

// 判断两个 ISO/日期 字符串是否落在同一个「北京时间」日期。
export function isSameBeijingDate(a, b) {
  if (!a || !b) return false;
  return beijingDateString(new Date(a)) === beijingDateString(new Date(b));
}

// 模型稳定ID规范化：NFKC 归一 + 转小写 + 仅保留字母数字（含 Unicode 字母，兼容中文名）。
// 注意：平台隔离在调用方拼接（platform::normalized），本函数只负责规范化「名称部分」。
export function normalizeModelId(raw) {
  return String(raw == null ? '' : raw)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

export function round(n, digits = 2) {
  if (typeof n !== 'number' || Number.isNaN(n)) return n;
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

// 极简 RFC4180 风格 CSV 解析（支持双引号转义、字段内逗号/换行）。
// 返回对象数组，首行为表头。
export function parseCsv(text) {
  if (!text || typeof text !== 'string') return [];
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const pushField = () => {
    row.push(field);
    field = '';
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else {
      if (c === '"') {
        inQuotes = true;
      } else if (c === ',') {
        pushField();
      } else if (c === '\r') {
        // 忽略，交由 \n 处理换行
      } else if (c === '\n') {
        pushRow();
      } else {
        field += c;
      }
    }
  }
  // 收尾：若最后字段非空或存在未闭合行
  if (field.length > 0 || row.length > 0) pushRow();
  if (rows.length === 0) return [];
  const header = rows[0].map((h) => h.trim());
  const out = [];
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    if (cells.length === 1 && cells[0] === '') continue; // 跳过空行
    const obj = {};
    header.forEach((h, idx) => {
      obj[h] = cells[idx] !== undefined ? cells[idx] : '';
    });
    out.push(obj);
  }
  return out;
}

// 带超时的 fetch 包装；允许注入 fetchImpl（测试用）。
// 返回 { ok, status, text, json } 的最小兼容接口。
export async function fetchWithTimeout(url, opts = {}) {
  const { timeoutMs = 30000, fetchImpl = globalThis.fetch, headers = {} } = opts;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (benchmark-monitor)', ...headers },
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return {
      ok: res.ok,
      status: res.status,
      text: async () => text,
      json: async () => json,
    };
  } finally {
    clearTimeout(timer);
  }
}

// URL 归一：去 query/hash、小写、去尾斜杠，用于新闻去重。
export function normalizeUrl(u) {
  if (!u) return '';
  try {
    const url = new URL(u);
    return (url.origin + url.pathname).toLowerCase().replace(/\/+$/, '');
  } catch {
    return String(u).replace(/\?.*$/, '').toLowerCase().replace(/\/+$/, '');
  }
}
