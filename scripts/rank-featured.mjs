// 独立重排命令：仅基于已有 news-data.json 重排双域精选，不再请求任何新闻 API。
//
// 用法：
//   node --env-file-if-exists=.env scripts/rank-featured.mjs
//   node scripts/rank-featured.mjs --target=public/news-data.json
//
// 行为：
//  - 读取目标 news-data.json（默认 public/news-data.json）。
//  - 用 featured-ranker 对其中两大领域条目重新评分/排序。
//  - 写回 featuredGroups + metadata（新增），并同步更新 featured（兼容旧消费方）。
//  - 不修改 archive、不触发 fetch-news / SuYxh / 三榜。
//  - 无 LLM_API_KEY 时走 rule_fallback（明确非 AI），父代理配置 key 后重跑即升级为 AI 评分。

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { rankFeatured, loadLLMConfig } from './featured-ranker.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(REPO_ROOT, 'public');

function log(...a) {
  process.stderr.write(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') + '\n');
}

async function main() {
  const args = process.argv.slice(2);
  const targetArg = args.find((a) => a.startsWith('--target='));
  const target = targetArg ? targetArg.split('=')[1] : path.join(PUBLIC_DIR, 'news-data.json');

  if (!fs.existsSync(target)) {
    log(`[rank-featured] 目标文件不存在: ${target}`);
    process.exit(1);
  }

  const cfg = loadLLMConfig(process.env);
  const data = JSON.parse(fs.readFileSync(target, 'utf8'));
  const items = Array.isArray(data.data) ? data.data : Array.isArray(data) ? data : [];

  if (!items.length) {
    log('[rank-featured] 目标数据无条目，跳过。');
    process.exit(0);
  }

  log(`[rank-featured] 读取 ${items.length} 条，开始重排（LLM ${cfg.enabled ? '启用(' + cfg.model + ')' : '未启用→规则回退'}）...`);

  const { featuredGroups, metadata } = await rankFeatured(items, { cfg });

  // 兼容：featured = 双域合并（各 5，共 10），旧消费方仍可展示
  const featured = [...(featuredGroups.embodied || []), ...(featuredGroups.llm || [])];

  const out = {
    ...data,
    success: data.success ?? true,
    timestamp: data.timestamp || metadata.generatedAt,
    meta: { ...(data.meta || {}), featuredGroups, featuredMetadata: metadata },
    featuredGroups,
    featuredMetadata: metadata,
    featured,
    data: data.data,
  };

  fs.writeFileSync(target, JSON.stringify(out, null, 2), 'utf8');
  log(`[rank-featured] 写回 ${target}`);
  log(`  具身智能: ${featuredGroups.embodied?.length || 0} 条 (${metadata.domains.embodied?.scoreSource})`);
  log(`  大模型:   ${featuredGroups.llm?.length || 0} 条 (${metadata.domains.llm?.scoreSource})`);
  if (metadata.warnings.length) log('  警告:', JSON.stringify(metadata.warnings));
  if (metadata.notes.length) log('  说明:', JSON.stringify(metadata.notes));
}

const isMain = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('rank-featured.mjs');
if (isMain) {
  main().then(() => process.exit(0)).catch((e) => {
    log('[rank-featured] FATAL', e?.message || e);
    process.exit(1);
  });
}

export { main };
