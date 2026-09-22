import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizePulsar, eventDate, parseSocialMarkdown } from './pulsar-adapter.mjs';
import { curatePulsar, validateCuration, mergePulsarSource } from './pulsar-curator.mjs';
import { apiQueries, classifyText, isWorldModel } from './news-matcher.js';
import { fetchNewsAPIs } from './news-api-adapter.mjs';
import { assessNewsReport } from './check-news-report.mjs';
const fixture = lane => JSON.parse(fs.readFileSync(new URL(`./fixtures/pulsar-${lane}.sample.json`, import.meta.url)));
const now = new Date('2026-09-22T06:00:00Z');
const f = fixture('vla');
const normalized = () => normalizePulsar(f.raw, { ...f, now }).item;

test('真实VLA fixture保留原文和报告链接，不把报告日期标作事件日期', () => {
  const it = normalized();
  assert.equal(it.publishedAt, '2026-09-18T16:00:00.000Z');
  assert.equal(it.rawProvenance.reportDate, '2026-09-21');
  assert.equal(it.originalText, f.raw.summary);
  assert.equal(it.rawProvenance.sourceVerification, 'upstream-report-only');
  assert.equal(it.source, 'PULSAR VLA');
});
test('真实AI Markdown fixture规范化与日期隔离', () => {
  const a = fixture('ai'), raw = parseSocialMarkdown(a.markdown)[0];
  assert.equal(raw.url, 'no_url');
  const r = normalizePulsar(raw, { ...a, now });
  assert.equal(r.status, 'ok'); assert.equal(r.item.source, 'PULSAR AI');
  assert.equal(r.item.publishedAt, '2026-09-15T16:00:00.000Z');
  assert.equal(normalizePulsar(raw, { ...a, now, windowHours: 48 }).status, 'old');
  assert.equal(normalizePulsar({ summary: 'AI agent发布' }, { ...a, now }).status, 'unknown-date');
  assert.equal(normalizePulsar({ summary: '2026-09-23 AI agent发布' }, { ...a, now }).status, 'future');
  assert.equal(eventDate({ summary: '2026-02-30 AI发布' }, a.reportDate), null);
});
test('关键词边界、驼峰、worldmodel上下文与两API限长', () => {
  for (const text of ['VLA', 'visionLanguageAction', 'embodiedAI', 'embodied intelligence', '视觉语言动作', 'physicalAI']) assert.equal(classifyText(text), '具身智能', text);
  for (const word of ['Worldmodel', 'world model', 'world-model', 'world models', '世界模型']) assert.equal(isWorldModel(`AI predictive ${word}`), true);
  assert.equal(classifyText('NOVA festival'), null);
  assert.equal(isWorldModel('a philosophical world model'), false);
  assert.equal(classifyText('large language model'), '大模型');
  for (const service of ['newsapi', 'newsdata']) for (const lang of ['en', 'zh']) {
    const q = apiQueries(service, 'embodied', lang);
    assert.ok(q.every(x => x.length <= (service === 'newsdata' ? 100 : 500)));
    assert.ok(q.join(' ').includes(lang === 'zh' ? '世界模型' : 'world model'));
    if (lang === 'en') assert.ok(q.join(' ').includes('vision-language-action'));
  }
});
test('严格模型ID、重复和循环结构校验', () => {
  const c = [normalized()], good = { id: c[0].id, relevant: true, category: '具身智能', summary: '据上游报道，Figure展示家务能力。', duplicateOf: null };
  assert.equal(validateCuration({ items: [good] }, c, []).length, 1);
  for (const changed of [{ id: 'invented' }, { duplicateOf: 'invented' }, { duplicateOf: c[0].id }, { summary: '' }]) assert.throws(() => validateCuration({ items: [{ ...good, ...changed }] }, c, []));
});
test('调用模型跨源去重保留已有摘要、非public缓存与失败原文', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulsar-test-'));
  const old = { id: 'old', title: 'Figure Helix 2.5展示家务能力', summary: '已有摘要不能被覆盖', publishedAt: '2026-09-19T00:00:00Z', sources: [], category: '具身智能' };
  let calls = 0;
  const fetchImpl = async (_, opts) => {
    calls++; const body = JSON.parse(opts.body), payload = JSON.parse(body.messages[1].content);
    assert.ok(payload.candidates.length <= 40); assert.ok(payload.existing.length <= 40);
    return { ok: true, json: async () => ({ model: 'returned-model', choices: [{ message: { content: JSON.stringify({ items: payload.candidates.map(c => ({ id: c.id, relevant: true, category: '具身智能', summary: '据报道，Figure展示家务能力。', duplicateOf: payload.existing[0].id })) }) } }] }) };
  };
  const cfg = { enabled: true, apiKey: 'fixture-not-secret', model: 'requested-model', baseUrl: 'https://example.test/chat/completions' };
  const r = await curatePulsar([normalized()], [old], { outputsDir: dir, fetchImpl, cfg, now });
  assert.equal(calls, 1); assert.equal(r.status.semanticDuplicates, 1); assert.equal(r.items.length, 0);
  assert.equal(old.summary, '已有摘要不能被覆盖'); assert.equal(old.sources[0].platform, 'PULSAR VLA'); assert.equal(r.status.modelMismatch, true);
  const fail = await curatePulsar([normalized()], [], { outputsDir: dir, cfg, now, fetchImpl: async () => { throw new Error('故障'); } });
  assert.equal(fail.status.requests, 2); assert.equal(fail.status.state, 'failed-raw-preserved');
  assert.ok(fs.readFileSync(path.join(dir, 'pulsar-pending.json'), 'utf8').includes('Helix'));
});
test('API实际请求覆盖全部短query并保持两服务独立执行', async () => {
  const urls = [];
  const r = await fetchNewsAPIs({ now, env: { NEWSAPI_ORG_KEY: 'test', NEWSDATA_API_KEY: 'test' }, fetchImpl: async url => {
    urls.push(new URL(url)); return { ok: true, status: 200, json: async () => ({ articles: [], results: [] }) };
  } });
  for (const host of ['newsapi.org', 'newsdata.io']) {
    const q = urls.filter(u => u.hostname === host).map(u => u.searchParams.get('q')).join(' ');
    assert.ok(q.includes('world-model')); assert.ok(q.includes('视觉语言动作')); assert.ok(q.includes('embodied intelligence'));
  }
  assert.equal(r.successfulRequests, urls.length);
});
test('成功源门禁可由PULSAR贡献而非旧base', () => {
  assert.equal(assessNewsReport({ steps: { base: { normalized: 10 } } }).ok, false);
  assert.equal(assessNewsReport({ steps: { pulsar: { lanes: { ai: { status: 'ok' } } } } }).ok, true);
});
