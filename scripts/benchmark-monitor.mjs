// 基准监测编排器（独立脚本，无外部依赖，仅用 Node 内置 + 全局 fetch）。
//
// 用法：
//   node scripts/benchmark-monitor.mjs                 # 真实抓取三榜并写结果
//   node scripts/benchmark-monitor.mjs --no-merge      # 不写入 news-data.json
//   node scripts/benchmark-monitor.mjs --preview       # 额外生成 outputs 预览 HTML
//   node scripts/benchmark-monitor.mjs --lb 2026-06-25 # 强制 LiveBench 版本
//
// 设计要点（严格遵循授权）：
//  - 北京时间当天界限用于「今日」语义判断。
//  - 模型稳定ID按平台隔离（platform::normalized）。
//  - 仅首次运行建立基线，绝不宣称当前全部模型为今日新增。
//  - 当前 snapshot 与上一次有效 snapshot diff；源异常不覆盖旧快照、不推断删除。
//  - 发布日未知用 firstSeenAt + observation_window；有明确来源新增日期才标 sourceConfirmedDate。
//  - 跨观测窗口（上次观测与本次不在同一北京时间日）不断言今日。

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { BOARDS, SETTINGS, BOARD_ORDER } from './config/benchmark-monitor.config.mjs';
import { FETCHERS } from './lib/benchmark-sources.mjs';
import { diffBoard, buildNewsItems, mergeNewsIntoData } from './lib/benchmark-diff.mjs';
import { beijingDateString } from './lib/benchmark-util.mjs';
import { attachBenchmarkEvents } from './lib/benchmark-events.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(REPO_ROOT, 'public');
const OUTPUTS_DIR = path.join(REPO_ROOT, 'outputs');

const SNAPSHOT_FILE = path.join(PUBLIC_DIR, 'benchmark-snapshot.json');
const UPDATES_FILE = path.join(PUBLIC_DIR, 'benchmark-updates.json');
const HISTORY_DIR = path.join(PUBLIC_DIR, 'benchmark-history');
const NEWS_DATA_FILE = path.join(PUBLIC_DIR, 'news-data.json');

const MODELS_INCLUDED_CAP = 300;

// 快照 schema 版本。V1 的 parser 存在错误聚合（VLA 跨 benchmark 均值、LiveBench 各列均值
// 伪装总分），本版修正后升至 V2：模型按稳定字符串ID去重、保存分项 metrics、版本动态发现。
// 旧版本快照在运行时会自动迁移（备份旧文件 + 以基线方式重建，不发出假「新增」）。
const SCHEMA_VERSION = 2;

function log(...a) {
  // 摘要走 stderr，避免污染结构化输出 / 重定向
  process.stderr.write(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') + '\n');
}

function loadSnapshot(file = SNAPSHOT_FILE) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const data = JSON.parse(raw);
    if (data && data.boards) return data;
  } catch {
    /* 不存在或非法 → 视为首次 */
  }
  return null;
}

// 若现有快照 schema 过旧，则先备份旧文件（绝不删除个人文件），再把 prevSnapshot 置空，
// 使本次按「首次运行 / 基线」处理 —— 不把旧的错误 parser 结果当作「今日新增」重新广播。
function maybeMigrate(prevSnapshot, { snapshotFile, updatesFile, quiet } = {}) {
  if (!prevSnapshot) return { prevSnapshot, migration: null };
  const v = prevSnapshot.schemaVersion || 1;
  if (v >= SCHEMA_VERSION) return { prevSnapshot, migration: null };
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const backups = [];
  for (const f of [snapshotFile, updatesFile]) {
    try {
      if (f && fs.existsSync(f)) {
        const bak = `${f}.migrated-from-v${v}-${ts}.bak`;
        fs.copyFileSync(f, bak);
        backups.push(bak);
      }
    } catch (e) {
      if (!quiet) log(`  [warn] 备份旧文件失败 ${f}: ${e?.message || e}`);
    }
  }
  if (!quiet) {
    log(`  [迁移] 检测到旧 schema v${v}，已备份为基线重建（不广播假新增）`);
    for (const b of backups) log(`    备份: ${b}`);
  }
  return { prevSnapshot: null, migration: { fromVersion: v, toVersion: SCHEMA_VERSION, backups } };
}

