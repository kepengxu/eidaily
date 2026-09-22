import { Bookmark, BookmarkCheck, Layers, Globe } from "lucide-react";
import { useNewsTranslation } from "@/hooks/useNewsTranslation";
import { Link } from "react-router-dom";
import { useEffect, useState } from "react";
import { NewsItem } from "@/types/news";

interface NewsCardProps extends Partial<NewsItem> {
  className?: string;
}

// 分类色：大模型(钢蓝) / 具身智能(苔绿) / 其他(fun 灰紫)
const CAT_STYLES: Record<string, { dot: string; bg: string; text: string }> = {
  llm:     { dot: '#4A6572', bg: 'rgba(74,101,114,0.06)', text: '#4A6572' },
  embodied: { dot: '#5C6E4A', bg: 'rgba(92,110,74,0.06)', text: '#5C6E4A' },
  cn:   { dot: '#B8612E', bg: 'rgba(184,97,46,0.06)', text: '#B8612E' },
  intl: { dot: '#4A6572', bg: 'rgba(74,101,114,0.06)', text: '#4A6572' },
  tech: { dot: '#5C6E4A', bg: 'rgba(92,110,74,0.06)', text: '#5C6E4A' },
  fun:  { dot: '#8B6B84', bg: 'rgba(139,107,132,0.06)', text: '#8B6B84' },
};

function getCatKey(cat: string): string {
  const c = (cat || '').toLowerCase();
  if (c.includes('大模型') || c.includes('llm') || c.includes('model')) return 'llm';
  if (c.includes('具身') || c.includes('embodied') || c.includes('robot')) return 'embodied';
  if (c.includes('中国') || c.includes('国内') || c.includes('china')) return 'cn';
  if (c.includes('国际') || c.includes('国外') || c.includes('international')) return 'intl';
  if (c.includes('科技') || c.includes('tech')) return 'tech';
  return 'fun';
}

function formatTime(timestamp: string): string {
  try {
    const date = new Date(timestamp);
    if (isNaN(date.getTime())) return '';
    const diff = Math.abs(Date.now() - date.getTime());
    const mins = Math.floor(diff / 60000);
    const hrs = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);
    if (mins < 60) return `${mins}m`;
    if (hrs < 24) return `${hrs}h`;
    return `${days}d`;
  } catch { return ''; }
}

