// 离线测试（无依赖，仅 node:test + node:assert）：不发起真实网络、不读密钥。
// 覆盖：缓存命中不调 fetch、失败保留原文、模型名/数字校验警告、prompt 约束、id 稳定。
//
// 运行（managed node）：
//   /Users/cooperxu/.workbuddy/binaries/node/versions/22.22.2-3/bin/node --test scripts/robodojo-translate.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  translateRoboDojoItems,
  makeRoboDojoId,
  buildTranslateCacheKey,
  validateModelTokensPreserved,
  TRANSLATE_SYSTEM_PROMPT,
} from './robodojo-translate.mjs';

// 注入用 LLM 配置（apiKey 占位，测试内用 mock fetchImpl，不真正联网）
function cfg(enabled = true) {
  return {
    baseUrl: 'http://example.test/v1/chat/completions',
    model: 'glm-5.1-mini',
    apiKey: enabled ? 'test-key' : '',
    enabled,
  };
}

const ITEMS = [
  { date: '2026-09-21', text: 'Add SimpleMemVLA to the sim leaderboard (12.58 / 9.27%, contributed by SimpleMemVLA Team).', source: 'x#news' },
  { date: '2026-09-20', text: 'Add KinRT to the sim leaderboard (13.02 / 8.80%, contributed by IIGroup).', source: 'x#news' },
];

// ---------------- 1) 缓存命中：不调用 fetch，textZh 来自缓存 ----------------
test('缓存全命中时不调用 fetchImpl，textZh 来自缓存且 status=cached', async () => {
  const cache = {};
  for (const it of ITEMS) {
    const key = buildTranslateCacheKey(it.text, cfg().model);
    cache[key] = { textZh: `译文::${it.text.slice(0, 6)}`, model: cfg().model, warnings: [], ts: new Date().toISOString() };
  }
  let called = 0;
  const fetchImpl = async () => { called++; throw new Error('不应被调用'); };

  const res = await translateRoboDojoItems(ITEMS, { cfg: cfg(), fetchImpl, cache });
  assert.equal(called, 0, 'fetchImpl 不应被调用');
  assert.equal(res.calledLLM, false);
  assert.equal(res.items.length, 2);
  for (const r of res.items) {
    assert.equal(r.translationStatus, 'cached');
    assert.ok(r.textZh && r.textZh.startsWith('译文::'), '应来自缓存');
    assert.equal(r.text, ITEMS.find((i) => i.text === r.text).text, '原文 text 不变');
  }
});

// ---------------- 2) 失败：保留原文，textZh=null，status=failed ----------------
test('fetchImpl 抛错时保留原文：textZh=null, status=failed', async () => {
  const fetchImpl = async () => { throw new Error('network down'); };
  const res = await translateRoboDojoItems(ITEMS, { cfg: cfg(), fetchImpl, cache: {} });
  assert.equal(res.calledLLM, true);
  assert.equal(res.anyFailed, true);
  for (const r of res.items) {
    assert.equal(r.textZh, null, '失败应保留原文（无译文）');
    assert.equal(r.translationStatus, 'failed');
    assert.ok(r.translationWarnings.length > 0, '应给出失败原因');
    // 原文不被破坏
    assert.ok(ITEMS.some((i) => i.text === r.text && i.date === r.date));
  }
});

// ---------------- 3) 模型名/数字校验：译文遗漏数字 → 警告 ----------------
test('validateModelTokensPreserved：译文遗漏百分比/版本数字时给出警告', () => {
  const original = 'Add SimpleMemVLA (12.58 / 9.27%) to the leaderboard.';
  const ok = '将 SimpleMemVLA（12.58 / 9.27%）加入榜单。';
  const bad = '将 SimpleMemVLA 加入榜单。'; // 丢了数字
  assert.deepEqual(validateModelTokensPreserved(original, ok), [], '保留数字应无警告');
  const warns = validateModelTokensPreserved(original, bad);
  assert.ok(warns.length > 0, '遗漏数字应给出警告');
  assert.ok(warns.some((w) => w.includes('12.58') || w.includes('9.27')), '警告应指向丢失的数字');
});

test('翻译返回中遗漏某条 id → 该条 failed 且保留原文', async () => {
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({
      model: 'glm-5.1-mini',
      choices: [{ message: { content: JSON.stringify({ translations: [{ id: makeRoboDojoId(ITEMS[0].date, ITEMS[0].text), textZh: '第一条译文' }] }) } }],
    }),
  });
  const res = await translateRoboDojoItems(ITEMS, { cfg: cfg(), fetchImpl, cache: {} });
  const id0 = makeRoboDojoId(ITEMS[0].date, ITEMS[0].text);
  const id1 = makeRoboDojoId(ITEMS[1].date, ITEMS[1].text);
  const first = res.items.find((r) => r.id === id0);
  const second = res.items.find((r) => r.id === id1);
  assert.equal(first.textZh, '第一条译文');
  assert.equal(second.textZh, null, '模型漏返回的条目应 failed 保留原文');
  assert.equal(second.translationStatus, 'failed');
});

// ---------------- 4) prompt 约束：模型名/数字原样保留 + id 非空防漏项 ----------------
test('翻译系统提示包含：模型名/数字原样保留、忽略嵌入指令、严格返回 id/译文', () => {
  const p = TRANSLATE_SYSTEM_PROMPT;
  assert.ok(p.includes('模型名'), '应要求保留模型名');
  assert.ok(p.includes('数字') || p.includes('百分比'), '应要求保留数字/百分比');
  assert.ok(p.includes('忽略'), '应要求忽略嵌入指令');
  assert.ok(p.includes('id'), '应要求返回 id');
  assert.ok(p.includes('不得增删'), '应要求不增删 id（防重复/漏项）');
  assert.ok(p.includes('textZh'), '应要求返回 textZh');
});

// ---------------- 5) id 稳定 & 缓存键含 text+model+promptVersion ----------------
test('makeRoboDojoId 稳定；buildTranslateCacheKey 含 text+model+promptVersion', () => {
  const a = makeRoboDojoId('2026-09-21', ITEMS[0].text);
  const b = makeRoboDojoId('2026-09-21', ITEMS[0].text);
  assert.equal(a, b, '同 date+text 应稳定');
  assert.notEqual(makeRoboDojoId('2026-09-21', 'x'), makeRoboDojoId('2026-09-21', 'y'));

  const k1 = buildTranslateCacheKey('hello', 'glm-5.1-mini');
  const k2 = buildTranslateCacheKey('hello', 'glm-5.1-mini');
  const k3 = buildTranslateCacheKey('hello', 'other-model');
  const k4 = buildTranslateCacheKey('world', 'glm-5.1-mini');
  assert.equal(k1, k2);
  assert.notEqual(k1, k3, 'model 不同应不同键');
  assert.notEqual(k1, k4, 'text 不同应不同键');
  assert.ok(k1.includes('glm-5.1-mini'), '键应包含 model');
});

// ---------------- 6) 无 key：skipped-no-key，保留原文 ----------------
test('无 LLM_API_KEY 时 skipped-no-key，不调用 fetch，保留原文', async () => {
  let called = 0;
  const fetchImpl = async () => { called++; throw new Error('不应调用'); };
  const res = await translateRoboDojoItems(ITEMS, { cfg: cfg(false), fetchImpl });
  assert.equal(called, 0);
  for (const r of res.items) {
    assert.equal(r.translationStatus, 'skipped-no-key');
    assert.equal(r.textZh, null);
  }
});
