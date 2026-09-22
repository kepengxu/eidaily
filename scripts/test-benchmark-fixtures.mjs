// 基于真实结构 fixture 的离线测试：验证
//  - 所有模型ID均为字符串、唯一、无 "[object Object]" 等错误聚合
//  - VLA：按稳定字符串 slug 去重，模型数=去重后唯一 slug 数（非评测记录数），
//         跨异构 benchmark 不取均值（保存分项 metrics，score=null）
//  - LiveBench：动态发现版本；CSV 无 overall 列时不造总分（score=null，保留各分项）；
//         CSV 有 overall 列时使用官方总分
//  - RoboDojo：real/sim 键确为模型，并集计数，附带监测范围说明
// 不触网：数据源由注入 fetchImpl 返回 fixture。

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { FETCHERS, discoverLiveBenchVersions } from './lib/benchmark-sources.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(__dirname, 'fixtures');
const read = (f) => fs.readFileSync(path.join(FIX, f), 'utf8');

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

// ---- fixture 注入 fetchImpl ----
function makeFetch({ vla, livebenchCsv, liveBenchVersion, homeHtml, homeBundle }) {
  return async (url) => {
    if (url.includes('leaderboard.json') || url.includes('rolloutManifest')) return { ok: true, status: 200, text: async () => vla };
    if (url.endsWith('.js')) return { ok: true, status: 200, text: async () => homeBundle };
    if (url.includes('/table_') && url.endsWith('.csv'))
      return { ok: true, status: 200, text: async () => livebenchCsv };
    if (url.includes('livebench.ai')) return { ok: true, status: 200, text: async () => homeHtml };
    return { ok: false, status: 404, text: async () => '' };
  };
}

