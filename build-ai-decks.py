"""
把 xiaolinnote.com/ai/ 的 91 道大模型面试题并进记忆卡，并把过宽的
「LLM · AI · Agent · Eval」拆成六副。

规矩跟上一批一致：
  · 只搬**题目**和**出处链接**，正文一个字都不抄；
  · 背面是「先自己答 → 点链接对照」的占位，答案随后由人/agent 原创补写；
  · 跟现有卡近似重复的题丢掉。

源站每一页就是一道题（页面标题即题目），所以不需要抽页内小标题。
"""
import json, io, os, re, unicodedata

OUT = os.path.join('seed', 'decks')
SRC_DECK = os.path.join(OUT, '06-llm-ai-eval.json')


def norm(s):
    s = unicodedata.normalize('NFKC', s).lower()
    return re.sub(r'[\s?？。，,.、：:（）()「」"\'’“”…—\-_/\\]+', '', s)


def toks(s):
    n = norm(s)
    return set(n[i:i + 2] for i in range(len(n) - 1)) or {n}


def strip_no(t):
    """去掉源站标题前面的编号：`12. 什么是…` → `什么是…`"""
    return re.sub(r'^\d+[.、．]\s*', '', t).strip()


SEC_LABEL = {'agent': 'Agent 面试专题', 'rag': 'RAG 面试专题',
             'tools': 'LLM 工具调用面试专题', 'llm': '大模型工程面试专题',
             'langchain': 'LangChain 框架面试专题'}


def back_of(sec, url):
    return (
        '先自己答一遍，再点开原文对照 ——\n\n'
        f'[小林面试笔记 · {SEC_LABEL[sec]}]({url})\n\n'
        '> 本站只收录了**题目与出处链接**，答案没有抄过来。\n'
        '> 这张卡的答案待补：想清楚之后用自己的话写回这里，才算真的会了。'
    )


# ---------- 现有 33 张按主题分桶 ----------
def bucket_existing(t):
    s = norm(t)
    if any(k in s for k in ('eval', '评测', '评估', '打分', 'judge', '标注', '金标准',
                            'goldendataset', '回归检测', '指标')):
        return 'eval'
    if any(k in s for k in ('rag', '检索', '切分', 'chunk', '重排', 'rerank', 'embedding',
                            '向量', '余弦', '相似度')):
        return 'rag'
    if 'agent' in s:
        return 'agent'
    if any(k in s for k in ('mcp', 'toolcalling', '函数调用')):
        return 'tools'
    if 'langchain' in s:
        return 'langchain'
    return 'llm'


SUBS = [
    ('06a-llm-engineering.json', '大模型基础与工程', 'llm',
     '大模型自身的原理与工程落地：注意力与解码策略、微调与对齐（SFT/DPO/PPO）、量化与推理加速、部署方案选型、上下文与成本、幻觉成因与治理、结构化输出、安全与合规、灰度与降级。'),
    ('06b-rag.json', 'RAG 检索增强', 'rag',
     '从原始文档到最终答案的每一环：切分、embedding 与向量检索、关键词与多路召回、Query 改写、重排、上下文组装，以及检索质量与生成质量为什么必须分开评。'),
    ('06c-agent.json', 'Agent', 'agent',
     'Agent 的组成与工作流：ReAct 与各种设计范式、任务拆解、记忆与记忆压缩、反思、多 Agent 协作与单多之争，以及 Agent 系统最容易崩在哪里。'),
    ('06d-tool-calling-mcp.json', '工具调用与 MCP', 'tools',
     'Function Calling、Skill、MCP、A2A 之间到底什么关系；MCP 的通信方式与工程接入；工具调用的可靠性、鉴权与失败处理。'),
    ('06e-langchain.json', 'LangChain 框架', 'langchain',
     'LangChain 的核心抽象（Chain、Agent、Memory、Tool）与架构理解、用它搭 Agent 的步骤、Deep Research 类应用的实现逻辑，以及框架与手搓的取舍。'),
    ('06f-llm-eval.json', 'LLM 评测 Eval', 'eval',
     '这一副是 SDET 视角、源站没有的部分：金标准集怎么建、标注一致性、离线与在线 eval 的分工、LLM-as-judge 的适用边界与已知偏差、prompt/模型变更的回归检测。'),
]

src = json.load(io.open(SRC_DECK, encoding='utf-8'))
old_by = {}
for c in src['cards']:
    old_by.setdefault(bucket_existing(c['front']), []).append(c)

ai = json.load(io.open('ai-index.json', encoding='utf-8'))
new_by = {}
for r in ai:
    new_by.setdefault(r['sec'], []).append(r)

print(f"{'牌组':<22}{'原有':>5}{'新增':>5}{'丢重':>5}{'合计':>6}")
print('-' * 45)
tot = 0
for fname, name, key, desc in SUBS:
    olds = old_by.get(key, [])
    ex = [toks(c['front']) for c in olds]
    cards, dropped, seen = [], 0, set()
    for r in new_by.get(key, []):
        q = strip_no(r['title'])
        tq = toks(q)
        if norm(q) in seen or any(len(tq & e) / max(1, min(len(tq), len(e))) > 0.62 for e in ex):
            dropped += 1
            continue
        seen.add(norm(q))
        cards.append({'front': q, 'back': back_of(r['sec'], r['url'])})
    deck = {'name': name, 'description': desc, 'dailyNewLimit': 12, 'cards': olds + cards}
    io.open(os.path.join(OUT, fname), 'w', encoding='utf-8').write(
        json.dumps(deck, ensure_ascii=False, indent=2) + '\n')
    tot += len(deck['cards'])
    print(f"{name:<22}{len(olds):>5}{len(cards):>5}{dropped:>5}{len(deck['cards']):>6}")

print('-' * 45)
print(f"{'合计':<22}{len(src['cards']):>5}{'':>5}{'':>5}{tot:>6}")
print('\n旧文件 06-llm-ai-eval.json 需要移走')
