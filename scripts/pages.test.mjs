import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assessNewsReport, checkNewsReport } from './check-news-report.mjs';
import { isPagesFile, preparePages } from './prepare-pages.mjs';

const report = (endpoints, benchmark = { ok: false, error: 'HTTP 503' }) => ({
  steps: { base: { read: 1000 }, suyxh: { endpoints }, benchmark },
  counts: { retained: 1000 }, failures: [],
});

test('旧数据、缓存和辅助端点不能冒充本次新闻采集成功', () => {
  assert.equal(assessNewsReport(report({ sourceStatus: { status: 'ok' }, opmlFeeds: { status: 'ok' }, latest24h: { status: 'error' } })).ok, false);
  assert.equal(assessNewsReport({}).ok, false);
});
test('任一实际新闻请求成功可发布，空结果也不冒充新增条目', () => {
  assert.equal(assessNewsReport(report({ latest24h: { status: 'ok', itemCount: 0 } })).ok, true);
  assert.equal(assessNewsReport(report({ latest7d: { status: 'ok' } })).ok, true);
  assert.deepEqual(assessNewsReport(report({}, { ok: true })).freshSources, ['robodojo']);
});
test('报告中独立失败的 RoboDojo 及评分警告不会漏报', () => {
  const r = report({ latest24h: { status: 'ok' }, latest7d: { status: 'error', error: '超时' } });
  r.steps.featuredRank = { warnings: ['评分回退'] };
  const result = assessNewsReport(r);
  assert.equal(result.failures.length, 2);
  assert.deepEqual(result.warnings, ['评分回退']);
});
test('缺失或损坏报告阻止发布并写摘要', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eidaily-report-'));
  try {
    const file = path.join(dir, 'report.json');
    const summary = path.join(dir, 'summary');
    assert.equal(checkNewsReport(file, summary).ok, false);
    fs.writeFileSync(file, '{');
    assert.equal(checkNewsReport(file, summary).ok, false);
    assert.match(fs.readFileSync(summary, 'utf8'), /禁止提交和部署/);
  } finally { fs.rmSync(dir, { recursive: true }); }
});
test('Pages 白名单保留核心数据、博客和资源，拒绝私有文件及旧三榜', () => {
  for (const name of ['index.html', 'assets/main-123.js', 'news-data.json', 'news-archive.json', 'robodojo-news.json', 'robodojo-news-history/2026-09-22.json', 'feed.json', 'blog-data.json', 'blog/example.html', 'blog/技术动态-123.html']) assert.equal(isPagesFile(name), true, name);
  for (const name of ['CNAME', '.env', 'news-data-backup.json', 'news-data.json.bak', 'blog-data.json.backup', 'benchmark-snapshot.json', 'benchmark-updates.json', 'benchmark-history/2026-09-22.json', 'outputs/featured-rank-cache.json', 'robodojo-news-history/backup.json', 'assets/private-cache.json']) assert.equal(isPagesFile(name), false, name);
  assert.throws(() => preparePages('/tmp'), /仅允许/);
});
