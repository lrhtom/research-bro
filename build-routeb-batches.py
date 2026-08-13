"""B 路线：背面没有出处链接的卡，没有原文可比，只能靠独立知识复核。

把这些卡按字数均衡切批，同一副牌尽量不拆散。
不带任何原文 —— 这一路本来就没有出处。
"""
import json, io, os, re, glob
from collections import OrderedDict

OUT = 'C:/Users/lrhto/AppData/Local/Temp/routeb'
CAP = 110_000

LINK = re.compile(r'\]\((https://(?:www\.)?xiaolin(?:coding|note)\.com/[^)\s]+)\)')

by_file = OrderedDict()
n_all = n_src = 0
for p in sorted(glob.glob('seed/decks/*.json')):
    deck = json.load(io.open(p, encoding='utf-8'))
    for i, c in enumerate(deck['cards']):
        n_all += 1
        if LINK.search(c['back']):
            n_src += 1
            continue
        by_file.setdefault(os.path.basename(p), []).append({
            'id': f'{os.path.basename(p)[:-5]}#{i}',
            'card_index': i,
            'deck': deck['name'],
            'file': os.path.basename(p),
            'front': c['front'],
            'ours': c['back'],
        })

cost = lambda r: len(r['ours'])
chunks = []
for fname, items in sorted(by_file.items(), key=lambda kv: -sum(cost(r) for r in kv[1])):
    cur, acc = [], 0
    for r in items:
        if cur and acc + cost(r) > CAP:
            chunks.append(cur); cur, acc = [], 0
        cur.append(r); acc += cost(r)
    if cur:
        chunks.append(cur)

chunks.sort(key=lambda c: -sum(cost(r) for r in c))
total = sum(cost(r) for v in by_file.values() for r in v)
N = max(1, -(-total // CAP))
bins = [[] for _ in range(N)]
load = [0] * N
for c in chunks:
    i = load.index(min(load))
    bins[i].extend(c); load[i] += sum(cost(r) for r in c)

os.makedirs(os.path.join(OUT, 'batches'), exist_ok=True)
os.makedirs(os.path.join(OUT, 'findings'), exist_ok=True)
print(f'全部卡片 {n_all}，有出处 {n_src}，无出处 {n_all - n_src}（本轮范围）')
print(f'合计 {total // 1000} 千字，切 {N} 批\n')
for i, b in enumerate(bins, 1):
    p = os.path.join(OUT, 'batches', f'r{i:02d}.json')
    io.open(p, 'w', encoding='utf-8').write(json.dumps(b, ensure_ascii=False, indent=1))
    decks = sorted({r['file'][:-5] for r in b})
    print(f'  r{i:02d}  {len(b):3d} 张  {load[i-1]//1000:4d} 千字  {",".join(d[:16] for d in decks)}')
