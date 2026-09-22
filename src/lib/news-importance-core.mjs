// 新闻全量排序：明确可解释的重要性规则（纯函数，server 与前端共用，无副作用）。
//
// 设计原则（严格遵循授权）：
//  - 规则可解释、确定性、不调用任何 LLM；排序标注为「规则排序（非 AI）」。
//  - 关键词区分：模型发布(需模型/版本上下文；硬件机器人新品单列)、模型更新、
//    具身 VLA/VLN/机器人学习/灵巧操作/导航/世界模型/数据/评测/开源、
//    LLM 新基础/推理/多模态/长上下文/agent/工具调用/MCP/训练/推理；
//    降低 营销/教程/融资/普通行业 优先级；英文词边界避免误报。
//  - 纯公司名或单独 "release" 不当作模型发布。
//  - 已有 AI 分(importance)仅作有限参考：只在「规则分相等」时作为次级微调，绝不把无 AI 分的条目整体挤下。
//  - 排序键：重要性(规则分)desc → 发布时间 desc → 稳定 id asc。
//  - 关键词集中在本文件单一来源，避免再复制 AI matcher 的混合域归属。

// ---------------- 共享关键词（单一来源） ----------------
export const IMPORTANCE_KEYWORDS = {
  // 模型发布：需「发布动词 + 模型信号」同时具备；纯公司名不算。
  releaseVerbs: [
    '发布', '上线', '开源', '推出', '官宣', '首发', '亮相', '问世', '揭晓', '开放',
    'release', 'releases', 'released', 'launch', 'launches', 'launched', 'unveil', 'unveiled',
    'announce', 'announced', 'announces', 'debut', 'debuts', 'debuted',
    'open-source', 'open-sourced', 'open source', 'introduces', 'introduce',
    'rolls out', 'roll out', 'ship', 'ships', 'shipped',
  ],
  // 模型信号：具体模型名/家族/版本（不含纯公司名）
  modelSignals: [
    'GPT', 'Claude', 'Gemini', 'Qwen', 'DeepSeek', 'GLM', 'Llama', 'Mistral', 'Kimi',
    'Doubao', 'Hunyuan', 'ERNIE', 'MiniMax', 'StepFun', 'Moonshot', 'Grok', '文心', '通义',
    '智谱', '百川', '阶跃', '零一', '星火', '商汤', 'o1', 'o3', 'o4', 'o5',
    'OpenVLA', 'GR00T', 'pi0', 'RT-1', 'RT-2', 'RoboFlamingo', 'Octo', 'RDT',
    'VLA', 'VLN', 'Liber', 'StarVLA', 'Galaxea', 'SimpleMemVLA', 'OpenWAM', 'KinRT',
    'Meituan-Robotics', 'DM0.5', 'MolmoAct', 'AgiBot', 'Figure', 'Unitree', 'Skywork',
    '新模型', '新基座', '新架构', 'new model', 'new foundation', 'foundation model',
    'new model release', 'new version', '新版本', '新系统', '新框架模型',
  ],
  // 更新动词（模型更新，区别于发布）
  updateVerbs: [
    '更新', '升级', '迭代', '微调', '增强版', '新版', '优化版',
    'update', 'updated', 'upgrade', 'upgraded', 'fine-tune', 'fine-tuned',
    'fine tuning', 'iteration', 'refreshed', 'revised',
  ],
  // 具身智能关键词（VLA/VLN/机器人学习/灵巧操作/导航/世界模型/数据/评测/开源）
  embodied: [
    'VLA', 'VLN', 'vision-language-action', 'vision language action',
    'vision-language navigation', 'vision-language-navigation', 'vision and language navigation',
    'vision-language-action model', '机器人学习', 'robot learning', 'robotic learning',
    '灵巧操作', 'dexterous manipulation', 'dexterous', '双臂操作', 'bimanual',
    '机器人导航', 'robot navigation', 'navigation', '导航', '世界模型', 'world model',
    'robot world model', '具身数据', 'robot dataset', '数据集', 'dataset', '数据评测',
    'benchmark', '评测', '仿真到现实', 'sim-to-real', 'sim2real', '跨本体', 'cross-embodiment',
    '遥操作', 'teleoperation', 'humanoid', '人形机器人', '机械臂', 'manipulation',
    'robot foundation', 'embodied', '具身', '机器人', 'robot', 'robotics', 'robotic',
  ],
  // 大模型研究关键词（新基础/推理/多模态/长上下文/agent/工具调用/MCP/训练/推理）
  llm: [
    '大模型', '大语言模型', '推理模型', 'reasoning model', '推理', 'inference',
    '多模态', 'multimodal', '长上下文', 'long-context', 'long context', '长文本',
    'AI agent', 'agent', '智能体', '工具调用', 'tool use', 'tool calling', 'tool-use',
    'function calling', 'MCP', '训练', 'training', '预训练', 'pretrain', 'post-train',
    '基座模型', 'foundation model', '基础模型', '语言模型', 'language model', 'LLM',
  ],
  // 工具（release 不是模型）
  tool: [
    '工具', 'tool', 'sdk', '框架', 'framework', '库', 'library', '插件', 'plugin',
    '平台', 'platform', '开源工具', 'open-source tool', 'CLI', 'API 工具',
  ],
  // 营销/教程/融资/普通行业（降权）
  lowered: [
    '融资', 'funding', 'raise', 'raised', '轮融资', '估值', 'ipo', '上市',
    '教程', '指南', '怎么', '如何', 'tutorial', 'how to', '攻略', '科普',
    '营销', '推广', 'market', '抽奖', '活动', '直播', '招聘', 'hiring',
    '周报', '月报', '盘点', '总结', 'opinion', '观点', '评论',
  ],
  // 硬件机器人新品（单列高档）
  hardwareRobot: [
    '人形机器人', 'humanoid', '四足', 'quadruped', '机械臂', '机械人', '机器人新品',
    '新机器人', 'new robot', 'new hardware', '硬件', 'hardware', '实体机器人', '本体',
  ],
  // 纯公司名（仅作发布信号时不足，用于排除"公司名+release"误判为模型发布）
  companyNames: [
    'OpenAI', 'Anthropic', 'Google', 'DeepMind', 'Meta', 'Microsoft', '阿里', '阿里巴巴',
    '百度', '腾讯', '字节', '字节跳动', '华为', '小米', 'xAI', 'Cohere', '智元', '宇树',
    '银河通用', '优必选', '傅利叶', '星海图', '美团', 'Meituan', 'NVIDIA', '英伟达',
  ],
};