async function main() {
  // ===== VLA：稳定字符串ID + 按 benchmark 分项 + 禁止跨 benchmark 均值 =====
  process.stderr.write('\n[VLA] 真实结构解析\n');
  {
    const vla = read('vla-leaderboard.json');
    const res = await FETCHERS.vla(
      { id: 'vla', source: 'https://example/leaderboard.json', timeoutMs: 5000 },
      { fetchImpl: makeFetch({ vla }) }
    );
    assert(res.status === 'ok', 'VLA 解析成功');

    // 1) 模型ID 全部为字符串、唯一、无 [object Object]
    const ids = res.models.map((m) => m.id);
    assert(ids.every((id) => typeof id === 'string'), '所有模型ID为字符串');
    assert(new Set(ids).size === ids.length, '模型ID唯一，无重复');
    assert(!ids.some((id) => id.includes('[object')), '不存在 [object Object] 错误ID');
    // 2) 模型数 = 去重后唯一 slug 数（4：susie/rt1/octo/NoModelField；对象 model 记录被跳过）
    assert(res.modelCount === 4, `VLA 模型数=去重slug数(4)，实际=${res.modelCount}`);
    // 3) 跨 benchmark 不取均值：susie 在 calvin(2.94) 与 libero(75.3)，score 必须 null
    const susie = res.models.find((m) => m.rawId === 'susie__ghilglue');
    assert(susie.score === null && susie.scoreAvailable === false, 'VLA 不产出跨 benchmark 总分（score=null）');
    assert(
      JSON.stringify(susie.metrics) === JSON.stringify({ calvin: 2.94, libero: 75.3 }),
      'susie 分项 metrics 按 benchmark 保存（calvin/libero），未均值'
    );
    assert(susie.benchmarks.length === 2, 'susie 参与 2 个 benchmark');
    // 4) 缺 overall_score 的记录：benchmark 仍计入，metric 为 null
    const octo = res.models.find((m) => m.rawId === 'octo__base');
    assert(octo && octo.metrics.libero === null, 'octo 缺 overall_score → metric 置 null（不臆造）');
    // 5) 缺 model 字段、回退 name_in_paper 的记录被正常收录
    const nomf = res.models.find((m) => m.rawId === 'NoModelField');
    assert(!!nomf, 'name_in_paper 回退记录被收录');
    // 6) 对象 model 字段被跳过（不污染聚合）
    assert(!res.models.some((m) => m.rawId === '[object Object]'), '非字符串 model 记录被跳过');
  }

  // ===== LiveBench：动态发现版本 =====
  process.stderr.write('\n[LiveBench] 动态版本发现\n');
  {
    const homeHtml = read('livebench-home.html');
    const homeBundle = read('livebench-main.js');
    const board = { id: 'livebench', base: 'https://livebench.ai', homepage: 'https://livebench.ai/', timeoutMs: 5000 };
    const versions = await discoverLiveBenchVersions(board, {
      fetchImpl: makeFetch({ homeHtml, homeBundle }),
    });
    assert(Array.isArray(versions) && versions.length === 11, `发现 11 个版本，实际=${versions?.length}`);
    assert(versions.includes('2024-06-24'), '首版哨兵 2024-06-24 存在');
    assert(versions[versions.length - 1] === '2026-06-25', '最新版本为 2026-06-25');
    // 动态发现失败应抛错（主页无 bundle 引用）
    let threw = false;
    try {
      await discoverLiveBenchVersions(board, { fetchImpl: makeFetch({ homeHtml: '<html></html>', homeBundle: '' }) });
    } catch {
      threw = true;
    }
    assert(threw, '主页无 bundle 引用时明确抛出版本发现失败');
  }

  // ===== LiveBench：CSV 无 overall 列 → 不造总分 =====
  process.stderr.write('\n[LiveBench] CSV 无 overall 列（保留分项，不造总分）\n');
  {
    const csv = read('livebench-table-no-overall.csv');
    const res = await FETCHERS.livebench(
      { id: 'livebench', base: 'https://livebench.ai', homepage: 'https://livebench.ai/', timeoutMs: 5000 },
      { fetchImpl: makeFetch({ livebenchCsv: csv }), liveBenchVersion: '2026-06-25' }
    );
    assert(res.status === 'ok', 'LiveBench 解析成功');
    assert(res.modelCount === 2, `LiveBench 模型数=行数(2)，实际=${res.modelCount}`);
    const m1 = res.models.find((m) => m.name === 'claude-opus');
    assert(m1.score === null && m1.scoreAvailable === false, '无 overall 列 → 不造总分（score=null）');
    assert(JSON.stringify(m1.metrics) === JSON.stringify({ math: 99.0, code: 80.4, reasoning: 88.1 }), '各分项 metrics 被保留');
    assert(res.versionSource === 'override', '版本来源标记为 override');
    assert(res.stale === false, '非降级');
  }

  // ===== LiveBench：CSV 有 overall 列 → 使用官方总分 =====
  process.stderr.write('\n[LiveBench] CSV 有 overall 列（使用官方总分）\n');
  {
    const csv = read('livebench-table-with-overall.csv');
    const res = await FETCHERS.livebench(
      { id: 'livebench', base: 'https://livebench.ai', homepage: 'https://livebench.ai/', timeoutMs: 5000 },
      { fetchImpl: makeFetch({ livebenchCsv: csv }), liveBenchVersion: '2026-06-25' }
    );
    const m1 = res.models.find((m) => m.name === 'claude-opus');
    assert(m1.score === 90.5, `使用官方 overall 列(90.5)，实际=${m1.score}（非各列均值 ${(99 + 80.4 + 88.1) / 3}）`);
    assert(m1.scoreAvailable === true, 'overall 存在 → scoreAvailable=true');
    assert(JSON.stringify(m1.metrics) === JSON.stringify({ overall: 90.5, math: 99.0, code: 80.4, reasoning: 88.1 }), '分项含 overall');
  }

  // ===== RoboDojo：real/sim 键为模型 + 监测范围 =====
  process.stderr.write('\n[RoboDojo] real/sim 键为模型 + 范围说明\n');
  {
    const manifest = read('robodojo-manifest.json');
    const res = await FETCHERS.robodojo(
      { id: 'robodojo', source: 'https://example/rolloutManifest.generated.json', timeoutMs: 5000 },
      { fetchImpl: makeFetch({ vla: manifest }) }
    );
    assert(res.status === 'ok', 'RoboDojo 解析成功');
    assert(res.modelCount === 3, `RoboDojo 模型数=real∪sim(3)，实际=${res.modelCount}`);
    assert(res.models.every((m) => typeof m.id === 'string'), 'RoboDojo 模型ID均为字符串');
    assert(new Set(res.models.map((m) => m.id)).size === res.models.length, 'RoboDojo ID唯一');
    const rt1 = res.models.find((m) => m.rawId === 'RT1');
    assert(rt1 && rt1.domains.sort().join() === 'real,sim', 'RT1 同时出现在 real 与 sim');
    assert(typeof res.scope === 'string' && res.scope.length > 0, '附带监测范围说明');
  }

  process.stderr.write(`\n==== fixture 测试：PASS=${passed} FAIL=${failed} ====\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  process.stderr.write('测试异常: ' + (e?.stack || e) + '\n');
  process.exit(1);
});
