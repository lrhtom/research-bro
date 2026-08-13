"""43 条「原文错、我们对」的卡：卡片内容不改，只在出处链接前加一行提示。

不加提示的后果：以后点开链接对照，会看到原文跟卡片说的不一样，
反而以为自己背错了 —— 提示就是为了拦住这个误判。
"""
import json, io, os, glob, re
from collections import defaultdict

FD = 'C:/Users/lrhto/AppData/Local/Temp/compare/findings'
ALL = 'C:/Users/lrhto/AppData/Local/Temp/compare/all.json'
OUT = 'C:/Users/lrhto/AppData/Local/Temp/srcwrong'

rows = {r['id']: r for r in json.load(io.open(ALL, encoding='utf-8'))}
cur = {}
for p in sorted(glob.glob('seed/decks/*.json')):
    d = json.load(io.open(p, encoding='utf-8'))
    for i, c in enumerate(d['cards']):
        cur[f'{os.path.basename(p)[:-5]}#{i}'] = c

items = defaultdict(list)
n = 0
for p in sorted(glob.glob(os.path.join(FD, '*.json'))):
    for f in json.load(io.open(p, encoding='utf-8')):
        if f.get('kind') != 'source-wrong':
            continue
        r = rows.get(f['id'])
        c = cur.get(f['id'])
        if not r or not c:
            print('!! 找不到', f['id']); continue
        n += 1
        items[r['file']].append({
            'id': f['id'],
            'card_index': int(f['id'].split('#')[1]),
            'severity': f['severity'],
            'what': f['what'],
            'ours_says': f.get('ours_says'),
            'src_says': f.get('src_says'),
            'front': c['front'],
            'current_back': c['back'],
            'source_section': r['src'],
            'source_url': r['url'],
        })

os.makedirs(OUT, exist_ok=True)
os.makedirs(os.path.join(OUT, 'applied'), exist_ok=True)
print(f'source-wrong 合计 {n} 条，分布 {len(items)} 个牌组\n')
for k, v in sorted(items.items(), key=lambda kv: -len(kv[1])):
    v.sort(key=lambda x: x['card_index'])
    io.open(os.path.join(OUT, k), 'w', encoding='utf-8').write(json.dumps(v, ensure_ascii=False, indent=1))
    print(f'  {len(v):2d} 条  {k}')
