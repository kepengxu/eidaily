// 跨源去重：精确规范标题 / URL 去重，跨源同项保留 sources[]，绝不模糊乱并。
// 设计原则（严格遵循授权）：
//  - 仅当「规范 URL 相同」或「规范标题相同」才视为同一项（精确，非模糊）。
//  - 同项合并：sources[] 累加（按 url+platform 去重），rawProvenance 合并为数组，
//    保留最早 publishedAt（首次 last_seen 不替换 publishedAt），保留非空 summary。
//  - 不跨异构语义合并（模糊仅保守：仅以上述精确键），避免把不同新闻并成一条。

import { parseStrictUTC } from './date-util.mjs';

// 跨源同项判定：URL 规范键相同或标题规范键相同，均视为同一项（精确，非模糊）。
function findExisting(mapByUrl, mapByTitle, item) {
  if (item._urlKey && mapByUrl.has(item._urlKey)) return mapByUrl.get(item._urlKey);
  if (item._titleKey && mapByTitle.has(item._titleKey)) return mapByTitle.get(item._titleKey);
  return null;
}

function sourceSig(s) {
  return `${s.platform}::${s.url || ''}::${s.media || ''}`;
}

function mergeSources(existing, incoming) {
  const map = new Map();
  for (const s of existing) map.set(sourceSig(s), s);
  for (const s of incoming) {
    const sig = sourceSig(s);
    if (!map.has(sig)) map.set(sig, s);
  }
  return [...map.values()];
}

function earliestISO(a, b) {
  const da = parseStrictUTC(a);
  const db = parseStrictUTC(b);
  if (!da) return b || null;
  if (!db) return a || null;
  return da.getTime() <= db.getTime() ? a : b;
}

// items: 规范化的 NewsItem（含 _urlKey/_titleKey 运行时字段）
// 返回去重后的数组；每个元素已分配稳定 id（基于规范键哈希）。
export function dedupItems(items) {
  const mapByUrl = new Map();
  const mapByTitle = new Map();
  const all = [];
  for (const it of items) {
    const existing = findExisting(mapByUrl, mapByTitle, it);
    if (!existing) {
      const node = { ...it, sources: [...(it.sources || [])] };
      if (it._urlKey) mapByUrl.set(it._urlKey, node);
      if (it._titleKey) mapByTitle.set(it._titleKey, node);
      all.push(node);
      continue;
    }
    const cur = existing;
    // 合并 sources
    cur.sources = mergeSources(cur.sources, it.sources || []);
    // 合并 provenance
    const prevProv = Array.isArray(cur.rawProvenance) ? cur.rawProvenance : [cur.rawProvenance];
    const incProv = Array.isArray(it.rawProvenance) ? it.rawProvenance : [it.rawProvenance];
    cur.rawProvenance = [...prevProv, ...incProv].filter(Boolean);
    // 保留最早 publishedAt（不替换）
    cur.publishedAt = earliestISO(cur.publishedAt, it.publishedAt) || cur.publishedAt;
    // 优先保留非空 summary / titleZh
    if (!cur.summary && it.summary) cur.summary = it.summary;
    if (!cur.titleZh && it.titleZh) cur.titleZh = it.titleZh;
    // 保留最早 firstSeenAt / lastSeenAt（仅当缺失才补）
    if (!cur.firstSeenAt && it.firstSeenAt) cur.firstSeenAt = it.firstSeenAt;
    if (!cur.lastSeenAt && it.lastSeenAt) cur.lastSeenAt = it.lastSeenAt;
  }

  const out = [];
  for (const it of all) {
    const id = 'u_' + hashKey(it._urlKey || it._titleKey || ('id:' + (it.title || '').toLowerCase()));
    // 清理运行时字段
    const { _urlKey, _titleKey, ...clean } = it;
    clean.id = id;
    out.push(clean);
  }
  return out;
}

function hashKey(s) {
  // 稳定短哈希（FNV-1a）
  let h = 0x811c9dc5;
  const str = String(s);
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}
