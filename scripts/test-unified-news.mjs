// 离线测试：覆盖 adapter fixtures / date 时区-未来-缺失 / 跨源去重保留 provenance /
// 失败缓存 / archive 保留 / pipeline。不依赖网络（用本地 fixture + mock fetchImpl）。
// 运行：node scripts/test-unified-news.mjs

import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import assert from 'assert';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(__dirname, 'fixtures');

import { fetchSuYxhAggregator, SUYXH_ENDPOINTS } from './suyxh-adapter.mjs';
import { normalizeRawItem } from './lib/news-normalize.mjs';
import { dedupItems } from './lib/news-dedup.mjs';
import { loadArchive, mergeIntoArchive, writeArchive } from './lib/archive.mjs';
import { parseStrictUTC, isFuture, withinWindow } from './lib/date-util.mjs';
import { canonicalUrlKey, canonicalTitleKey, cleanUrl, stripTrackingParams } from './lib/url-normalize.mjs';
import { runPipeline } from './unified-news.mjs';

const FIXEP = {
  latest24h: 'https://suyxh.github.io/ai-news-aggregator/data/latest-24h.json',
  latest7d: 'https://suyxh.github.io/ai-news-aggregator/data/latest-7d.json',
  sourceStatus: 'https://suyxh.github.io/ai-news-aggregator/data/source-status.json',
  waytoagi7d: 'https://suyxh.github.io/ai-news-aggregator/data/waytoagi-7d.json',
  opmlFeeds: 'https://suyxh.github.io/ai-news-aggregator/data/opml-feeds.json',
};

function readFix(name) {
  return fs.readFileSync(path.join(FIX, name), 'utf8');
}

