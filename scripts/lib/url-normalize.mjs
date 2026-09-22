// URL 规范化工具：去除跟踪参数与 fragment，保留语义参数；生成去重用的规范键。
// 设计原则（严格遵循授权）：
//  - 仅剥离公认的「跟踪/营销/引流」参数（utm_*/fbclid/gclid/ref/spm/分享参数等），
//    保留对内容定位有意义的语义查询参数（如 id、p、slug、doc、article 等）。
//  - 剥离 fragment（# 锚点多为前端路由/跟踪，不参与内容去重）。
//  - 生成规范 URL 时：小写 host、按字母序重排剩余 query、解码可安全解码的百分号。

const TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id',
  'utm_name', 'utm_reader', 'utm_brand', 'utm_social', 'utm_swu',
  'fbclid', 'gclid', 'gclsrc', 'dclid', 'msclkid', 'mc_cid', 'mc_eid',
  'ref', 'ref_src', 'ref_url', 'ref_', 'spm', 'scid', 'share_', 'sharefrom',
  'igshid', 'twclid', 'feature', 'ns_mchannel', 'ns_campaign', 'ns_source',
  'ns_linkname', 'ns_fee', 'ns_', 'cmpid', 'gdftrk', 'hmb_campaign',
  'hmb_medium', 'hmb_source', 'mkt_tok', 'aki_uid', 'icid', 'vero_id',
  'wprd', 'wprl', 'from', 'scene', 'campaign', 'cn', 'ch', 'position',
  'amp', 'amp_', 'smid', 'snrw', 'snsr', 'xtor', 'yclid', 'trk', 'tracking',
]);

export function stripTrackingParams(url) {
  if (!url || typeof url !== 'string') return url || '';
  let u;
  try {
    u = new URL(url);
  } catch {
    // 非标准 URL（如相对路径 / 无 scheme），仅做字符串级剥离
    return stripTrackingStringFallback(url);
  }
  // 移除 fragment
  u.hash = '';
  // 过滤跟踪参数
  const toDelete = [];
  u.searchParams.forEach((_v, key) => {
    const k = key.toLowerCase();
    if (TRACKING_PARAMS.has(k)) {
      toDelete.push(key);
    } else if ([...TRACKING_PARAMS].some((t) => t.endsWith('_') && k.startsWith(t))) {
      // 前缀型跟踪参数（ref_ / ns_ / amp_ / share_ / utm_ 等）
      toDelete.push(key);
    }
  });
  toDelete.forEach((k) => u.searchParams.delete(k));
  // 规范化：小写 host、去除默认端口、按 key 字母序重排
  u.host = u.host.toLowerCase();
  if ((u.protocol === 'https:' && u.port === '443') || (u.protocol === 'http:' && u.port === '80')) {
    u.port = '';
  }
  const sorted = new URLSearchParams([...u.searchParams.entries()].sort((a, b) => a[0].localeCompare(b[0])));
  u.search = sorted.toString();
  return u.toString();
}

function stripTrackingStringFallback(url) {
  // 去掉 # 之后，再去掉已知跟踪 query 参数
  let s = url.split('#')[0];
  const qIdx = s.indexOf('?');
  if (qIdx === -1) return s;
  const base = s.slice(0, qIdx);
  const params = s.slice(qIdx + 1).split('&').filter((pair) => {
    const k = (pair.split('=')[0] || '').toLowerCase();
    if (!k) return true;
    if (TRACKING_PARAMS.has(k)) return false;
    if ([...TRACKING_PARAMS].some((t) => t.endsWith('_') && k.startsWith(t))) return false;
    return true;
  });
  return params.length ? `${base}?${params.join('&')}` : base;
}

// 去重规范键：优先用规范 URL，否则用规范标题。
export function canonicalUrlKey(url) {
  const clean = stripTrackingParams(url);
  if (!clean) return null;
  return 'u:' + clean.toLowerCase();
}

export function canonicalTitleKey(title) {
  if (!title) return null;
  // 去首尾空白、折叠空白、去除常见标点与全半角差异，转小写
  const t = title
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[‘’`'""''「」『』()（）\[\]【】{}<>《》、，。.,!！?？:：;；·\-_|｜/\\]/g, '')
    .toLowerCase();
  if (!t) return null;
  return 't:' + t.slice(0, 120);
}

// 规范 URL（保留语义参数、去跟踪、去 fragment），用于展示与跨源同项判定。
export function cleanUrl(url) {
  return stripTrackingParams(url);
}
