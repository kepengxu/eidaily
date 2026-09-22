// 前端入口：新闻重要性排序（纯函数，规则可解释，非 AI 评分）。
// 真实实现位于 news-importance-core.mjs（与离线单测共用同一来源）。
export {
  sortNewsByImportance,
  classifyImportance,
  detectModelRelease,
  detectModelUpdate,
  detectToolRelease,
  detectMarketingFunding,
  detectEmbodied,
  detectLlm,
  detectHardwareRobot,
  TIER_LABELS,
  IMPORTANCE_KEYWORDS,
} from './news-importance-core.mjs';

export type SortMode = 'importance' | 'latest';
