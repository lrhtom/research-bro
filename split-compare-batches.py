"""把配好对的 936 张卡切成若干批，按字数均衡，同一副牌尽量不拆散。"""
import json, io, os
from collections import OrderedDict

OUT = 'C:/Users/lrhto/AppData/Local/Temp/compare'
# 一批塞多少字：约 11 万字 ≈ 8 万 token，留得下 agent 自己推理的余量
CAP = 110_000

rows = json.load(io.open(os.path.join(OUT, 'all.json'), encoding='utf-8'))

by_file = OrderedDict()
for r in rows:
    by_file.setdefault(r['file'], []).append(r)

cost = lambda r: len(r['ours']) + len(r['src'])

# 单副牌超过一批的容量就顺序切开（切开的几段仍连号，便于回看）
chunks = []
for fname, items in sorted(by_file.items(), key=lambda kv: -sum(cost(r) for r in kv[1])):
    cur, acc = [], 0
    for r in items:
        if cur and acc + cost(r) > CAP:
            chunks.append(cur)
            cur, acc = [], 0
        cur.append(r)
        acc += cost(r)
    if cur:
        chunks.append(cur)

chunks.sort(key=lambda c: -sum(cost(r) for r in c))
N = max(1, -(-sum(cost(r) for r in rows) // CAP))
bins = [[] for _ in range(N)]
load = [0] * N
for c in chunks:
    i = load.index(min(load))
    bins[i].extend(c)
    load[i] += sum(cost(r) for r in c)

os.makedirs(os.path.join(OUT, 'batches'), exist_ok=True)
for i, b in enumerate(bins, 1):
    p = os.path.join(OUT, 'batches', f'b{i:02d}.json')
    io.open(p, 'w', encoding='utf-8').write(json.dumps(b, ensure_ascii=False, indent=1))
    decks = sorted({r['file'][:-5] for r in b})
    print(f'b{i:02d}  {len(b):3d} 张  {load[i-1]//1000:4d} 千字  {",".join(d[:14] for d in decks)}')
