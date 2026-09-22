// 新闻源小批量验证脚本（不打印任何密钥 / 带 key 的 URL）
// 用法: node --env-file-if-exists=.env scripts/validate-sources.mjs
// 输出: 结构化 JSON 报告到 stdout（同时打印可读摘要到 stderr）
import Parser from 'rss-parser';
import { classifyText, serviceQuery, newsApiQuery } from './news-matcher.js';

const log = (...a) => console.error(...a); // 摘要走 stderr，避免污染 JSON stdout

const NEWSAPI_ORG_KEY = process.env.NEWSAPI_ORG_KEY || '';
const NEWSDATA_API_KEY = process.env.NEWSDATA_API_KEY || '';

// 真实时钟日期：取 2 天前作为 from 窗口（落在免费套餐时间窗内）
const twoDaysAgo = new Date();
twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
const fromDate = twoDaysAgo.toISOString().split('T')[0];

const RSS_SOURCES = [
  { name: '机器之心', url: 'https://www.jiqizhixin.com/rss' },
  { name: '36氪', url: 'https://36kr.com/feed' },
  { name: '钛媒体', url: 'https://www.tmtpost.com/feed' },
  { name: 'InfoQ中文', url: 'https://www.infoq.cn/feed' },
  { name: 'IT之家', url: 'https://www.ithome.com/rss/' },
];

function maskKey(k) {
  if (!k) return '(未配置)';
  return k.slice(0, 4) + '****' + k.slice(-4);
}

function categorizeSample(items) {
  const counts = {};
  for (const it of items) {
    const c = classifyText(`${it.title || ''} ${it.content || ''}`);
    if (c) counts[c] = (counts[c] || 0) + 1;
  }
  return counts;
}

async function validateNewsApiOrg() {
  const results = [];
  if (!NEWSAPI_ORG_KEY) {
    results.push({ domain: 'llm', configured: false, note: 'NEWSAPI_ORG_KEY 未配置，跳过' });
    results.push({ domain: 'embodied', configured: false, note: 'NEWSAPI_ORG_KEY 未配置，跳过' });
    return { api: 'NewsAPI.org', configured: false, results };
  }
  for (const domain of ['llm', 'embodied']) {
    const q = encodeURIComponent(serviceQuery(domain, 'en'));
    const url = `https://newsapi.org/v2/everything?q=${q}&language=en&sortBy=publishedAt&from=${fromDate}&pageSize=10&apiKey=${NEWSAPI_ORG_KEY}`;
    const rec = { domain, configured: true, endpoint: 'newsapi.org/v2/everything', method: 'GET', params: { q_terms: serviceQuery(domain, 'en').split(' OR ').length, language: 'en', from: fromDate, pageSize: 10 } };
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 20000);
    try {
      const r = await fetch(url, { signal: ctrl.signal });
      const data = await r.json().catch(() => ({}));
      rec.httpStatus = r.status;
      rec.httpStatusText = r.statusText;
      if (r.ok) {
        rec.articlesReturned = Array.isArray(data.articles) ? data.articles.length : 0;
        rec.apiTotalResults = data.totalResults ?? null;
        const sample = (data.articles || []).slice(0, 3).map(a => ({
          title: a.title, source: a.source?.name, publishedAt: a.publishedAt,
        }));
        rec.sample = sample;
        rec.categoryCounts = categorizeSample((data.articles || []).map(a => ({ title: a.title, content: a.description || a.content || '' })));
        rec.ok = true;
      } else {
        rec.ok = false;
        rec.error = data?.message || data?.error || r.statusText;
        rec.errorCode = data?.code || null;
      }
    } catch (e) {
      rec.ok = false;
      rec.error = e.name === 'AbortError' ? '请求超时(20s)' : e.message;
    } finally { clearTimeout(t); }
    results.push(rec);
  }
  return { api: 'NewsAPI.org', configured: true, results };
}

