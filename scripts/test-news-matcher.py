#!/usr/bin/env python3
# 离线测试：验证 grok-cleanup.py 中共享 matcher 的边界/上下文逻辑（仅标准库）
# 覆盖：中国/英文 LLM、VLA、VLN、大学机器人研究、无关手机新闻、
#      ACT 单独、VLN 单独（预期 None）、含 AI 子串的普通英文、PI 单独、Google 单独、
#      泛词(训练/导航/模型)单独、旧历史非相关被过滤。

import sys
import os
import importlib.util

HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("grok_cleanup_mod", os.path.join(HERE, "grok-cleanup.py"))
grok = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(grok)

classify_text = grok.classify_text
KW = grok.load_keywords()


def make_cases():
    return [
        ("中国LLM(智谱GLM大模型)", "智谱AI发布GLM-4.5大模型，支持超长上下文", "", "大模型"),
        ("英文LLM(OpenAI GPT-5)", "OpenAI launches GPT-5 with improved reasoning capabilities", "", "大模型"),
        ("英文LLM(DeepSeek)", "DeepSeek open sources new reasoning model", "", "大模型"),
        ("VLA(英文)", "Researchers propose a new VLA for bimanual manipulation", "", "具身智能"),
        ("VLN(英文)", "VLN benchmark improves vision-language navigation on indoor scenes", "", "具身智能"),
        ("大学机器人研究(Stanford robot learning)", "Stanford team develops robot learning method for dexterous grasping", "", "具身智能"),
        ("无关手机新闻", "新款智能手机发布，电池续航提升30%", "", None),
        ("ACT单独(考试)", "ACT exam scores released for high school students", "", None),
        ("ACT+robotics上下文", "ACT: a new action-chunking policy for robot manipulation", "", "具身智能"),
        ("VLN单独", "VLN reaches new SOTA on indoor navigation tasks", "", None),
        ("含AI子串普通英文(train)", "The train arrived at the railway station on time", "", None),
        ("PI单独(导师)", "The PI (principal investigator) leads the new lab", "", None),
        ("中文具身(宇树人形机器人)", "宇树发布新一代人形机器人，支持端到端操控", "", "具身智能"),
        ("中文VLA", "视觉语言动作模型VLA取得新的研究进展", "", "具身智能"),
        ("CALVIN无上下文(人名)", "CALVIN is a popular baby name in the region", "", None),
        ("CALVIN+robotics上下文", "CALVIN benchmark advances robot learning for manipulation", "", "具身智能"),
        ("Google单独(搜索引擎)", "Google 发布新版搜索引擎功能", "", None),
        ("泛词(训练导航模型)", "新训练方法提升导航模型精度", "", None),
    ]


def filter_records(records):
    return [r for r in records if classify_text(r["title"] + " " + r.get("content", ""), KW)]


def main():
    cases = make_cases()
    pass_count = 0
    fail_count = 0

    print("=== matcher 分类测试 (Python) ===")
    for name, title, content, expected in cases:
        actual = classify_text(title + " " + content, KW)
        ok = actual == expected
        if ok:
            pass_count += 1
        else:
            fail_count += 1
        print(f"{'✅' if ok else '❌'} {name}: 实际={actual} 期望={expected}")

    print("\n=== 历史非相关记录过滤测试 ===")
    history = [
        {"title": "新款手机发布，续航大幅提升", "content": "普通消费电子新闻"},
        {"title": "OpenAI 发布 GPT-5，推理能力增强", "content": "大模型新闻"},
        {"title": "某大学开设通识教育课程", "content": "与AI无关"},
    ]
    kept = filter_records(history)
    history_ok = len(kept) == 1 and "GPT-5" in kept[0]["title"]
    if history_ok:
        pass_count += 1
    else:
        fail_count += 1
    print(f"{'✅' if history_ok else '❌'} 历史过滤: 保留 {len(kept)} 条（期望 1），被过滤={len(history) - len(kept)}")
    for r in history:
        mark = "保留" if r in kept else "剔除"
        print(f"   {mark} | {r['title']}")

    print(f"\n=== 汇总: 通过 {pass_count}，失败 {fail_count} ===")
    sys.exit(1 if fail_count > 0 else 0)


if __name__ == "__main__":
    main()