// 本地 fixture 驱动的 mock fetchImpl
function makeMockFetch() {
  return async (url) => {
    let body;
    let status = 200;
    if (url === FIXEP.latest24h) body = readFix('suyxh-latest-24h.sample.json');
    else if (url === FIXEP.latest7d) body = readFix('suyxh-latest-7d.sample.json');
    else if (url === FIXEP.sourceStatus) body = readFix('suyxh-source-status.sample.json');
    else if (url === FIXEP.opmlFeeds) body = readFix('suyxh-opml-feeds.sample.json');
    else if (url === FIXEP.waytoagi7d) {
      // 真实情况：返回 HTML（非 JSON）→ 必须记为失败
      status = 404;
      body = readFix('suyxh-waytoagi-7d.html');
    } else {
      status = 404;
      body = '{"error":"unknown fixture url"}';
    }
    return {
      status,
      ok: status >= 200 && status < 300,
      text: async () => body,
    };
  };
}

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}\n      ${e.message}`);
  }
}
function checkAsync(name, fn) {
  return fn().then(
    () => { passed++; console.log(`  ✓ ${name}`); },
    (e) => { failed++; console.log(`  ✗ ${name}\n      ${e.message}`); }
  );
}

console.log('\n=== 1) url-normalize ===');
check('去除跟踪参数与 fragment，保留语义参数', () => {
  const u = 'https://news.example.com/p/1?utm_source=x&fbclid=abc&id=42#section';
  const c = cleanUrl(u);
  assert.ok(!c.includes('utm_source'), '不应含 utm_source');
  assert.ok(!c.includes('fbclid'), '不应含 fbclid');
  assert.ok(!c.includes('#section'), '不应含 fragment');
  assert.ok(c.includes('id=42'), '应保留语义参数 id');
});
check('canonicalUrlKey 小写 host + 排序参数', () => {
  const a = canonicalUrlKey('https://X.EXAMPLE.com/p?b=2&a=1');
  const b = canonicalUrlKey('https://x.example.com/p?a=1&b=2');
  assert.strictEqual(a, b, '规范键应一致');
});

console.log('\n=== 2) date-util ===');
check('严格 UTC 解析（含 Z）', () => {
  const d = parseStrictUTC('2026-09-21T02:16:18.838Z');
  assert.ok(d && d.getTime() === Date.parse('2026-09-21T02:16:18.838Z'));
});
check('无时区按源 UTC 处理', () => {
  const d = parseStrictUTC('2026-09-21 02:16:18');
  assert.ok(d && d.getUTCHours() === 2, '应视为 UTC 02:16');
});
check('无法解析返回 null（未知日期不收录）', () => {
  assert.strictEqual(parseStrictUTC(''), null);
  assert.strictEqual(parseStrictUTC('not-a-date'), null);
  assert.strictEqual(parseStrictUTC(null), null);
});
check('未来日期隔离', () => {
  const future = new Date(Date.now() + 86400000 * 10);
  assert.strictEqual(isFuture(future.toISOString(), new Date()), true);
  assert.strictEqual(isFuture('2020-01-01T00:00:00Z', new Date()), false);
});
check('窗口判定（24h/7d/90d）', () => {
  const now = new Date('2026-09-21T12:00:00Z');
  assert.strictEqual(withinWindow('2026-09-21T11:00:00Z', 1, now), true);
  assert.strictEqual(withinWindow('2026-09-20T11:00:00Z', 1, now), false);
  assert.strictEqual(withinWindow('2026-09-21T11:00:00Z', 7, now), true);
  assert.strictEqual(withinWindow('2026-09-21T11:00:00Z', 90, now), true);
});

console.log('\n=== 3) news-normalize（分类/过滤/数学守卫）===');
const suyxhCtx = (raw) => ({
  platform: 'SuYxh聚合', media: raw.site_name || 'SuYxh', siteId: raw.site_id || null, sourceType: 'suyxh',
  titleFrom: (r) => r.title, titleZhFrom: (r) => r.title_zh || '', summaryFrom: () => '',
  urlFrom: (r) => r.url, dateFrom: (r) => r.published_at, firstSeenFrom: (r) => r.first_seen_at, lastSeenFrom: (r) => r.last_seen_at,
});
function loadSample24() { return JSON.parse(readFix('suyxh-latest-24h.sample.json')); }
check('大模型强词命中 → 含入', () => {
  const raw = loadSample24().items.find((i) => i.id === 'a1001');
  const r = normalizeRawItem(raw, suyxhCtx(raw));
  assert.strictEqual(r.status, 'ok');
  assert.strictEqual(r.item.category, '大模型');
  assert.strictEqual(r.item.titleZh, raw.title_zh);
  assert.strictEqual(r.item.summary, '', '公开源无正文，summary 应为空（不伪造）');
});
check('具身实体+robotics锚 → 含入（傅利叶公司）', () => {
  const raw = loadSample24().items.find((i) => i.id === 'a1007');
  const r = normalizeRawItem(raw, suyxhCtx(raw));
  assert.strictEqual(r.status, 'ok');
  assert.strictEqual(r.item.category, '具身智能');
});
check('傅利叶数学误报守卫 → 排除', () => {
  const raw = loadSample24().items.find((i) => i.id === 'a1006');
  const r = normalizeRawItem(raw, suyxhCtx(raw));
  assert.strictEqual(r.status, 'excluded');
  assert.ok(/数学/.test(r.reason), '排除原因应提及数学: ' + r.reason);
});
check('泛财经生活 → 排除（未命中两领域）', () => {
  const raw = loadSample24().items.find((i) => i.id === 'a1005');
  const r = normalizeRawItem(raw, suyxhCtx(raw));
  assert.strictEqual(r.status, 'excluded');
});
check('未来日期 → future（不收录/不称今日）', () => {
  const raw = loadSample24().items.find((i) => i.id === 'a1008');
  const r = normalizeRawItem(raw, suyxhCtx(raw), { now: new Date('2026-09-21T12:00:00Z') });
  assert.strictEqual(r.status, 'future');
});
check('未知日期 → excluded（不伪造今天）', () => {
  const raw = loadSample24().items.find((i) => i.id === 'a1009');
  const r = normalizeRawItem(raw, suyxhCtx(raw));
  assert.strictEqual(r.status, 'excluded');
  assert.ok(/日期/.test(r.reason));
});
check('无标题 → excluded', () => {
  const raw = loadSample24().items.find((i) => i.id === 'a1012');
  const r = normalizeRawItem(raw, suyxhCtx(raw));
  assert.strictEqual(r.status, 'excluded');
});

console.log('\n=== 4) 跨源去重（保留 sources[] / provenance）===');
check('同标题跨源 → 合并 sources，保留双方 provenance', () => {
  const items = loadSample24().items.filter((i) => ['a1001', 'a1002'].includes(i.id));
  const norm = items.map((raw) => normalizeRawItem(raw, suyxhCtx(raw)).item);
  const merged = dedupItems(norm);
  assert.strictEqual(merged.length, 1, '应合并为 1 条');
  assert.strictEqual(merged[0].sources.length, 2, 'sources 应为 2');
  assert.ok(merged[0].sources.some((s) => s.media === '新智元'));
  assert.ok(merged[0].sources.some((s) => s.media === '量子位'));
});
check('首次 last_seen 不替换最早 publishedAt', () => {
  // a1001 published 01:10, a1002 published 01:30 → 合并后应保留最早 01:10
  const items = loadSample24().items.filter((i) => ['a1001', 'a1002'].includes(i.id));
  const norm = items.map((raw) => normalizeRawItem(raw, suyxhCtx(raw)).item);
  const merged = dedupItems(norm);
  assert.strictEqual(merged[0].publishedAt, '2026-09-21T01:10:00.000Z');
});

console.log('\n=== 5) adapter fixtures + 失败缓存 ===');
await checkAsync('实际抓取 fixture，waytoagi 默认禁用且不计失败', async () => {
  const res = await fetchSuYxhAggregator({ fetchImpl: makeMockFetch(), now: new Date('2026-09-21T12:00:00Z') });
  assert.strictEqual(res.endpoints.latest24h.status, 'ok');
  assert.strictEqual(res.endpoints.latest7d.status, 'ok');
  assert.strictEqual(res.endpoints.sourceStatus.status, 'ok');
  assert.strictEqual(res.endpoints.opmlFeeds.status, 'ok');
  assert.strictEqual(res.endpoints.waytoagi7d.status, 'disabled', 'waytoagi 默认禁用');
  assert.ok(!res.failures.some((f) => f.endpoint === 'waytoagi7d'), '禁用不计为失败');
  assert.ok(res.items.length > 0, '应有并集条目');
  assert.ok(res.upstreamSourceStatus && res.upstreamSourceStatus.failed_sites.includes('aihubtoday'));
});

console.log('\n=== 6) archive 保留 / 90 天裁剪 / 不丢新来源 ===');
check('合并新项、裁剪过期、保留 publishedAt', () => {
  const now = new Date('2026-09-21T12:00:00Z');
  const old = [
    { id: 'u_old', title: '旧条目', publishedAt: new Date(now.getTime() - 100 * 86400000).toISOString(), category: '大模型', sources: [{ platform: 'x', media: 'm', url: 'u', attribution: 'a', publishedAt: 'x' }], _urlKey: 'u:a', _titleKey: 't:旧条目' },
  ];
  const fresh = [
    { id: 'u_new', title: '新条目', publishedAt: now.toISOString(), category: '具身智能', sources: [{ platform: 'y', media: 'n', url: 'v', attribution: 'b', publishedAt: 'y' }], _urlKey: 'u:b', _titleKey: 't:新条目' },
  ];
  const r1 = mergeIntoArchive({ schemaVersion: 1, updatedAt: '', retentionDays: 90, items: old }, fresh, { now });
  assert.strictEqual(r1.total, 1, '过期项应被裁剪，仅剩新项');
  assert.strictEqual(r1.pruned, 1);
  // 再合并一次同新项（模拟下次运行），不应重复
  const r2 = mergeIntoArchive(r1.archive, fresh, { now });
  const cnt = r2.archive.items.filter((i) => i.title === '新条目').length;
  assert.strictEqual(cnt, 1, '不应重复');
});
check('已存在项合并 sources 但不替换 publishedAt', () => {
  const now = new Date('2026-09-21T12:00:00Z');
  const published = '2026-09-20T00:00:00.000Z';
  const prev = [{ id: 'u_x', title: 'X', publishedAt: published, category: '大模型', sources: [{ platform: 'p1', media: 'm1', url: 'u1', attribution: 'a1', publishedAt: published }], _urlKey: 'u:u1', _titleKey: 't:x' }];
  const incoming = [{ id: 'u_x', title: 'X', publishedAt: now.toISOString(), category: '大模型', sources: [{ platform: 'p2', media: 'm2', url: 'u2', attribution: 'a2', publishedAt: now.toISOString() }], _urlKey: 'u:u1', _titleKey: 't:x' }];
  const r = mergeIntoArchive({ schemaVersion: 1, updatedAt: '', retentionDays: 90, items: prev }, incoming, { now });
  const it = r.archive.items.find((i) => i.title === 'X');
  assert.strictEqual(it.publishedAt, published, 'publishedAt 不应被替换');
  assert.strictEqual(it.sources.length, 2, 'sources 应累加');
});

console.log('\n=== 7) pipeline 端到端（mock fetch，临时目录）===');
await checkAsync('runPipeline 产出 news-data.json + archive + 校验报告', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'unified-test-'));
  const publicDir = path.join(tmp, 'public');
  const outputsDir = path.join(tmp, 'outputs');
  fs.mkdirSync(publicDir, { recursive: true });
  fs.mkdirSync(outputsDir, { recursive: true });
  // 空 base（无既有 news-data.json）
  const report = await runPipeline({
    fetchImpl: makeMockFetch(),
    now: new Date('2026-09-21T12:00:00Z'),
    publicDir, outputsDir, skipBase: true, runBenchmark: false, maxHomepage: 8000, quiet: true,
  });
  // 校验文件
  const nd = JSON.parse(fs.readFileSync(path.join(publicDir, 'news-data.json'), 'utf8'));
  assert.strictEqual(nd.success, true);
  assert.ok(Array.isArray(nd.data) && nd.data.length > 0, '应有数据');
  assert.ok(Array.isArray(nd.featured) && nd.featured.length <= 10, '精选≤10');
  assert.ok(nd.meta.sourceStatusUpstream && nd.meta.sourceStatusUpstream.sites.failed.includes('aihubtoday'), '上游失败源应保留');
  assert.ok(nd.meta.opmlCoverage && nd.meta.opmlCoverage.totalFeeds === 6, 'OPML 覆盖计数');
  // 跨源合并：a1001+a1002 应合并为 1 条（title 同）
  const gpt = nd.data.filter((i) => /GPT-5\.2/.test(i.title));
  assert.strictEqual(gpt.length, 1, '跨源同项应合并为 1');
  assert.strictEqual(gpt[0].sources.length, 2, '合并后 sources=2');
  // 数学/泛财经/未来/无日期/无标题 不应出现
  const titles = nd.data.map((i) => i.title);
  assert.ok(!titles.some((t) => /傅利叶级数/.test(t)), '数学误报应排除');
  assert.ok(!titles.some((t) => /股市大涨/.test(t)), '泛财经应排除');
  assert.ok(!titles.some((t) => /DeepSeek 预告下周/.test(t)), '未来应隔离');
  assert.ok(!titles.some((t) => /Claude 新增工具调用/.test(t)), '无日期应排除');
  // archive 存在且不截断
  const arc = JSON.parse(fs.readFileSync(path.join(publicDir, 'news-archive.json'), 'utf8'));
  assert.ok(arc.items.length >= nd.data.length, '归档应含全部（不截断）');
  // 校验报告
  const val = JSON.parse(fs.readFileSync(path.join(outputsDir, 'unified-news-validation.json'), 'utf8'));
  assert.strictEqual(val.counts.futureIsolated, 1, '未来隔离计数=1');
  assert.ok(!val.failures.some((f) => f.endpoint === 'waytoagi7d'), '禁用不计为失败');
  // backup 不应删旧（此轮无可备份，跳过）
});

console.log('\n=== 8) pipeline：base 复用 + 失败源保留归档 ===');
await checkAsync('既有 base 与 SuYxh 合并，归档保留两方', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'unified-test2-'));
  const publicDir = path.join(tmp, 'public');
  const outputsDir = path.join(tmp, 'outputs');
  fs.mkdirSync(publicDir, { recursive: true });
  fs.mkdirSync(outputsDir, { recursive: true });
  // 预置既有 news-data.json（含两条 base 两领域新闻）
  const baseData = {
    success: true, total: 2, data: [
      { id: 'legacy1', title: '旧采集：某大模型发布', summary: '旧摘要', content: '旧内容', source: '机器之心', publishedAt: '2026-09-21T05:00:00Z', category: '大模型', originalUrl: 'https://legacy.example.com/1', upstreamPlatform: '既有采集(base)', mediaName: '机器之心' },
      { id: 'bench_x', title: '三榜动态项', benchmarkNews: true, category: '具身智能', publishedAt: '2026-09-21T05:00:00Z' },
    ],
  };
  fs.writeFileSync(path.join(publicDir, 'news-data.json'), JSON.stringify(baseData));
  const report = await runPipeline({
    fetchImpl: makeMockFetch(), now: new Date('2026-09-21T12:00:00Z'),
    publicDir, outputsDir, skipBase: false, runBenchmark: false, maxHomepage: 8000, quiet: true,
  });
  const nd = JSON.parse(fs.readFileSync(path.join(publicDir, 'news-data.json'), 'utf8'));
  // base 旧采集项应保留（benchmark 项被跳过，由 benchmark-monitor 独立维护，此处不纳入）
  assert.ok(nd.data.some((i) => i.title === '旧采集：某大模型发布'), 'base 项应保留');
  assert.ok(!nd.data.some((i) => i.title === '三榜动态项'), 'benchmark 项不纳入归档（独立维护）');
  // 归档包含 base + suyxh
  assert.ok(report.counts.archived >= 2, '归档应含 base+suyxh');
});

console.log(`\n=== 结果：通过 ${passed}，失败 ${failed} ===`);
process.exit(failed ? 1 : 0);
