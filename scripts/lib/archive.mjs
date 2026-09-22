// 90 天滚动归档：持久化、与首页分离、不截断。
// 设计原则（严格遵循授权）：
//  - 归档为去重后的全量（最近 retentionDays 天内），绝不截断到 30 条。
//  - 与新采集合并时按规范键去重：已存在项保留其原始 publishedAt（首次 last_seen 不替换 publishedAt），
//    仅追加新来源的 sources[] 与合并 provenance；首次出现的项 firstSeenAt 记为本次观测时间。
//  - 过期项（publishedAt 早于 now - retentionDays）裁剪掉，保持滚动窗口。

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseStrictUTC, ageDays } from './date-util.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_RETENTION_DAYS = 90;
const SCHEMA_VERSION = 1;

function keyOf(it) {
  return it._key || it._urlKey || it._titleKey || ('id:' + (it.title || '').toLowerCase());
}

export function loadArchive(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const data = JSON.parse(raw);
    if (data && Array.isArray(data.items)) return data;
  } catch {
    /* 不存在或非法 → 首次 */
  }
  return null;
}

// 把「已去重的新采集项」合并进归档，返回更新后的归档对象。
// newItems: dedup 后的 NewsItem 数组（含 _key）。
// 返回 { archive, added, updated, pruned, total }。
export function mergeIntoArchive(prevArchive, newItems, { now = new Date(), retentionDays = DEFAULT_RETENTION_DAYS, file } = {}) {
  const existing = (prevArchive && Array.isArray(prevArchive.items)) ? prevArchive.items : [];
  const byKey = new Map();
  for (const it of existing) byKey.set(keyOf(it), it);

  const sourceSig = (s) => `${s.platform}::${s.url || ''}::${s.media || ''}`;
  let added = 0;
  let updated = 0;

  for (const ni of newItems) {
    const k = keyOf(ni);
    const prev = byKey.get(k);
    if (!prev) {
      const item = { ...ni, firstSeenAt: ni.firstSeenAt || now.toISOString() };
      byKey.set(k, item);
      added++;
    } else {
      // 合并 sources（保留历史），不替换 publishedAt
      const map = new Map();
      for (const s of (prev.sources || [])) map.set(sourceSig(s), s);
      for (const s of (ni.sources || [])) {
        const sig = sourceSig(s);
        if (!map.has(sig)) map.set(sig, s);
      }
      prev.sources = [...map.values()];
      // 合并 provenance
      const pp = Array.isArray(prev.rawProvenance) ? prev.rawProvenance : [prev.rawProvenance];
      const np = Array.isArray(ni.rawProvenance) ? ni.rawProvenance : [ni.rawProvenance];
      prev.rawProvenance = [...pp, ...np].filter(Boolean);
      // 不替换 publishedAt；仅在缺失时补
      if (!prev.publishedAt && ni.publishedAt) prev.publishedAt = ni.publishedAt;
      // 优先补非空 summary / titleZh
      if (!prev.summary && ni.summary) prev.summary = ni.summary;
      if (!prev.titleZh && ni.titleZh) prev.titleZh = ni.titleZh;
      // firstSeenAt 保留最早（不替换）
      if (!prev.firstSeenAt) prev.firstSeenAt = now.toISOString();
      // 追加 lastSeenAt
      prev.lastSeenAt = ni.lastSeenAt || prev.lastSeenAt || null;
      updated++;
    }
  }

  // 裁剪过期项
  let pruned = 0;
  const cutoff = now.getTime() - retentionDays * 86400000;
  const kept = [];
  for (const it of byKey.values()) {
    const d = parseStrictUTC(it.publishedAt);
    if (d && d.getTime() < cutoff) {
      pruned++;
      continue;
    }
    kept.push(it);
  }

  const archive = {
    schemaVersion: SCHEMA_VERSION,
    updatedAt: now.toISOString(),
    retentionDays,
    items: kept,
  };
  return { archive, added, updated, pruned, total: kept.length };
}

export function writeArchive(file, archive) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(archive, null, 2), 'utf8');
}
