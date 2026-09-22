// 可复用新闻领域匹配模块（纯函数，无外部依赖，仅依赖共享 JSON）
// 领域：大模型 / 具身智能
// 匹配规则：
//  - 纯 ASCII 词（含缩写/实体）使用词边界 \b...\b，避免 NOVA 误命中 VLA、API 误命中 PI 等
//  - 含非 ASCII（中文等）的词使用子串包含
//  - 具身歧义词（ACT/PI/RDT/Octo/CALVIN/Habitat）必须同时出现 robotics 上下文锚词才认定相关
//  - 短英文词边界；不能仅凭公司名（如 Google）或泛词（训练/导航/模型）认定相关

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KEYWORDS = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'news-search-keywords.json'), 'utf8')
);

const DOMAIN_LLM = '大模型';
const DOMAIN_EMBODIED = '具身智能';

function isAscii(str) {
  // 仅含 ASCII 字符（字母/数字/空格/标点），可用词边界匹配
  return /^[\x00-\x7f]*$/.test(str);
}

function matchTerm(text, term) {
  if (isAscii(term)) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('\\b' + escaped + '\\b', 'i');
    return re.test(text);
  }
  return text.toLowerCase().includes(term.toLowerCase());
}

function matchAny(text, terms) {
  if (!terms) return false;
  return terms.some((t) => matchTerm(text, t));
}

export function isWorldModel(text) {
  return !!text && matchAny(text, KEYWORDS.worldmodel.terms)
    && matchAny(text, [...KEYWORDS.worldmodel.anchors, ...KEYWORDS.roboticsAnchors]);
}

export function isEmbodied(text) {
  if (!text) return false;
  if (isWorldModel(text)) return true;
  const e = KEYWORDS.embodied;
  if (matchAny(text, e.strong)) return true;
  if (matchAny(text, e.entities)) return true;
  // 歧义词需 robotics 上下文锚词
  if (matchAny(text, e.ambiguous) && matchAny(text, KEYWORDS.roboticsAnchors)) {
    return true;
  }
  return false;
}

export function isLLM(text) {
  if (!text) return false;
  const l = KEYWORDS.llm;
  if (matchAny(text, l.strong)) return true;
  if (matchAny(text, l.entities)) return true;
  return false;
}

// 主分类：具身智能优先（避免 VLA / 机器人基础模型被“大模型”词抢走），返回两领域之一或 null
export function classifyText(text) {
  if (!text) return null;
  if (isEmbodied(text)) return DOMAIN_EMBODIED;
  if (isLLM(text)) return DOMAIN_LLM;
  return null;
}

// 带原因的分类（供过滤统计与脱敏报告使用）。行为同 classifyText，但额外返回命中原因。
export function classifyWithReason(text) {
  if (!text) return { category: null, reason: '空文本' };
  if (isWorldModel(text)) return { category: DOMAIN_EMBODIED, reason: '具身智能-worldmodel+AI上下文' };
  const e = KEYWORDS.embodied;
  if (matchAny(text, e.strong)) return { category: DOMAIN_EMBODIED, reason: '具身智能-强词命中' };
  if (matchAny(text, e.entities)) return { category: DOMAIN_EMBODIED, reason: '具身智能-实体命中' };
  if (matchAny(text, e.ambiguous) && matchAny(text, KEYWORDS.roboticsAnchors)) {
    return { category: DOMAIN_EMBODIED, reason: '具身智能-歧义词+robotics上下文' };
  }
  const l = KEYWORDS.llm;
  if (matchAny(text, l.strong)) return { category: DOMAIN_LLM, reason: '大模型-强词命中' };
  if (matchAny(text, l.entities)) return { category: DOMAIN_LLM, reason: '大模型-实体命中' };
  return { category: null, reason: '未命中大模型/具身智能关键词' };
}

// 数学/纯理论误报守卫（针对性，避免「傅里叶变换」等被「傅利叶」实体误判为具身）。
// 仅当具身判定来自「傅利叶」类实体，且文本明显是纯数学（含傅里叶 + 数学信号且缺 robotics 锚词）时降级。
const MATH_SIGNALS = ['傅里叶', '微积分', '导数', '积分', '级数', '微分方程', '线性代数', '矩阵论', '泛函分析', '拓扑', '数论', '概率论'];
export function guardMathFalsePositive(text, category) {
  if (category !== DOMAIN_EMBODIED || !text) return { ok: true, reason: null };
  const hasFourierEntity = /傅利叶/.test(text);
  if (!hasFourierEntity) return { ok: true, reason: null };
  const hasMath = MATH_SIGNALS.some((m) => text.includes(m));
  const hasRoboticsAnchor = matchAny(text, KEYWORDS.roboticsAnchors);
  if (hasMath && !hasRoboticsAnchor) {
    return { ok: false, reason: '疑似纯数学语境(傅里叶变换)非具身智能' };
  }
  return { ok: true, reason: null };
}

