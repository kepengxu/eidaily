// 离线测试（无依赖，仅 node:test + node:assert）：不发起网络、不读密钥。
// 覆盖：发布优先普通、VLA/VLN、工具 release 不是模型、营销降低、中文/英文、排序先于分页、time tie。
//
// 运行（managed node）：
//   /Users/cooperxu/.workbuddy/binaries/node/versions/22.22.2-3/bin/node --test scripts/news-importance.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  sortNewsByImportance,
  classifyImportance,
  detectModelRelease,
  detectToolRelease,
} from '../src/lib/news-importance-core.mjs';

function mk(id, title, summary = '', ageHours = 1, extra = {}) {
  return {
    id,
    title,
    titleZh: title,
    summary,
    publishedAt: new Date(Date.now() - ageHours * 3600_000).toISOString(),
    category: '大模型',
    ...extra,
  };
}

// ---------------- 1) 发布优先普通 ----------------
test('模型发布优先于普通行业新闻', () => {
  const items = [
    mk('a', '某普通行业动态更新', '', 2),
    mk('b', 'GPT-7 正式发布，推理能力大幅提升', '', 2),
    mk('c', 'Claude 新模型上线', '', 2),
  ];
  const sorted = sortNewsByImportance(items, { sortMode: 'importance' });
  assert.equal(sorted[0].id, 'b');
  assert.equal(sorted[1].id, 'c');
  assert.equal(sorted[2].id, 'a');
});

// ---------------- 2) VLA/VLN 命中具身研究且高档 ----------------
test('VLA/VLN 命中具身智能研究且高于普通', () => {
  const vla = mk('v', 'VLA 模型在灵巧操作任务上取得新进展');
  const vln = mk('n', 'vision-language navigation 新方法提升机器人导航');
  const ordinary = mk('o', '某会议周报盘点', '', 1);
  assert.equal(classifyImportance(vla).tier, 'embodied_research');
  assert.equal(classifyImportance(vln).tier, 'embodied_research');
  const sorted = sortNewsByImportance([ordinary, vla, vln], { sortMode: 'importance' });
  // 两条具身研究(72)均高于普通(30)；同分按稳定 id 兜底，顺序不定，但普通必在最后
  assert.equal(sorted[2].id, 'o');
  assert.deepEqual([sorted[0].id, sorted[1].id].sort(), ['n', 'v']);
});

// ---------------- 3) 工具 release 不是模型 ----------------
test('工具发布（无模型名）归为 tool，不是 model_release', () => {
  const toolTitle = '开源团队发布数据标注工具框架';
  assert.equal(detectModelRelease(toolTitle), false, '无模型信号不应判为模型发布');
  assert.equal(detectToolRelease(toolTitle), true, '应判为工具');
  assert.equal(classifyImportance(mk('t', toolTitle)).tier, 'tool');

  // 反例：含模型名的发布仍判为模型发布（非工具）
  const modelTitle = 'DeepSeek 发布新模型 DeepSeek-V4';
  assert.equal(detectModelRelease(modelTitle), true);
  assert.equal(classifyImportance(mk('m', modelTitle)).tier, 'model_release');
});

// ---------------- 4) 营销/融资/教程 降权低于普通 ----------------
test('营销/融资/教程 低于普通行业', () => {
  const fund = mk('f', '某 AI 公司完成新一轮融资，估值大涨');
  const tut = mk('u', '新手保姆级使用教程与避坑指南');
  const ordinary = mk('o', '某行业技术观察与展望', '', 1);
  const sorted = sortNewsByImportance([ordinary, fund, tut], { sortMode: 'importance' });
  // 普通(30) > 营销(12)，所以普通在前；两条营销同分，顺序按稳定 id 兜底
  assert.equal(sorted[0].id, 'o');
  assert.deepEqual([sorted[1].id, sorted[2].id].sort(), ['f', 'u']);
  assert.equal(classifyImportance(fund).tier, 'marketing_funding');
  assert.equal(classifyImportance(tut).tier, 'marketing_funding');
});

