// 统一新闻规范化：把各来源的原始条目规范为统一 NewsItem 字段，
// 应用共享 matcher 做两大领域（大模型 / 具身智能，含 AI 工具工程）过滤，
// 保留原文 URL / 上游平台 / 媒体名 / 出处署名，title_zh 已有则用之，绝不伪造正文。
//
// 输出统一字段（与 src/types/news.ts 的 NewsItem 兼容，并附加溯源字段）：
//   title, titleZh, summary, content(空，不伪造), imageUrl(null), source,
//   publishedAt(严格UTC，无则排除), category, originalUrl(去跟踪), aiInsight(null),
//   language, needsTranslation,
//   upstreamPlatform, mediaName, attribution,
//   sources[ {platform,media,siteId,url,attribution,publishedAt} ],
//   rawProvenance, filterReason, firstSeenAt, lastSeenAt

import { classifyWithReason, guardMathFalsePositive, DOMAIN_LLM, DOMAIN_EMBODIED } from '../news-matcher.js';
import { parseStrictUTC, isFuture } from './date-util.mjs';
import { canonicalUrlKey, canonicalTitleKey, cleanUrl } from './url-normalize.mjs';

function hasChinese(s) {
  return /[一-龥]/.test(s || '');
}

// raw: 来源原始条目对象
// ctx: {
//   platform: 'SuYxh聚合' | 'NewsAPI.org' | 'NewsData' | 'RSS' | ...,
//   media: 媒体名（site_name / 来源名）,
//   siteId: 可选,
//   sourceType: 'suyxh' | 'api' | 'rss' | 'benchmark',
//   titleFrom(raw): 取标题, summaryFrom(raw), urlFrom(raw), dateFrom(raw),
//   titleZhFrom(raw): 取中文标题（可选）,
//   firstSeenFrom(raw), lastSeenFrom(raw),
// }
export function normalizeRawItem(raw, ctx, { now = new Date() } = {}) {
  const title = (ctx.titleFrom ? ctx.titleFrom(raw) : raw.title || '')?.toString().trim() || '';
  if (!title) {
    return { status: 'excluded', reason: '无标题', raw };
  }
  const titleZh = (ctx.titleZhFrom ? ctx.titleZhFrom(raw) : '')?.toString().trim()
    || (hasChinese(title) ? title : '');
  const summaryRaw = (ctx.summaryFrom ? ctx.summaryFrom(raw) : raw.summary || raw.content || '')?.toString().trim() || '';
  // 不伪造正文：content 始终为空；summary 仅当来源提供才保留，否则空（UI 显示「无摘要」）
  const urlRaw = (ctx.urlFrom ? ctx.urlFrom(raw) : raw.url || raw.originalUrl || raw.link)?.toString().trim() || '';
  const originalUrl = cleanUrl(urlRaw);

  // 领域分类（含数学误报守卫）
  const { category, reason: clsReason } = classifyWithReason(`${title} ${titleZh}`);
  if (!category) {
    return { status: 'excluded', reason: clsReason, raw, title };
  }
  const guard = guardMathFalsePositive(`${title} ${titleZh}`, category);
  if (!guard.ok) {
    return { status: 'excluded', reason: guard.reason, raw, title };
  }

  // 日期：严格 UTC，未知 → 排除（绝不伪造今天）
  const dateRaw = ctx.dateFrom ? ctx.dateFrom(raw) : raw.publishedAt;
  const date = parseStrictUTC(dateRaw);
  if (!date) {
    return { status: 'excluded', reason: '日期无法解析(未知日期不收录)', raw, title };
  }
  if (isFuture(date, now)) {
    return {
      status: 'future',
      reason: '未来日期隔离(不收录/不称今日发布)',
      raw,
      title,
      publishedAtISO: date.toISOString(),
    };
  }

  const media = ctx.media || raw.source || raw.site_name || ctx.platform;
  const attribution = `${media} via ${ctx.platform}`;
  const sourceEntry = {
    platform: ctx.platform,
    media,
    siteId: ctx.siteId || raw.site_id || null,
    url: originalUrl || urlRaw,
    attribution,
    publishedAt: date.toISOString(),
  };

  const language = hasChinese(title) ? 'zh' : 'en';
  const source = media; // 兼容既有 UI 的 source 字段（媒体名）

  const item = {
    title,
    titleZh: titleZh || title,
    summary: summaryRaw, // 可能为空；UI 显示「无摘要」
    content: '', // 不伪造正文
    imageUrl: null,
    source,
    publishedAt: date.toISOString(),
    category,
    originalUrl: originalUrl || urlRaw,
    aiInsight: null,
    language,
    needsTranslation: language === 'en',
    upstreamPlatform: ctx.platform,
    mediaName: media,
    attribution,
    sources: [sourceEntry],
    rawProvenance: makeProvenance(raw, ctx),
    filterReason: clsReason,
    firstSeenAt: ctx.firstSeenFrom ? (ctx.firstSeenFrom(raw) || null) : null,
    lastSeenAt: ctx.lastSeenFrom ? (ctx.lastSeenFrom(raw) || null) : null,
    // 去重用规范键（运行时）
    _urlKey: canonicalUrlKey(originalUrl || urlRaw),
    _titleKey: canonicalTitleKey(title),
  };
  return { status: 'ok', item, reason: clsReason };
}

function makeProvenance(raw, ctx) {
  // 保留最小原始溯源，避免大对象；真实字段原样保留
  const p = {};
  for (const k of ['id', 'site_id', 'site_name', 'source', 'title', 'url', 'published_at', 'first_seen_at', 'last_seen_at', 'title_zh', 'title_en', 'title_original', 'title_bilingual']) {
    if (raw[k] !== undefined) p[k] = raw[k];
  }
  p._platform = ctx.platform;
  p._sourceType = ctx.sourceType;
  return p;
}

export { DOMAIN_LLM, DOMAIN_EMBODIED };