function capModels(models, newIds) {
  if (!Array.isArray(models) || models.length <= MODELS_INCLUDED_CAP) {
    return { models, truncated: false, included: models.length };
  }
  const seen = new Set(newIds || []);
  const prioritized = models.filter((m) => seen.has(m.id)).concat(models.filter((m) => !seen.has(m.id)));
  return { models: prioritized.slice(0, MODELS_INCLUDED_CAP), truncated: true, included: MODELS_INCLUDED_CAP };
}

export async function runMonitor(opts = {}) {
  const {
    fetchImpl = globalThis.fetch,
    now = new Date(),
    publicDir = PUBLIC_DIR,
    mergeNews = SETTINGS.mergeNews,
    writePreview = false,
    liveBenchVersion = null,
    quiet = false,
    snapshotFile = SNAPSHOT_FILE,
    updatesFile = UPDATES_FILE,
    historyDir = HISTORY_DIR,
    newsDataFile = NEWS_DATA_FILE,
  } = opts;

  const todayDate = beijingDateString(now);
  const rawPrev = opts.snapshotOverride || loadSnapshot(snapshotFile);
  const { prevSnapshot, migration } = maybeMigrate(rawPrev, { snapshotFile, updatesFile, quiet });
  const lastObsDate = prevSnapshot?.updatedAt ? beijingDateString(new Date(prevSnapshot.updatedAt)) : null;
  const firstRun = !prevSnapshot;

  const newSnapshot = { schemaVersion: SCHEMA_VERSION, updatedAt: now.toISOString(), boards: {} };
  const boardResults = {};
  const boardDiffs = {};
  const anyError = { value: false };

  for (const id of BOARD_ORDER) {
    const cfg = BOARDS[id];
    const fetchOpts = { fetchImpl, liveBenchVersion };
    // LiveBench 动态发现失败时降级到上次已知版本（明确 stale），故传入上次快照的版本日期
    if (id === 'livebench') fetchOpts.lastKnownVersion = prevSnapshot?.boards?.livebench?.snapshotTime || null;
    const res = await FETCHERS[id](cfg, fetchOpts);
    const prev = prevSnapshot?.boards?.[id] || null;

    if (res.status === 'error') {
      anyError.value = true;
      boardResults[id] = {
        id: res.id,
        status: 'error',
        source: res.source,
        scrapeTime: res.scrapeTime,
        snapshotTime: prev?.snapshotTime ?? null,
        modelCount: prev?.modelCount ?? 0,
        preservedModelCount: prev?.modelCount ?? null,
        newModels: [],
        scoreChanges: [],
        removedModels: [],
        models: [],
        error: res.error,
        // 失败保留上一次的版本/降级元数据（如有）
        ...(prev?.versionSource ? { versionSource: prev.versionSource } : {}),
        ...(prev?.stale ? { stale: true } : {}),
      };
      // 关键：源异常保留旧快照，不覆盖、不推断删除
      if (prev) newSnapshot.boards[id] = prev;
      boardDiffs[id] = { status: 'error', newModels: [], scoreChanges: [], removedModels: [] };
      continue;
    }

    let diff;
    if (!prev) {
      diff = { status: 'baseline', newModels: [], scoreChanges: [], removedModels: [] };
    } else {
      diff = diffBoard(prev, res, { lastObsDate, todayDate });
    }
    const capped = capModels(res.models, diff.newModels.map((m) => m.id));
    boardResults[id] = {
      id: res.id,
      status: diff.status,
      source: res.source,
      scrapeTime: res.scrapeTime,
      snapshotTime: res.snapshotTime,
      modelCount: res.modelCount,
      newModels: diff.newModels,
      scoreChanges: diff.scoreChanges,
      removedModels: diff.removedModels,
      models: capped.models,
      modelsTruncated: capped.truncated,
      modelsIncluded: capped.included,
      error: null,
      // LiveBench 版本发现来源 / 降级标记；RoboDojo 监测范围说明
      ...(res.versionSource ? { versionSource: res.versionSource } : {}),
      ...(res.stale ? { stale: true } : {}),
      ...(res.scope ? { scope: res.scope } : {}),
    };
    newSnapshot.boards[id] = {
      snapshotTime: res.snapshotTime,
      scrapeTime: res.scrapeTime,
      modelCount: res.modelCount,
      models: res.models,
      ...(res.versionSource ? { versionSource: res.versionSource } : {}),
      ...(res.stale ? { stale: true } : {}),
      ...(res.scope ? { scope: res.scope } : {}),
    };
    boardDiffs[id] = diff;
  }

  // 汇总新增新闻（仅真实新增收录）
  const newsItems = [];
  for (const id of BOARD_ORDER) {
    const cfg = BOARDS[id];
    const items = buildNewsItems(
      { ...boardResults[id], snapshotTime: boardResults[id].snapshotTime, scrapeTime: boardResults[id].scrapeTime },
      boardDiffs[id],
      cfg,
      { maxNewsPerRun: SETTINGS.maxNewsPerRun }
    );
    newsItems.push(...items);
  }

  let mergeResult = null;
  if (mergeNews && newsItems.length) {
    mergeResult = mergeNewsIntoData(newsItems, newsDataFile);
  }

  const report = {
    generatedAt: now.toISOString(),
    timezone: 'Asia/Shanghai',
    beijingDate: todayDate,
    run: {
      firstRun,
      scrapeTime: now.toISOString(),
      lastObservation: prevSnapshot?.updatedAt || null,
      lastObservationBeijingDate: lastObsDate,
      todayBeijingDate: todayDate,
      anySourceError: anyError.value,
      ...(migration ? { migration } : {}),
    },
    boards: boardResults,
    news: {
      generated: newsItems.length,
      merged: mergeResult || null,
      items: mergeNews ? newsItems : [],
    },
  };

  // Carry forward event history so same-day refreshes do not erase earlier changes.
  let previousReport = null;
  try { previousReport = JSON.parse(fs.readFileSync(updatesFile, 'utf8')); } catch {}
  attachBenchmarkEvents(report, previousReport);

  // 落盘：当前更新报告 + 按日期归档 + 新快照
  if (writePreview) {
    report.previewPath = writePreviewHtml(report);
  }
  fs.mkdirSync(historyDir, { recursive: true });
  fs.writeFileSync(updatesFile, JSON.stringify(report, null, 2));
  const historyFile = path.join(historyDir, `${todayDate}.json`);
  fs.writeFileSync(historyFile, JSON.stringify(report, null, 2));
  fs.writeFileSync(snapshotFile, JSON.stringify(newSnapshot, null, 2));

  if (!quiet) {
    log('==== benchmark-monitor 运行摘要 ====');
    log(`北京时间日期: ${todayDate}  首次运行: ${firstRun}${migration ? ` [schema迁移 v${migration.fromVersion}→v${migration.toVersion}]` : ''}`);
    log(`上次观测: ${lastObsDate || '(无)'}`);
    for (const id of BOARD_ORDER) {
      const b = boardResults[id];
      const ver = b.versionSource ? ` 版本源=${b.versionSource}${b.stale ? '(降级stale)' : ''}` : '';
      log(
        `  [${id}] 状态=${b.status} 模型数=${b.modelCount} 新增=${b.newModels.length} 分数变化=${b.scoreChanges.length}` +
          (b.error ? ` 错误=${b.error}` : '') + ver
      );
    }
    log(`新闻条目生成=${newsItems.length}` + (mergeResult ? ` 合并写入=${mergeResult.added}` : ''));
    log(`输出: ${updatesFile}`);
    log(`快照: ${snapshotFile}`);
    log(`归档: ${historyFile}`);
  }

  return report;
}