// ---------------- 匹配工具 ----------------
function hasCn(s, arr) {
  for (const k of arr) if (s.includes(k)) return true;
  return false;
}
// 英文短语/词边界匹配：对含空格的短语直接用 includes；对单词用 \b 边界避免误报。
function hasEn(s, arr) {
  const lower = s.toLowerCase();
  for (const k of arr) {
    const kk = k.toLowerCase();
    if (/\s/.test(kk)) {
      if (lower.includes(kk)) return true;
    } else {
      const re = new RegExp(`\\b${kk.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
      if (re.test(lower)) return true;
    }
  }
  return false;
}
function hasAny(s, arr) {
  const chinese = arr.filter(k => /[\u3400-\u9fff]/.test(k));
  const english = arr.filter(k => !/[\u3400-\u9fff]/.test(k));
  return hasCn(s, chinese) || hasEn(s, english);
}
// 模型名/版本号信号：已知模型词 或 CamelCase/带数字版本 token（避免纯公司名）。
const MODEL_TOKEN_RE = /(?:[A-Z][a-z]*[A-Z][\w]*)|(?:[A-Za-z][\w]*-?\d[\w.]*)|(?:\d[\w.]*-\w+)/;
function hasModelToken(text, kws) {
  if (hasAny(text, kws.modelSignals)) return true;
  const m = text.match(MODEL_TOKEN_RE);
  if (m) {
    const t = m[0];
    // 排除纯公司名命中的 CamelCase（如 OpenAI/Google/Meta/Anthropic 已在 companyNames，这里兜底）
    if (kws.companyNames.some((c) => c.toLowerCase() === t.toLowerCase())) return false;
    // 至少含一个字母且非纯公司名 => 视作模型 token
    if (/[A-Za-z]/.test(t)) return true;
  }
  return false;
}
function hasReleaseVerb(text, kws) {
  return hasAny(text, kws.releaseVerbs);
}
function hasUpdateVerb(text, kws) {
  return hasAny(text, kws.updateVerbs);
}

// ---------------- 分类（返回 tier + 规则分 + 短标签） ----------------
export const TIER_LABELS = {
  hardware_robot: '硬件机器人新品',
  model_release: '模型发布',
  embodied_research: '具身智能研究',
  llm_research: '大模型研究',
  model_update: '模型更新',
  tool: '工具/平台',
  marketing_funding: '营销/融资/教程',
  ordinary: '普通行业',
};

const TIER_SCORE = {
  hardware_robot: 85,
  model_release: 80,
  embodied_research: 72,
  llm_research: 72,
  model_update: 66,
  tool: 58,
  marketing_funding: 12,
  ordinary: 30,
};

// 供测试导出的细分判定
export function detectModelRelease(text, kws = IMPORTANCE_KEYWORDS) {
  if (!hasReleaseVerb(text, kws)) return false;
  return hasModelToken(text, kws);
}
export function detectModelUpdate(text, kws = IMPORTANCE_KEYWORDS) {
  if (!hasUpdateVerb(text, kws)) return false;
  return hasModelToken(text, kws) || hasAny(text, kws.llm) || hasAny(text, kws.embodied);
}
export function detectToolRelease(text, kws = IMPORTANCE_KEYWORDS) {
  // 工具 release：有 release 动词 + 工具词，但不是模型发布
  if (hasReleaseVerb(text, kws) && hasAny(text, kws.tool) && !detectModelRelease(text, kws)) return true;
  return hasAny(text, kws.tool) && !detectModelRelease(text, kws) && !hasModelToken(text, kws);
}
export function detectMarketingFunding(text, kws = IMPORTANCE_KEYWORDS) {
  return hasAny(text, kws.lowered);
}
export function detectEmbodied(text, kws = IMPORTANCE_KEYWORDS) {
  return hasAny(text, kws.embodied);
}
export function detectLlm(text, kws = IMPORTANCE_KEYWORDS) {
  return hasAny(text, kws.llm);
}
export function detectHardwareRobot(text, kws = IMPORTANCE_KEYWORDS) {
  return hasAny(text, kws.hardwareRobot);
}

// 主分类：返回 { tier, score, label }
export function classifyImportance(item, kws = IMPORTANCE_KEYWORDS) {
  const text = [item?.title, item?.titleZh, item?.summary].filter(Boolean).join(' ');
  const t = text || '';

  // 1) 硬件机器人新品（含发布动词优先；即便无发布动词，明确硬件新品也单列）
  if (detectHardwareRobot(t, kws) && (hasReleaseVerb(t, kws) || detectModelRelease(t, kws) || /\brobot\b|机器人|humanoid/i.test(t))) {
    return { tier: 'hardware_robot', score: TIER_SCORE.hardware_robot, label: TIER_LABELS.hardware_robot };
  }
  // 2) 模型发布（需模型/版本上下文；纯公司名+release 不命中）
  if (detectModelRelease(t, kws)) {
    return { tier: 'model_release', score: TIER_SCORE.model_release, label: TIER_LABELS.model_release };
  }
  // 3) 模型更新
  if (detectModelUpdate(t, kws)) {
    return { tier: 'model_update', score: TIER_SCORE.model_update, label: TIER_LABELS.model_update };
  }
  // 4) 具身智能研究
  if (detectEmbodied(t, kws)) {
    return { tier: 'embodied_research', score: TIER_SCORE.embodied_research, label: TIER_LABELS.embodied_research };
  }
  // 5) 大模型研究
  if (detectLlm(t, kws)) {
    return { tier: 'llm_research', score: TIER_SCORE.llm_research, label: TIER_LABELS.llm_research };
  }
  // 6) 工具/平台（非模型）
  if (detectToolRelease(t, kws)) {
    return { tier: 'tool', score: TIER_SCORE.tool, label: TIER_LABELS.tool };
  }
  // 7) 营销/融资/教程 降权
  if (detectMarketingFunding(t, kws)) {
    return { tier: 'marketing_funding', score: TIER_SCORE.marketing_funding, label: TIER_LABELS.marketing_funding };
  }
  // 8) 普通行业
  return { tier: 'ordinary', score: TIER_SCORE.ordinary, label: TIER_LABELS.ordinary };
}

// ---------------- 排序 ----------------
// sortMode: 'importance'(默认) | 'latest'
// 规则分优先；AI 分(importance)仅作「规则分相等时」的次级微调（有限参考，不把无 AI 条目挤下）。
// 时间降序 → 稳定 id 升序 作为最终兜底。
export function sortNewsByImportance(items, opts = {}) {
  const { sortMode = 'importance', kws = IMPORTANCE_KEYWORDS } = opts;
  const arr = Array.isArray(items) ? items.slice() : [];
  const idOf = (it) => it?.id || `${it?.publishedAt || ''}:${it?.title || ''}`;
  const timeOf = (it) => {
    const d = new Date(it?.publishedAt).getTime();
    return isNaN(d) ? 0 : d;
  };
  const aiScoreOf = (it) => {
    const v = typeof it?.importance === 'number' ? it.importance : Number(it?.importance);
    return Number.isFinite(v) ? v : 0;
  };

  if (sortMode === 'latest') {
    arr.sort((a, b) => {
      const dt = timeOf(b) - timeOf(a);
      if (dt) return dt;
      return String(idOf(a)).localeCompare(String(idOf(b)));
    });
    return arr;
  }

  // importance 模式
  const scored = arr.map((it) => {
    const c = classifyImportance(it, kws);
    return { it, ruleScore: c.score, tier: c.tier, label: c.label, ai: aiScoreOf(it) };
  });
  scored.sort((a, b) => {
    if (b.ruleScore !== a.ruleScore) return b.ruleScore - a.ruleScore; // 规则分优先
    if (b.ai !== a.ai) return b.ai - a.ai; // 仅规则分相等时，AI 分有限微调
    const dt = timeOf(b.it) - timeOf(a.it);
    if (dt) return dt;
    return String(idOf(a.it)).localeCompare(String(idOf(b.it)));
  });
  return scored.map((s) => s.it);
}

export default sortNewsByImportance;