// 语言代码 -> 查询小组键名
const QUERY_GROUP = { en: 'internationalEnglish', zh: 'domesticChinese' };

// 构建 NewsAPI.ai 的 query OR 对象（按领域拆分，避免某条新闻数量阈值导致具身被遗漏）
export function newsApiQuery(domain, lang = 'en', fromDate = null) {
  const groupKey = QUERY_GROUP[lang] || 'internationalEnglish';
  const group = KEYWORDS.queries[groupKey][domain];
  const orClauses = group.map((kw) => ({ keywordLoc: 'title', keyword: kw }));
  const andClauses = [{ $or: orClauses }, { lang: lang === 'zh' ? 'chi' : 'eng' }];
  if (fromDate) andClauses.push({ dateStart: fromDate });
  return { $query: { $and: andClauses } };
}

// 构建 Currents API 的 keywords 字符串（空格分隔，短词）
export function currentsKeywords(domain, lang = 'en') {
  const groupKey = QUERY_GROUP[lang] || 'internationalEnglish';
  return KEYWORDS.queries[groupKey][domain].join(' ');
}

// 构建 NewsAPI.org / NewsData / GNews 等通用搜索服务的 OR 查询串。
// 复用共享两领域词库（KEYWORDS.queries），按领域独立取词；为避免超长单条查询，
// 优先保证用户指定的核心词（每领域核心：llm=ChatGPT/Claude/DeepSeek/Kimi/LLM；
// embodied=embodied AI/robotics/vision-language-action/vision-and-language navigation），
// 再用共享词库补足至上限。返回未编码的 OR 串，调用方自行 encodeURIComponent。
const SERVICE_CORE_PRIORITY = {
  llm: [
    'ChatGPT', 'Claude', 'DeepSeek', 'Kimi', 'LLM', 'GPT-5', 'Gemini',
    'OpenAI', 'Anthropic'
  ],
  embodied: [
    'embodied AI', 'robotics', 'vision-language-action', 'VLA',
    'world model', 'worldmodel', 'world-model', 'world models',
    'embodiedAI', 'embodied intelligence', 'physical AI', 'vision-and-language navigation'
  ]
};
const SERVICE_MAX_TERMS = 12;

export function serviceQuery(domain, lang = 'en') {
  const groupKey = QUERY_GROUP[lang] || 'internationalEnglish';
  const all = KEYWORDS.queries[groupKey][domain] || [];
  const priority = lang === 'zh' && domain === 'embodied'
    ? ['具身智能', '视觉语言动作', '世界模型', '机器人世界模型', 'VLA', 'physical AI', 'embodiedAI']
    : SERVICE_CORE_PRIORITY[domain] || [];
  const seen = new Set();
  const terms = [];
  for (const w of [...priority, ...all]) {
    if (seen.has(w)) continue;
    seen.add(w);
    terms.push(w);
    if (terms.length >= SERVICE_MAX_TERMS) break;
  }
  return terms.join(' OR ');
}

// NewsData 免费套餐 q 长度上限为 100 字符（实测超长会返回 422 UnsupportedQueryLength），
// 因此单独提供短查询（每领域核心实体，OR 连接），实测可正常返回 200。
const NEWSDATA_SHORT = {
  llm: {
    en: 'ChatGPT OR Claude OR DeepSeek OR LLM OR Gemini OR OpenAI OR Anthropic',
    zh: '大模型 OR 具身智能 OR 机器人 OR DeepSeek OR 智谱',
  },
  embodied: {
    en: 'embodied AI OR robotics OR VLA OR world model OR worldmodel OR physical AI OR embodiedAI',
    zh: '具身智能 OR 视觉语言动作 OR 世界模型 OR 机器人 OR VLA OR embodiedAI',
  },
};
export function newsDataQuery(domain, lang = 'en') {
  const group = NEWSDATA_SHORT[domain];
  if (!group) return NEWSDATA_SHORT.llm[lang] || NEWSDATA_SHORT.llm.en;
  return group[lang] || group.en;
}

// 单条限制不变；补充短查询覆盖无法塞进 NewsData 100 字符的变体。
export function apiQueries(service, domain, lang = 'en') {
  const primary = service === 'newsdata' ? newsDataQuery(domain, lang) : serviceQuery(domain, lang);
  if (domain !== 'embodied') return [primary];
  const extra = lang === 'zh'
    ? ['视觉语言动作 OR 世界模型 OR 机器人世界模型 OR 具身智能']
    : ['vision-language-action OR world-model OR world models OR embodied intelligence',
       'action-conditioned world model OR visionLanguageAction OR physicalAI'];
  const limit = service === 'newsdata' ? 100 : 500;
  const queries = [...new Set([primary, ...extra])];
  if (queries.some(q => q.length > limit)) throw new Error('新闻查询超过服务长度限制');
  return queries;
}

export { DOMAIN_LLM, DOMAIN_EMBODIED };
