// 安全一次性采集 + 源验证脚本（不打印任何密钥 / 含 key 的 URL）
// 统一收集 2 个 API（NewsAPI.org / NewsData）+ 5 个 RSS
// 真实日期筛选、去重、复用共享 matcher 分类（大模型 / 具身智能）
// 用法: node --env-file-if-exists=.env scripts/collect-news-safe.mjs
// 输出: public/news-data.json（真实数据，禁止编造） + /tmp/raw-validation.json（脱敏验证报告）
import Parser from 'rss-parser';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { classifyText, newsDataQuery, serviceQuery } from './news-matcher.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const NEWSAPI_ORG_KEY = process.env.NEWSAPI_ORG_KEY || '';
const NEWSDATA_API_KEY = process.env.NEWSDATA_API_KEY || '';

const TIMEOUT_MS = 20000;
const MAX_AGE_DAYS = 3; // 真实日期窗口：仅保留最近 3 天内、非未来的真实日期条目（用户既有授权范围）
const MAX_ITEMS = 30;

const NOW = new Date();
const cutoff = new Date(NOW.getTime() - MAX_AGE_DAYS * 86400000);

const log = (...a) => console.error(...a); // 摘要走 stderr，避免污染结构化输出

function maskKey(k) {
  if (!k) return '(未配置)';
  return k.slice(0, 4) + '****' + k.slice(-4);
}

async function fetchWithTimeout(url, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal });
    // 在超时保护下完整读取响应体：此前 clearTimeout 在 headers 返回即撤除，
    // 若响应体（body）迟迟不结束则无超时保护。此处先读全 body，再统一清计时器。
    const text = await r.text();
    let parsed;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = {};
    }
    // 暴露与 Response 兼容的最小接口（status / ok / json），供调用方无改动使用
    return {
      status: r.status,
      ok: r.ok,
      json: async () => parsed,
      text: async () => text,
    };
  } finally {
    clearTimeout(t);
  }
}

function parseDate(s) {
  if (!s) return null;
  const d = new Date(s);
  if (isNaN(d.getTime())) return null;
  return d;
}

function hasChinese(s) {
  return /[一-龥]/.test(s || '');
}

function classifyCategory(title, content) {
  const c = classifyText(`${title || ''} ${content || ''}`);
  return c || '其他';
}

function dedupeKey(title, url) {
  const u = (url || '').replace(/\?.*$/, '').toLowerCase().trim();
  if (u) return 'u:' + u;
  const t = (title || '').toLowerCase().replace(/\s+/g, '').slice(0, 80);
  return 't:' + t;
}

const collected = [];
function maybePush(item) {
  const cat = classifyCategory(item.title, item.content || item.summary || '');
  if (cat === '其他') return; // 仅保留两大领域，保持数据干净
  item.category = cat;
  // 真实日期校验：必须可解析、非未来、在窗口内
  const d = parseDate(item.publishedAt);
  if (!d) return; // 无真实日期的条目不收录（禁止伪造日期）
  if (d > NOW) return; // 丢弃未来日期（异常数据）
  if (d < cutoff) return; // 丢弃过旧条目
  collected.push(item);
}

// ---------------- NewsAPI.org ----------------
async function collectNewsApiOrg() {
  const rec = {
    source: 'NewsAPI.org',
    type: 'api',
    configured: !!NEWSAPI_ORG_KEY,
    endpoint: 'newsapi.org/v2/everything',
    requests: [],
  };
  if (!NEWSAPI_ORG_KEY) {
    rec.skipped = 'NEWSAPI_ORG_KEY 未配置，跳过';
    return rec;
  }
  for (const domain of ['llm', 'embodied']) {
    const q = serviceQuery(domain, 'en');
    const url = `https://newsapi.org/v2/everything?q=${encodeURIComponent(q)}&language=en&sortBy=publishedAt&pageSize=10&apiKey=${NEWSAPI_ORG_KEY}`;
    const reqRec = { domain, params: { q_terms: q.split(' OR ').length, language: 'en', pageSize: 10 } };
    try {
      const r = await fetchWithTimeout(url);
      reqRec.httpStatus = r.status;
      const data = await r.json().catch(() => ({}));
      if (r.ok) {
        const arts = Array.isArray(data.articles) ? data.articles : [];
        reqRec.itemCount = arts.length;
        reqRec.totalResults = data.totalResults ?? null;
        for (const a of arts) {
          maybePush({
            title: a.title,
            summary: a.description || '',
            content: a.content || a.description || '',
            source: a.source?.name || 'NewsAPI.org',
            publishedAt: a.publishedAt,
            originalUrl: a.url,
            language: 'en',
            needsTranslation: true,
          });
        }
      } else {
        reqRec.ok = false;
        reqRec.error = data?.message || data?.code || r.statusText;
      }
    } catch (e) {
      reqRec.ok = false;
      reqRec.error = e.name === 'AbortError' ? '请求超时(20s)' : e.message;
    }
    rec.requests.push(reqRec);
  }
  return rec;
}