// ---------------- 预览 HTML（脱敏：仅公开结果，无密钥） ----------------
function writePreviewHtml(report) {
  fs.mkdirSync(OUTPUTS_DIR, { recursive: true });
  const p = path.join(OUTPUTS_DIR, 'benchmark-monitor-preview.html');
  const json = JSON.stringify(report, null, 2);
  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>基准监测预览 · ${report.beijingDate}</title>
<style>
  body{font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#0f1115;color:#e6e6e6;margin:0;padding:24px;}
  h1{font-size:18px;margin:0 0 4px} .meta{color:#8b8b8b;font-size:12px;margin-bottom:20px}
  .board{border:1px solid #23262d;border-radius:10px;padding:16px;margin-bottom:16px;background:#15181e}
  .badge{display:inline-block;padding:2px 10px;border-radius:999px;font-size:11px;font-weight:700;letter-spacing:.04em}
  .baseline{background:#1d3a5f;color:#9ec5ff} .no_change{background:#2b2b2b;color:#bdbdbd}
  .updated{background:#1f4d2e;color:#9bf0b4} .error{background:#4d1f1f;color:#ff9b9b}
  .row{display:flex;gap:18px;flex-wrap:wrap;margin-top:10px;font-size:13px;color:#cfcfcf}
  .k{color:#8b8b8b;font-size:11px;text-transform:uppercase;letter-spacing:.05em}
  .v{font-size:15px;font-weight:600}
  .models{margin-top:10px;font-size:12px;color:#bdbdbd;max-height:160px;overflow:auto}
  .err{color:#ff9b9b;font-size:12px;margin-top:8px}
  .note{color:#9ec5ff;font-size:12px;margin-top:4px}
  pre{background:#0b0d11;border:1px solid #23262d;border-radius:8px;padding:14px;overflow:auto;max-height:420px;font-size:11px}
  a{color:#9ec5ff}
</style></head><body>
<h1>基准监测预览</h1>
<div class="meta">北京时间 ${report.beijingDate} · ${report.run.firstRun ? '首次运行（建立基线）' : '增量监测'} · 上次观测 ${report.run.lastObservationBeijingDate || '（无）'}</div>
${report.run.migration ? `<div class="note" style="color:#ffd479">检测到旧 schema（v${report.run.migration.fromVersion}），已备份旧文件并以基线重建（未广播假新增）。</div>` : ''}
<div class="note" style="color:#9ec5ff">说明：<b>数据时间/版本日期</b>（snapshotTime，如 LiveBench 发布版本、VLA last_updated）≠ <b>本次刷新时间</b>（抓取时刻）。版本日期只代表源数据截止日，不代表本监测刚刷新。</div>
${Object.values(report.boards)
  .map((b) => {
    const cls = b.status;
    const label = { baseline: '首次基线', no_change: '无变化', updated: '新收录', error: '失败' }[b.status] || b.status;
    const newList = (b.newModels || []).map((m) => `${m.name}（${m.discoveryType === 'source_confirmed' ? '来源确认' : '观测窗口'}${m.assertedToday ? '·今日' : ''}）`).join('；') || '—';
    const ver = b.versionSource
      ? `<div class="row"><div><div class="k">版本源</div><div class="v">${b.versionSource}${b.stale ? ' · 降级stale' : ''}</div></div></div>`
      : '';
    const scope = b.scope ? `<div class="note">监测范围：${b.scope}</div>` : '';
    return `<div class="board">
      <span class="badge ${cls}">${label}</span> <strong style="margin-left:8px">${b.id}</strong>
      <div class="row">
        <div><div class="k">模型数</div><div class="v">${b.modelCount}</div></div>
        <div><div class="k">数据时间/版本</div><div class="v">${b.snapshotTime || '—'}</div></div>
        <div><div class="k">刷新时间</div><div class="v">${b.scrapeTime}</div></div>
        <div><div class="k">分数变化</div><div class="v">${b.scoreChanges.length}</div></div>
      </div>
      ${ver}
      <div class="note">新增收录：${newList}</div>
      ${scope}
      ${b.error ? `<div class="err">异常：${b.error}（保留上一次有效快照，未覆盖、未推断删除）</div>` : ''}
      <div class="models">证据：<a href="${b.source}">${b.source}</a></div>
    </div>`;
  })
  .join('')}
<h3 style="font-size:13px;color:#8b8b8b">脱敏结果 JSON</h3>
<pre>${json.replace(/</g, '&lt;')}</pre>
</body></html>`;
  fs.writeFileSync(p, html);
  return p;
}

// ---------------- 直接运行 ----------------
const isMain = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('benchmark-monitor.mjs');
if (isMain) {
  const args = process.argv.slice(2);
  const merge = !args.includes('--no-merge');
  const preview = args.includes('--preview');
  const lbArg = args.find((a) => a.startsWith('--lb='));
  const lb = lbArg ? lbArg.split('=')[1] : null;
  runMonitor({ mergeNews: merge, writePreview: preview, liveBenchVersion: lb })
    .then(() => process.exit(0))
    .catch((e) => {
      log('FATAL', e?.message || e);
      process.exit(1);
    });
}
