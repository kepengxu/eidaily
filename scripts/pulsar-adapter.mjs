import { createHash } from 'node:crypto';
import { classifyText, isWorldModel } from './news-matcher.js';
import { canonicalUrlKey, canonicalTitleKey } from './lib/url-normalize.mjs';

export const PULSAR_BASE = 'https://raw.githubusercontent.com/sou350121/pulsar-web/main/src/data/';
export const PULSAR_ENDPOINTS = { vla: PULSAR_BASE + 'vla-social-intel.json', ai: PULSAR_BASE + 'ai-social-intel.json' };
const hash = s => createHash('sha256').update(s).digest('hex').slice(0, 24);
const httpUrl = s => { try { const u = new URL(s); return /^https?:$/.test(u.protocol) && !u.username && !u.password ? u.href : ''; } catch { return ''; } };

export function eventDate(raw, reportDate) {
  const explicit = raw.eventPublishedAt || raw.publishedAt;
  if (explicit) {
    if (!/^\d{4}-\d{2}-\d{2}(?:T.*(?:Z|[+-]\d{2}:\d{2}))?$/.test(explicit)) return null;
    const d = new Date(explicit.length === 10 ? explicit + 'T00:00:00+08:00' : explicit);
    return Number.isFinite(+d) ? d : null;
  }
  // 日期必须来自单条原文，报告日期只提供短日期的年份，绝不直接当事件日期。
  const text = raw.summary || '';
  const full = text.match(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/);
  const short = text.match(/(?:^|[^\d])(\d{1,2})(?:\/|\s*月\s*)(\d{1,2})(?:\s*日)?/);
  if (!full && !short) return null;
  const year = full ? full[1] : reportDate?.slice(0, 4);
  if (!/^20\d{2}$/.test(year || '')) return null;
  const month = (full ? full[2] : short[1]).padStart(2, '0');
  const day = (full ? full[3] : short[2]).padStart(2, '0');
  const key = `${year}-${month}-${day}`;
  const d = new Date(key + 'T00:00:00+08:00');
  if (!Number.isFinite(+d) || new Date(+d + 8 * 3600000).toISOString().slice(0, 10) !== key) return null;
  return d;
}

export function normalizePulsar(raw, { lane, reportDate, resourceUrl, now = new Date(), windowHours = 168 } = {}) {
  if (!['vla', 'ai'].includes(lane) || !raw || typeof raw.summary !== 'string' || !raw.summary.trim()) return { status: 'invalid' };
  const date = eventDate(raw, reportDate);
  if (!date) return { status: 'unknown-date' };
  if (+date > +now) return { status: 'future' };
  if (+date < +now - windowHours * 3600000) return { status: 'old' };
  const resource = httpUrl(resourceUrl);
  if (!resource) return { status: 'invalid-source' };
  const originalSourceUrl = httpUrl(raw.url);
  const text = raw.summary.trim();
  const title = raw.person_or_entity ? `${raw.person_or_entity}：${text.slice(0, 110)}` : text.slice(0, 150);
  const category = classifyText(`${title} ${text}`);
  // AI线也只收两领域；无规则命中交由LLM判断，失败则后台隔离。
  const id = `pulsar_${hash(`${lane}|${originalSourceUrl}|${text}`)}`;
  const publishedAt = date.toISOString(), fetchedAt = now.toISOString();
  const source = `PULSAR ${lane.toUpperCase()}`;
  const provenance = { platform: 'PULSAR', lane, resourceUrl: resource, reportDate,
    originalSourceUrl: originalSourceUrl || null, sourceVerification: originalSourceUrl ? 'upstream-link-not-independently-verified' : 'upstream-report-only',
    upstreamMedia: raw.source || null, eventPublishedAt: publishedAt, fetchedAt, datePrecision: 'day', originalText: text };
  // 无原始媒体链接时只链接实际读到的公开报告，明确不是一手已证实消息。
  const reportLink = new URL(resource);
  reportLink.searchParams.set('pulsar_item', id);
  const originalUrl = originalSourceUrl || reportLink.href;
  return { status: 'ok', item: { id, title, summary: text, content: text, originalText: text,
    category, source, mediaName: source, upstreamPlatform: 'PULSAR', lane, pulsarLane: lane,
    originalUrl, eventPublishedAt: publishedAt, publishedAt, fetchedAt, language: 'zh',
    tags: isWorldModel(text) ? ['worldmodel'] : [], rawProvenance: provenance,
    sources: [{ platform: source, media: raw.source || source, url: originalUrl, resourceUrl: resource,
      originalSourceUrl: originalSourceUrl || null, lane, eventPublishedAt: publishedAt, fetchedAt, publishedAt,
      sourceVerification: provenance.sourceVerification }],
    _urlKey: canonicalUrlKey(originalUrl),
    _titleKey: canonicalTitleKey(title) } };
}

