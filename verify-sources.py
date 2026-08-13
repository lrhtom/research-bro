"""核对每张卡的题目与它标注的出处是否真的对得上。

只读原站页面的**标题结构**（h1~h4 的 id 与标题文字），不读也不保存正文。
检查三件事：
  1. 卡片背面那条锚点，在原站页面里是否真实存在
  2. 该锚点对应的标题文字，跟卡片正面是否一致（防串卡 / 防题目被改写）
  3. 有没有卡片指向了抓不到的页面
"""
import json, io, os, re, unicodedata

PAIRS = 'verify-pairs.json'
VP = os.environ.get('VPAGES', 'C:/Users/lrhto/AppData/Local/Temp/vpages2')

PUNCT = re.compile(r'[\s\?\uff1f\u3002\uff0c,\.\u3001\uff1a:\uff08\uff09\(\)\u300c\u300d"\'\u2019\u201c\u201d\u2026\u2014\-_/\\#]+')


def norm(s):
    return PUNCT.sub('', unicodedata.normalize('NFKC', s).lower())


pairs = json.load(io.open(PAIRS, encoding='utf-8'))
ok = miss_page = miss_anchor = mismatch = 0
bad_anchor, bad_text, missing_pages = [], [], set()

for url, items in pairs.items():
    if 'xiaolincoding.com' not in url:
        continue
    f = os.path.join(VP, url.rsplit('/', 1)[-1])
    if not os.path.exists(f) or os.path.getsize(f) < 500:
        miss_page += len(items)
        missing_pages.add(url)
        continue

    html = io.open(f, encoding='utf-8', errors='replace').read()
    ids = {}
    for lv, hid, inner in re.findall(r'<h([1-4])\s+id="([^"]+)"[^>]*>(.*?)</h\1>', html, re.S):
        t = re.sub(r'<[^>]+>', '', inner).replace('\u200b', '').strip()
        ids[hid] = re.sub(r'^#+\s*', '', t).strip().rstrip('#').strip()

    for deck, front, frag in items:
        if not frag:
            continue
        if frag not in ids:
            miss_anchor += 1
            bad_anchor.append((deck, front, url.rsplit('/', 1)[-1], frag))
            continue
        if norm(ids[frag]) == norm(front):
            ok += 1
        else:
            mismatch += 1
            bad_text.append((deck, front, ids[frag]))

total = ok + miss_anchor + mismatch
print(f'带锚点的卡合计     : {total}')
print(f'  锚点存在且题目一致: {ok}')
print(f'  锚点在原站找不到  : {miss_anchor}')
print(f'  锚点在但题目不符  : {mismatch}')
print(f'  页面抓不到(跳过)  : {miss_page}  {sorted(missing_pages)[:3]}')

if bad_anchor:
    print('\n--- 锚点找不到 ---')
    for d, fr, u, a in bad_anchor[:15]:
        print(f'  [{d[:14]}] {u}\n      卡片: {fr[:44]}\n      锚点: #{a}')
if bad_text:
    print('\n--- 题目与锚点标题不符 ---')
    for d, fr, t in bad_text[:15]:
        print(f'  [{d[:14]}]\n      卡片: {fr[:46]}\n      原站: {t[:46]}')
