// 离线测试（无依赖，仅 node:test + node:assert）：不发起真实网络请求、不读密钥。
// 覆盖语义去重核心场景：
//   - 多文章事件被合并
//   - 不同模型版本不合并（mock 让模型判定为不同事件）
//   - 非法/invalid id 被忽略；模型未返回 id 补 singleton
//   - 合并代表保留最完整来源 summary 与多来源 links
//   - 缓存命中（内容+model+endpoint 相同 → 不二次调用 LLM）
//   - API 失败 → 明确 dedupeStatus='fallback'，保留独立报道，不声称语义成功
//   - 不足 5 个独立事件时不虚构补位
//
// 运行（managed node）：
//   /Users/cooperxu/.workbuddy/binaries/node/versions/22.22.2-3/bin/node --test scripts/dedupe.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  loadLLMConfig,
  dedupeEvents,
  validateDedupeResponse,
  buildDedupeCacheKey,
  mergeCluster,
  rankDomain,
} from './featured-ranker.mjs';

const NOW = new Date('2026-09-21T12:00:00.000Z');
const HOUR = 3600_000;

// 构造单域候选（用于 rankDomain）
function mk(id, category, title, summary, ageHours, extra = {}) {
  return {
    id,
    title,
    summary: summary || '',
    category,
    publishedAt: new Date(NOW.getTime() - ageHours * HOUR).toISOString(),
    sources: [{ platform: '聚合', media: `媒体-${id}`, url: `https://example.com/${id}` }],
    ...extra,
  };
}

// 可控 mock fetch：根据 system 提示区分「评分」与「去重」，并可让去重返回指定 groups 或抛错。
function makeMock({ dedupeGroups, throwDedupe = false, scoreHandler, onCall } = {}) {
  return async function mockFetch(url, opts) {
    const messages = opts?.body ? JSON.parse(opts.body).messages : [];
    const sys = messages.find((m) => m.role === 'system')?.content || '';
    const isDedupe = sys.includes('新闻事件聚类器');
    if (onCall) onCall(isDedupe);
    if (isDedupe) {
      if (throwDedupe) throw new Error('mock LLM 去重网络错误');
      const content = JSON.stringify({ groups: dedupeGroups });
      return { ok: true, status: 200, text: async () => '', json: async () => ({ model: 'glm-5.1-mini', choices: [{ message: { content } }] }) };
    }
    // 评分路径
    let scores;
    if (scoreHandler) scores = scoreHandler(messages);
    else {
      const ids = (messages.find((m) => m.role === 'user')?.content || '').match(/ITEM\s*({[^}]*})/g) || [];
      scores = ids.map((s, i) => {
        const obj = JSON.parse(s.replace(/^ITEM\s*/, ''));
        return { id: obj.id, importance: 80 - i * 5, eventType: 'industry', reason: 'x' };
      });
    }
    const content = JSON.stringify({ scores });
    return { ok: true, status: 200, text: async () => '', json: async () => ({ model: 'glm-5.1-mini', choices: [{ message: { content } }] }) };
  };
}

// ---------------- 1) 多文章事件被合并 ----------------
test('同一事件的多篇报道被合并为一个独立事件', async () => {
  const items = [
    mk('a', '大模型', 'Qwen-Image 2.1 发布', '阿里发布 Qwen-Image 2.1，主打图像生成。', 2),
    mk('b', '大模型', 'Qwen-Image 2.1 上线', '据多家媒体，Qwen-Image 2.1 已正式上线可用。', 3),
    mk('c', '大模型', 'Qwen-Image 2.1 开放', 'Qwen-Image 2.1 面向开发者开放 API。', 4),
  ];
  const cfg = loadLLMConfig({ LLM_API_KEY: 'sk-test', LLM_MODEL: 'glm-5.1-mini' });
  const r = await dedupeEvents(items, {
    cfg,
    fetchImpl: makeMock({ dedupeGroups: [['a', 'b', 'c']] }),
    now: NOW,
    cache: {},
  });
  assert.equal(r.dedupeStatus, 'semantic');
  assert.equal(r.clusters, 1);
  assert.equal(r.merges, 1);
  assert.equal(r.mergedItems, 2); // 3 篇 → 合并掉 2 篇
  assert.equal(r.representatives.length, 1);
  assert.deepEqual(r.representatives[0].mergedIds.sort(), ['a', 'b', 'c']);
});