export const NewsCard = ({
  id,
  title = '',
  summary = '',
  source = '',
  publishedAt = '',
  category = '',
  className = "",
  titleZh = '',
  sources,
  needsTranslation,
  language,
  mediaName,
  upstreamPlatform,
}: NewsCardProps) => {
  const { getLocalizedCategory } = useNewsTranslation();
  const [isBookmarked, setIsBookmarked] = useState(false);
  const catKey = getCatKey(category);
  const catStyle = CAT_STYLES[catKey] || CAT_STYLES.fun;

  // 主标题优先用已有中文标题（不伪造），否则用原文。
  const primaryTitle = titleZh && titleZh.trim() ? titleZh.trim() : (title || '').trim();
  const originalTitle = (title || '').trim();
  const showOriginal = titleZh && titleZh.trim() && originalTitle && originalTitle !== titleZh.trim();

  // 真实摘要（来源提供才保留）；空摘要明确标注「标题信息不足，暂无摘要」，绝不编造。
  // 仅当摘要非空且与标题不同（非把标题当摘要）时展示，避免隐藏来源提供的真实短摘要。
  const sTrim = (summary || '').trim();
  const tTrim = (title || '').trim();
  const hasSummary = !!sTrim; // 保留来源提供的所有非空摘要，不因与标题相似而隐藏。

  // 多来源（跨源同项合并）
  const multiSources = Array.isArray(sources) ? sources : null;
  const sourceCount = multiSources ? multiSources.length : 0;

  // 未翻译英文标识（保留，不声称已翻译）
  const isUntranslatedEn = needsTranslation === true || (language === 'en' && !titleZh);

  useEffect(() => {
    try {
      const bookmarks = localStorage.getItem('bookmarked-news');
      if (bookmarks) {
        const list = JSON.parse(bookmarks);
        setIsBookmarked(Array.isArray(list) && list.some((item: any) => item.id === id));
      }
    } catch {}
  }, [id]);

  const handleBookmark = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      const bookmarks = localStorage.getItem('bookmarked-news');
      let list = bookmarks ? JSON.parse(bookmarks) : [];
      if (!Array.isArray(list)) list = [];
      if (isBookmarked) {
        list = list.filter((item: any) => item.id !== id);
        setIsBookmarked(false);
      } else {
        list.unshift({ id, title: primaryTitle, summary, imageUrl: '', source, publishedAt, category });
        setIsBookmarked(true);
      }
      localStorage.setItem('bookmarked-news', JSON.stringify(list));
    } catch {}
  };

  return (
    <Link to={`/news/${id}`} className="block group">
      <article className={`${className}`} style={{
        padding: '16px 0',
        borderBottom: '1px solid hsl(var(--border))',
      }}>
        {/* Meta row: category dot + source + time + 跨源标记 + 未翻译标识 */}
        <div className="flex items-center gap-2 mb-2 flex-wrap">
          <span className="inline-flex items-center gap-1.5" style={{
            fontSize: '10px',
            fontFamily: "'DM Mono', monospace",
            fontWeight: 500,
            letterSpacing: '0.06em',
            color: catStyle.text,
            textTransform: 'uppercase',
          }}>
            <span style={{
              display: 'inline-block',
              width: 7, height: 7,
              background: catStyle.dot,
            }} />
            {getLocalizedCategory(category)}
          </span>
          <span style={{ color: 'hsl(var(--border))', fontSize: '10px' }}>|</span>
          <span className="text-[10px] font-mono tracking-wider uppercase text-muted-foreground"
            style={{ fontFamily: "'DM Mono', monospace" }}>
            {mediaName || source}
          </span>
          <span className="text-[10px] font-mono text-muted-foreground"
            style={{ fontFamily: "'DM Mono', monospace" }}>
            {formatTime(publishedAt)}
          </span>
          {sourceCount > 1 && (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full" style={{
              fontSize: '9px', fontFamily: "'DM Mono', monospace",
              background: 'rgba(196,77,52,0.10)', color: '#C44D34', letterSpacing: '0.04em',
            }}>
              <Layers className="w-2.5 h-2.5" /> {sourceCount} 来源
            </span>
          )}
          {isUntranslatedEn && (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full" style={{
              fontSize: '9px', fontFamily: "'DM Mono', monospace",
              background: 'rgba(74,101,114,0.10)', color: '#4A6572', letterSpacing: '0.04em',
            }}>
              <Globe className="w-2.5 h-2.5" /> 未翻译·EN
            </span>
          )}
        </div>

        {/* Title - serif（优先中文标题，保留原文署名） */}
        <h2 className="text-base sm:text-lg font-serif font-bold leading-snug line-clamp-2 mb-1.5"
          style={{ fontFamily: "'Noto Serif SC', 'Georgia', serif", letterSpacing: '-0.01em' }}>
          {primaryTitle || '（无标题）'}
        </h2>

        {/* 原文标题（仅当与中文标题不同且有英文时展示，保留出处） */}
        {showOriginal && (
          <p className="text-[11px] leading-snug line-clamp-1 mb-1.5" style={{ color: 'hsl(var(--muted-foreground))', fontStyle: 'italic' }}>
            {originalTitle}
          </p>
        )}

        {/* Summary：真实摘要 或 明确「无摘要」（不编造） */}
        {hasSummary ? (
          <p className="text-[13px] leading-relaxed line-clamp-2 text-muted-foreground"
            style={{ fontFamily: "'Noto Sans SC', sans-serif" }}>
            {summary}
          </p>
        ) : (
          <p className="text-[12px] leading-relaxed line-clamp-1" style={{ color: 'hsl(var(--muted-foreground))', opacity: 0.7 }}>
            标题信息不足，暂无摘要
          </p>
        )}

        {/* 来源署名（上游平台 / 媒体） */}
        {upstreamPlatform && (
          <p className="text-[10px] mt-1.5" style={{ color: 'hsl(var(--muted-foreground))', fontFamily: "'DM Mono', monospace", letterSpacing: '0.04em' }}>
            来源：{upstreamPlatform}{mediaName ? ` · ${mediaName}` : ''}
          </p>
        )}

        {/* Actions (hover) */}
        <div className="flex items-center gap-3 mt-2 opacity-0 group-hover:opacity-100 transition-opacity duration-200">
          <button
            onClick={handleBookmark}
            className="flex items-center gap-1 text-[10px] font-mono tracking-wider uppercase transition-colors"
            style={{
              fontFamily: "'DM Mono', monospace",
              color: isBookmarked ? '#C44D34' : 'hsl(var(--muted-foreground))'
            }}
          >
            {isBookmarked ? <BookmarkCheck className="w-3 h-3" /> : <Bookmark className="w-3 h-3" />}
            <span className="hidden sm:inline">{isBookmarked ? '已收藏' : '收藏'}</span>
          </button>
          {sourceCount > 1 && (
            <span className="text-[10px] font-mono tracking-wider uppercase text-muted-foreground"
              style={{ fontFamily: "'DM Mono', monospace" }}>
              跨源合并 · {multiSources!.map((s) => s.media || s.platform || '?').join(' / ')}
            </span>
          )}
        </div>
      </article>
    </Link>
  );
};
