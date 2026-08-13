"""把各批核对结果汇总成一份差异清单。

产物只有一个 markdown 报告，落在项目根目录，供人工判定。
**不改动任何卡片** —— 改不改、怎么改，由人看完报告再决定。
"""
import json, io, os, glob
from collections import Counter

FD = 'C:/Users/lrhto/AppData/Local/Temp/compare/findings'
BD = 'C:/Users/lrhto/AppData/Local/Temp/compare/batches'
REPORT = 'card-audit-report.md'

KIND_CN = {
    'contradiction': '与原文冲突',
    'error': '我们写错了',
    'offtopic': '答非所问',
    'missing-key': '漏了必答点',
    'source-wrong': '原文有问题（我们对）',
}
SEV_ORDER = {'high': 0, 'medium': 1, 'low': 2}

done, missing, all_f = [], [], []
for i in range(1, 25):
    p = os.path.join(FD, f'b{i:02d}.json')
    b = os.path.join(BD, f'b{i:02d}.json')
    if not os.path.exists(p):
        missing.append(f'b{i:02d}')
        continue
    try:
        fs = json.load(io.open(p, encoding='utf-8'))
    except Exception as e:
        missing.append(f'b{i:02d}(解析失败 {e})')
        continue
    done.append(f'b{i:02d}')
    for f in fs:
        f['_batch'] = f'b{i:02d}'
        all_f.append(f)

n_cards = sum(len(json.load(io.open(os.path.join(BD, f'{b}.json'), encoding='utf-8')))
              for b in done)

kinds = Counter(f.get('kind', '?') for f in all_f)
sevs = Counter(f.get('severity', '?') for f in all_f)
files = Counter(f.get('file', '?') for f in all_f)

all_f.sort(key=lambda f: (SEV_ORDER.get(f.get('severity'), 9), f.get('file', ''), f.get('id', '')))

L = []
L.append('# 题库答案 · 与出处原文比对报告\n')
L.append(f'核对范围：{n_cards} 张带出处链接的卡（共 {len(done)}/24 批完成'
         + (f'，缺 {", ".join(missing)}' if missing else '') + '）\n')
L.append(f'报出问题：**{len(all_f)}** 条 —— '
         + '、'.join(f'{k} {v}' for k, v in sevs.most_common()) + '\n')
L.append('> 这份报告只做判定，不动卡片。原文正文没有、也不会进入任何卡片。\n')

L.append('\n## 按类型\n')
L.append('| 类型 | 条数 |\n|---|---:|')
for k, v in kinds.most_common():
    L.append(f'| {KIND_CN.get(k, k)} | {v} |')

L.append('\n## 按牌组\n')
L.append('| 牌组文件 | 条数 |\n|---|---:|')
for k, v in files.most_common():
    L.append(f'| `{k}` | {v} |')

for sev, label in (('high', '严重（记进脑子会答错）'),
                   ('medium', '中等（不准确但不致命）'),
                   ('low', '轻微（用词/边界）')):
    group = [f for f in all_f if f.get('severity') == sev]
    if not group:
        continue
    L.append(f'\n---\n\n## {label} · {len(group)} 条\n')
    for f in group:
        L.append(f'### `{f.get("id")}` · {KIND_CN.get(f.get("kind"), f.get("kind"))}'
                 f' · 把握 {f.get("confidence", "?")}\n')
        L.append(f'**题**：{f.get("front", "")}\n')
        L.append(f'- 我们：{f.get("ours_says", "")}')
        L.append(f'- 原文：{f.get("src_says", "")}')
        L.append(f'- 问题：{f.get("what", "")}')
        L.append(f'- 建议：{f.get("fix", "")}\n')

io.open(REPORT, 'w', encoding='utf-8').write('\n'.join(L))

print(f'完成批次 {len(done)}/24 ' + (f'缺 {missing}' if missing else ''))
print(f'覆盖卡片 {n_cards}')
print(f'问题合计 {len(all_f)}: ' + ', '.join(f'{k}={v}' for k, v in sevs.most_common()))
print('类型: ' + ', '.join(f'{KIND_CN.get(k,k)}={v}' for k, v in kinds.most_common()))
print(f'报告 -> {REPORT}')