export function parseSocialMarkdown(text) {
  const rows = [];
  let current = null;
  for (const line of text.split('\n')) {
    if (/^[-*]\s+\S/.test(line)) {
      if (current) rows.push(current);
      current = { summary: line.replace(/^[-*]\s+/, '').replace(/\*\*/g, ''), source: '', url: '' };
    } else if (current) {
      const link = line.match(/来源[:：]\s*\[([^\]]+)\]\(([^)]+)\)/);
      if (link) { current.source = link[1]; current.url = link[2]; }
      else if (/^\s+https?:\/\//.test(line)) current.url = line.trim();
    }
  }
  if (current) rows.push(current);
  return rows;
}

export async function fetchPulsar({ fetchImpl = fetch, now = new Date(), windowHours = Number(process.env.PULSAR_WINDOW_HOURS || 168) } = {}) {
  if (!Number.isFinite(windowHours) || windowHours < 1 || windowHours > 168) throw new Error('PULSAR_WINDOW_HOURS 必须为1至168');
  const items = [], quarantine = [], lanes = {};
  await Promise.all(['vla', 'ai'].map(async lane => {
    const rec = lanes[lane] = { resources: [], raw: 0, normalized: 0, excluded: {}, status: 'error' };
    const ingest = (raw, reportDate, resourceUrl) => {
      rec.raw++;
      const r = normalizePulsar(raw, { lane, reportDate, resourceUrl, now, windowHours });
      if (r.status === 'ok') { items.push(r.item); rec.normalized++; }
      else { rec.excluded[r.status] = (rec.excluded[r.status] || 0) + 1; quarantine.push({ lane, reportDate, resourceUrl, reason: r.status, raw }); }
    };
    const get = async (url, json = false) => {
      const entry = { url, status: 'error' }; rec.resources.push(entry);
      try {
        const res = await fetchImpl(url, { signal: AbortSignal.timeout(25000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = json ? await res.json() : await res.text();
        if (json && !Array.isArray(data?.social_intel)) throw new Error('social_intel字段无效');
        if (!json && (!/^# /m.test(data) || !/社交|social/i.test(data))) throw new Error('社交报告结构无效');
        entry.status = 'ok'; rec.status = 'ok'; return data;
      } catch (e) { entry.error = /HTTP \d+/.test(e.message) ? e.message : '请求超时或结构无效'; return null; }
    };
    const data = await get(PULSAR_ENDPOINTS[lane], true);
    if (data) {
      rec.jsonDateRange = data.social_intel.map(x => x.date).filter(Boolean).sort();
      rec.jsonDateRange = [rec.jsonDateRange[0], rec.jsonDateRange.at(-1)];
      for (const d of data.social_intel) for (const raw of d.signals || []) ingest(raw, d.date, PULSAR_ENDPOINTS[lane]);
    }
    // 页面实际读取按日Markdown；逐日验证HTTP，不依赖陈旧AI JSON。
    for (let n = 0; n <= Math.ceil(windowHours / 24); n++) {
      const day = new Date(+now + 8 * 3600000 - n * 86400000).toISOString().slice(0, 10);
      const url = `${PULSAR_BASE}_${lane}_social_${day}.md`;
      const md = await get(url);
      if (md) for (const raw of parseSocialMarkdown(md)) ingest(raw, day, url);
    }
  }));
  items.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  return { items, quarantine, status: { fetchedAt: now.toISOString(), windowHours, lanes } };
}
