"""把 144 条 finding 按牌组文件分组，生成修复任务包。

一个文件只交给一个 agent，避免两个 agent 同时写同一份 JSON。
任务包里带上：finding、卡片当前正反面、以及出处原文段落（供 agent 复核判定）。
"""
import json, io, os, glob
from collections import defaultdict

FD = 'C:/Users/lrhto/AppData/Local/Temp/compare/findings'
ALL = 'C:/Users/lrhto/AppData/Local/Temp/compare/all.json'
OUT = 'C:/Users/lrhto/AppData/Local/Temp/fix'

rows = {r['id']: r for r in json.load(io.open(ALL, encoding='utf-8'))}

findings = []
for p in sorted(glob.glob(os.path.join(FD, '*.json'))):
    findings += json.load(io.open(p, encoding='utf-8'))

# source-wrong 不改卡片内容 —— 我们本来就是对的
by_file = defaultdict(list)
skipped_src_wrong = 0
for f in findings:
    if f.get('kind') == 'source-wrong':
        skipped_src_wrong += 1
        continue
    r = rows.get(f['id'])
    if not r:
        print('!! 找不到卡片', f['id'])
        continue
    by_file[r['file']].append({
        'id': f['id'],
        'card_index': int(f['id'].split('#')[1]),
        'kind': f['kind'],
        'severity': f['severity'],
        'confidence': f.get('confidence'),
        'what': f['what'],
        'fix': f['fix'],
        'ours_says': f.get('ours_says'),
        'src_says': f.get('src_says'),
        'front': r['front'],
        'current_back': r['ours'],
        'source_section': r['src'],
        'source_url': r['url'],
    })

os.makedirs(OUT, exist_ok=True)
SEV = {'high': 0, 'medium': 1, 'low': 2}
groups = []
for fname, items in sorted(by_file.items(), key=lambda kv: -len(kv[1])):
    items.sort(key=lambda x: (SEV[x['severity']], x['card_index']))
    p = os.path.join(OUT, fname)
    io.open(p, 'w', encoding='utf-8').write(json.dumps(items, ensure_ascii=False, indent=1))
    groups.append((fname, len(items), os.path.getsize(p) // 1024))

print(f'source-wrong 跳过（我们本来是对的）: {skipped_src_wrong}')
print(f'要修的 finding 合计: {sum(g[1] for g in groups)}  分布在 {len(groups)} 个牌组文件\n')
for fname, n, kb in groups:
    print(f'  {n:3d} 条  {kb:4d} KB  {fname}')
