// 三榜数据源抓取 + 解析。
// 设计原则：
//  - 优先使用真实结构化数据（RoboDojo 的 rolloutManifest JSON、LiveBench 的 table CSV、
//    VLA 的 leaderboard JSON）。
//  - 任何抓取/解析失败都返回 status:'error'，绝不编造模型或分数。
//  - 每个模型输出 { id, rawId, name, org, score, scoreAvailable, ... }。
//    id 已带平台前缀（platform::normalized），实现「按平台隔离」的稳定ID。
//  - VLA：按「稳定字符串 model slug」聚合；保存按 benchmark 的分项分数，
//         禁止跨异构 benchmark 取均值作为总分（不同 benchmark 量纲不同，均值无意义）。
//  - LiveBench：版本必须由官方主页 JS bundle 动态发现；若有官方 overall 列才用，
//         否则保留各分项 metrics，绝不把各列算平均伪装成总分。
//  - RoboDojo：real/sim 顶层键即模型标识；监测范围为两者并集。
//
// 模型数口径：一律按「去重后的稳定模型ID」计算，绝不把评测记录（多 benchmark 行）当模型数。

import { fetchWithTimeout, parseCsv, normalizeModelId, round } from './benchmark-util.mjs';

export class SourceError extends Error {}

// ------------------------- LiveBench 版本动态发现 -------------------------
// 从官方主页（SPA）的 JS bundle 中提取版本日期数组。
// 主页本身是 React SPA，版本列表硬编码在 main.<hash>.js 的数组里（首版哨兵为
// "2024-06-24"）。我们每次动态抓取主页→bundle，正则抽取版本，绝不依赖本地硬编码列表。
//
// 返回：升序日期字符串数组；发现失败抛 SourceError（由上层决定降级或报错）。
export async function discoverLiveBenchVersions(board, opts = {}) {
  const homeUrl = board.homepage || (board.base ? `${board.base.replace(/\/$/, '')}/` : 'https://livebench.ai/');
  const fetchImpl = opts.fetchImpl || globalThis.fetch;

  const homeRes = await fetchWithTimeout(homeUrl, { timeoutMs: board.timeoutMs, fetchImpl });
  if (!homeRes.ok) throw new SourceError(`主页 HTTP ${homeRes.status}`);
  const html = await homeRes.text();

  // 定位 bundle 脚本（带内容哈希，每次发布会变 → 必须动态读取）
  const m = html.match(/static\/js\/main\.[a-f0-9]+\.js/);
  if (!m) throw new SourceError('主页 HTML 未包含 JS bundle 引用，无法发现版本');
  const bundleUrl = new URL(m[0], homeUrl).href;

  const bundleRes = await fetchWithTimeout(bundleUrl, { timeoutMs: board.timeoutMs, fetchImpl });
  if (!bundleRes.ok) throw new SourceError(`bundle HTTP ${bundleRes.status}`);
  const bundle = await bundleRes.text();

  // 抽取「≥2 个连续 ISO 日期」的数组字面量
  const arrs = [...bundle.matchAll(/\[("20\d\d-\d\d-\d\d)"(?:,"20\d\d-\d\d-\d\d")+\]/g)];
  if (!arrs.length) throw new SourceError('bundle 中未发现任何版本日期数组');

  // 优先取包含 LiveBench 首版哨兵 "2024-06-24" 的数组（即版本下拉选项）
  let chosen = null;
  for (const a of arrs) {
    try {
      const dates = JSON.parse(a[0]);
      if (Array.isArray(dates) && dates.includes('2024-06-24')) {
        chosen = dates;
        break;
      }
    } catch {
      /* 解析失败跳过 */
    }
  }
  // 哨兵未命中（bundle 结构变化）时退而取最长日期数组
  if (!chosen) {
    let longest = null;
    for (const a of arrs) {
      try {
        const dates = JSON.parse(a[0]);
        if (!longest || dates.length > longest.length) longest = dates;
      } catch {
        /* ignore */
      }
    }
    chosen = longest;
  }
  if (!chosen || !chosen.length) throw new SourceError('bundle 中未能解析出有效版本日期');
  return chosen;
}

// 解析可用版本：优先动态发现；发现失败则降级到上次已知版本（明确 stale），
// 若连缓存都没有则明确抛出「版本发现失败」（绝不默默声称 latest）。
export async function resolveLiveBenchVersion(board, opts = {}) {
  if (opts.liveBenchVersion) {
    return { version: opts.liveBenchVersion, source: 'override', stale: false };
  }
  let discovered;
  try {
    discovered = await discoverLiveBenchVersions(board, opts);
  } catch (e) {
    if (opts.lastKnownVersion) {
      return { version: opts.lastKnownVersion, source: 'stale-cache', stale: true };
    }
    throw new SourceError(`LiveBench 版本发现失败：${e.message}`);
  }
  const candidates = [...discovered].sort().reverse(); // 最新优先
  for (const v of candidates) {
    const url = `${board.base}/table_${v.replace(/-/g, '_')}.csv`;
    try {
      const res = await fetchWithTimeout(url, { timeoutMs: board.timeoutMs, fetchImpl: opts.fetchImpl });
      if (res.ok) return { version: v, source: 'discovered', stale: false };
    } catch {
      // 继续尝试更早版本
    }
  }
  // 已发现版本但都不可访问
  if (opts.lastKnownVersion) {
    return { version: opts.lastKnownVersion, source: 'stale-cache', stale: true };
  }
  throw new SourceError(`LiveBench 已发现版本均不可访问（最新 ${candidates[0] || '未知'}）`);
}

// ------------------------- RoboDojo -------------------------
export async function fetchRoboDojo(board, opts = {}) {
  const scrapeTime = new Date().toISOString();
  try {
    const res = await fetchWithTimeout(board.source, {
      timeoutMs: board.timeoutMs,
      fetchImpl: opts.fetchImpl,
    });
    if (!res.ok) throw new SourceError(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data || typeof data !== 'object') throw new SourceError('返回体非 JSON 对象');

    // real/sim 顶层键即模型标识（值为该模型的 rollout clip 列表）。
    const realRaw = (data.real && typeof data.real === 'object') ? data.real : {};
    const simRaw = (data.sim && typeof data.sim === 'object') ? data.sim : {};
    const realKeys = Object.keys(realRaw).filter((k) => typeof k === 'string');
    const simKeys = Object.keys(simRaw).filter((k) => typeof k === 'string');
    const all = new Set([...realKeys, ...simKeys]);
    if (all.size === 0) throw new SourceError('real/sim 均无模型键');

    const models = [...all].map((k) => ({
      id: `robodojo::${normalizeModelId(k)}`,
      rawId: k,
      name: k,
      org: null,
      score: null,
      scoreAvailable: false, // rolloutManifest 不提供逐模型分数，不臆造
      domains: [
        ...(realKeys.includes(k) ? ['real'] : []),
        ...(simKeys.includes(k) ? ['sim'] : []),
      ],
    }));

    return {
      id: board.id,
      status: 'ok',
      source: board.source,
      scrapeTime,
      snapshotTime: data.generatedAt || null,
      modelCount: models.length,
      models,
      // 监测范围说明：manifest 列出的真实/仿真模型并集，并非榜单「分数排名」全量
      scope: '数据源为 rolloutManifest：real/sim 顶层键即模型标识（值为该模型的 rollout 视频列表）。'
        + '监测范围为 manifest 中列出的真实(real)与仿真(sim)模型并集；该清单可能少于完整评测模型总数，仅反映 manifest 已收录者。',
      error: null,
    };
  } catch (e) {
    return errorResult(board, scrapeTime, e);
  }
}

// ------------------------- LiveBench -------------------------
export async function fetchLiveBench(board, opts = {}) {
  const scrapeTime = new Date().toISOString();
  let resolved;
  try {
    resolved = await resolveLiveBenchVersion(board, {
      ...opts,
      lastKnownVersion: opts.lastKnownVersion,
    });
  } catch (e) {
    return errorResult(board, scrapeTime, e);
  }
  const { version, source: versionSource, stale } = resolved;

  try {
    const csvUrl = `${board.base}/table_${version.replace(/-/g, '_')}.csv`;
    const res = await fetchWithTimeout(csvUrl, {
      timeoutMs: board.timeoutMs,
      fetchImpl: opts.fetchImpl,
    });
    if (!res.ok) throw new SourceError(`HTTP ${res.status}`);
    const text = await res.text();
    const rows = parseCsv(text);
    if (!rows.length) throw new SourceError('CSV 解析为空');

    const header = rows.length ? Object.keys(rows[0]) : [];
    // 仅当存在官方明确的总分列才采用；否则不造总分
    const overallCol = header.find((h) => /^(overall|average|total|score)$/i.test(h));

    const models = rows
      .filter((r) => r.model && String(r.model).trim())
      .map((r) => {
        const name = String(r.model).trim();
        const metrics = {};
        for (const [k, v] of Object.entries(r)) {
          if (k === 'model') continue;
          const n = parseFloat(v);
          if (typeof n === 'number' && !Number.isNaN(n)) metrics[k] = round(n);
        }
        const official = overallCol ? metrics[overallCol] : undefined;
        return {
          id: `livebench::${normalizeModelId(name)}`,
          rawId: name,
          name,
          org: null,
          // 有官方 overall 列才用；否则 score=null，绝不把各分项平均伪装成总分
          score: overallCol && typeof official === 'number' ? round(official) : null,
          scoreAvailable: !!(overallCol && typeof official === 'number'),
          metrics, // 各分项原始分数，供前端按列展示
        };
      });

    if (models.length === 0) throw new SourceError('未解析出任何模型行');

    return {
      id: board.id,
      status: 'ok',
      source: csvUrl,
      scrapeTime,
      snapshotTime: version, // 版本日期（≠ 本次刷新时间）
      modelCount: models.length,
      models,
      versionSource, // 'discovered' | 'stale-cache' | 'override'
      stale, // 降级到旧版本时为 true
      error: null,
    };
  } catch (e) {
    return errorResult(board, scrapeTime, e);
  }
}

// ------------------------- VLA (AllenAI) -------------------------
export async function fetchVLA(board, opts = {}) {
  const scrapeTime = new Date().toISOString();
  try {
    const res = await fetchWithTimeout(board.source, {
      timeoutMs: board.timeoutMs,
      fetchImpl: opts.fetchImpl,
    });
    if (!res.ok) throw new SourceError(`HTTP ${res.status}`);
    const data = await res.json();
    const results = Array.isArray(data?.results) ? data.results : [];
    if (!results.length) throw new SourceError('results 为空');

    // 按「稳定字符串 model slug」聚合（同一模型跨多个 benchmark 出现多次）。
    // 非字符串 slug（例如对象）直接跳过，避免 normalizeModelId 把它变成
    // "[object Object]" 从而把所有记录错误折叠为同一条。
    const map = new Map();
    for (const r of results) {
      if (!r || typeof r !== 'object') continue;
      const slug =
        typeof r.model === 'string' && r.model.trim()
          ? r.model.trim()
          : typeof r.name_in_paper === 'string' && r.name_in_paper.trim()
            ? r.name_in_paper.trim()
            : null;
      if (!slug) continue; // 无可用稳定ID → 跳过，不污染聚合

      if (!map.has(slug)) {
        map.set(slug, {
          slug,
          display: r.display_name || r.name_in_paper || slug,
          benchmarks: [], // 该模型参与的所有 benchmark（去重）
          metrics: {}, // benchmark -> overall_score（未报告则为 null）
        });
      }
      const e = map.get(slug);
      const bench = typeof r.benchmark === 'string' ? r.benchmark : null;
      if (bench && !e.benchmarks.includes(bench)) e.benchmarks.push(bench);
      if (bench) {
        // 仅保存「该模型在该 benchmark 上的分数」，禁止跨异构 benchmark 取均值
        e.metrics[bench] = typeof r.overall_score === 'number' ? round(r.overall_score) : null;
      }
    }
    if (map.size === 0) throw new SourceError('无可用模型条目');

    const models = [...map.values()].map((e) => ({
      id: `vla::${normalizeModelId(e.slug)}`,
      rawId: e.slug,
      name: e.display,
      org: null,
      // 跨异构 benchmark 量纲不同，均值无意义 → 总分置 null，仅保留分项 metrics
      score: null,
      scoreAvailable: false,
      benchmarks: e.benchmarks,
      metrics: e.metrics,
    }));

    return {
      id: board.id,
      status: 'ok',
      source: board.source,
      scrapeTime,
      snapshotTime: data.last_updated || null,
      modelCount: models.length, // = 去重后的唯一 model slug 数，非评测记录数
      models,
      error: null,
    };
  } catch (e) {
    return errorResult(board, scrapeTime, e);
  }
}

function errorResult(board, scrapeTime, e) {
  return {
    id: board.id,
    status: 'error',
    source: board.source || board.base || '',
    scrapeTime,
    snapshotTime: null,
    modelCount: 0,
    models: [],
    error: e?.message || String(e),
  };
}

export const FETCHERS = {
  robodojo: fetchRoboDojo,
  livebench: fetchLiveBench,
  vla: fetchVLA,
};
