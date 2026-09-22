import { useEffect, useState } from 'react';
interface NewsItem {
  date: string;
  text: string;
  source: string;
  textZh?: string | null;
  translationStatus?: 'ok' | 'cached' | 'failed' | 'skipped-no-key';
  translationModel?: string | null;
  translationWarnings?: string[];
}
interface NewsReport { status: string; error?: string; source: string; items: NewsItem[] }
export const BenchmarkMonitor = () => {
  const [report, setReport] = useState<NewsReport | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const ctrl = new AbortController();
    fetch(`${import.meta.env.BASE_URL}robodojo-news.json`, { cache: 'no-cache', signal: ctrl.signal })
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(setReport).catch(e => { if (e.name !== 'AbortError') setError(e.message); });
    return () => ctrl.abort();
  }, []);
  const events = [...(report?.items || [])].sort((a,b) => b.date.localeCompare(a.date)).slice(0,5);
  return <section className="my-4 rounded-lg border bg-card p-4" aria-label="RoboDojo官方News">
    <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
      <h2 className="text-sm font-semibold">RoboDojo · News</h2>
      <a className="text-xs text-muted-foreground hover:underline" href="https://robodojo-benchmark.com/leaderboard#news" target="_blank" rel="noreferrer">官网公告 · 最近 5 条 ↗</a>
    </div>
    {(error || report?.status === 'error') && <p className="text-xs text-red-700">更新失败：{error || report?.error}；如有历史公告则保留展示。</p>}
    {!report && !error ? <p className="text-xs text-muted-foreground">加载中…</p> : <ol className="list-none divide-y p-0">
      {Array.from({length:5},(_,i) => {
        const event = events[i];
        if (!event) return <li key={i} className="py-2 text-sm leading-6 break-words"><span className="text-muted-foreground">—：暂无更多官方公告</span></li>;
        const zh = (event.textZh || '').trim();
        const display = zh || event.text;
        return (
          <li key={`${event.date}:${event.text}`} className="py-2 text-sm leading-6 break-words">
            <time dateTime={event.date} className="tabular-nums">{event.date}</time>：
            <span>{display}</span>
            {event.source ? (
              <a
                className="ml-2 inline-block align-middle text-[11px] text-muted-foreground underline underline-offset-2"
                href={event.source}
                target="_blank"
                rel="noreferrer"
              >来源 ↗</a>
            ) : null}
          </li>
        );
      })}
    </ol>}
  </section>;
};
export default BenchmarkMonitor;