// ---------------- NewsData ----------------
async function collectNewsData() {
  const rec = {
    source: 'NewsData',
    type: 'api',
    configured: !!NEWSDATA_API_KEY,
    endpoint: 'newsdata.io/api/1/news',
    requests: [],
  };
  if (!NEWSDATA_API_KEY) {
    rec.skipped = 'NEWSDATA_API_KEY 未配置，跳过';
    return rec;
  }
  for (const domain of ['llm', 'embodied']) {
    // 使用 ≤100 字符短查询（免费套餐限制），避免 422 UnsupportedQueryLength
    const q = newsDataQuery(domain, 'en');
    const url = `https://newsdata.io/api/1/news?apikey=${NEWSDATA_API_KEY}&q=${encodeURIComponent(q)}&language=en&size=10`;
    const reqRec = { domain, params: { q, language: 'en', size: 10 } };
    try {
      const r = await fetchWithTimeout(url);
      reqRec.httpStatus = r.status;
      const data = await r.json().catch(() => ({}));
      if (r.ok) {
        const res = Array.isArray(data.results) ? data.results : [];
        reqRec.itemCount = res.length;
        reqRec.totalResults = data.totalResults ?? data.total ?? null;
        for (const a of res) {
          maybePush({
            title: a.title,
            summary: a.description || '',
            content: a.content || a.description || '',
            source: a.source_id || 'NewsData',
            publishedAt: a.pubDate,
            originalUrl: a.link || a.url,
            language: 'en',
            needsTranslation: true,
          });
        }
      } else {
        reqRec.ok = false;
        reqRec.error = data?.message || data?.code || r.statusText;
      }
    } catch (e) {
      reqRec.ok = false;
      reqRec.error = e.name === 'AbortError' ? '请求超时(20s)' : e.message;
    }
    rec.requests.push(reqRec);
  }
  return rec;
}

// ---------------- RSS ----------------
const RSS_SOURCES = [
  { name: '机器之心', url: 'https://www.jiqizhixin.com/rss' },
  { name: '36氪', url: 'https://36kr.com/feed' },
  { name: '钛媒体', url: 'https://www.tmtpost.com/feed' },
  { name: 'InfoQ中文', url: 'https://www.infoq.cn/feed' },
  { name: 'IT之家', url: 'https://www.ithome.com/rss/' },
];

async function collectRSS() {
  const parser = new Parser({
    timeout: TIMEOUT_MS,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; news-collector/1.0)' },
  });
  const rec = { source: 'RSS', type: 'rss', configured: true, requests: [] };
  for (const src of RSS_SOURCES) {
    const reqRec = { source: src.name, endpoint: src.url };
    try {
      const feed = await parser.parseURL(src.url);
      const items = feed.items || [];
      reqRec.httpStatus = '200(解析成功)';
      reqRec.itemCount = items.length;
      let added = 0;
      for (const it of items) {
        const pub = it.isoDate || it.pubDate;
        const title = it.title || '';
        const content = it.contentSnippet || it.content || '';
        const before = collected.length;
        maybePush({
          title,
          summary: content.slice(0, 200),
          content,
          source: src.name,
          publishedAt: pub,
          originalUrl: it.link,
          language: hasChinese(title) ? 'zh' : 'en',
          needsTranslation: !hasChinese(title),
        });
        if (collected.length > before) added++;
      }
      reqRec.addedCount = added;
    } catch (e) {
      reqRec.ok = false;
      reqRec.error = e.message || String(e);
      reqRec.errorType = /HTML/i.test(reqRec.error)
        ? '返回非RSS内容(疑似HTML)'
        : /timeout/i.test(reqRec.error)
          ? '超时(20s)'
          : '解析失败';
      reqRec.httpStatus = 'N/A';
    }
    rec.requests.push(reqRec);
  }
  return rec;
}

