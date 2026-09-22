// 离线 fixture 测试：覆盖首跑 / 次跑无变化 / 模型新增 / 分数变化 /
// 源失败保留快照 / 跨日时间语义 / 来源确认日期 / unknown 不当 0。
// 不触网：所有数据源由注入的 fetchImpl 返回 fixture。

import fs from 'fs';
import os from 'os';
import path from 'path';
import { runMonitor } from './benchmark-monitor.mjs';
import { diffBoard, buildNewsItems, mergeNewsIntoData } from './lib/benchmark-diff.mjs';
import { BOARDS } from './config/benchmark-monitor.config.mjs';

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) {
    passed++;
    process.stderr.write(`  PASS ${msg}\n`);
  } else {
    failed++;
    process.stderr.write(`  FAIL ${msg}\n`);
  }
}

// ---- fixture 构造 ----
function baseState() {
  return {
    robodojoFail: false,
    robodojo: {
      generatedAt: '2026-09-20T00:00:00.000Z',
      real: { A: [] },
      sim: { A: [], B: [], C: [] },
    },
    livebenchCsv:
      'model,overall,math,code\n' +
      'm1,42,10,20\n' +
      'm2,80,30,40\n',
    vla: {
      last_updated: '2026-08-10',
      results: [
        { model: 'x', display_name: 'X', overall_score: 1.0, benchmark: 'b1' },
        { model: 'y', display_name: 'Y', overall_score: 2.0, benchmark: 'b2' },
      ],
    },
  };
}

function makeFetch(state) {
  return async (url) => {
    if (state.robodojoFail && url.includes('rolloutManifest')) {
      return { ok: false, status: 500, text: async () => '' };
    }
    if (url.includes('/table_') && url.endsWith('.csv')) {
      return { ok: true, status: 200, text: async () => state.livebenchCsv };
    }
    if (url.includes('rolloutManifest')) {
      return { ok: true, status: 200, text: async () => JSON.stringify(state.robodojo) };
    }
    if (url.includes('leaderboard.json')) {
      return { ok: true, status: 200, text: async () => JSON.stringify(state.vla) };
    }
    return { ok: false, status: 404, text: async () => '' };
  };
}