// ---------------- 5) 中文 / 英文 均可识别模型发布 ----------------
test('中文与英文均可识别模型发布；纯公司名+release 不算模型发布', () => {
  const cn = 'GPT-7 正式发布，性能大幅提升';
  const en = 'OpenAI releases GPT-7 with stronger reasoning';
  const companyOnly = 'OpenAI 发布最新研究进展';
  assert.equal(detectModelRelease(cn), true);
  assert.equal(detectModelRelease(en), true);
  assert.equal(detectModelRelease(companyOnly), false, '纯公司名+release 不当模型发布');
  assert.equal(classifyImportance(mk('c', cn)).tier, 'model_release');
  assert.equal(classifyImportance(mk('e', en)).tier, 'model_release');
});

// ---------------- 6) 排序先于分页（全量排序后再切片） ----------------
test('排序先于分页：排序后前 20 条规则分均不低于第 21 条起', () => {
  const items = [];
  for (let i = 0; i < 25; i++) {
    // 交替高低重要性，制造乱序
    const title = i % 3 === 0 ? `GPT 新模型发布 ${i}` : `行业周报盘点 ${i}`;
    items.push(mk(`n${i}`, title, '', i + 1));
  }
  const sorted = sortNewsByImportance(items, { sortMode: 'importance' });
  // 规则分单调不增
  for (let i = 1; i < sorted.length; i++) {
    const a = classifyImportance(sorted[i - 1]).score;
    const b = classifyImportance(sorted[i]).score;
    assert.ok(a >= b, `第 ${i} 处规则分应不增：${a} >= ${b}`);
  }
  // 分页前 20 == 排序结果前 20
  const page1 = sorted.slice(0, 20);
  assert.equal(page1.length, 20);
  assert.equal(page1[0].id, sorted[0].id);
  assert.equal(page1[19].id, sorted[19].id);
});

// ---------------- 7) 时间并列 / 稳定 id 兜底 ----------------
test('规则分相等时按发布时间降序；时间也相等按稳定 id 升序', () => {
  const base = Date.now();
  const mkAt = (id, hoursAgo) => ({
    id,
    title: '普通行业新闻', // 同 tier，便于制造规则分相等
    titleZh: '普通行业新闻',
    summary: '',
    publishedAt: new Date(base - hoursAgo * 3600_000).toISOString(),
    category: '大模型',
  });
  const older = mkAt('z', 10);
  const newer = mkAt('a', 2);
  const sameTimeA = { ...mkAt('b', 5), publishedAt: newer.publishedAt };
  const sameTimeB = { ...mkAt('c', 5), publishedAt: newer.publishedAt };
  // 同分(ordinary=30) 且 newer 比 older 新 → newer 在前
  let sorted = sortNewsByImportance([older, newer], { sortMode: 'importance' });
  assert.equal(sorted[0].id, 'a', '同分应按时间降序');

  // 时间也相同 → 稳定 id 升序（b < c）
  sorted = sortNewsByImportance([sameTimeB, sameTimeA], { sortMode: 'importance' });
  assert.equal(sorted[0].id, 'b');
  assert.equal(sorted[1].id, 'c');
});

// ---------------- 8) 已有 AI 分仅作有限参考（不把无 AI 的挤下） ----------------
test('AI 分(importance)仅在规则分相等时微调，不推翻规则重要性', () => {
  const release = mk('r', 'GPT-7 正式发布', '', 2); // 规则 80
  const ordinaryHighAI = { ...mk('o', '普通公告', '', 2), importance: 99 }; // 规则 30，但有 AI 高分
  const sorted = sortNewsByImportance([ordinaryHighAI, release], { sortMode: 'importance' });
  assert.equal(sorted[0].id, 'r', '规则分更高的发布应排前，AI 分不能把它挤下');
});

// ---------------- 9) 最新发布模式：纯按时间降序 ----------------
test('sortMode=latest 仅按发布时间降序', () => {
  const items = [mk('old', 'x', '', 50), mk('new', 'y', '', 1), mk('mid', 'z', '', 20)];
  const sorted = sortNewsByImportance(items, { sortMode: 'latest' });
  assert.deepEqual(sorted.map((s) => s.id), ['new', 'mid', 'old']);
});