// ---------------- 主流程 ----------------
(async () => {
  log('=== 安全一次性采集 + 源验证 ===');
  log('系统时钟(真实):', NOW.toISOString());
  log('用户声明日期: 2026-09-21');
  log('NewsAPI.org 密钥:', maskKey(NEWSAPI_ORG_KEY));
  log('NewsData 密钥:', maskKey(NEWSDATA_API_KEY));
  log('日期窗口: 最近', MAX_AGE_DAYS, '天，禁止未来日期/伪造');

  const newsApiOrg = await collectNewsApiOrg();
  const newsData = await collectNewsData();
  const rss = await collectRSS();

  // 去重
  const seen = new Set();
  const deduped = [];
  for (const it of collected) {
    const key = dedupeKey(it.title, it.originalUrl);
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(it);
    }
  }

  // 排序（按真实发布时间降序）
  deduped.sort((a, b) => {
    const ta = parseDate(a.publishedAt)?.getTime() || 0;
    const tb = parseDate(b.publishedAt)?.getTime() || 0;
    return tb - ta;
  });

  const finalItems = deduped.slice(0, MAX_ITEMS).map((it, i) => ({
    id: 'news_' + NOW.getTime() + '_' + i.toString(16),
    title: it.title,
    summary: (it.summary || '').slice(0, 300),
    content: it.content || '',
    imageUrl: null, // 不伪造图片
    source: it.source,
    publishedAt: it.publishedAt,
    category: it.category,
    originalUrl: it.originalUrl,
    language: it.language,
    needsTranslation: !!it.needsTranslation,
    // 未编造 AI 点评：显式置空
    aiInsight: null,
  }));

  // 领域统计
  const domainCounts = {};
  for (const it of finalItems) {
    domainCounts[it.category] = (domainCounts[it.category] || 0) + 1;
  }
  const englishCount = finalItems.filter((x) => x.needsTranslation).length;

  const output = {
    success: true,
    timestamp: NOW.toISOString(),
    total: finalItems.length,
    source: 'real-collection-2api-5rss',
    generatedBy: 'collect-news-safe.mjs',
    notice:
      englishCount > 0
        ? `共 ${englishCount} 条英文条目保留原文（未配置翻译密钥，未编造翻译）`
        : '全部为中文条目',
    data: finalItems,
  };

  fs.mkdirSync(PUBLIC_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(PUBLIC_DIR, 'news-data.json'),
    JSON.stringify(output, null, 2),
    'utf8'
  );
  log(`\n✅ 已写入 public/news-data.json: ${finalItems.length} 条`);
  log('领域分布:', JSON.stringify(domainCounts));
  log('英文保留条目:', englishCount);

  // 验证报告（脱敏）
  const validationReport = {
    generatedAt: NOW.toISOString(),
    systemClock: NOW.toISOString(),
    userStatedDate: '2026-09-21',
    clockConsistent: NOW.toISOString().startsWith('2026-09-21'),
    dateWindowDays: MAX_AGE_DAYS,
    keysMasked: {
      NEWSAPI_ORG_KEY: maskKey(NEWSAPI_ORG_KEY),
      NEWSDATA_API_KEY: maskKey(NEWSDATA_API_KEY),
    },
    collectedBeforeDedup: collected.length,
    finalCount: finalItems.length,
    domainCounts,
    englishRetainedCount: englishCount,
    sources: [newsApiOrg, newsData, rss],
  };

  fs.writeFileSync('/tmp/raw-validation.json', JSON.stringify(validationReport, null, 2), 'utf8');

  // stderr 可读摘要
  for (const grp of validationReport.sources) {
    log(`\n[${grp.source}] configured=${grp.configured}${grp.skipped ? ' skipped=' + grp.skipped : ''}`);
    for (const r of grp.requests) {
      if (r.skipped) {
        log('  -', r.skipped);
        continue;
      }
      const tag = r.ok === false ? 'ERR' : 'OK ';
      const detail = r.ok === false
        ? `http=${r.httpStatus} err=${r.error || r.errorType}`
        : `http=${r.httpStatus} count=${r.itemCount ?? r.addedCount ?? '-'} ${r.domain ? 'domain=' + r.domain : ''}`;
      log(`  - ${tag} ${r.domain || r.source || ''} ${detail}`);
    }
  }
  log('\n=== 完成，脱敏报告已写入 /tmp/raw-validation.json ===');
})();
