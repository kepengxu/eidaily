// 离线测试：验证共享 matcher 的分类逻辑（仅使用 Node 内置模块，无需联网/外部依赖）
// 覆盖：中国/英文 LLM、VLA、VLN、大学机器人研究、无关手机新闻、
//      ACT 单独、VLN 单独（预期 null）、含 AI 子串的普通英文、PI 单独、Google 单独、
//      泛词(训练/导航/模型)单独、旧历史非相关被过滤。

import { classifyText } from './news-matcher.js';

const cases = [
  // 中国 LLM
  {
    name: '中国LLM(智谱GLM大模型)',
    title: '智谱AI发布GLM-4.5大模型，支持超长上下文',
    content: '',
    expected: '大模型'
  },
  // 英文 LLM
  {
    name: '英文LLM(OpenAI GPT-5)',
    title: 'OpenAI launches GPT-5 with improved reasoning capabilities',
    content: '',
    expected: '大模型'
  },
  // 英文 LLM 实体 DeepSeek
  {
    name: '英文LLM(DeepSeek)',
    title: 'DeepSeek open sources new reasoning model',
    content: '',
    expected: '大模型'
  },
  // VLA
  {
    name: 'VLA(英文)',
    title: 'Researchers propose a new VLA for bimanual manipulation',
    content: '',
    expected: '具身智能'
  },
  // VLN
  {
    name: 'VLN(英文)',
    title: 'VLN benchmark improves vision-language navigation on indoor scenes',
    content: '',
    expected: '具身智能'
  },
  // 大学机器人研究（应命中具身）
  {
    name: '大学机器人研究(Stanford robot learning)',
    title: 'Stanford team develops robot learning method for dexterous grasping',
    content: '',
    expected: '具身智能'
  },
  // 无关普通手机新闻
  {
    name: '无关手机新闻',
    title: '新款智能手机发布，电池续航提升30%',
    content: '',
    expected: null
  },
  // ACT 单独（歧义词，无 robotics 上下文）
  {
    name: 'ACT单独(考试)',
    title: 'ACT exam scores released for high school students',
    content: '',
    expected: null
  },
  // ACT + robotics 上下文（应命中具身）
  {
    name: 'ACT+robotics上下文',
    title: 'ACT: a new action-chunking policy for robot manipulation',
    content: '',
    expected: '具身智能'
  },
  // VLN 单独（已移到 ambiguous，无 robotics 上下文时应返回 null）
  {
    name: 'VLN单独',
    title: 'VLN reaches new SOTA on indoor navigation tasks',
    content: '',
    expected: null
  },
  // 含 AI 子串的普通英文（train 含 ai，但不应命中）
  {
    name: '含AI子串普通英文(train)',
    title: 'The train arrived at the railway station on time',
    content: '',
    expected: null
  },
  // PI 单独（歧义词，无上下文）
  {
    name: 'PI单独(导师)',
    title: 'The PI (principal investigator) leads the new lab',
    content: '',
    expected: null
  },
  // 中文具身
  {
    name: '中文具身(宇树人形机器人)',
    title: '宇树发布新一代人形机器人，支持端到端操控',
    content: '',
    expected: '具身智能'
  },
  // 中文 VLA
  {
    name: '中文VLA',
    title: '视觉语言动作模型VLA取得新的研究进展',
    content: '',
    expected: '具身智能'
  },
  // CALVIN 无上下文
  {
    name: 'CALVIN无上下文(人名)',
    title: 'CALVIN is a popular baby name in the region',
    content: '',
    expected: null
  },
  // CALVIN 有上下文
  {
    name: 'CALVIN+robotics上下文',
    title: 'CALVIN benchmark advances robot learning for manipulation',
    content: '',
    expected: '具身智能'
  },
  // Google 单独不应认定相关
  {
    name: 'Google单独(搜索引擎)',
    title: 'Google 发布新版搜索引擎功能',
    content: '',
    expected: null
  },
  // 泛词 训练/导航/模型 单独不应认定相关
  {
    name: '泛词(训练导航模型)',
    title: '新训练方法提升导航模型精度',
    content: '',
    expected: null
  }
];

// 模拟 simple-aggregator 的历史记录过滤闸门：命中两领域才保留，否则实际剔除
function filterRecords(records) {
  return records.filter((r) => classifyText(`${r.title} ${r.content || ''}`));
}

const historyRecords = [
  { title: '新款手机发布，续航大幅提升', content: '普通消费电子新闻', when: 'old' },
  { title: 'OpenAI 发布 GPT-5，推理能力增强', content: '大模型新闻', when: 'recent' },
  { title: '某大学开设通识教育课程', content: '与AI无关', when: 'old' }
];

let pass = 0;
let fail = 0;

console.log('=== matcher 分类测试 ===');
for (const c of cases) {
  const actual = classifyText(`${c.title} ${c.content || ''}`);
  const ok = actual === c.expected;
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? '✅' : '❌'} ${c.name}: 实际=${actual} 期望=${c.expected}`);
}

console.log('\n=== 历史非相关记录过滤测试 ===');
const kept = filterRecords(historyRecords);
const expectedKept = 1; // 仅 GPT-5 应保留
const historyOk = kept.length === expectedKept && kept[0].title.includes('GPT-5');
if (historyOk) pass++;
else fail++;
console.log(`${historyOk ? '✅' : '❌'} 历史过滤: 保留 ${kept.length} 条（期望 ${expectedKept}），被过滤=${historyRecords.length - kept.length}`);
for (const r of historyRecords) {
  const isKept = kept.includes(r);
  console.log(`   ${isKept ? '保留' : '剔除'} | ${r.title}`);
}

console.log(`\n=== 汇总: 通过 ${pass}，失败 ${fail} ===`);
process.exit(fail > 0 ? 1 : 0);
