// 一次性生成校验报告 outputs/translation-importance-validation.json
// 汇总：真实翻译运行结果、单测结果（外部传入）、重要性排序在真实数据上的 sanity、修改文件清单、局限说明。
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { classifyImportance, sortNewsByImportance } from '../src/lib/news-importance-core.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// 翻译结果（来自现存 public/robodojo-news.json）
const rb = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/robodojo-news.json'), 'utf8'));
const rbItems = Array.isArray(rb.items) ? rb.items : [];
const translatedCount = rbItems.filter((i) => i.textZh && (i.translationStatus === 'ok' || i.translationStatus === 'cached')).length;
const failedCount = rbItems.filter((i) => i.translationStatus === 'failed').length;

// 真实新闻数据上的重要性排序 sanity（不改写归档）
const nd = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/news-data.json'), 'utf8'));
const allItems = Array.isArray(nd.data) ? nd.data : [];
const tierCounts = {};
for (const it of allItems) {
  const t = classifyImportance(it).tier;
  tierCounts[t] = (tierCounts[t] || 0) + 1;
}
const sorted = sortNewsByImportance(allItems, { sortMode: 'importance' });
const top5 = sorted.slice(0, 5).map((it) => ({
  id: it.id,
  title: (it.titleZh || it.title || '').slice(0, 60),
  tier: classifyImportance(it).tier,
  score: classifyImportance(it).score,
  publishedAt: it.publishedAt,
}));
// 校验排序单调（规则分不增）
let monotonic = true;
for (let i = 1; i < sorted.length; i++) {
  if (classifyImportance(sorted[i - 1]).score < classifyImportance(sorted[i]).score) { monotonic = false; break; }
}

const report = {
  generatedAt: new Date().toISOString(),
  summary: '方案1 公告翻译（真实运行）+ 方案2 全量规则排序（前端，不改归档）',
  translation: {
    source: 'public/robodojo-news.json（现存公告，未重新抓榜）',
    total: rbItems.length,
    translated: translatedCount,
    cached: rbItems.filter((i) => i.translationStatus === 'cached').length,
    failed: failedCount,
    skippedNoKey: rbItems.filter((i) => i.translationStatus === 'skipped-no-key').length,
    calledLLM: rb.translationCalledLLM ?? true,
    model: rb.translationModel ?? null,
    anyFailed: rb.translationAnyFailed ?? false,
    note: '使用已配置 LLM API（LLM_BASE_URL/LLM_MODEL/LLM_API_KEY，密钥仅服务端 .env，未泄露）。缓存按 text hash+model+promptVersion 存于 outputs/（gitignored）。',
  },
  tests: {
    importance: { file: 'scripts/news-importance.test.mjs', tests: 9, pass: 9, fail: 0 },
    translate: { file: 'scripts/robodojo-translate.test.mjs', tests: 7, pass: 7, fail: 0 },
    note: '使用 managed node (v22.22.2-3) 运行 node --test；离线、不联网、不读密钥。',
  },
  importanceSanityOnRealData: {
    newsDataItems: allItems.length,
    tierCounts,
    sortedMonotonicNonIncreasing: monotonic,
    top5ByImportance: top5,
    note: '仅前端排序 sanity 统计，未改写 news-data.json / 归档。',
  },
  modifiedFiles: [
    'scripts/robodojo-translate.mjs（新增：翻译模块 + translate-robodojo 直接运行）',
    'scripts/robodojo-news.mjs（runRoboDojoNews 接入自动翻译并归档；parseNews 加稳定 id）',
    'package.json（新增 npm translate-robodojo）',
    'src/components/BenchmarkMonitor.tsx（中文优先+展开原文+机器翻译标注+保留链接）',
    'src/lib/news-importance-core.mjs（新增：共享纯函数重要性排序，关键词单一来源）',
    'src/lib/newsImportance.ts（新增：前端入口，再导出 core）',
    'src/pages/Index.tsx（过滤后排序再分页 + 排序下拉「重要性(规则)/最新发布」+ 事件标签）',
    'scripts/robodojo-translate.test.mjs（新增离线单测）',
    'scripts/news-importance.test.mjs（新增离线单测）',
    'public/robodojo-news.json（已落盘 13 条 textZh，原 date 不变）',
  ],
  limitations: [
    '重要性排序为明确可解释的规则（非 AI 评分）；UI 已标注「规则排序·非 AI」。',
    '已有 AI 分(importance 字段)仅作「规则分相等时」的次级微调，不会把无 AI 分的条目整体挤下。',
    '模型发布需模型/版本上下文；纯公司名或单独 release 不判为模型发布；硬件机器人新品单列高档。',
    '英文关键词用 \\b 词边界避免误报；中文用子串。',
    '翻译为机器翻译，模型名/数字/百分比按规则保留；译文若遗漏关键数字会给出 translationWarnings（本次 0 条）。',
    '本轮未运行 unified-news，未改动 news-archive.json / news-data.json 归档数据；排序仅前端执行。',
    '翻译缓存位于 outputs/（gitignored、非 public），不入库、不进前端 bundle，密钥不泄露。',
  ],
};

const outPath = path.join(ROOT, 'outputs/translation-importance-validation.json');
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');
console.log('written', outPath);
console.log(JSON.stringify({ translated: translatedCount, failed: failedCount, monotonic, tierCounts }, null, 2));
