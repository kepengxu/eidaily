// 统一新闻编排管线（collect + aggregate + archive + benchmark 统一入口）
//
// 用法：
//   node --env-file-if-exists=.env scripts/unified-news.mjs
//   node scripts/unified-news.mjs --skip-base        # 跳过读取既有 news-data.json（仅 SuYxh + 归档）
//   node scripts/unified-news.mjs --no-benchmark     # 不调用三榜监测
//   node scripts/unified-news.mjs --max-homepage=8000
//
// 设计原则（严格遵循授权）：
//  - 真实完成 SuYxh 公开聚合数据接入；其余来源(reuse 既有采集 / 三榜)独立失败不整个清空。
//  - 统一字段、两大领域(大模型/具身智能，含 AI 工具工程)过滤；不引入泛财经生活；保留原文 URL/上游平台/媒体名/署名。
//  - 跨源同项保留 sources[]（精确去重，不模糊乱并）；首次 last_seen 不替换 publishedAt。
//  - 90 天滚动归档持久化、不截断；与首页 10 精选/分页分离。
//  - 每条请求 20-30s body 全超时；有效旧数据在源失败时保留（归档不覆盖丢失）。
//  - 覆盖被写 public 数据到 outputs/backup（不删旧）。
//  - 三榜监测独立步骤，失败仅记录不中断。

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { fetchSuYxhAggregator, SUYXH_ENDPOINTS } from './suyxh-adapter.mjs';
import { fetchPulsar } from './pulsar-adapter.mjs';
import { curatePulsar } from './pulsar-curator.mjs';
import { fetchNewsAPIs } from './news-api-adapter.mjs';
import { normalizeRawItem } from './lib/news-normalize.mjs';
import { dedupItems } from './lib/news-dedup.mjs';
import { loadArchive, mergeIntoArchive, writeArchive } from './lib/archive.mjs';
import { parseStrictUTC, isFuture, withinWindow } from './lib/date-util.mjs';
import { canonicalUrlKey, canonicalTitleKey, cleanUrl } from './lib/url-normalize.mjs';
import { classifyWithReason, guardMathFalsePositive } from './news-matcher.js';
import { rankFeatured, loadLLMConfig } from './featured-ranker.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(REPO_ROOT, 'public');
const OUTPUTS_DIR = path.join(REPO_ROOT, 'outputs');
const BACKUP_DIR = path.join(OUTPUTS_DIR, 'backup');

const NEWS_DATA = path.join(PUBLIC_DIR, 'news-data.json');
const NEWS_ARCHIVE = path.join(PUBLIC_DIR, 'news-archive.json');
const SUYXH_STATUS = path.join(PUBLIC_DIR, 'suyxh-source-status.json');
const VALIDATION = path.join(OUTPUTS_DIR, 'unified-news-validation.json');

const RETENTION_DAYS = 90;
const TWO_DOMAINS = new Set(['大模型', '具身智能']);

