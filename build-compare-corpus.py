"""把每张卡的答案和它出处的原文段落配成对，供事实核对。

只在核对阶段读原文，**原文正文不进任何卡片、不进仓库**：
产物写到系统临时目录，核对完就可以删。

对小林 coding 的卡：按背面那条锚点，从原页面里切出该小节
（从这个标题开始，到下一个同级或更高级标题为止）。
对小林面试笔记（AI）的卡：整页就是一题，取全文。
"""
import json, io, os, re, glob, html as htmlmod

VP = 'C:/Users/lrhto/AppData/Local/Temp/vpages2'
AIB = 'C:/Users/lrhto/AppData/Local/Temp/aibody'
OUT = 'C:/Users/lrhto/AppData/Local/Temp/compare'

LINK = re.compile(r'\]\((https://(?:www\.)?xiaolin(?:coding|note)\.com/[^)\s]+)\)')
HEAD = re.compile(r'<h([1-6])\s+id="([^"]+)"[^>]*>(.*?)</h\1>', re.S)


def detag(s):
    """HTML → 朴素文本。代码块保留内容，其余标签丢掉。"""
    s = re.sub(r'<(script|style)\b.*?</\1>', ' ', s, flags=re.S | re.I)
    s = re.sub(r'<br\s*/?>', '\n', s)
    s = re.sub(r'</(p|div|li|tr|h[1-6]|pre|blockquote)>', '\n', s)
    s = re.sub(r'<li[^>]*>', '\n- ', s)
    s = re.sub(r'</t[dh]>', ' | ', s)
    s = re.sub(r'<[^>]+>', '', s)
    s = htmlmod.unescape(s).replace('\u200b', '')
    s = re.sub(r'[ \t\u00a0]+', ' ', s)
    s = re.sub(r'\n\s*\n\s*\n+', '\n\n', s)
    return s.strip()


def sections(path):
    """页面 → {锚点id: (标题文字, 该小节正文)}"""
    raw = io.open(path, encoding='utf-8', errors='replace').read()
    # 只取正文容器，避开侧栏目录 / 页脚
    m = re.search(r'<div class="vp-doc[^"]*"[^>]*>(.*)', raw, re.S)
    body = m.group(1) if m else raw
    hs = list(HEAD.finditer(body))
    out = {}
    for i, h in enumerate(hs):
        lv, hid = int(h.group(1)), h.group(2)
        title = re.sub(r'^#+\s*', '', detag(h.group(3))).strip().rstrip('#').strip()
        end = len(body)
        for j in range(i + 1, len(hs)):
            if int(hs[j].group(1)) <= lv:
                end = hs[j].start()
                break
        out[hid] = (title, detag(body[h.end():end]))
    return out


def whole(path):
    raw = io.open(path, encoding='utf-8', errors='replace').read()
    m = re.search(r'<div class="vp-doc[^"]*"[^>]*>(.*?)</div>\s*</div>\s*</div>', raw, re.S)
    return detag(m.group(1) if m else raw)


page_cache = {}
rows, no_src, no_sec = [], 0, 0

for f in sorted(glob.glob('seed/decks/*.json')):
    deck = json.load(io.open(f, encoding='utf-8'))
    for idx, c in enumerate(deck['cards']):
        m = LINK.search(c['back'])
        if not m:
            no_src += 1
            continue
        url = m.group(1)
        base, frag = (url.split('#', 1) + [''])[:2]
        name = base.rsplit('/', 1)[-1]

        if 'xiaolincoding.com' in url:
            p = os.path.join(VP, name)
            if p not in page_cache:
                page_cache[p] = sections(p) if os.path.exists(p) else {}
            secs = page_cache[p]
            if frag not in secs:
                no_sec += 1
                continue
            title, text = secs[frag]
        else:
            p = os.path.join(AIB, base.replace('https://xiaolinnote.com/ai/', '').replace('/', '__'))
            if not os.path.exists(p):
                no_sec += 1
                continue
            if p not in page_cache:
                page_cache[p] = whole(p)
            title, text = c['front'], page_cache[p]

        rows.append({
            'id': f'{os.path.basename(f)[:-5]}#{idx}',
            'deck': deck['name'],
            'file': os.path.basename(f),
            'front': c['front'],
            'ours': c['back'],
            'src_title': title,
            'src': text,
            'url': url,
        })

os.makedirs(OUT, exist_ok=True)
io.open(os.path.join(OUT, 'all.json'), 'w', encoding='utf-8').write(
    json.dumps(rows, ensure_ascii=False))

so = sum(len(r['ours']) for r in rows)
ss = sum(len(r['src']) for r in rows)
print(f'配对成功 : {len(rows)}')
print(f'背面无出处链接(跳过): {no_src}')
print(f'原文里找不到对应小节  : {no_sec}')
print(f'我们的答案 合计 {so/1000:.0f} 千字, 平均 {so//max(len(rows),1)}')
print(f'原文段落   合计 {ss/1000:.0f} 千字, 平均 {ss//max(len(rows),1)}')
short = [r for r in rows if len(r['src']) < 200]
print(f'原文段落 <200 字的: {len(short)}')
for r in short[:8]:
    print('   ', r['id'], r['front'][:36], '|', len(r['src']))
