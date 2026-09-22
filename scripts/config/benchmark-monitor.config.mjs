// 基准监测配置：三榜数据源、超时、分类映射、版本候选。
// 均为公开数据源；无密钥。解析逻辑优先使用真实结构化数据（JSON / CSV），
// 不使用臆造的 DOM 选择器。

export const BOARDS = {
  robodojo: {
    id: 'robodojo',
    name: 'RoboDojo',
    // 用于页面与新闻展示的名称
    displayName: 'RoboDojo 机器人操作榜单',
    // 真实结构化数据源（rollout manifest 的 real/sim 顶层键即模型标识集合）
    source: 'https://robodojo-benchmark.com/data/rolloutManifest.generated.json',
    // 人类可读的榜单页（作为 news originalUrl / 证据 URL）
    evidence: 'https://robodojo-benchmark.com/leaderboard',
    category: '具身智能',
    timeoutMs: 60000,
    // 该源仅提供模型集合与整体 generatedAt，无逐模型发布日期
    hasPerModelDate: false,
  },
  livebench: {
    id: 'livebench',
    name: 'LiveBench',
    displayName: 'LiveBench 大模型榜单',
    // 版本不再由本地硬编码列表决定：每次运行从官方主页 JS bundle 动态发现（见
    // benchmark-sources.mjs 的 discoverLiveBenchVersions）。下面 versionList 仅作文档/
    // 紧急回退参考，解析逻辑不会把它当作「最新」去默默声称。
    homepage: 'https://livebench.ai/',
    versionList: [
      '2024-06-24',
      '2024-07-26',
      '2024-08-31',
      '2024-11-25',
      '2025-04-02',
      '2025-04-25',
      '2025-05-30',
      '2025-11-25',
      '2025-12-23',
      '2026-01-08',
      '2026-06-25',
    ],
    base: 'https://livebench.ai',
    evidence: 'https://livebench.ai/',
    category: '大模型',
    timeoutMs: 30000,
    hasPerModelDate: false,
  },
  vla: {
    id: 'vla',
    name: 'VLA Leaderboard',
    displayName: 'VLA 模型榜单 (AllenAI)',
    source: 'https://allenai.github.io/vla-evaluation-harness/leaderboard/leaderboard.json',
    evidence: 'https://allenai.github.io/vla-evaluation-harness/leaderboard/',
    category: '具身智能',
    timeoutMs: 60000,
    hasPerModelDate: false,
  },
};

// 监测运行参数
export const SETTINGS = {
  // 单次运行生成新闻条目上限（防止月度大批量更新时淹没新闻流）。
  // 超出部分仍计入「新增收录」统计，但仅前 N 条写入 news-data.json，并在报告中注明。
  maxNewsPerRun: 50,
  // 是否将真实新增写入 news-data.json（merge 时按 URL/id 去重，保留旧数据）
  mergeNews: true,
};

// 榜单展示顺序
export const BOARD_ORDER = ['robodojo', 'livebench', 'vla'];
