import { useState, useEffect, useMemo } from 'react';
import { Helmet } from 'react-helmet-async';
import { AppHeader } from '@/components/AppHeader';
import { CategoryTabs } from '@/components/CategoryTabs';
import { NewsCard } from '@/components/NewsCard';
import { SideMenu } from '@/components/SideMenu';
import { DailyBriefing } from '@/components/DailyBriefing';
import { BenchmarkMonitor } from '@/components/BenchmarkMonitor';
import { Disclaimer } from '@/components/Disclaimer';
import { EmailSubscribe } from '@/components/EmailSubscribe';
import { PerformanceMonitor } from '@/components/PerformanceMonitor';
import { MobileNavigation, MobileGestureHint } from '@/components/MobileNavigation';
import { useNews } from '@/hooks/useNews';
import { sortNewsByImportance, classifyImportance, TIER_LABELS } from '@/lib/newsImportance';
import { useLanguage } from '@/contexts/LanguageContext';
import { useScrollPosition } from '@/hooks/useScrollPosition';
import { usePerformanceOptimization } from '@/hooks/usePerformanceOptimization';
import { RefreshCw } from 'lucide-react';

// 客户端日期窗口判定（严格按 publishedAt，未知/未来日期不参与）
function withinWindowClient(publishedAt: string, days: number): boolean {
  try {
    const d = new Date(publishedAt).getTime();
    if (isNaN(d)) return false;
    const diff = Date.now() - d;
    if (diff < 0) return false; // 未来日期不纳入"近期"窗口
    return diff <= days * 86400000;
  } catch {
    return false;
  }
}