async function main() {
  // ===== 场景1：首跑（基线） =====
  process.stderr.write('\n[场景1] 首次运行建立基线\n');
  {
    const s = baseState();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bmtest-'));
    const rep = await runMonitor({
      fetchImpl: makeFetch(s),
      now: new Date('2026-09-21T02:00:00Z'),
      publicDir: dir,
      snapshotFile: path.join(dir, 'snapshot.json'),
      updatesFile: path.join(dir, 'updates.json'),
      historyDir: path.join(dir, 'history'),
      newsDataFile: path.join(dir, 'news.json'),
      mergeNews: false,
      quiet: true,
      liveBenchVersion: '2026-06-25',
    });
    assert(rep.run.firstRun === true, '首次运行 firstRun=true');
    assert(rep.boards.robodojo.status === 'baseline', 'robodojo 状态=基线');
    assert(rep.boards.livebench.status === 'baseline', 'livebench 状态=基线');
    assert(rep.boards.vla.status === 'baseline', 'vla 状态=基线');
    assert(rep.boards.robodojo.modelCount === 3, 'robodojo 模型数=3 (A/B/C union)');
    assert(rep.boards.livebench.modelCount === 2, 'livebench 模型数=2');
    assert(rep.boards.vla.modelCount === 2, 'vla 模型数=2');
    // LiveBench 取官方 overall 列(42)，而非各列均值 (42+10+20)/3=24
    const m1 = rep.boards.livebench.models.find((m) => m.name === 'm1');
    assert(m1.score === 42, 'livebench 使用 overall 列(42) 而非各列均值(24)');
    assert(JSON.stringify(m1.metrics) === JSON.stringify({ overall: 42, math: 10, code: 20 }), 'livebench 保留各分项 metrics');
    assert(rep.boards.robodojo.newModels.length === 0, '基线不产生「今日新增」');
    assert(rep.news.generated === 0, '基线不生成新闻');
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ===== 场景2：次跑无变化 =====
  process.stderr.write('\n[场景2] 第二次运行（无变化）\n');
  {
    const s = baseState();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bmtest-'));
    const common = {
      fetchImpl: makeFetch(s),
      publicDir: dir,
      snapshotFile: path.join(dir, 'snapshot.json'),
      updatesFile: path.join(dir, 'updates.json'),
      historyDir: path.join(dir, 'history'),
      newsDataFile: path.join(dir, 'news.json'),
      mergeNews: false,
      quiet: true,
      liveBenchVersion: '2026-06-25',
    };
    await runMonitor({ ...common, now: new Date('2026-09-21T02:00:00Z') });
    const rep2 = await runMonitor({ ...common, now: new Date('2026-09-21T03:00:00Z') });
    assert(rep2.run.firstRun === false, '非首次运行');
    assert(rep2.boards.robodojo.status === 'no_change', 'robodojo 状态=无变化');
    assert(rep2.boards.livebench.status === 'no_change', 'livebench 状态=无变化');
    assert(rep2.boards.robodojo.newModels.length === 0, '无新增模型');
    assert(rep2.news.generated === 0, '无新闻生成');
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ===== 场景3：模型新增 + 分数变化 =====
  process.stderr.write('\n[场景3] 模型新增与分数变化\n');
  {
    const s = baseState();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bmtest-'));
    const common = {
      fetchImpl: makeFetch(s),
      publicDir: dir,
      snapshotFile: path.join(dir, 'snapshot.json'),
      updatesFile: path.join(dir, 'updates.json'),
      historyDir: path.join(dir, 'history'),
      newsDataFile: path.join(dir, 'news.json'),
      mergeNews: false,
      quiet: true,
      liveBenchVersion: '2026-06-25',
    };
    await runMonitor({ ...common, now: new Date('2026-09-21T02:00:00Z') });
    // 修改：robodojo 新增 D；livebench m1 的官方 overall 分数 42->55
    s.robodojo.sim.D = [];
    s.livebenchCsv = 'model,overall,math,code\nm1,55,15,25\nm2,80,30,40\n';
    const rep = await runMonitor({ ...common, now: new Date('2026-09-21T03:00:00Z') });
    assert(rep.boards.robodojo.status === 'updated', 'robodojo 状态=已更新');
    const d = rep.boards.robodojo.newModels.find((m) => m.name === 'D');
    assert(!!d, 'robodojo 检测到新增模型 D');
    assert(d && d.discoveryType === 'observation_window', 'D 为观测窗口新增（无来源日期）');
    const sc = rep.boards.livebench.scoreChanges.find((m) => m.name === 'm1');
    assert(!!sc && sc.oldScore === 42 && sc.newScore === 55, 'livebench m1 官方 overall 分数变化 42->55');
    assert(rep.news.generated >= 1, '生成了新增新闻条目');
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ===== 场景4：源失败保留快照、不推断删除 =====
  process.stderr.write('\n[场景4] 源失败保留快照\n');
  {
    const s = baseState();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bmtest-'));
    const common = {
      fetchImpl: makeFetch(s),
      publicDir: dir,
      snapshotFile: path.join(dir, 'snapshot.json'),
      updatesFile: path.join(dir, 'updates.json'),
      historyDir: path.join(dir, 'history'),
      newsDataFile: path.join(dir, 'news.json'),
      mergeNews: false,
      quiet: true,
      liveBenchVersion: '2026-06-25',
    };
    await runMonitor({ ...common, now: new Date('2026-09-21T02:00:00Z') });
    // 令 robodojo 源失败
    s.robodojoFail = true;
    const rep = await runMonitor({ ...common, now: new Date('2026-09-21T03:00:00Z') });
    assert(rep.boards.robodojo.status === 'error', 'robodojo 状态=失败');
    assert(rep.boards.robodojo.modelCount === 3, '失败时仍展示保留的模型数(3)');
    assert(rep.boards.robodojo.preservedModelCount === 3, 'preservedModelCount=3');
    assert(rep.boards.robodojo.newModels.length === 0, '失败不产生新增（不臆造）');
    // 快照未被覆盖
    const snap = JSON.parse(fs.readFileSync(path.join(dir, 'snapshot.json'), 'utf8'));
    assert(snap.boards.robodojo && snap.boards.robodojo.modelCount === 3, '快照中 robodojo 仍为 3 个模型（未丢失）');
    assert(rep.boards.livebench.status === 'no_change', '另一榜不受影响仍为无变化');
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ===== 场景5：跨日时间语义（不能断言今日） =====
  process.stderr.write('\n[场景5] 跨观测窗口（跨日）不断言今日\n');
  {
    const s = baseState();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bmtest-'));
    const common = {
      fetchImpl: makeFetch(s),
      publicDir: dir,
      snapshotFile: path.join(dir, 'snapshot.json'),
      updatesFile: path.join(dir, 'updates.json'),
      historyDir: path.join(dir, 'history'),
      newsDataFile: path.join(dir, 'news.json'),
      mergeNews: false,
      quiet: true,
      liveBenchVersion: '2026-06-25',
    };
    // 第一天（北京时间 09-21）建立基线
    await runMonitor({ ...common, now: new Date('2026-09-21T02:00:00Z') });
    // 第二天（北京时间 09-22）新增模型 D
    s.robodojo.sim.D = [];
    const rep = await runMonitor({ ...common, now: new Date('2026-09-22T02:00:00Z') });
    const d = rep.boards.robodojo.newModels.find((m) => m.name === 'D');
    assert(!!d, '检测到新增模型 D');
    assert(d.assertedToday === false, '跨日：assertedToday=false（不断言今日）');
    assert(d.discoveryType === 'observation_window', '跨日：discoveryType=observation_window');
    assert(/自 2026-09-21 观测以来/.test(d.note), '跨日：note 标明自上次观测以来');
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ===== 场景6：单位级时间语义 + unknown 不当 0 =====
  process.stderr.write('\n[场景6] 单位：来源确认日期 / 同日观测窗口 / unknown 不当 0\n');
  {
    const prev = {
      models: [
        { id: 'robodojo::a', rawId: 'A', name: 'A', org: null, score: null, scoreAvailable: false },
        { id: 'livebench::m1', rawId: 'm1', name: 'm1', org: null, score: 10, scoreAvailable: true },
      ],
    };
    // 6a 来源确认新增日期=今日
    const today = '2026-09-21';
    const currA = {
      scrapeTime: '2026-09-21T03:00:00Z',
      models: [
        { id: 'robodojo::a', rawId: 'A', name: 'A', org: null, score: null, scoreAvailable: false },
        { id: 'robodojo::n', rawId: 'N', name: 'N', org: null, score: null, scoreAvailable: false, dateAdded: '2026-09-21T00:00:00Z' },
      ],
    };
    const dA = diffBoard(prev, currA, { lastObsDate: '2026-09-21', todayDate: today });
    const nA = dA.newModels.find((m) => m.name === 'N');
    assert(dA.status === 'updated', '6a 状态=updated');
    assert(nA.sourceConfirmedDate && nA.discoveryType === 'source_confirmed', '6a 标 sourceConfirmedDate');
    assert(nA.assertedToday === true, '6a 来源确认今日 → assertedToday=true');

    // 6b 同日观测窗口（无来源日期）→ assertedToday=true
    const currB = {
      scrapeTime: '2026-09-21T03:00:00Z',
      models: [
        { id: 'robodojo::a', rawId: 'A', name: 'A', org: null, score: null, scoreAvailable: false },
        { id: 'robodojo::n', rawId: 'N', name: 'N', org: null, score: null, scoreAvailable: false },
      ],
    };
    const dB = diffBoard(prev, currB, { lastObsDate: '2026-09-21', todayDate: today });
    const nB = dB.newModels.find((m) => m.name === 'N');
    assert(nB.assertedToday === true, '6b 同日观测窗口 → assertedToday=true');
    assert(nB.discoveryType === 'observation_window', '6b discoveryType=observation_window');

    // 6c unknown 分数不参与变化判断（robodojo 分数始终 unknown）
    assert(dA.scoreChanges.length === 0, '6c 未知分数不触发分数变化');
    // 6d livebench 分数变化正常检测
    const currD = {
      scrapeTime: '2026-09-21T03:00:00Z',
      models: [
        { id: 'robodojo::a', rawId: 'A', name: 'A', org: null, score: null, scoreAvailable: false },
        { id: 'livebench::m1', rawId: 'm1', name: 'm1', org: null, score: 99, scoreAvailable: true },
      ],
    };
    const dD = diffBoard(prev, currD, { lastObsDate: '2026-09-21', todayDate: today });
    assert(dD.scoreChanges.length === 1 && dD.scoreChanges[0].newScore === 99, '6d livebench 分数变化 10->99 被捕获');
  }

  // ===== 场景7：新闻合并去重（保留旧数据） =====
  process.stderr.write('\n[场景7] 新闻合并 URL/id 去重，保留旧数据\n');
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bmtest-'));
    const newsPath = path.join(dir, 'news-data.json');
    const existingItem = {
      id: 'bench_robodojo_D_2026-09-21',
      title: '旧条目',
      summary: '已存在',
      content: '已存在',
      imageUrl: null,
      source: 'x',
      publishedAt: '2026-09-21T00:00:00Z',
      category: '具身智能',
      originalUrl: 'https://robodojo-benchmark.com/leaderboard',
      language: 'zh',
      needsTranslation: false,
      aiInsight: null,
    };
    fs.writeFileSync(newsPath, JSON.stringify({ success: true, total: 1, data: [existingItem] }));
    const newItems = [
      // 与 existingItem 同 id → 应被去重
      { ...existingItem, title: '新但同id' },
      // 不同 id/url → 应加入
      {
        id: 'bench_robodojo_E_2026-09-21',
        title: '新增 E',
        summary: 's',
        content: 'c',
        imageUrl: null,
        source: 'RoboDojo',
        publishedAt: '2026-09-21T03:00:00Z',
        category: '具身智能',
        originalUrl: 'https://robodojo-benchmark.com/leaderboard/model/E',
        language: 'zh',
        needsTranslation: false,
        aiInsight: null,
      },
    ];
    const r = mergeNewsIntoData(newItems, newsPath);
    const after = JSON.parse(fs.readFileSync(newsPath, 'utf8'));
    assert(r.added === 1, '仅 1 条新条目被加入（同 id 去重）');
    assert(after.data.length === 2, '合并后共 2 条');
    assert(after.data.some((x) => x.id === 'bench_robodojo_D_2026-09-21' && x.title === '旧条目'), '旧数据被保留');
    fs.rmSync(dir, { recursive: true, force: true });
  }

  process.stderr.write(`\n==== 测试结果：PASS=${passed} FAIL=${failed} ====\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  process.stderr.write('测试异常: ' + (e?.stack || e) + '\n');
  process.exit(1);
});
