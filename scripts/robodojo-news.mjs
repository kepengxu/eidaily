import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeRoboDojoId, translateRoboDojoItems } from './robodojo-translate.mjs';
import { loadLLMConfig } from './featured-ranker.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = 'https://robodojo-benchmark.com/leaderboard';
export function parseNews(text) {
  // Read only literal date/text arrays used by the official News component. Never execute fetched JS.
  const blocks = text.match(/\[(?:\{date:"\d{4}\/\d{2}\/\d{2}",text:"(?:\\.|[^"\\])*"\},?)+\]/g) || [];
  const rows = blocks.flatMap(block => [...block.matchAll(/\{date:("\d{4}\/\d{2}\/\d{2}"),text:("(?:\\.|[^"\\])*")\}/g)].map(m => ({ date: JSON.parse(m[1]).replaceAll('/', '-'), text: JSON.parse(m[2]), source: `${source}#news` })));
  // 加稳定 id（date+text 哈希），供翻译缓存/去重复用；原文 date 不变。
  return [...new Map(rows.map(r => [`${r.date}:${r.text}`, r])).values()]
    .sort((a,b) => b.date.localeCompare(a.date))
    .map(r => ({ ...r, id: makeRoboDojoId(r.date, r.text) }));
}
export async function runRoboDojoNews({ fetchImpl = fetch, now = new Date(), skipTranslate = false } = {}) {
  const target = path.join(root, 'public/robodojo-news.json');
  const get = async url => { const response = await fetchImpl(url, { signal: AbortSignal.timeout(25000) }); if (!response.ok) throw new Error(`HTTP ${response.status}`); return response.text(); };
  try {
    const html = await get(source);
    const entry = html.match(/<script[^>]+src="([^"]+\.js)"/);
    if (!entry) throw new Error('未找到官网页面模块');
    const entryUrl = new URL(entry[1], source).href;
    const main = await get(entryUrl);
    let items = parseNews(main);
    let evidenceUrl = entryUrl;
    if (!items.length) {
      const assets = [...new Set(main.match(/assets\/index-[\w-]+\.js/g) || [])].slice(0, 15);
      for (const asset of assets) {
        const url = new URL(`/${asset}`, source).href;
        const text = await get(url);
        if (!text.includes('leaderboard-news')) continue;
        items = parseNews(text);
        if (items.length) { evidenceUrl = url; break; }
      }
    }
    if (!items.length) throw new Error('官网News结构变化或公告为空，未覆盖历史数据');
    // 自动翻译并归档（服务端 LLM；无 key → 保留原文 textZh=null；失败明确保留原文）
    let translatedItems = items;
    let translationMeta = { enabled: false, calledLLM: false, anyFailed: false, model: null };
    if (!skipTranslate) {
      try {
        const cfg = loadLLMConfig(process.env);
        const tr = await translateRoboDojoItems(items, { cfg, fetchImpl, now });
        translatedItems = tr.items;
        translationMeta = { enabled: cfg.enabled, calledLLM: tr.calledLLM, anyFailed: tr.anyFailed, model: tr.model };
      } catch (te) {
        // 翻译故障不影响公告落盘：保留原文
        for (const it of translatedItems) {
          it.textZh = null;
          it.translationStatus = 'failed';
          it.translationWarnings = [`翻译环节异常：${te?.message || te}`];
        }
        translationMeta = { enabled: true, calledLLM: false, anyFailed: true, model: null, error: te?.message || String(te) };
      }
    }
    const report = { status: 'ok', source, evidenceUrl, fetchedAt: new Date().toISOString(), dateMeaning: '官网News公告日期，非监测时间或模型发布日期', translation: translationMeta, items: translatedItems };
    fs.writeFileSync(target, JSON.stringify(report, null, 2));
    const dir = path.join(root, 'public/robodojo-news-history');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date())}.json`), JSON.stringify(report, null, 2));
    return { ...report, news: { generated: 0 } };
  } catch (e) {
    let old = { items: [] }; try { old = JSON.parse(fs.readFileSync(target, 'utf8')); } catch {}
    const report = { ...old, status: 'error', source, error: e.message, lastAttemptAt: new Date().toISOString(), stale: true };
    fs.writeFileSync(target, JSON.stringify(report, null, 2));
    return { ...report, news: { generated: 0 } };
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = await runRoboDojoNews(); console.log(JSON.stringify({ status: r.status, count: r.items.length, latest: r.items[0], error: r.error }, null, 2)); if (r.status !== 'ok') process.exitCode = 1;
}