function log(...a) {
  process.stderr.write(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') + '\n');
}

function hasChinese(s) {
  return /[一-龥]/.test(s || '');
}

// ---------------- 备份（不删旧） ----------------
function backupPublic() {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const backed = [];
  for (const f of [NEWS_DATA, NEWS_ARCHIVE]) {
    try {
      if (fs.existsSync(f)) {
        const dest = path.join(BACKUP_DIR, `${path.basename(f)}.${ts}.bak`);
        fs.mkdirSync(BACKUP_DIR, { recursive: true });
        fs.copyFileSync(f, dest);
        backed.push(dest);
      }
    } catch (e) {
      log(`  [warn] 备份 ${f} 失败: ${e?.message || e}`);
    }
  }
  return backed;
}

// ---------------- 既有采集（base）归一化 ----------------
// 读取既有 news-data.json，信任其两大领域分类，仅校验日期/清理 URL，构建 sources[]。
// 跳过三榜动态新闻（由 benchmark-monitor 独立维护，避免 id 漂移导致重复）。
function normalizeLegacyItem(item, now) {
  if (item?.benchmarkNews || (item?.id || '').startsWith('bench_')) {
    return { status: 'benchmark-skip', item };
  }
  const title = (item?.title || '')?.toString().trim();
  if (!title) return { status: 'excluded', reason: '无标题' };
  const category = item?.category;
  if (!TWO_DOMAINS.has(category)) {
    return { status: 'excluded', reason: `非两大领域(旧分类:${category || '空'})` };
  }
  const date = parseStrictUTC(item?.publishedAt);
  if (!date) return { status: 'excluded', reason: '日期无法解析(未知日期不收录)' };
  if (isFuture(date, now)) return { status: 'future', reason: '未来日期隔离', publishedAtISO: date.toISOString() };

  const originalUrl = cleanUrl(item?.originalUrl || '');
  const media = item?.mediaName || item?.source || '既有采集';
  const platform = item?.upstreamPlatform || '既有采集(base)';
  const sourceEntry = {
    platform,
    media,
    siteId: null,
    url: originalUrl || item?.originalUrl || '',
    attribution: item?.attribution || `${media} via ${platform}`,
    publishedAt: date.toISOString(),
  };
  const language = item?.language || (hasChinese(title) ? 'zh' : 'en');
  const norm = {
    title,
    titleZh: item?.titleZh || (language === 'zh' ? title : ''),
    summary: item?.summary || '',
    content: item?.content || '',
    imageUrl: null,
    source: media,
    publishedAt: date.toISOString(),
    category,
    originalUrl: originalUrl || item?.originalUrl || '',
    aiInsight: null,
    language,
    needsTranslation: language === 'en',
    upstreamPlatform: platform,
    mediaName: media,
    attribution: sourceEntry.attribution,
    sources: Array.isArray(item?.sources) && item.sources.length ? item.sources : [sourceEntry],
    rawProvenance: item?.rawProvenance || { legacy: true, id: item?.id, source: item?.source, upstreamPlatform: item?.upstreamPlatform },
    ...(item?.pulsarLane ? { pulsarLane: item.pulsarLane, lane: item.lane, eventPublishedAt: item.eventPublishedAt, fetchedAt: item.fetchedAt, originalText: item.originalText, pulsarProcessing: item.pulsarProcessing } : {}),
    filterReason: `既有采集(信任原分类 ${category})`,
    firstSeenAt: null,
    lastSeenAt: null,
    _urlKey: canonicalUrlKey(originalUrl || item?.originalUrl || ''),
    _titleKey: canonicalTitleKey(title),
  };
  return { status: 'ok', item: norm, reason: norm.filterReason };
}

// ---------------- 规则排序精选（非声称 AI 重要性） ----------------
// 规则：时间新鲜度(70%) + 有摘要(15%) + 跨源多来源(10%) + 含中文标题(5%)。
function pickFeatured(items, now, n = 10) {
  const scored = items.map((it) => {
    const age = (now.getTime() - parseStrictUTC(it.publishedAt)?.getTime() || 0) / 86400000;
    const recency = Math.max(0, 1 - age / RETENTION_DAYS);
    const hasSummary = it.summary && it.summary.trim().length > 15 ? 0.15 : 0;
    const multiSource = (it.sources?.length || 1) > 1 ? 0.1 : 0;
    const zhTitle = hasChinese(it.title) ? 0.05 : 0;
    return { it, score: recency * 0.7 + hasSummary + multiSource + zhTitle };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, n).map((s) => s.it);
}

// ---------------- 构建首页 news-data.json ----------------
function buildHomepage(archiveItems, { now, maxHomepage, upstreamSourceStatus, opmlFeeds, suyxhStats }) {
  const sorted = [...archiveItems].sort((a, b) => {
    const ta = parseStrictUTC(a.publishedAt)?.getTime() || 0;
    const tb = parseStrictUTC(b.publishedAt)?.getTime() || 0;
    return tb - ta;
  });

  const windows = { '24h': 0, '7d': 0, '90d': 0 };
  const categoryCounts = {};
  const sourceCounts = {};
  for (const it of sorted) {
    if (withinWindow(it.publishedAt, 1, now)) windows['24h']++;
    if (withinWindow(it.publishedAt, 7, now)) windows['7d']++;
    if (withinWindow(it.publishedAt, 90, now)) windows['90d']++;
    categoryCounts[it.category] = (categoryCounts[it.category] || 0) + 1;
    const m = it.mediaName || it.source || '未知';
    sourceCounts[m] = (sourceCounts[m] || 0) + 1;
  }

  const capped = sorted.length > maxHomepage;
  const data = capped ? sorted.slice(0, maxHomepage) : sorted;
  const featured = pickFeatured(sorted, now, 10);

  const sourceStatusUpstream = upstreamSourceStatus
    ? {
        generatedAt: upstreamSourceStatus.generated_at || null,
        sites: {
          total: Array.isArray(upstreamSourceStatus.sites) ? upstreamSourceStatus.sites.length : null,
          ok: upstreamSourceStatus.successful_sites ?? null,
          failed: Array.isArray(upstreamSourceStatus.failed_sites) ? upstreamSourceStatus.failed_sites : [],
          zeroItem: Array.isArray(upstreamSourceStatus.zero_item_sites) ? upstreamSourceStatus.zero_item_sites : [],
        },
        fetchedRawItems: upstreamSourceStatus.fetched_raw_items ?? null,
        itemsBeforeTopicFilter: upstreamSourceStatus.items_before_topic_filter ?? null,
        itemsIn24h: upstreamSourceStatus.items_in_24h ?? null,
        rssOpml: upstreamSourceStatus.rss_opml
          ? {
              enabled: upstreamSourceStatus.rss_opml.enabled,
              feedTotal: upstreamSourceStatus.rss_opml.feed_total,
              effectiveFeedTotal: upstreamSourceStatus.rss_opml.effective_feed_total,
              okFeeds: upstreamSourceStatus.rss_opml.ok_feeds,
              failedFeeds: upstreamSourceStatus.rss_opml.failed_feeds,
              zeroItemFeeds: upstreamSourceStatus.rss_opml.zero_item_feeds,
              skippedFeeds: upstreamSourceStatus.rss_opml.skipped_feeds,
              replacedFeeds: upstreamSourceStatus.rss_opml.replaced_feeds ?? null,
            }
          : null,
        topicFilter: 'ai_tech_robotics',
        note: '公开聚合源已按 ai_tech_robotics 主题过滤；source_count 仅表示上游来源覆盖，不等同本页全部可用来源；本页仅纳入通过两大领域(大模型/具身智能)过滤的条目。',
      }
    : null;

  const opmlCoverage = opmlFeeds
    ? {
        groups: Array.isArray(opmlFeeds) ? opmlFeeds.length : null,
        totalFeeds: Array.isArray(opmlFeeds) ? opmlFeeds.reduce((n, g) => n + (Array.isArray(g.feeds) ? g.feeds.length : 0), 0) : null,
        note: 'OPML RSS 清单仅用于展示上游来源覆盖范围，不代表本页已全部抓取这些源。',
      }
    : null;

  const meta = {
    generatedAt: now.toISOString(),
    generatedBy: 'unified-news-pipeline',
    total: sorted.length,
    archiveTotal: archiveItems.length,
    retentionDays: RETENTION_DAYS,
    windows,
    categoryCounts,
    sourceCounts,
    sourceStatusUpstream,
    opmlCoverage,
    featuredRule: 'recency*0.7 + hasSummary*0.15 + multiSource*0.1 + zhTitle*0.05（规则排序，非声称AI重要性）',
    homepageCapped: capped,
    homepageCap: maxHomepage,
    note: capped
      ? `首页展示上限 ${maxHomepage} 条（公开 JSON 过大已限条数，完整归档见 news-archive.json，共 ${archiveItems.length} 条）。`
      : '首页展示最近 90 天归档全量（无 30 条截断）。',
  };

  return {
    success: true,
    timestamp: now.toISOString(),
    source: 'unified: 既有采集(base) + SuYxh聚合 + 三榜动态',
    meta,
    featured,
    data,
  };
}

// ---------------- 主流程（可导出，便于测试） ----------------
export async function runPipeline(opts = {}) {
  const {
    fetchImpl = globalThis.fetch,
    now = new Date(),
    publicDir = PUBLIC_DIR,
    outputsDir = OUTPUTS_DIR,
    skipBase = false,
    runBenchmark = true,
    runRank = true,
    runPulsar = true,
    runAPIs = true,
    maxHomepage = 8000,
    quiet = false,
  } = opts;

  const newsDataPath = path.join(publicDir, 'news-data.json');
  const archivePath = path.join(publicDir, 'news-archive.json');
  const suyxhStatusPath = path.join(publicDir, 'suyxh-source-status.json');
  const validationPath = path.join(outputsDir, 'unified-news-validation.json');
  const backupDir = path.join(outputsDir, 'backup');

  const report = {
    generatedAt: now.toISOString(),
    steps: {},
    sources: {},
    counts: {},
    failures: [],
    filterReasons: {},
    futureCount: 0,
  };

  // 1) 备份现有 public 数据（不删旧）
  const backed = [];
  for (const f of [newsDataPath, archivePath]) {
    try {
      if (fs.existsSync(f)) {
        fs.mkdirSync(backupDir, { recursive: true });
        const ts = now.toISOString().replace(/[:.]/g, '-');
        const dest = path.join(backupDir, `${path.basename(f)}.${ts}.bak`);
        fs.copyFileSync(f, dest);
        backed.push(dest);
      }
    } catch (e) {
      /* ignore */
    }
  }
  report.steps.backup = backed;

  // 2) 收集 base（既有采集，复用现有 API 结果，不重复消费密钥）
  let baseRaw = [];
  if (!skipBase) {
    try {
      const d = JSON.parse(fs.readFileSync(newsDataPath, 'utf8'));
      if (Array.isArray(d.data)) baseRaw = d.data;
    } catch {
      /* 无既有数据 */
    }
  }
  const baseNormalized = [];
  let baseExcluded = 0;
  let baseFuture = 0;
  for (const it of baseRaw) {
    const r = normalizeLegacyItem(it, now);
    if (r.status === 'ok') baseNormalized.push(r.item);
    else if (r.status === 'future') baseFuture++;
    else if (r.status === 'excluded') baseExcluded++;
  }
  report.steps.base = { read: baseRaw.length, normalized: baseNormalized.length, excluded: baseExcluded, future: baseFuture, skipped: skipBase ? 'skip-base' : false };

  // 3) 收集 SuYxh（必须实际请求）
  const suyxh = await fetchSuYxhAggregator({ fetchImpl, now, timeoutMs: 25000 });
  report.steps.suyxh = {
    collectedAt: suyxh.collectedAt,
    rawUnion: suyxh.stats.unionRaw,
    raw24h: suyxh.stats.raw24h,
    raw7d: suyxh.stats.raw7d,
    sourceCount: suyxh.stats.sourceCount,
    siteCount: suyxh.stats.siteCount,
    endpoints: suyxh.endpoints,
    failures: suyxh.failures,
  };
  for (const f of suyxh.failures) report.failures.push({ group: 'suyxh', ...f });

  // 4) 归一化 SuYxh 条目（分类/过滤/日期）
  const suyxhNormalized = [];
  let suyxhFuture = 0;
  const suyxhExcludedReasons = {};
  for (const { raw, _ctx } of suyxh.items) {
    const r = normalizeRawItem(raw, _ctx, { now });
    if (r.status === 'ok') suyxhNormalized.push(r.item);
    else if (r.status === 'future') {
      suyxhFuture++;
      report.futureCount++;
    } else if (r.status === 'excluded') {
      suyxhExcludedReasons[r.reason] = (suyxhExcludedReasons[r.reason] || 0) + 1;
      report.filterReasons[r.reason] = (report.filterReasons[r.reason] || 0) + 1;
    }
  }
  // base 排除原因也计入
  report.filterReasons['base-非两大领域/无日期'] = (report.filterReasons['base-非两大领域/无日期'] || 0) + baseExcluded;
  report.futureCount += baseFuture;

  // 5) 两API实际采集 + PULSAR有限候选整理，先规则再跨源模型事件去重。
  const api = runAPIs ? await fetchNewsAPIs({ fetchImpl, now }) : { items: [], requests: [], successfulRequests: 0 };
  report.steps.newsAPIs = { requests: api.requests, successfulRequests: api.successfulRequests, retained: api.items.length };
  const allOk = [...baseNormalized, ...suyxhNormalized, ...api.items];
  if (runPulsar) {
    try {
      const pulsar = await fetchPulsar({ fetchImpl, now });
      fs.mkdirSync(outputsDir, { recursive: true });
      fs.writeFileSync(path.join(outputsDir, 'pulsar-quarantine.json'), JSON.stringify(pulsar.quarantine, null, 2), { mode: 0o600 });
      const curated = await curatePulsar(pulsar.items, allOk, { fetchImpl, now, outputsDir });
      allOk.push(...curated.items);
      report.steps.pulsar = { ...pulsar.status, processing: curated.status };
      fs.mkdirSync(publicDir, { recursive: true });
      fs.writeFileSync(path.join(publicDir, 'pulsar-source-status.json'), JSON.stringify(report.steps.pulsar, null, 2));
    } catch {
      report.steps.pulsar = { status: 'error', error: 'PULSAR采集或整理失败，保留既有归档' };
      report.failures.push({ group: 'pulsar', error: report.steps.pulsar.error });
    }
  }
  const merged = dedupItems(allOk);

  // 6) 合并进 90 天滚动归档
  const prevArchive = loadArchive(archivePath);
  const mergeRes = mergeIntoArchive(prevArchive, merged, { now, retentionDays: RETENTION_DAYS, file: archivePath });
  fs.mkdirSync(publicDir, { recursive: true });
  writeArchive(archivePath, mergeRes.archive);
  report.steps.archive = {
    added: mergeRes.added,
    updated: mergeRes.updated,
    pruned: mergeRes.pruned,
    total: mergeRes.total,
    retentionDays: RETENTION_DAYS,
  };

  // 7) 构建首页 news-data.json
  const homepage = buildHomepage(mergeRes.archive.items, {
    now,
    maxHomepage,
    upstreamSourceStatus: suyxh.upstreamSourceStatus,
    opmlFeeds: suyxh.opmlFeeds,
    suyxhStats: suyxh.stats,
  });

  if (report.steps.pulsar) {
    report.steps.pulsar.published = Object.fromEntries(['vla', 'ai'].map(lane => {
      const rows = homepage.data.filter(it => it.sources?.some(s => s.platform === `PULSAR ${lane.toUpperCase()}`));
      return [lane, { total: rows.length, domains: Object.fromEntries([...TWO_DOMAINS].map(domain => [domain, rows.filter(it => it.category === domain).length])) }];
    }));
    fs.writeFileSync(path.join(publicDir, 'pulsar-source-status.json'), JSON.stringify(report.steps.pulsar, null, 2));
  }
  homepage.meta.pulsar = report.steps.pulsar || null;

  // 7.2) 摘要回填（不虚构）：上游摘要为空时，用本地 archive 同 id/url 的真实 summary 回填；
  //      仍缺则 UI 显示「标题信息不足，暂无摘要」，绝不编造或全量付费生成。
  {
    const archiveById = new Map();
    const archiveByUrl = new Map();
    for (const a of mergeRes.archive.items) {
      if (a.id) archiveById.set(a.id, a);
      const u = canonicalUrlKey(a.originalUrl || a.source || '');
      if (u) archiveByUrl.set(u, a);
    }
    let backfilled = 0;
    for (const it of [...(homepage.data || []), ...(homepage.featured || [])]) {
      if (it.summary && it.summary.trim()) continue;
      const arc = (it.id && archiveById.get(it.id)) || archiveByUrl.get(canonicalUrlKey(it.originalUrl || it.source || ''));
      if (arc && arc.summary && arc.summary.trim()) {
        it.summary = arc.summary;
        it._summaryBackfilled = true;
        backfilled++;
      }
    }
    report.steps.summaryBackfill = { backfilled };
  }

  // 7.5) 双域精选 AI 评分（接入 merge 之后；无 key 时规则回退，明确非 AI）
  //       featured 保持兼容，另新增 featuredGroups + featuredMetadata。
  if (runRank) {
    try {
      const cfg = loadLLMConfig(process.env);
      const { featuredGroups, metadata } = await rankFeatured(mergeRes.archive.items, {
        cfg,
        now,
        fetchImpl,
      });
      const rankedFeatured = [...(featuredGroups.embodied || []), ...(featuredGroups.llm || [])];
      // 顶层 + meta 双写：顶层供兼容消费方；meta.featuredGroups 供首页双域精选 UI 读取。
      homepage.featuredGroups = featuredGroups;
      homepage.featuredMetadata = metadata;
      homepage.featured = rankedFeatured.length ? rankedFeatured : homepage.featured;
      homepage.meta = { ...homepage.meta, featuredGroups, featuredMetadata: metadata };
      report.steps.featuredRank = {
        llmEnabled: metadata.llmEnabled,
        embodied: featuredGroups.embodied?.length || 0,
        llm: featuredGroups.llm?.length || 0,
        embodiedSource: metadata.domains.embodied?.scoreSource,
        llmSource: metadata.domains.llm?.scoreSource,
        warnings: metadata.warnings,
        notes: metadata.notes,
      };
    } catch (e) {
      report.steps.featuredRank = { ok: false, error: e?.message || String(e) };
      report.failures.push({ group: 'featured-rank', error: e?.message || String(e) });
      log(`  [warn] 双域精选评分失败，保留规则 featured: ${e?.message || e}`);
    }
  }

  fs.writeFileSync(newsDataPath, JSON.stringify(homepage, null, 2), 'utf8');
  report.steps.homepage = {
    total: homepage.meta.total,
    featured: homepage.featured.length,
    dataLen: homepage.data.length,
    capped: homepage.meta.homepageCapped,
    windows: homepage.meta.windows,
    categoryCounts: homepage.meta.categoryCounts,
    sourceCount_local: Object.keys(homepage.meta.sourceCounts).length,
  };

  // 8) 写入上游来源状态（供 UI「上游报告」展示）
  if (suyxh.upstreamSourceStatus || suyxh.opmlFeeds) {
    fs.writeFileSync(
      suyxhStatusPath,
      JSON.stringify(
        {
          generatedAt: suyxh.collectedAt,
          upstreamSourceStatus: suyxh.upstreamSourceStatus,
          opmlFeeds: suyxh.opmlFeeds,
          endpoints: suyxh.endpoints,
        },
        null,
        2
      ),
      'utf8'
    );
  }

  // 9) 三榜监测（独立步骤，失败仅记录）
  if (runBenchmark) {
    try {
      const { runRoboDojoNews: runMonitor } = await import('./robodojo-news.mjs');
      const bm = await runMonitor({ mergeNews: true, quiet: true, now, fetchImpl });
      report.steps.benchmark = {
        ok: bm.status === 'ok',
        source: bm.source,
        officialNewsCount: bm.items.length,
        error: bm.error || null,
        anySourceError: bm.status !== 'ok',
      };
    } catch (e) {
      report.steps.benchmark = { ok: false, error: e?.message || String(e) };
      report.failures.push({ group: 'benchmark', error: e?.message || String(e) });
    }
  }

  // 10) 脱敏验证报告
  report.sources = {
    base: { normalized: baseNormalized.length, excluded: baseExcluded, future: baseFuture },
    suyxh: {
      rawUnion: suyxh.stats.unionRaw,
      normalized: suyxhNormalized.length,
      future: suyxhFuture,
      endpointsOk: Object.values(suyxh.endpoints).filter((e) => e.status === 'ok').length,
      endpointsTotal: Object.keys(suyxh.endpoints).length,
    },
  };
  report.counts = {
    collectedRaw: baseRaw.length + suyxh.stats.unionRaw,
    retained: merged.length,
    archived: mergeRes.total,
    featured: homepage.featured.length,
    futureIsolated: report.futureCount,
  };
  report.limits = {
    didNotFabricateDateForUnknown: true,
    didNotClaimFutureAsToday: true,
    didNotFabricateBody: true,
    didNotClaimFullSourceUsable: '公开源已按主题过滤；source_count 仅示覆盖',
  };

  fs.mkdirSync(outputsDir, { recursive: true });
  fs.writeFileSync(validationPath, JSON.stringify(report, null, 2), 'utf8');
  report.validationPath = validationPath;

  if (!quiet) {
    log('==== unified-news 运行摘要 ====');
    log(`采集原始: base=${baseRaw.length} suyxh并集=${suyxh.stats.unionRaw}（24h=${suyxh.stats.raw24h}, 7d=${suyxh.stats.raw7d}）`);
    log(`保留(去重后): ${merged.length}  归档总计: ${mergeRes.total}（新增${mergeRes.added}/更新${mergeRes.updated}/裁剪${mergeRes.pruned}）`);
    log(`未来隔离: ${report.futureCount}  分类:`, JSON.stringify(homepage.meta.categoryCounts));
    log(`窗口:`, JSON.stringify(homepage.meta.windows));
    log(`SuYxh 端点:`, Object.entries(suyxh.endpoints).map(([k, v]) => `${k}=${v.status}`).join(' '));
    if (suyxh.failures.length) log(`SuYxh 失败:`, JSON.stringify(suyxh.failures));
    if (report.steps.benchmark) log(`三榜:`, JSON.stringify(report.steps.benchmark.boards || report.steps.benchmark));
    log(`校验报告: ${validationPath}`);
  }
  return report;
}

// ---------------- 直接运行 ----------------
const isMain = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('unified-news.mjs');
if (isMain) {
  const args = process.argv.slice(2);
  const skipBase = args.includes('--skip-base');
  const noBenchmark = args.includes('--no-benchmark');
  const noRank = args.includes('--no-rank');
  const maxArg = args.find((a) => a.startsWith('--max-homepage='));
  const maxHomepage = maxArg ? parseInt(maxArg.split('=')[1], 10) || 8000 : 8000;
  runPipeline({ skipBase, runBenchmark: !noBenchmark, runRank: !noRank, maxHomepage })
    .then(() => process.exit(0))
    .catch((e) => {
      log('FATAL', e?.message || e);
      process.exit(1);
    });
}
