"""
Grok 新闻清洗脚本
在原始新闻源抓取后运行，过滤旧闻 + 优化发布时间
"""
import json, os, sys, time, hashlib, io, re

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

GROK_API_BASE = os.environ.get('GROK_API_BASE', 'https://jiuuij.de5.net/v1')
GROK_API_KEY = os.environ.get('GROK_API_KEY', '')
GROK_MODEL = os.environ.get('GROK_MODEL', 'grok-4.20-multi-agent-xhigh')

NEWS_FILE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'public', 'news-data.json')
VERSION_FILE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'public', 'version.json')

KEYWORDS_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'news-search-keywords.json')

MAX_AGE_DAYS = 3  # 只保留最近3天的新闻
MAX_NEWS = 30      # 最多保留30条


# ---- 共享 matcher 逻辑（与 scripts/news-matcher.js 等价，从同一 JSON 加载）----
def load_keywords():
    with open(KEYWORDS_FILE, 'r', encoding='utf-8') as f:
        return json.load(f)


def _is_ascii(s):
    return all(ord(c) < 128 for c in s)


def _match_term(text, term):
    if _is_ascii(term):
        pat = r'\b' + re.escape(term) + r'\b'
        return re.search(pat, text, re.IGNORECASE) is not None
    return term.lower() in text.lower()


def _match_any(text, terms):
    if not terms:
        return False
    return any(_match_term(text, t) for t in terms)


def is_embodied(text, kw):
    if not text:
        return False
    e = kw['embodied']
    if _match_any(text, e.get('strong')):
        return True
    if _match_any(text, e.get('entities')):
        return True
    # 歧义词需 robotics 上下文锚词
    if _match_any(text, e.get('ambiguous')) and _match_any(text, kw.get('roboticsAnchors')):
        return True
    return False


def is_llm(text, kw):
    if not text:
        return False
    l = kw['llm']
    if _match_any(text, l.get('strong')):
        return True
    if _match_any(text, l.get('entities')):
        return True
    return False


def classify_text(text, kw):
    """返回 '具身智能' / '大模型' / None，与 news-matcher.js 语义一致。"""
    if not text:
        return None
    if is_embodied(text, kw):
        return '具身智能'
    if is_llm(text, kw):
        return '大模型'
    return None

def main():
    print('🧹 Grok 新闻清洗')

    if not os.path.exists(NEWS_FILE):
        print('⚠️ news-data.json 不存在，跳过')
        return

    with open(NEWS_FILE, 'r', encoding='utf-8') as f:
        data = json.load(f)

    items = data.get('data', [])
    if isinstance(data, list):
        items = data
    print(f'📰 原始: {len(items)} 条')

    # 1. 过滤太旧的新闻
    now = time.time()
    cutoff = now - MAX_AGE_DAYS * 86400
    filtered = []
    removed_old = 0
    for item in items:
        try:
            pub = item.get('publishedAt', '')
            if 'T' in pub:
                ts = time.mktime(time.strptime(pub[:19], '%Y-%m-%dT%H:%M:%S'))
            else:
                ts = time.mktime(time.strptime(pub[:10], '%Y-%m-%d'))
            if ts > cutoff:
                filtered.append(item)
            else:
                removed_old += 1
        except:
            filtered.append(item)  # 无法解析日期就保留

    print(f'🗑️  移除 {removed_old} 条超过{MAX_AGE_DAYS}天的旧闻')

    # 2. 去重（按标题相似度）
    seen = set()
    unique = []
    for item in filtered:
        key = item.get('title', '')[:40].lower().strip()
        if key not in seen:
            seen.add(key)
            unique.append(item)
    print(f'📋 去重后: {len(unique)} 条')

    # 3. AI 关键词过滤（基于共享 matcher 的边界 / 上下文逻辑，替代一刀切的大学/游戏/汽车排除）
    kw = load_keywords()
    ai_filtered = []
    removed_non_ai = 0
    for item in unique:
        text = (item.get('title', '') + ' ' + item.get('summary', '') + ' ' + item.get('content', ''))
        cat = classify_text(text, kw)
        if cat:
            # 统一两领域分类（大模型 / 具身智能），消除旧分类残留
            item['category'] = cat
            ai_filtered.append(item)
        else:
            removed_non_ai += 1
    print(f'🤖 AI过滤: 移除 {removed_non_ai} 条非AI内容，保留项统一分类为 大模型/具身智能')

    # 4. 按时间排序
    def get_ts(item):
        try:
            pub = item.get('publishedAt', '')
            return time.mktime(time.strptime(pub[:19], '%Y-%m-%dT%H:%M:%S'))
        except:
            return 0
    ai_filtered.sort(key=get_ts, reverse=True)

    # 5. 限制数量
    ai_filtered = ai_filtered[:MAX_NEWS]
    print(f'✂️  保留前{MAX_NEWS}条')

    # 6. 保存
    output = {
        'success': True,
        'timestamp': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        'total': len(ai_filtered),
        'source': 'multi-api-grok-cleaned',
        'data': ai_filtered,
    }
    os.makedirs(os.path.dirname(NEWS_FILE), exist_ok=True)
    with open(NEWS_FILE, 'w', encoding='utf-8') as f:
        json.dump(output, f, ensure_ascii=False, indent=2)
    print(f'💾 已保存 {len(ai_filtered)} 条')

    # 版本
    ver = {
        'version': '2.1.0',
        'buildTime': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        'lastUpdate': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        'updateInterval': '12小时',
        'source': 'Multi-API + Grok Cleanup',
    }
    with open(VERSION_FILE, 'w', encoding='utf-8') as f:
        json.dump(ver, f, ensure_ascii=False, indent=2)

    print('✅ 清洗完成')

if __name__ == '__main__':
    main()