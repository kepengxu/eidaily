import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
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
  const originalDate = raw.reportItem ? eventDate({ eventPublishedAt: raw.eventDate }, reportDate) : eventDate(raw, reportDate);
  const date = originalDate || (/^\d{4}-\d{2}-\d{2}$/.test(reportDate || '') ? new Date(`${reportDate}T00:00:00+08:00`) : null);
  if (!date || !Number.isFinite(+date)) return { status: 'unknown-date' };
  if (+date > +now) return { status: 'future' };
  if (+date < +now - windowHours * 3600000 && !raw.reportItem) return { status: 'old' };
  const dateBasis = originalDate ? 'original-event' : 'source_report';
  const eventPublishedAt = originalDate?.toISOString() || null;
  const resource = httpUrl(resourceUrl);
  if (!resource) return { status: 'invalid-source' };
  const originalSourceUrl = httpUrl(raw.url);
  const text = raw.summary.trim();
  const title = raw.title || (raw.person_or_entity ? `${raw.person_or_entity}：${text.slice(0, 110)}` : text.slice(0, 150));
  const category = classifyText(`${title} ${text}`);
  // AI线也只收两领域；无规则命中交由LLM判断，失败则后台隔离。
  const id = `pulsar_${hash(`${lane}|${originalSourceUrl}|${text}`)}`;
  const publishedAt = date.toISOString(), fetchedAt = now.toISOString();
  const source = `PULSAR ${lane.toUpperCase()}`;
  const provenance = { platform: 'PULSAR', lane, resourceUrl: resource, reportDate,
    originalSourceUrl: originalSourceUrl || null, sourceVerification: originalSourceUrl ? 'upstream-link-not-independently-verified' : 'upstream-report-only',
    upstreamMedia: raw.source || null, eventPublishedAt, eventDate: eventPublishedAt, dateBasis, reportDate, sourceURL: resource, links: raw.links || [], fetchedAt, datePrecision: 'day', originalText: text };
  // 无原始媒体链接时只链接实际读到的公开报告，明确不是一手已证实消息。
  const reportLink = new URL(resource);
  reportLink.searchParams.set('pulsar_item', id);
  const originalUrl = originalSourceUrl || reportLink.href;
  return { status: 'ok', item: { id, title, summary: text, content: text, originalText: text,
    category, source, mediaName: source, upstreamPlatform: 'PULSAR', lane, pulsarLane: lane,
    originalUrl, eventPublishedAt, eventDate: eventPublishedAt, reportDate, sourceURL: resource, dateBasis, links: raw.links || [], publishedAt, fetchedAt, language: 'zh',
    tags: isWorldModel(text) ? ['worldmodel'] : [], rawProvenance: provenance,
    sources: [{ platform: source, media: raw.source || source, url: originalUrl, resourceUrl: resource,
      originalSourceUrl: originalSourceUrl || null, lane, eventPublishedAt, eventDate: eventPublishedAt, reportDate, sourceURL: resource, dateBasis, fetchedAt, publishedAt,
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

async function fetchSocialSupplement({ fetchImpl = fetch, now = new Date(), windowHours = 168 } = {}) {
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
    // Social 仅访问已经公开的 JSON；禁止拼接每日文件名。
  }));
  items.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  return { items, quarantine, status: { fetchedAt: now.toISOString(), windowHours, lanes } };
}

export const PULSAR_DIRECTORIES = { ai: 'https://sou350121.github.io/pulsar-web/ai-daily/', vla: 'https://sou350121.github.io/pulsar-web/vla/' };
const decode = s => s.replace(/&#(x[\da-f]+|\d+);/gi, (_, n) => String.fromCodePoint(n[0].toLowerCase() === 'x' ? parseInt(n.slice(1), 16) : Number(n))).replace(/&(amp|quot|apos|lt|gt|nbsp);/g, (_, n) => ({ amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' })[n]);
const textOf = s => decode((s || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
const hrefs = s => [...s.matchAll(/<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>/gi)].map(m => decode(m[1]));

export function parseReportDirectory(html, directoryUrl, now = new Date()) {
  const today = new Date(+now + 8 * 3600000).toISOString().slice(0, 10);
  const cutoff = new Date(Date.parse(`${today}T00:00:00Z`) - 6 * 86400000).toISOString().slice(0, 10);
  const base = new URL(directoryUrl);
  return [...new Map(hrefs(html).flatMap(href => {
    const u = new URL(href, base);
    if (u.origin !== base.origin || !u.pathname.startsWith(base.pathname)) return [];
    const suffix = u.pathname.slice(base.pathname.length);
    const date = suffix.match(/^(\d{4}-\d{2}-\d{2})\/?$/)?.[1];
    if (!date || date < cutoff || date > today || new Date(date).toISOString().slice(0, 10) !== date) return [];
    return [[date, { reportDate: date, url: u.href }]];
  })).values()].sort((a, b) => b.reportDate.localeCompare(a.reportDate));
}

export function parseReportItems(html, lane) {
  const rows = [];
  const span = (s, cls) => textOf(s.match(new RegExp(`<span\\b[^>]*class=["'][^"']*\\b${cls}\\b[^"']*["'][^>]*>([\\s\\S]*?)<\\/span>`, 'i'))?.[1]);
  for (const match of html.matchAll(/<li\b[^>]*class=["']([^"']*digest-item[^"']*)["'][^>]*>([\s\S]*?)<\/li>/gi)) {
    if (!match[1].includes(`digest-item--${lane}`)) continue;
    const block = match[2], title = span(block, 'digest-title'), summary = span(block, 'digest-summary');
    if (title && summary) rows.push({ title, summary, source: span(block, 'digest-source'), links: hrefs(block), reportItem: true });
  }
  // VLA 同时提供 digest 与完整 article，按 URL 合并而非重复入库。
  for (const match of html.matchAll(/<article\b[^>]*>([\s\S]*?)<\/article>/gi)) {
    const block = match[1];
    if (lane === 'ai' && /tag-vla/.test(block) || lane === 'vla' && /tag-ai/.test(block)) continue;
    const title = textOf(block.match(/<h3\b[^>]*>([\s\S]*?)<\/h3>/i)?.[1]);
    const summary = textOf(block.match(/<p\b[^>]*>([\s\S]*?)<\/p>/i)?.[1]);
    if (title && summary) rows.push({ title, summary, links: hrefs(block), reportItem: true });
  }
  const merged = new Map();
  for (const row of rows) {
    row.links = [...new Set(row.links.map(httpUrl).filter(Boolean))]; row.url = row.links[0] || '';
    const key = row.url || row.title;
    const previous = merged.get(key);
    merged.set(key, { ...row, links: [...new Set([...(previous?.links || []), ...row.links])] });
  }
  if (!merged.size && !/digest-feed|digest-domain-section|暫無|暂无/.test(html)) throw new Error('无法识别日报详情结构');
  return [...merged.values()];
}

export async function fetchPulsar({ fetchImpl = fetch, now = new Date(), outputsDir, includeSocial = true, windowHours = 168 } = {}) {
  const cachePath = outputsDir && path.join(outputsDir, 'pulsar-reports-cache.json');
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(cachePath, 'utf8')); } catch { /* 首次缓存 */ }
  const items = [], quarantine = [], lanes = {};
  const today = new Date(+now + 8 * 3600000).toISOString().slice(0, 10);
  await Promise.all(Object.entries(PULSAR_DIRECTORIES).map(async ([lane, directory]) => {
    const rec = lanes[lane] = { status: 'error', directorySuccess: false, resources: [], reports: [], raw: 0, normalized: 0, changed: 0, unchanged: 0 };
    const get = async (url, detail = false) => {
      const resource = { url, status: 'error' }; rec.resources.push(resource);
      try {
        const res = await fetchImpl(url, { signal: AbortSignal.timeout(25000) });
        if (!res.ok) { resource.status = detail && res.status === 404 ? 'pending_detail' : 'error'; resource.error = `HTTP ${res.status}`; return null; }
        const html = await res.text(); resource.status = 'ok'; return html;
      } catch { resource.error = '请求失败或超时'; return null; }
    };
    const directoryHtml = await get(directory);
    if (directoryHtml === null) return;
    if (!/<html|<main|<a\b/i.test(directoryHtml)) { rec.resources[0].status = 'error'; rec.resources[0].error = '目录结构无效'; return; }
    rec.directorySuccess = true;
    const reports = parseReportDirectory(directoryHtml, directory, now);
    rec.reportDates = reports.map(r => r.reportDate);
    rec.todayStatus = reports.some(r => r.reportDate === today) ? 'published' : 'not_published';
    rec.status = rec.todayStatus === 'not_published' ? 'not_published' : 'ok';
    for (const report of reports) {
      const html = await get(report.url, true);
      if (html === null) { rec.reports.push({ ...report, status: rec.resources.at(-1).status }); continue; }
      const key = `${lane}|${report.url}`, previous = cache[key];
      try {
        const rawItems = parseReportItems(html, lane);
        const contentHash = hash(JSON.stringify(rawItems));
        const unchanged = previous?.contentHash === contentHash && Array.isArray(previous.items);
        const extracted = unchanged ? previous.items : rawItems.map(raw => normalizePulsar(raw, { lane, reportDate: report.reportDate, resourceUrl: report.url, now, windowHours })).filter(r => r.status === 'ok').map(r => r.item);
        cache[key] = { contentHash, reportDate: report.reportDate, resourceUrl: report.url, items: extracted, fetchedAt: now.toISOString(), revision: unchanged ? previous.revision : (previous?.revision || 0) + 1 };
        rec[unchanged ? 'unchanged' : 'changed']++; rec.raw += extracted.length;
        const revision = cache[key].revision;
        items.push(...structuredClone(extracted).map(it => ({ ...it, reportRevision: revision, reportChanged: !unchanged })));
        rec.normalized += extracted.length;
        rec.reports.push({ ...report, status: unchanged ? 'unchanged' : previous ? 'revision' : 'new', count: extracted.length, revision });
      } catch (e) { rec.resources.at(-1).status = 'error'; rec.resources.at(-1).error = e.message; }
    }
    if (rec.resources.some(r => r.status === 'pending_detail')) rec.status = 'pending_detail';
    if (rec.resources.slice(1).some(r => r.status === 'error')) rec.status = 'error';
  }));
  if (cachePath) { fs.mkdirSync(outputsDir, { recursive: true }); fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2), { mode: 0o600 }); }
  const social = includeSocial ? await fetchSocialSupplement({ fetchImpl, now, windowHours }) : null;
  if (social) { items.push(...social.items); quarantine.push(...social.quarantine); }
  items.sort((a, b) => (b.reportDate || '').localeCompare(a.reportDate || '') || b.publishedAt.localeCompare(a.publishedAt));
  return { items, quarantine, status: { fetchedAt: now.toISOString(), windowHours, lanes, social: social?.status || null,
    changedReports: Object.values(lanes).reduce((n, r) => n + r.changed, 0), directorySuccesses: Object.values(lanes).filter(r => r.directorySuccess).length } };
}
