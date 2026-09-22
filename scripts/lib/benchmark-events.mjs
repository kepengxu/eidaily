// Preserve observed events between runs; dates describe observations, not model release dates.
export function attachBenchmarkEvents(report, previous = null) {
  for (const [id, board] of Object.entries(report.boards || {})) {
    const at = board.scrapeTime || report.generatedAt;
    const candidates = [];
    const add = (key, text) => candidates.push({ id: `${id}:${at}:${key}`, at, text });
    for (const m of board.newModels || []) add(`new:${m.id}`, `新收录 ${m.name}（监测发现，非发布日期）`);
    for (const m of board.scoreChanges || []) add(`score:${m.id}`, `${m.name} 分数由 ${m.oldScore} 更新为 ${m.newScore}`);
    if (board.status === 'baseline') add('baseline', `建立监测基线，收录 ${board.modelCount} 个模型标识；暂不能判断此前新增`);
    if (board.status === 'no_change') add('no_change', '完成查询，较上次有效快照未发现变化');
    if (board.status === 'error') add('error', `查询失败：${board.error || '未知错误'}；保留上次有效快照`);
    const old = previous?.boards?.[id]?.events || [];
    board.events = [...new Map([...old, ...candidates].map(e => [e.id, e])).values()]
      .filter(e => Number.isFinite(Date.parse(e.at)))
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || a.id.localeCompare(b.id))
      .slice(0, 100);
  }
  return report;
}