async function validateNewsData() {
  const results = [];
  if (!NEWSDATA_API_KEY) {
    results.push({ domain: 'llm', configured: false, note: 'NEWSDATA_API_KEY 未配置，跳过' });
    results.push({ domain: 'embodied', configured: false, note: 'NEWSDATA_API_KEY 未配置，跳过' });
    return { api: 'NewsData', configured: false, results };
  }
  for (const domain of ['llm', 'embodied']) {
    const q = encodeURIComponent(serviceQuery(domain, 'en'));
    // 先用小批量 size=10（免费套餐上限附近），再探测 size=50 是否触发套餐错误
    for (const size of [10, 50]) {
      const url = `https://newsdata.io/api/1/news?apikey=${NEWSDATA_API_KEY}&q=${q}&category=technology&language=en&size=${size}`;
      const rec = { domain, configured: true, endpoint: 'newsdata.io/api/1/news', method: 'GET', params: { q_terms: serviceQuery(domain, 'en').split(' OR ').length, category: 'technology', language: 'en', size }, sizeProbe: size };
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 20000);
      try {
        const r = await fetch(url, { signal: ctrl.signal });
        const data = await r.json().catch(() => ({}));
        rec.httpStatus = r.status;
        rec.httpStatusText = r.statusText;
        if (r.ok) {
          rec.resultsReturned = Array.isArray(data.results) ? data.results.length : 0;
          rec.apiTotalResults = data.totalResults ?? data.total ?? null;
          const sample = (data.results || []).slice(0, 3).map(a => ({
            title: a.title, source: a.source_id, pubDate: a.pubDate,
          }));
          rec.sample = sample;
          rec.categoryCounts = categorizeSample((data.results || []).map(a => ({ title: a.title, content: a.description || a.content || '' })));
          rec.ok = true;
        } else {
          rec.ok = false;
          rec.error = data?.message || data?.error || r.statusText;
          rec.errorCode = data?.code || null;
        }
      } catch (e) {
        rec.ok = false;
        rec.error = e.name === 'AbortError' ? '请求超时(20s)' : e.message;
      } finally { clearTimeout(t); }
      results.push(rec);
    }
  }
  return { api: 'NewsData', configured: true, results };
}

async function validateRSS() {
  const parser = new Parser({ timeout: 20000, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; news-validator/1.0)' } });
  const results = [];
  for (const src of RSS_SOURCES) {
    const rec = { source: src.name, endpoint: src.url, method: 'RSS', timeoutMs: 20000 };
    try {
      const feed = await parser.parseURL(src.url); // 一次尝试，rss-parser 自带 20s 超时
      const items = (feed.items || []).slice(0, 5);
      rec.ok = true;
      rec.httpStatus = '200(解析成功)';
      rec.itemsReturned = feed.items?.length || 0;
      const sample = items.map(it => ({
        title: it.title, pubDate: it.pubDate, source: src.name,
      }));
      rec.sample = sample;
      rec.categoryCounts = categorizeSample(items.map(it => ({ title: it.title, content: (it.contentSnippet || it.content || '') })));
    } catch (e) {
      rec.ok = false;
      rec.error = e.message || String(e);
      // 区分：返回 HTML 而非 XML（非 RSS 端点）/ 超时 / 其它
      if (/HTML/i.test(rec.error)) rec.errorType = '返回非RSS内容(疑似HTML)';
      else if (/timeout/i.test(rec.error)) rec.errorType = '超时(20s)';
      else rec.errorType = '解析失败';
      rec.httpStatus = 'N/A';
    }
    results.push(rec);
  }
  return { api: 'RSS', configured: true, results };
}

(async () => {
  log('=== 开始新闻源小批量验证 ===');
  log('from 窗口(真实日期):', fromDate);
  log('NewsAPI.org 密钥:', maskKey(NEWSAPI_ORG_KEY));
  log('NewsData 密钥:', maskKey(NEWSDATA_API_KEY));

  const newsApiOrg = await validateNewsApiOrg();
  const newsData = await validateNewsData();
  const rss = await validateRSS();

  const report = {
    generatedAt: new Date().toISOString(),
    fromDate,
    sources: [newsApiOrg, newsData, rss],
  };

  // 可读摘要到 stderr
  for (const grp of report.sources) {
    log(`\n[${grp.api}] configured=${grp.configured}`);
    for (const r of grp.results) {
      if (r.note) { log('  -', r.note); continue; }
      const tag = r.ok ? 'OK ' : 'ERR';
      const detail = r.ok
        ? `http=${r.httpStatus} count=${r.resultsReturned ?? r.articlesReturned} cat=${JSON.stringify(r.categoryCounts)}`
        : `http=${r.httpStatus} err=${r.error || r.errorType}`;
      log(`  - ${tag} ${r.domain || r.source || ''} ${detail}`);
    }
  }

  process.stdout.write(JSON.stringify(report, null, 2));
})();
