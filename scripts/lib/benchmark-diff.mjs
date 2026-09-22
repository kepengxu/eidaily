// 快照 diff + 新闻条目生成。
//
// 关键语义（严格遵循授权要求）：
//  1. 首次运行只建立基线（baseline），绝不把当前全部模型宣称为「今日新增」。
//  2. 仅对比「当前 snapshot」与「上一次有效 snapshot」：出现在当前、缺失于上次者 = 新增收录。
//  3. 发布日未知时用 firstSeenAt，并区分「新收录」(observation_window) 与「新发布」(source_confirmed)。
//  4. 跨观测窗口（上次观测与本次不在同一北京时间日）不得断言「今日」。
//  5. 源异常时由编排层保留旧 snapshot、不推断删除；本模块只处理成功抓取的结果。
//  6. 分数变化仅在两侧均有可用分数且数值不同才记录；未知分数绝不当作 0。

import fs from 'fs';
import { beijingDateString, isSameBeijingDate, normalizeUrl } from './benchmark-util.mjs';

// 对单个新增模型计算发现元数据（discoveryType / assertedToday / note）。
function classifyNewModel(model, { lastObsDate, todayDate }) {
  const dateAdded = model.dateAdded || null; // 来源若提供逐模型新增日期
  const sameDay = !!lastObsDate && lastObsDate === todayDate;

  if (dateAdded && isSameBeijingDate(dateAdded, todayDate)) {
    return {
      discoveryType: 'source_confirmed',
      sourceConfirmedDate: dateAdded,
      assertedToday: true,
      note: '来源标注新增日期为今日（北京时间），可确认当日新增',
    };
  }
  return {
    discoveryType: 'observation_window',
    sourceConfirmedDate: null,
    assertedToday: sameDay,
    note: sameDay
      ? '今日观测窗口内新增（无来源发布日期，非来源确认发布）'
      : `自 ${lastObsDate || '未知'} 观测以来新增（跨观测窗口，不断言为今日发布）`,
  };
}

// 仅对「成功抓取」的当前结果做 diff。prevBoard 可能为 null（首次由编排层处理）。
export function diffBoard(prevBoard, currResult, { lastObsDate, todayDate }) {
  const prevIds = new Set((prevBoard?.models || []).map((m) => m.id));
  const newModels = [];
  for (const m of currResult.models) {
    if (!prevIds.has(m.id)) {
      newModels.push({
        ...m,
        firstSeenAt: currResult.scrapeTime,
        ...classifyNewModel(m, { lastObsDate, todayDate }),
      });
    }
  }

  const prevById = new Map((prevBoard?.models || []).map((m) => [m.id, m]));
  const scoreChanges = [];
  for (const m of currResult.models) {
    const p = prevById.get(m.id);
    if (
      p &&
      p.scoreAvailable &&
      m.scoreAvailable &&
      typeof p.score === 'number' &&
      typeof m.score === 'number' &&
      p.score !== m.score
    ) {
      scoreChanges.push({
        id: m.id,
        name: m.name,
        rawId: m.rawId,
        oldScore: p.score,
        newScore: m.score,
      });
    }
  }

  let status;
  if (!prevBoard) status = 'baseline';
  else if (newModels.length > 0 || scoreChanges.length > 0) status = 'updated';
  else status = 'no_change';

  return { status, newModels, scoreChanges, removedModels: [] };
}

// 依据 diff 结果生成「真实新增」的新闻条目（兼容现有 news-data.json 字段）。
// 仅当状态为 updated 且有新增收录时产出；按名称排序后受 maxNewsPerRun 上限约束。
export function buildNewsItems(boardResult, diffResult, boardConfig, { maxNewsPerRun = 50 } = {}) {
  if (diffResult.status !== 'updated' || !diffResult.newModels.length) return [];
  const beijingDate = beijingDateString(new Date(boardResult.scrapeTime));
  const sorted = [...diffResult.newModels].sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const capped = sorted.slice(0, maxNewsPerRun);
  const truncated = sorted.length - capped.length;

  return capped.map((m) => {
    const orgPart = m.org ? `（${m.org}）` : '';
    const scorePart = m.scoreAvailable ? `，当前榜分约 ${m.score}` : '';
    const title = `${boardConfig.displayName} 新增收录模型：${m.name}`;
    const summary =
      `监测到 ${boardConfig.displayName}（数据时间 ${boardResult.snapshotTime || '未知'}）新增收录模型「${m.name}」${orgPart}。` +
      `本次为${m.discoveryType === 'source_confirmed' ? '来源确认新增' : '观测窗口新增'}${scorePart}。` +
      `说明：${m.note}。`;
    return {
      id: `bench_${boardConfig.id}_${m.rawId}_${beijingDate}`,
      title,
      summary,
      content: summary,
      imageUrl: null,
      source: boardConfig.displayName,
      publishedAt: boardResult.scrapeTime,
      category: boardConfig.category,
      originalUrl: boardConfig.evidence,
      language: 'zh',
      needsTranslation: false,
      aiInsight: null,
      // 额外标记（不影响前端既有 NewsItem 类型，便于识别与去重）
      benchmarkNews: true,
      board: boardConfig.id,
      discoveryType: m.discoveryType,
      assertedToday: m.assertedToday,
    };
  });
}

// 将新增新闻条目合并进 news-data.json：按 id / originalUrl 去重，保留既有数据。
export function mergeNewsIntoData(newsItems, newsDataPath) {
  if (!newsItems.length) return { added: 0, considered: 0, path: newsDataPath };
  let data;
  try {
    data = JSON.parse(fs.readFileSync(newsDataPath, 'utf8'));
  } catch {
    return { added: 0, considered: newsItems.length, error: 'news-data.json 读取失败', path: newsDataPath };
  }
  const existing = Array.isArray(data.data) ? data.data : [];
  const seenIds = new Set(existing.map((x) => x.id));
  const seenUrls = new Set(existing.map((x) => normalizeUrl(x.originalUrl)).filter(Boolean));

  const toAdd = [];
  for (const it of newsItems) {
    if (seenIds.has(it.id)) continue;
    const u = normalizeUrl(it.originalUrl);
    if (u && seenUrls.has(u)) continue;
    toAdd.push(it);
  }
  if (toAdd.length) {
    data.data = [...toAdd, ...existing];
    data.total = data.data.length;
    data.timestamp = new Date().toISOString();
    fs.writeFileSync(newsDataPath, JSON.stringify(data, null, 2));
  }
  return { added: toAdd.length, considered: newsItems.length, path: newsDataPath };
}
