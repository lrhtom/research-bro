"""B 路线的 23 条 finding 按牌组分组，生成修复任务包。

跟 A 路线的差别：没有原文可比（这批卡本来就没出处），
所以任务包里不带 source_section —— 修复者要靠自己的知识复核。
"""
import json, io, os, glob, sys
from collections import defaultdict

FD = 'C:/Users/lrhto/AppData/Local/Temp/routeb/findings'
OUT = 'C:/Users/lrhto/AppData/Local/Temp/routeb/fix'

# 还被 source-wrong 标注 agent 占着的牌组，这一轮先不派（避免两个 agent 同写一个文件）
BLOCKED = set(sys.argv[1:])

cur = {}
for p in sorted(glob.glob('seed/decks/*.json')):
    d = json.load(io.open(p, encoding='utf-8'))
    for i, c in enumerate(d['cards']):
        cur[f'{os.path.basename(p)[:-5]}#{i}'] = c

items = defaultdict(list)
for p in sorted(glob.glob(os.path.join(FD, '*.json'))):
    for f in json.load(io.open(p, encoding='utf-8')):
        c = cur.get(f['id'])
        if not c:
            print('!! 找不到卡片', f['id']); continue
        items[f['file']].append({
            'id': f['id'],
            'card_index': int(f['id'].split('#')[1]),
            'kind': f['kind'],
            'severity': f['severity'],
            'confidence': f.get('confidence'),
            'what': f['what'],
            'fix': f['fix'],
            'ours_says': f.get('ours_says'),
            'front': c['front'],
            'current_back': c['back'],
        })

os.makedirs(OUT, exist_ok=True)
os.makedirs(os.path.join(OUT, 'applied'), exist_ok=True)
now, later = [], []
for k, v in sorted(items.items(), key=lambda kv: -len(kv[1])):
    v.sort(key=lambda x: x['card_index'])
    io.open(os.path.join(OUT, k), 'w', encoding='utf-8').write(json.dumps(v, ensure_ascii=False, indent=2))
    (later if k in BLOCKED else now).append((k, len(v)))

print(f'合计 {sum(len(v) for v in items.values())} 条，{len(items)} 个牌组\n')
print(f'可以马上派（{sum(n for _, n in now)} 条）:')
for k, n in now:
    print(f'  {n:2d}  {k}')
print(f'\n先等标注 agent 让开（{sum(n for _, n in later)} 条）:')
for k, n in later:
    print(f'  {n:2d}  {k}')
