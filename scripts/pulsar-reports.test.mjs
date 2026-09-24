import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fetchPulsar, parseReportDirectory, parseReportItems, normalizePulsar, PULSAR_DIRECTORIES } from './pulsar-adapter.mjs';
import { runPipeline } from './unified-news.mjs';
import { curatePulsar } from './pulsar-curator.mjs';
import { assessNewsReport } from './check-news-report.mjs';
const html = fs.readFileSync(new URL('./fixtures/pulsar-report.sample.html', import.meta.url), 'utf8');
const now = new Date('2026-09-24T02:00:00Z');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pulsar-reports-'));
const response = (body, status = 200) => ({ ok: status === 200, status, text: async () => body, json: async () => JSON.parse(body) });
test('真实链接解析跨月近七天，排除猜测日期与跨频道链接', () => {
  const body = '<a href="/pulsar-web/ai-daily/2026-08-31">旧月</a><a href="/pulsar-web/ai-daily/2026-09-01">本月</a><a href="/pulsar-web/vla/2026-09-01">另一线</a><a href="/pulsar-web/ai-daily/2026-08-20">过期</a>';
  assert.deepEqual(parseReportDirectory(body, PULSAR_DIRECTORIES.ai, new Date('2026-09-02T02:00:00Z')).map(r => r.reportDate), ['2026-09-01', '2026-08-31']);
});
test('缺原始日期保留日报日期但不伪造事件日期，论文代码链接保留', () => {
  for (const lane of ['ai', 'vla']) {
    const raw = parseReportItems(html, lane)[0];
    assert.equal(raw.links.length, 2);
    const it = normalizePulsar(raw, { lane, reportDate: '2026-09-24', resourceUrl: PULSAR_DIRECTORIES[lane], now }).item;
    assert.equal(it.eventDate, null); assert.equal(it.dateBasis, 'source_report'); assert.equal(it.reportDate, '2026-09-24');
  }
});
test('频道独立、缺今日、pending404、未变复用items以及revision', async () => {
  const outputsDir = tmp(); let revision = false; const requests = [];
  const fetchImpl = async url => {
    requests.push(url);
    if (url === PULSAR_DIRECTORIES.ai) return response('<a href="/pulsar-web/ai-daily/2026-09-23">报告</a>');
    if (url === PULSAR_DIRECTORIES.vla) return response('<a href="/pulsar-web/vla/2026-09-24">报告</a><a href="/pulsar-web/vla/2026-09-23">报告</a>');
    if (url.endsWith('/vla/2026-09-24')) return response('', 404);
    return response(revision ? html.replace('工程工具。', '工程工具，新增修订。') : html);
  };
  const a = await fetchPulsar({ fetchImpl, outputsDir, now, includeSocial: false });
  assert.equal(a.status.lanes.ai.status, 'not_published'); assert.equal(a.status.lanes.vla.status, 'pending_detail');
  assert.equal(a.items.length, 2);
  const b = await fetchPulsar({ fetchImpl, outputsDir, now, includeSocial: false });
  assert.equal(b.status.changedReports, 0); assert.equal(b.items.length, 2); assert.equal(b.items[0].reportChanged, false);
  revision = true;
  const c = await fetchPulsar({ fetchImpl, outputsDir, now, includeSocial: false });
  assert.equal(c.status.changedReports, 1); assert.equal(c.items.find(it => it.lane === 'ai').reportRevision, 2);
  assert.equal(c.items.find(it => it.lane === 'vla').reportRevision, 1);
  assert.ok(requests.every(url => !url.includes('_social_')));
});
test('pulsar-only不请求其他source，有效空目录成功，网络全失败不写新闻', async () => {
  const root = tmp(), publicDir = path.join(root, 'public'), outputsDir = path.join(root, 'outputs');
  fs.mkdirSync(publicDir); fs.writeFileSync(path.join(publicDir, 'news-data.json'), '{"data":[]}');
  const original = fs.readFileSync(path.join(publicDir, 'news-data.json'), 'utf8');
  const urls = [];
  const fetchImpl = async url => { urls.push(url); assert.ok(url.includes('pulsar-web')); return url.endsWith('.json') ? response('{"social_intel":[]}') : response('<main>暂无报告</main>'); };
  const r = await runPipeline({ pulsarOnly: true, now, publicDir, outputsDir, fetchImpl, quiet: true });
  assert.equal(r.outcome, 'unchanged'); assert.equal(assessNewsReport(r).ok, true); assert.equal(urls.length, 4);
  await assert.rejects(runPipeline({ pulsarOnly: true, now, publicDir, outputsDir, fetchImpl: async () => { throw Error('网络失败'); }, quiet: true }));
  assert.equal(fs.readFileSync(path.join(publicDir, 'news-data.json'), 'utf8'), original);
});
test('未变模型结果缓存复用且修订重新整理', async () => {
  const outputsDir = tmp(), cfg = { enabled: true, model: 'test', apiKey: 'test', baseUrl: 'https://example.test/llm' }; let calls = 0;
  const fetchImpl = async (_, options) => {
    calls++; const data = JSON.parse(JSON.parse(options.body).messages[1].content);
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ items: data.candidates.map(it => ({ id: it.id, relevant: true, category: '大模型', summary: '据上游报告，工具支持模型编排。', duplicateOf: null })) }) } }] }) };
  };
  const raw = normalizePulsar(parseReportItems(html, 'ai')[0], { lane: 'ai', now, reportDate: '2026-09-24', resourceUrl: PULSAR_DIRECTORIES.ai }).item;
  const a = await curatePulsar([{ ...raw, reportRevision: 1, reportChanged: true }], [], { outputsDir, cfg, fetchImpl, now });
  const b = await curatePulsar([{ ...raw, reportRevision: 1 }], [], { outputsDir, cfg, fetchImpl, now });
  assert.equal(calls, 1); assert.equal(b.items.length, a.items.length);
  await curatePulsar([{ ...raw, reportRevision: 2, reportChanged: true }], [], { outputsDir, cfg, fetchImpl, now });
  assert.equal(calls, 2);
});
