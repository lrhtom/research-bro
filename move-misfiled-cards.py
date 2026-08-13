"""把 8 张纯 App 自动化的卡从「Web UI 自动化测试」搬到「App 自动化测试」。

当初按题目文本自动分牌组时分错的。证据：03d 里 java_automation 那页已有编号
1,2,3,7..20，正好缺 4,5,6,12；python 那页缺 4,9,11,12 —— 就是这 8 张。

搬过去后按 (出处页, 题号) 排好序，让每页的编号连成 1..20。
"""
import json, io, re

WEB = 'seed/decks/03c-web-automation.json'
APP = 'seed/decks/03d-app-automation.json'
MOVE = (23, 24, 25, 26, 47, 48, 49, 50)

LINK = re.compile(r'\]\((https://[^)\s]+)\)')
PAGE_ORDER = {'java_automation.html': 0, 'python_automation.html': 1}


def page_of(card):
    m = LINK.search(card['back'])
    return m.group(1).split('#')[0].rsplit('/', 1)[-1] if m else ''


def num_of(card):
    m = re.match(r'(\d+)\.', card['front'])
    return int(m.group(1)) if m else 999


web = json.load(io.open(WEB, encoding='utf-8'))
app = json.load(io.open(APP, encoding='utf-8'))

moved = [web['cards'][i] for i in MOVE]
for c in moved:
    assert page_of(c) in PAGE_ORDER, f'出处不是 App 那两页: {c["front"][:30]}'
assert not ({c['front'] for c in moved} & {c['front'] for c in app['cards']}), '正面撞车'

web['cards'] = [c for i, c in enumerate(web['cards']) if i not in MOVE]
app['cards'] = sorted(app['cards'] + moved, key=lambda c: (PAGE_ORDER.get(page_of(c), 9), num_of(c)))

for p, d in ((WEB, web), (APP, app)):
    io.open(p, 'w', encoding='utf-8', newline='\n').write(
        json.dumps(d, ensure_ascii=False, indent=2) + '\n')

print(f'Web UI 自动化测试: 51 -> {len(web["cards"])}')
print(f'App 自动化测试  : 32 -> {len(app["cards"])}')
for page in PAGE_ORDER:
    ns = sorted(num_of(c) for c in app['cards'] if page_of(c) == page)
    gap = [n for n in range(1, 21) if n not in ns]
    print(f'  {page}: 编号 {ns[0]}..{ns[-1]}，缺口 {gap or "无"}')
print('\n搬过去的 8 张：')
for c in moved:
    print(f'  {c["front"][:56]}')
