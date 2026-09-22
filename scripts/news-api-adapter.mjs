import { apiQueries, classifyText } from './news-matcher.js';
import { canonicalUrlKey, canonicalTitleKey, cleanUrl } from './lib/url-normalize.mjs';

// 每服务固定有限查询；独立失败、不覆盖既有文件、不输出带密钥URL或响应正文。
export async function fetchNewsAPIs({ fetchImpl = fetch, now = new Date(), env = process.env } = {}) {
  const items = [], requests = [];
  for (const service of ['newsapi', 'newsdata']) {
    const key = env[service === 'newsapi' ? 'NEWSAPI_ORG_KEY' : 'NEWSDATA_API_KEY'];
    if (!key) { requests.push({ service, status: 'skipped' }); continue; }
    for (const domain of ['llm', 'embodied']) {
      for (const lang of ['en', 'zh']) {
        for (const q of apiQueries(service, domain, lang)) {
          const rec = { service, domain, lang, q, status: 'error' };
          requests.push(rec);
          const url = new URL(service === 'newsapi' ? 'https://newsapi.org/v2/everything' : 'https://newsdata.io/api/1/news');
          const params = service === 'newsapi'
            ? { q, apiKey: key, language: lang, pageSize: '20', sortBy: 'publishedAt', from: new Date(+now - 7 * 86400000).toISOString() }
            : { q, apikey: key, language: lang, size: '10' };
          for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
          try {
            const res = await fetchImpl(url, { signal: AbortSignal.timeout(20000) });
            rec.httpStatus = res.status;
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            const rows = service === 'newsapi' ? data.articles : data.results;
            if (!Array.isArray(rows)) throw new Error('新闻响应结构无效');
            rec.status = 'ok'; rec.raw = rows.length; rec.retained = 0;
            for (const r of rows) {
              const title = r.title || '', summary = r.description || '';
              const category = classifyText(`${title} ${summary}`);
              let rawDate = service === 'newsapi' ? r.publishedAt : r.pubDate;
              if (service === 'newsdata' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(rawDate || '')) rawDate = rawDate.replace(' ', 'T') + 'Z';
              const date = new Date(rawDate || NaN);
              const originalUrl = cleanUrl(r.url || r.link || '');
              if (!title || !category || !Number.isFinite(+date) || +date > +now || +date < +now - 7 * 86400000 || !/^https?:\/\//.test(originalUrl)) continue;
              const source = r.source?.name || r.source_id || service;
              const publishedAt = date.toISOString();
              items.push({ title, summary, content: r.content || summary, category, originalUrl, publishedAt,
                source, mediaName: source, upstreamPlatform: service, language: lang,
                sources: [{ platform: service, media: source, url: originalUrl, publishedAt }],
                rawProvenance: { platform: service, fetchedAt: now.toISOString() },
                _urlKey: canonicalUrlKey(originalUrl), _titleKey: canonicalTitleKey(title) });
              rec.retained++;
            }
          } catch (e) { rec.error = e.name === 'TimeoutError' ? '请求超时' : `采集失败${rec.httpStatus ? ` HTTP ${rec.httpStatus}` : ''}`; }
        }
      }
    }
  }
  return { items, requests, successfulRequests: requests.filter(r => r.status === 'ok').length };
}