function formatGeneratedTime(iso?: string | null): string {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`;
  } catch {
    return iso;
  }
}

// 来源状态面板：上游聚合源报告 与 本页可用来源 严格分开
function SourceStatusPanel({ meta }: { meta: any }) {
  const { isZh } = useLanguage();
  const upstream = meta?.sourceStatusUpstream;
  const sourceCounts: Record<string, number> = meta?.sourceCounts || {};
  const localSources = Object.keys(sourceCounts).sort((a, b) => sourceCounts[b] - sourceCounts[a]);

  return (
    <div className="mt-3 rounded-lg border px-4 py-3" style={{ borderColor: 'hsl(var(--border))', background: 'hsl(var(--card))' }}>
      <div className="flex items-center gap-2 mb-2" style={{ fontFamily: "'DM Mono', monospace", fontSize: '10px', color: 'hsl(var(--muted-foreground))', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
        <span className="inline-block w-1.5 h-1.5" style={{ background: '#4A6572' }} />
        {isZh ? '来源状态' : 'SOURCE STATUS'}
      </div>

      {/* 上游聚合源报告（来自 SuYxh，含失败源，不声称全可用） */}
      <div className="mb-3">
        <div style={{ fontSize: '11px', fontWeight: 700, color: 'hsl(var(--foreground))' }}>
          {isZh ? '上游聚合源报告（SuYxh）' : 'Upstream aggregator report (SuYxh)'}
        </div>
        {upstream ? (
          <div className="mt-1.5 space-y-1" style={{ fontSize: '11px', color: 'hsl(var(--muted-foreground))' }}>
            <div>
              {isZh ? '站点总数' : 'Sites total'}: <b style={{ color: 'hsl(var(--foreground))' }}>{upstream.sites?.total ?? '—'}</b>
              {' · '}
              {isZh ? '成功' : 'OK'}: <b style={{ color: '#9bf0b4' }}>{upstream.sites?.ok ?? '—'}</b>
              {' · '}
              {isZh ? '失败' : 'Failed'}:{' '}
              <b style={{ color: '#ff9b9b' }}>{(upstream.sites?.failed || []).join(', ') || '—'}</b>
            </div>
            {upstream.rssOpml ? (
              <div>
                {isZh ? 'RSS/OPML 清单' : 'RSS/OPML feeds'}:{' '}
                {isZh ? '共' : 'total'} {upstream.rssOpml.feedTotal ?? '—'}{' '}
                {isZh ? '（有效' : '(effective'} {upstream.rssOpml.effectiveFeedTotal ?? '—'}{' '}
                {isZh ? '，成功' : ', ok'} {upstream.rssOpml.okFeeds ?? '—'}{' '}
                {isZh ? '，失败' : ', failed'} {upstream.rssOpml.failedFeeds ?? '—'}{' '}
                {isZh ? '，零条' : ', zero'} {upstream.rssOpml.zeroItemFeeds ?? '—'}）
              </div>
            ) : null}
            <div style={{ opacity: 0.8 }}>
              {isZh
                ? '说明：公开聚合源已按主题过滤；上游 site_count 仅表示来源覆盖，不代表本页全部可用。'
                : 'Note: upstream site_count shows coverage only, not all usable on this page.'}
            </div>
          </div>
        ) : (
          <div className="mt-1.5" style={{ fontSize: '11px', color: 'hsl(var(--muted-foreground))' }}>
            {isZh ? '（本页数据暂无上游聚合源报告）' : '(no upstream report bundled with this data)'}
          </div>
        )}
      </div>

      {/* 本页可用来源（实际落在本页数据的来源） */}
      <div>
        <div style={{ fontSize: '11px', fontWeight: 700, color: 'hsl(var(--foreground))' }}>
          {isZh ? `本页可用来源（${localSources.length}）` : `Local available sources (${localSources.length})`}
        </div>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {localSources.length ? (
            localSources.map((s) => (
              <span
                key={s}
                className="px-2 py-0.5 rounded-full"
                style={{ fontSize: '10px', fontFamily: "'DM Mono', monospace", background: 'hsl(var(--muted))', color: 'hsl(var(--muted-foreground))' }}
              >
                {s} <b style={{ color: 'hsl(var(--foreground))' }}>{sourceCounts[s]}</b>
              </span>
            ))
          ) : (
            <span style={{ fontSize: '11px', color: 'hsl(var(--muted-foreground))' }}>—</span>
          )}
        </div>
      </div>
    </div>
  );
}

const Index = () => {
  const { news, rawNews, meta, featured, loading, error, categories, selectedCategory, setSelectedCategory, refreshNews } = useNews();
  const { isZh } = useLanguage();
  const { saveScrollPosition, restoreScrollPosition } = useScrollPosition({
    key: 'news-list-scroll',
    restoreOnMount: true,
    saveOnUnmount: true,
  });
  const { debounce } = usePerformanceOptimization();

  const [lastUpdateTime, setLastUpdateTime] = useState<Date>(new Date());
  const [sideMenuOpen, setSideMenuOpen] = useState(false);
  const [dailyBriefingOpen, setDailyBriefingOpen] = useState(false);
  const [disclaimerOpen, setDisclaimerOpen] = useState(false);
  const [emailSubscribeOpen, setEmailSubscribeOpen] = useState(false);

  // 筛选与分页状态
  const [selectedSource, setSelectedSource] = useState<string>('all');
  const [dateWindow, setDateWindow] = useState<number | null>(null); // null=全部, 2天(48小时)/7天/90天
  const [keyword, setKeyword] = useState('');
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 20;
  // 列表排序：默认「重要性」（规则排序，非 AI），可选「最新发布」
  const [sortMode, setSortMode] = useState<'importance' | 'latest'>('importance');

  useEffect(() => {
    if (!loading && !error && news.length > 0) {
      setLastUpdateTime(new Date());
    }
  }, [news, loading, error]);

  // 可用来源列表（优先 meta，否则从当前数据推导）
  const availableSources = useMemo(() => {
    if (meta?.sourceCounts && Object.keys(meta.sourceCounts).length) {
      return Object.keys(meta.sourceCounts).sort((a, b) => meta.sourceCounts[b] - meta.sourceCounts[a]);
    }
    const set = new Set<string>();
    for (const it of rawNews) set.add(it.mediaName || it.source || '未知');
    return Array.from(set).sort();
  }, [meta, rawNews]);

  // 组合筛选（分类已由 useNews 处理；此处叠加 来源/窗口/关键词）
  const filtered = useMemo(() => {
    let list = news;
    if (selectedSource !== 'all') list = list.filter((it) => (it.mediaName || it.source) === selectedSource);
    if (dateWindow != null) list = list.filter((it) => withinWindowClient(it.publishedAt, dateWindow));
    const kw = keyword.trim().toLowerCase();
    if (kw) {
      list = list.filter((it) => {
        const hay = `${it.title || ''} ${it.titleZh || ''} ${it.summary || ''}`.toLowerCase();
        return hay.includes(kw);
      });
    }
    return list;
  }, [news, selectedSource, dateWindow, keyword]);

  // 过滤后、分页前执行排序（重要性规则 / 最新发布）；规则可解释、非 AI 评分。
  const sortedList = useMemo(
    () => sortNewsByImportance(filtered, { sortMode }),
    [filtered, sortMode]
  );

  // 双域精选（固定左具身智能 / 右大模型，各 5）——独立展示，不受分类页签筛选影响。
  // 可解释标示：这是服务端评分后的独立双域精选，不与新闻列表共享分类过滤。
  const dualFeatured = useMemo(() => {
    const fg = meta?.featuredGroups;
    if (fg && (Array.isArray(fg.embodied) || Array.isArray(fg.llm))) {
      return {
        embodied: (fg.embodied || []).slice(0, 5),
        llm: (fg.llm || []).slice(0, 5),
        source: meta?.featuredMetadata?.scoreSource || 'unknown',
        metadata: meta?.featuredMetadata || null,
        fromGroups: true,
      };
    }
    // 兼容回退：按 category 切分旧 featured（仍保持双域独立，不随分类页签变化）
    const emb = (featured || []).filter((it) => it.category === '具身智能').slice(0, 5);
    const llm = (featured || []).filter((it) => it.category === '大模型').slice(0, 5);
    return { embodied: emb, llm, source: 'legacy-featured', metadata: null, fromGroups: false };
  }, [meta, featured]);

  // 分页（基于排序后的全量筛选结果）
  const totalPages = Math.max(1, Math.ceil(sortedList.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageItems = useMemo(
    () => sortedList.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE),
    [sortedList, safePage]
  );

  // 筛选/排序变化时回到第一页
  useEffect(() => {
    setPage(1);
  }, [selectedSource, dateWindow, keyword, selectedCategory, sortMode]);

  const handleRefresh = debounce(() => {
    saveScrollPosition();
    refreshNews();
    setLastUpdateTime(new Date());
    setTimeout(() => restoreScrollPosition(), 300);
  }, 1000);

  const handleMenuClick = (menuItem: string) => {
    setSideMenuOpen(false);
    switch (menuItem) {
      case 'daily-briefing': setDailyBriefingOpen(true); break;
      case 'rss-subscribe': setEmailSubscribeOpen(true); break;
      case 'disclaimer': setDisclaimerOpen(true); break;
    }
  };

  const totalItems = meta?.total ?? news.length;
  const archiveTotal = meta?.archiveTotal ?? null;
  const windows = meta?.windows ?? null;

  const WINDOWS: Array<{ key: number | null; labelZh: string; labelEn: string }> = [
    { key: null, labelZh: '全部', labelEn: 'ALL' },
    { key: 2, labelZh: '48小时', labelEn: '48H' },
    { key: 7, labelZh: '7天', labelEn: '7D' },
    { key: 90, labelZh: '90天', labelEn: '90D' },
  ];

  return (
    <div className="min-h-screen" style={{ background: 'hsl(var(--background))' }}>
      <PerformanceMonitor onMetrics={(metrics) => console.log('性能指标:', metrics)} />
      <Helmet>
        <title>具身智能大模型新闻</title>
        <meta name="description" content="具身智能与大模型（AI）领域最新新闻资讯聚合：技术动态、产品发布、行业趋势与深度分析。" />
        <link rel="canonical" href="https://news.aipush.fun/" />
        <meta name="robots" content="index,follow" />
        <meta name="googlebot" content="index,follow" />
        <meta name="wxcard:title" content="具身智能大模型新闻" />
        <meta name="wxcard:desc" content="具身智能与大模型（AI）领域最新新闻资讯聚合：技术动态、产品发布、行业趋势与深度分析。" />
        <meta name="wxcard:imgUrl" content={`${window.location.origin}${import.meta.env.BASE_URL}wechat-share-300.png?v=2025080802`} />
        <meta name="wxcard:link" content={window.location.origin} />
        <meta property="og:type" content="website" />
        <meta property="og:url" content={window.location.origin} />
        <meta property="og:title" content="具身智能大模型新闻" />
        <meta property="og:description" content="具身智能与大模型（AI）领域最新新闻资讯聚合：技术动态、产品发布、行业趋势与深度分析。" />
        <meta property="og:image" content={`${window.location.origin}${import.meta.env.BASE_URL}wechat-share-300.png?v=2025080802`} />
        <meta property="og:image:width" content="300" />
        <meta property="og:image:height" content="300" />
        <meta property="og:image:type" content="image/png" />
        <meta property="og:site_name" content="具身智能大模型新闻" />
        <meta property="twitter:card" content="summary_large_image" />
        <meta property="twitter:url" content={window.location.origin} />
        <meta property="twitter:title" content="具身智能大模型新闻" />
        <meta property="twitter:description" content="具身智能与大模型（AI）领域最新新闻资讯聚合：技术动态、产品发布、行业趋势与深度分析。" />
        <meta property="twitter:image" content={`${window.location.origin}${import.meta.env.BASE_URL}wechat-share-300.png?v=2025080802`} />
      </Helmet>

      <div className="min-h-screen" style={{ background: 'hsl(var(--background))' }}>
        <AppHeader onMenuClick={() => setSideMenuOpen(true)} />

        {/* Side Menu */}
        <SideMenu isOpen={sideMenuOpen} onClose={() => setSideMenuOpen(false)} onMenuClick={handleMenuClick} />
        <DailyBriefing isOpen={dailyBriefingOpen} onClose={() => setDailyBriefingOpen(false)} />
        <Disclaimer isOpen={disclaimerOpen} onClose={() => setDisclaimerOpen(false)} />
        <EmailSubscribe isOpen={emailSubscribeOpen} onClose={() => setEmailSubscribeOpen(false)} />

        {/* Main Content */}
        <div className="max-w-[1100px] mx-auto px-4 sm:px-6 pb-20">
          {/* Category Tabs */}
          <div className="pt-4 pb-2">
            <CategoryTabs
              categories={categories}
              activeCategory={selectedCategory}
              onCategoryChange={setSelectedCategory}
            />
          </div>

          {/* 独立三榜动态监测区（与新闻流解耦） */}
          <BenchmarkMonitor />

          {/* 双域精选：固定左具身智能 / 右大模型，各 5 —— 独立展示，不受分类页签筛选影响 */}
          {!error && !loading && (dualFeatured.embodied.length > 0 || dualFeatured.llm.length > 0) && (
            <div className="mt-3">
              <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
                <span style={{ fontFamily: "'DM Mono', monospace", fontSize: '10px', color: 'hsl(var(--muted-foreground))', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                  {isZh ? '关键新闻' : 'KEY NEWS'}
                </span>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-0">
                {/* 左：具身智能 */}
                <div>
                  <div className="flex items-center gap-2 mb-1" style={{ fontSize: '11px', fontWeight: 700 }}>
                    <span className="inline-block w-1.5 h-1.5" style={{ background: '#5C6E4A' }} />
                    {isZh ? '具身智能' : 'EMBODIED'}
                  </div>
                  {dualFeatured.embodied.length > 0 ? (
                    dualFeatured.embodied.map((item, idx) => (
                      <NewsCard key={`feat-emb-${item.id}-${idx}`} {...item} />
                    ))
                  ) : (
                    <p className="text-[11px] py-2" style={{ color: 'hsl(var(--muted-foreground))' }}>
                      {isZh ? '近 7 天无候选，如实留空（未假填）。' : 'No candidates in 7d; left empty honestly.'}
                    </p>
                  )}
                </div>

                {/* 右：大模型 */}
                <div>
                  <div className="flex items-center gap-2 mb-1" style={{ fontSize: '11px', fontWeight: 700 }}>
                    <span className="inline-block w-1.5 h-1.5" style={{ background: '#4A6572' }} />
                    {isZh ? '大模型' : 'LLM'}
                  </div>
                  {dualFeatured.llm.length > 0 ? (
                    dualFeatured.llm.map((item, idx) => (
                      <NewsCard key={`feat-llm-${item.id}-${idx}`} {...item} />
                    ))
                  ) : (
                    <p className="text-[11px] py-2" style={{ color: 'hsl(var(--muted-foreground))' }}>
                      {isZh ? '近 7 天无候选，如实留空（未假填）。' : 'No candidates in 7d; left empty honestly.'}
                    </p>
                  )}
                </div>
              </div>

              {/* 注：metadata.notes / warnings（近 24h 不足 / 模型标识差异等）不在此处渲染，
                  仅保留于后台 featuredMetadata JSON 日志，供运维核查，不在前台展示。 */}
            </div>
          )}

          {/* 筛选栏：来源 / 日期窗口 / 关键词 / 刷新 */}
          {!error && !loading && (
            <div className="flex flex-wrap items-center gap-2 py-3" style={{ borderBottom: '1px solid hsl(var(--border))' }}>
              {/* 来源筛选 */}
              <select
                value={selectedSource}
                onChange={(e) => setSelectedSource(e.target.value)}
                className="px-2 py-1.5 border rounded text-[11px] font-mono"
                style={{ borderColor: 'hsl(var(--border))', background: 'hsl(var(--card))', color: 'hsl(var(--foreground))', fontFamily: "'DM Mono', monospace" }}
              >
                <option value="all">{isZh ? '全部来源' : 'ALL SOURCES'}</option>
                {availableSources.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>

              {/* 日期窗口 */}
              <div className="flex items-center gap-1">
                {WINDOWS.map((w) => {
                  const active = dateWindow === w.key;
                  return (
                    <button
                      key={String(w.key)}
                      onClick={() => setDateWindow(w.key)}
                      className="px-2 py-1.5 border rounded text-[10px] font-mono transition-colors"
                      style={{
                        borderColor: active ? 'hsl(var(--foreground))' : 'hsl(var(--border))',
                        background: active ? 'hsl(var(--foreground))' : 'hsl(var(--card))',
                        color: active ? 'hsl(var(--background))' : 'hsl(var(--muted-foreground))',
                        fontFamily: "'DM Mono', monospace",
                        letterSpacing: '0.04em',
                      }}
                    >
                      {isZh ? w.labelZh : w.labelEn}
                    </button>
                  );
                })}
              </div>

              {/* 关键词 */}
              <input
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                placeholder={isZh ? '关键词搜索…' : 'Search…'}
                className="flex-1 min-w-[140px] px-2 py-1.5 border rounded text-[11px]"
                style={{ borderColor: 'hsl(var(--border))', background: 'hsl(var(--card))', color: 'hsl(var(--foreground))' }}
              />

              {/* 列表排序：重要性（规则，非 AI）/ 最新发布 */}
              <select
                value={sortMode}
                onChange={(e) => setSortMode(e.target.value as 'importance' | 'latest')}
                className="px-2 py-1.5 border rounded text-[11px] font-mono"
                style={{ borderColor: 'hsl(var(--border))', background: 'hsl(var(--card))', color: 'hsl(var(--foreground))', fontFamily: "'DM Mono', monospace" }}
                title={isZh ? '规则排序，非 AI 评分' : 'Rule-based sort, not AI scoring'}
              >
                <option value="importance">{isZh ? '重要性（规则）' : 'IMPORTANCE'}</option>
                <option value="latest">{isZh ? '最新发布' : 'LATEST'}</option>
              </select>

              <button
                onClick={handleRefresh}
                disabled={loading}
                className="flex items-center gap-1.5 px-3 py-1.5 border transition-colors duration-150 hover:bg-foreground hover:text-background disabled:opacity-50"
                style={{
                  fontFamily: "'DM Mono', monospace",
                  fontSize: '10px',
                  letterSpacing: '0.06em',
                  textTransform: 'uppercase',
                  borderColor: 'hsl(var(--border))',
                }}
              >
                <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />
                <span className="hidden sm:inline">{isZh ? '刷新' : 'REFRESH'}</span>
              </button>
            </div>
          )}

          {/* 当前筛选结果计数 */}
          {!error && !loading && (
            <div className="flex items-center justify-between py-2" style={{ fontFamily: "'DM Mono', monospace", fontSize: '10px', color: 'hsl(var(--muted-foreground))', letterSpacing: '0.04em' }}>
              <span>{isZh ? `筛选结果` : 'FILTERED'}: <b style={{ color: 'hsl(var(--foreground))' }}>{filtered.length}</b> / {totalItems}</span>
              {dateWindow != null && <span>{dateWindow === 2 ? (isZh ? '窗口 48小时内' : 'WITHIN 48H') : (isZh ? `窗口 ${dateWindow}天` : `WINDOW ${dateWindow}D`)}</span>}
              <span style={{ opacity: 0.85 }}>
                {sortMode === 'importance'
                  ? isZh ? '· 重要性（规则排序·非 AI）' : '· IMPORTANCE (rule-based, non-AI)'
                  : isZh ? '· 最新发布' : '· LATEST'}
              </span>
            </div>
          )}

          {/* Error State */}
          {error && (
            <div className="flex flex-col items-center justify-center py-16">
              <p className="font-medium mb-1" style={{ color: 'hsl(var(--destructive))' }}>
                {isZh ? '新闻获取失败' : 'Failed to fetch news'}
              </p>
              <p className="text-sm mb-4" style={{ color: 'hsl(var(--muted-foreground))' }}>{error}</p>
              <button
                onClick={handleRefresh}
                disabled={loading}
                className="flex items-center space-x-2 px-4 py-2 rounded-lg transition-colors disabled:opacity-50"
                style={{ background: 'hsl(var(--foreground))', color: 'hsl(var(--card))' }}
              >
                <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
                <span>{isZh ? '重新获取' : 'Retry'}</span>
              </button>
            </div>
          )}

          {/* Loading State */}
          {loading && (
            <div className="flex items-center justify-center py-16">
              <div className="flex items-center space-x-3" style={{ color: 'hsl(var(--muted-foreground))' }}>
                <div className="flex space-x-1">
                  {[0, 1, 2].map((i) => (
                    <span
                      key={i}
                      className="w-1.5 h-1.5 rounded-full animate-pulse"
                      style={{
                        background: '#C44D34',
                        animationDelay: `${i * 0.2}s`
                      }}
                    />
                  ))}
                </div>
                <span className="text-sm">{isZh ? '正在获取最新资讯...' : 'Loading latest AI news...'}</span>
              </div>
            </div>
          )}

          {/* News List - Vertical (分页) */}
          {!loading && !error && pageItems.length > 0 && (
            <div className="mobile-scroll-container">
              {pageItems.map((item, index) => {
                const tier = sortMode === 'importance' ? classifyImportance(item).tier : 'ordinary';
                const showTag = sortMode === 'importance' && tier && tier !== 'ordinary';
                return (
                  <div
                    key={`${item.id}-${index}`}
                    className="animate-fade-in"
                    style={{ animationDelay: `${Math.min(index * 40, 800)}ms` }}
                  >
                    {showTag && (
                      <div className="mb-1 mt-3 first:mt-0">
                        <span
                          className="inline-block rounded px-1.5 py-0.5 text-[10px] font-mono"
                          style={{ background: 'hsl(var(--muted))', color: 'hsl(var(--foreground))' }}
                        >
                          {TIER_LABELS[tier as keyof typeof TIER_LABELS] || tier}
                        </span>
                      </div>
                    )}
                    <NewsCard {...item} />
                  </div>
                );
              })}
            </div>
          )}

          {/* 分页控制 */}
          {!loading && !error && filtered.length > PAGE_SIZE && (
            <div className="flex items-center justify-center gap-4 py-6" style={{ fontFamily: "'DM Mono', monospace", fontSize: '11px', color: 'hsl(var(--muted-foreground))' }}>
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={safePage <= 1}
                className="px-3 py-1.5 border rounded disabled:opacity-40"
                style={{ borderColor: 'hsl(var(--border))', color: 'hsl(var(--foreground))' }}
              >
                {isZh ? '上一页' : 'PREV'}
              </button>
              <span>
                {safePage} / {totalPages}
              </span>
              <button
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={safePage >= totalPages}
                className="px-3 py-1.5 border rounded disabled:opacity-40"
                style={{ borderColor: 'hsl(var(--border))', color: 'hsl(var(--foreground))' }}
              >
                {isZh ? '下一页' : 'NEXT'}
              </button>
            </div>
          )}

          {/* Empty State */}
          {!loading && !error && filtered.length === 0 && (
            <div className="text-center py-16">
              <h3 className="text-lg font-semibold mb-2" style={{ color: 'hsl(var(--foreground))' }}>
                {isZh ? '暂无新闻' : 'No news available'}
              </h3>
              <p style={{ color: 'hsl(var(--muted-foreground))' }}>
                {isZh ? '请调整筛选条件或稍后再试' : 'Try adjusting filters or check later'}
              </p>
            </div>
          )}
        </div>

        {/* Mobile Navigation */}
        <MobileNavigation onMenuClick={() => setSideMenuOpen(true)} currentPath="/" />
        <MobileGestureHint />
      </div>
    </div>
  );
};

export default Index;