// ---------------- 2) 不同模型版本不合并（mock 让模型判定为不同事件） ----------------
test('模型判定为不同事件（如不同版本）时不合并', async () => {
  const items = [
    mk('v25', '大模型', 'Qwen-Image 2.5 发布', 'Qwen-Image 2.5 发布。', 2),
    mk('v30', '大模型', 'Qwen-Image 3.0 发布', 'Qwen-Image 3.0 发布。', 3),
  ];
  const cfg = loadLLMConfig({ LLM_API_KEY: 'sk-test', LLM_MODEL: 'glm-5.1-mini' });
  const r = await dedupeEvents(items, {
    cfg,
    fetchImpl: makeMock({ dedupeGroups: [['v25'], ['v30']] }), // 模型明确分两个事件
    now: NOW,
    cache: {},
  });
  assert.equal(r.dedupeStatus, 'semantic');
  assert.equal(r.clusters, 2);
  assert.equal(r.merges, 0);
  assert.equal(r.representatives.length, 2);
});

// ---------------- 3) invalid / 未知 id 被忽略；未返回 id 补 singleton ----------------
test('校验：非法 id 忽略，模型未返回的候选补为 singleton', () => {
  const ids = new Set(['a', 'b']);
  const v = validateDedupeResponse({ groups: [['a', 'b'], ['ghost']] }, ids); // ghost 不存在
  assert.equal(v.ok, true);
  // ghost 被丢弃；a、b 在同一个有效组
  assert.equal(v.groups.length, 1);
  assert.deepEqual(v.groups[0].sort(), ['a', 'b']);

  // 模型完全不返回某 id → 补 singleton
  const v2 = validateDedupeResponse({ groups: [['a']] }, ids);
  assert.deepEqual(v2.groups.map((g) => g[0]).sort(), ['a', 'b']);
});

test('同一 id 在多个组中只保留首次出现（严格每 id<=1）', () => {
  const ids = new Set(['a', 'b']);
  const v = validateDedupeResponse({ groups: [['a'], ['a', 'b']] }, ids);
  const flat = v.groups.flat();
  assert.equal(flat.filter((x) => x === 'a').length, 1);
  assert.equal(flat.filter((x) => x === 'b').length, 1);
});

// ---------------- 4) 合并代表保留最完整来源 summary 与多来源 links ----------------
test('合并代表：保留最完整摘要 + 最高 importance + 多来源 links + mergedIds', async () => {
  const items = [
    mk('x', '大模型', 'Helix 2.5 发布', '短摘要', 2, { importance: 60 }),
    mk('y', '大模型', 'Helix 2.5 详情', '这是一条明显更完整、更详细的来源摘要内容，涵盖发布要点。', 3, { importance: 90 }),
  ];
  const rep = mergeCluster(items, ['x', 'y']);
  assert.equal(rep.summary, '这是一条明显更完整、更详细的来源摘要内容，涵盖发布要点。'); // 最长摘要胜出
  assert.equal(rep.importance, 90); // 最高 importance（anchor）
  assert.equal(rep.mergedIds.length, 2);
  assert.equal(rep.sources.length, 2); // 多来源 links 合并
  // anchor 取 importance 最高者 → y
  assert.equal(rep.id, 'y');
});

// ---------------- 5) 缓存命中：相同内容+model+endpoint 不二次调用 ----------------
test('内容+model+endpoint 命中缓存后不再调用 LLM', async () => {
  const items = [
    mk('a', '大模型', '事件A报道一', '摘要A1', 2),
    mk('b', '大模型', '事件A报道二', '摘要A2', 3),
  ];
  const cfg = loadLLMConfig({ LLM_API_KEY: 'sk-test', LLM_MODEL: 'glm-5.1-mini' });
  const cache = {};
  let dedupeCalls = 0;
  const fetchImpl = makeMock({ dedupeGroups: [['a', 'b']], onCall: (isD) => { if (isD) dedupeCalls++; } });

  const r1 = await dedupeEvents(items, { cfg, fetchImpl, now: NOW, cache });
  assert.equal(dedupeCalls, 1);
  const r2 = await dedupeEvents(items, { cfg, fetchImpl, now: NOW, cache }); // 同一 cache 对象
  assert.equal(dedupeCalls, 1, '缓存命中不应再次调用 LLM');
  assert.equal(r2.dedupeStatus, 'semantic');
  assert.deepEqual(r2.representatives[0].mergedIds.sort(), ['a', 'b']);

  // 内容变化 → 缓存键不同 → 再次调用
  const items2 = [...items, mk('c', '大模型', '事件B', '摘要B', 4)];
  await dedupeEvents(items2, { cfg, fetchImpl, now: NOW, cache });
  assert.equal(dedupeCalls, 2);
});

