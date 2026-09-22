// SuYxh 公开聚合数据适配器。
// 真实抓取以下端点（结构以实际返回为准，不臆造）：
//   latest-24h.json  latest-7d.json  source-status.json  waytoagi-7d.json  opml-feeds.json
//
// 设计原则（严格遵循授权）：
//  - 每个请求 20-30s body 全超时（先读全响应体再解析，避免 body 迟迟不结束无超时保护）。
//  - 任一端点失败都记入 failures / status，不抛出、不编造该源数据。
//  - 保留原文 url / 上游平台(SuYxh聚合) / 媒体名(site_name) / 出处署名；title_zh 已有则供 UI 使用，不伪造正文。
//  - 仅返回原始条目 + 上下文(ctx)，分类/过滤/去重由统一管线负责。
//  - 可注入 fetchImpl（用于离线测试）；默认全局 fetch。

export const SUYXH_ENDPOINTS = {
  latest24h: 'https://suyxh.github.io/ai-news-aggregator/data/latest-24h.json',
  latest7d: 'https://suyxh.github.io/ai-news-aggregator/data/latest-7d.json',
  sourceStatus: 'https://suyxh.github.io/ai-news-aggregator/data/source-status.json',
  waytoagi7d: 'https://suyxh.github.io/ai-news-aggregator/data/waytoagi-7d.json',
  opmlFeeds: 'https://suyxh.github.io/ai-news-aggregator/data/opml-feeds.json',
};

const DEFAULT_TIMEOUT_MS = 25000;

function fetchWithTimeout(url, { timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = globalThis.fetch } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  return fetchImpl(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } })
    .then(async (r) => {
      const text = await r.text(); // 先读全 body（全超时保护）
      let parsed = null;
      let parseError = null;
      try {
        if (text.trim().startsWith('{') || text.trim().startsWith('[')) {
          parsed = JSON.parse(text);
        } else {
          parseError = '响应非 JSON（疑似 ' + (text.slice(0, 40).replace(/\n/g, ' ')) + '…）';
        }
      } catch (e) {
        parseError = 'JSON 解析失败: ' + e.message;
      }
      return { status: r.status, ok: r.ok, text, parsed, parseError };
    })
    .finally(() => clearTimeout(t));
}

// 统一 SuYxh 条目的归一化上下文（供 news-normalize 使用）。
export function suyxhNormalizeCtx(raw) {
  return {
    platform: 'SuYxh聚合',
    media: raw.site_name || raw.source || 'SuYxh',
    siteId: raw.site_id || null,
    sourceType: 'suyxh',
    titleFrom: (r) => r.title || r.title_zh || r.title_original || '',
    titleZhFrom: (r) => r.title_zh || r.title_bilingual || '',
    summaryFrom: (r) => '', // 公开源无正文；不伪造
    urlFrom: (r) => r.url || '',
    dateFrom: (r) => r.published_at,
    firstSeenFrom: (r) => r.first_seen_at || null,
    lastSeenFrom: (r) => r.last_seen_at || null,
  };
}

export async function fetchSuYxhAggregator(opts = {}) {
  const {
    fetchImpl = globalThis.fetch,
    endpoints = SUYXH_ENDPOINTS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    now = new Date(),
    skip = [], // 可跳过某些端点（如测试时）
  } = opts;

  const result = {
    collectedAt: now.toISOString(),
    adapter: 'suyxh-adapter',
    endpoints: {},
    items: [], // 去重后的原始条目（含 _ctx）
    upstreamSourceStatus: null,
    opmlFeeds: null,
    failures: [],
    stats: { raw24h: 0, raw7d: 0, unionRaw: 0, sourceCount: null, siteCount: null },
  };

  async function tryFetch(name, url) {
    if (skip.includes(name)) {
      result.endpoints[name] = { status: 'skipped', note: '被 skip 选项跳过' };
      return null;
    }
    const rec = { url, status: 'error' };
    result.endpoints[name] = rec; // 引用挂载：后续对 rec 的修改都可见
    const started = Date.now();
    try {
      const r = await fetchWithTimeout(url, { timeoutMs, fetchImpl });
      rec.httpStatus = r.status;
      rec.durationMs = Date.now() - started;
      if (!r.ok) {
        rec.status = 'error';
        rec.error = `HTTP ${r.status}`;
        result.failures.push({ endpoint: name, error: rec.error });
      } else if (r.parseError) {
        rec.status = 'error';
        rec.error = r.parseError;
        result.failures.push({ endpoint: name, error: r.parseError });
      } else {
        rec.status = 'ok';
        rec.itemCount = Array.isArray(r.parsed?.items) ? r.parsed.items.length : null;
        rec.generatedAt = r.parsed?.generated_at || null;
        return r.parsed;
      }
    } catch (e) {
      rec.status = 'error';
      rec.error = e.name === 'AbortError' ? `请求超时(${timeoutMs / 1000}s)` : e.message;
      rec.durationMs = Date.now() - started;
      result.failures.push({ endpoint: name, error: rec.error });
    }
    result.endpoints[name] = rec;
    return null;
  }

  // 1) latest-24h / latest-7d：取条目并集（按 id 去重，7d 优先）
  const j24 = await tryFetch('latest24h', endpoints.latest24h);
  const j7 = await tryFetch('latest7d', endpoints.latest7d);
  if (j24) {
    result.stats.raw24h = Array.isArray(j24.items) ? j24.items.length : 0;
    result.stats.sourceCount = j24.source_count ?? result.stats.sourceCount;
    result.stats.siteCount = j24.site_count ?? result.stats.siteCount;
  }
  if (j7) {
    result.stats.raw7d = Array.isArray(j7.items) ? j7.items.length : 0;
    result.stats.sourceCount = j7.source_count ?? result.stats.sourceCount;
    result.stats.siteCount = j7.site_count ?? result.stats.siteCount;
  }
  const byId = new Map();
  for (const j of [j24, j7]) {
    if (!j || !Array.isArray(j.items)) continue;
    for (const it of j.items) {
      if (!it || !it.id) continue;
      if (!byId.has(it.id)) byId.set(it.id, it);
    }
  }
  result.stats.unionRaw = byId.size;
  result.items = [...byId.values()].map((raw) => ({ raw, _ctx: suyxhNormalizeCtx(raw) }));

  // 2) source-status.json（上游报告，原样保留供 UI「上游报告」展示）
  const js = await tryFetch('sourceStatus', endpoints.sourceStatus);
  if (js) result.upstreamSourceStatus = js;

  // 3) opml-feeds.json（RSS 清单：仅用于展示来源覆盖，不声称全抓）
  const jo = await tryFetch('opmlFeeds', endpoints.opmlFeeds);
  if (jo) result.opmlFeeds = jo;

  // 4) waytoagi-7d.json（实际查看：当前返回 HTML/非 JSON → 记为失败，不臆造）
  await tryFetch('waytoagi7d', endpoints.waytoagi7d);

  return result;
}
