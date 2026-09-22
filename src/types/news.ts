export interface NewsItem {
  id: string;
  title: string;
  summary: string;
  content: string;
  imageUrl: string;
  source: string;
  publishedAt: string;
  category: string;
  originalUrl?: string;
  aiInsight?: string;
  // 用于存储原始英文内容（如果有的话）
  originalTitle?: string;
  originalSummary?: string;
  originalContent?: string;
  // 标识是否为翻译内容
  isTranslatedContent?: boolean;
  // ---- 统一管线扩展字段（可选，兼容既有数据） ----
  upstreamPlatform?: string; // 上游平台（如 SuYxh聚合 / 既有采集）
  mediaName?: string; // 媒体名（站点名）
  attribution?: string; // 出处署名
  titleZh?: string; // 中文标题（原文已有则用之，不伪造）
  sources?: NewsSourceRef[]; // 跨源同项保留的来源列表
  rawProvenance?: unknown; // 原始溯源（不对外暴露密钥）
  filterReason?: string; // 入选/过滤原因（用于统计，不声称重要性）
  firstSeenAt?: string | null;
  lastSeenAt?: string | null;
  needsTranslation?: boolean;
  language?: string;
  // ---- 双域精选评分字段（服务端评分后落盘，前端只读展示） ----
  importance?: number; // 0-100，AI 或规则评分
  eventType?: 'new_model_release' | 'model_update' | 'research' | 'tool' | 'industry' | 'other';
  reason?: string; // 评分依据（AI 判断前缀 / 规则前缀）
  scoreSource?: 'ai' | 'rule_fallback'; // 评分来源，明确是否 AI
  sourceReturnedModel?: string | null; // 模型实际返回名（用于不一致警告）
}

export interface NewsSourceRef {
  platform?: string;
  media?: string;
  siteId?: string | null;
  url?: string;
  attribution?: string;
  publishedAt?: string;
}

export interface NewsMeta {
  generatedAt: string;
  generatedBy?: string;
  total: number;
  archiveTotal?: number;
  retentionDays?: number;
  windows?: { '24h': number; '7d': number; '90d': number };
  categoryCounts?: Record<string, number>;
  sourceCounts?: Record<string, number>;
  sourceStatusUpstream?: {
    generatedAt?: string | null;
    sites?: { total: number | null; ok: number | null; failed: string[]; zeroItem: string[] };
    fetchedRawItems?: number | null;
    itemsBeforeTopicFilter?: number | null;
    itemsIn24h?: number | null;
    rssOpml?: {
      enabled?: boolean;
      feedTotal?: number;
      effectiveFeedTotal?: number;
      okFeeds?: number;
      failedFeeds?: number;
      zeroItemFeeds?: number;
      skippedFeeds?: number;
      replacedFeeds?: number | null;
    } | null;
    topicFilter?: string;
    note?: string;
  } | null;
  opmlCoverage?: { groups: number | null; totalFeeds: number | null; note?: string } | null;
  featuredRule?: string;
  homepageCapped?: boolean;
  homepageCap?: number;
  note?: string;
  // 双域精选（固定左具身智能 / 右大模型，各 5）
  featuredGroups?: {
    embodied?: NewsItem[];
    llm?: NewsItem[];
  };
  featuredMetadata?: Record<string, any>;
}

export interface NewsCategory {
  id: string;
  name: string;
  color: string;
}

export const DEFAULT_CATEGORIES: NewsCategory[] = [
  { id: 'ai', name: 'AI 模型', color: 'ai-color' },
  { id: 'tech', name: '科技', color: 'tech-color' },
  { id: 'economy', name: '经济', color: 'economy-color' },
  { id: 'analysis', name: '深度分析', color: 'analysis-color' },
];