test('buildDedupeCacheKey 仅依赖内容+model+endpoint（确定、随输入变化）', () => {
  const items = [mk('a', '大模型', '标题', '摘要', 1)];
  const cfg = loadLLMConfig({ LLM_API_KEY: 'sk-test', LLM_MODEL: 'glm-5.1-mini', LLM_BASE_URL: 'http://h1/v1' });
  const k1 = buildDedupeCacheKey(items, cfg.model, 'h1');
  const k2 = buildDedupeCacheKey(items, cfg.model, 'h1');
  assert.equal(k1, k2);
  const k3 = buildDedupeCacheKey(items, 'other-model', 'h1');
  assert.notEqual(k1, k3);
  const items3 = [mk('a', '大模型', '标题改', '摘要', 1)];
  assert.notEqual(k1, buildDedupeCacheKey(items3, cfg.model, 'h1'));
});

// ---------------- 6) API 失败 → 明确 fallback，保留独立报道，不声称语义成功 ----------------
test('去重 API 失败时 dedupeStatus=fallback，保留全部独立报道且不合并', async () => {
  const items = [
    mk('a', '大模型', '事件A', '摘要A', 2),
    mk('b', '大模型', '事件A另一篇', '摘要B', 3),
  ];
  const cfg = loadLLMConfig({ LLM_API_KEY: 'sk-test', LLM_MODEL: 'glm-5.1-mini' });
  const r = await dedupeEvents(items, {
    cfg,
    fetchImpl: makeMock({ throwDedupe: true }),
    now: NOW,
    cache: {},
  });
  assert.equal(r.dedupeStatus, 'fallback');
  assert.equal(r.merges, 0);
  assert.equal(r.mergedItems, 0);
  assert.equal(r.representatives.length, 2, '失败时应保留原始报道，不做合并');
  assert.ok(r.fallbackReason && r.fallbackReason.includes('失败'));
});

test('无 LLM_API_KEY 时 dedupeStatus=skipped-no-key，不做任何合并', async () => {
  const items = [
    mk('a', '大模型', '事件A', '摘要A', 2),
    mk('b', '大模型', '事件A另一篇', '摘要B', 3),
  ];
  const cfg = loadLLMConfig({ LLM_API_KEY: '' });
  const r = await dedupeEvents(items, { cfg, fetchImpl: makeMock({}), now: NOW, cache: {} });
  assert.equal(r.dedupeStatus, 'skipped-no-key');
  assert.equal(r.representatives.length, 2);
});

// ---------------- 7) 不足 5 个独立事件时，rankDomain 不虚构补位 ----------------
test('rankDomain：去重后不足 5 个独立事件，如实保留，不虚构', async () => {
  // 仅 3 条候选（且分属不同事件），AI 评分 + 去重后应为 3 条
  const items = [
    mk('a', '大模型', '新闻一', '摘要一', 1, { importance: 80 }),
    mk('b', '大模型', '新闻二', '摘要二', 2, { importance: 70 }),
    mk('c', '大模型', '新闻三', '摘要三', 3, { importance: 60 }),
  ];
  const cfg = loadLLMConfig({ LLM_API_KEY: 'sk-test', LLM_MODEL: 'glm-5.1-mini' });
  const fetchImpl = makeMock({ dedupeGroups: [['a'], ['b'], ['c']] });
  const wf = {
    withinWindow: (pub, days, now = NOW) => {
      const d = new Date(pub).getTime();
      if (isNaN(d)) return false;
      const diff = now.getTime() - d;
      return diff >= 0 && diff <= days * 86400000;
    },
  };
  const r = await rankDomain(items, { domainKey: 'llm', cfg, now: NOW, windowFns: wf, fetchImpl, n: 5, cache: {} });
  assert.equal(r.dedupeStatus, 'semantic');
  assert.equal(r.items.length, 3, '不足 5 不应虚构补位');
  // 同时校验评分阶段也走了 AI（usedAI=true），且 items 携带 importance
  assert.equal(r.usedAI, true);
  assert.ok(r.items.every((it) => typeof it.importance === 'number'));
});
