import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function assessNewsReport(report) {
  const endpoints = report?.steps?.suyxh?.endpoints || {};
  // base 是旧文件；来源状态、OPML 清单和 LLM 评分也不算新新闻请求。
  const freshSources = ['latest24h', 'latest7d'].filter(name => endpoints[name]?.status === 'ok');
  if (report?.steps?.benchmark?.ok === true) freshSources.push('robodojo');
  const failures = [...(report?.failures || [])];
  for (const [name, endpoint] of Object.entries(endpoints)) {
    if (endpoint.status === 'error' && !failures.some(f => f.endpoint === name)) {
      failures.push({ group: 'suyxh', endpoint: name, error: endpoint.error });
    }
  }
  const benchmark = report?.steps?.benchmark;
  if (benchmark && benchmark.ok !== true && !failures.some(f => f.group === 'benchmark')) {
    failures.push({ group: 'benchmark', error: benchmark.error || '公告采集失败，保留历史数据' });
  }
  const warnings = report?.steps?.featuredRank?.warnings || [];
  return { ok: freshSources.length > 0, freshSources, failures, warnings };
}

export function checkNewsReport(file, summaryFile) {
  let result;
  try {
    const report = JSON.parse(fs.readFileSync(file, 'utf8'));
    result = assessNewsReport(report);
  } catch (error) {
    result = { ok: false, freshSources: [], failures: [{ group: 'report', error: error.message }], warnings: [] };
  }
  const text = [
    '## 新闻采集检查',
    `本次成功的新闻数据源：${result.freshSources.join('、') || '无'}。`,
    '既有 base、归档、缓存、来源状态和 OPML 清单不计入新请求成功。',
    ...result.failures.map(f => `- 失败 ${f.group || ''}/${f.endpoint || ''}：${f.error || '未知错误'}`),
    ...result.warnings.map(w => `- 评分警告：${typeof w === 'string' ? w : JSON.stringify(w)}`),
    result.ok ? '允许继续构建；部分源失败时保留对应历史数据，不视为该源更新成功。' : '无新闻数据请求成功或报告不可用：退出 1，禁止提交和部署旧数据。',
    '',
  ].join('\n');
  if (summaryFile) fs.appendFileSync(summaryFile, text);
  console.log(text);
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const result = checkNewsReport(path.join(root, 'outputs/unified-news-validation.json'), process.env.GITHUB_STEP_SUMMARY);
  if (!result.ok) process.exitCode = 1;
}
