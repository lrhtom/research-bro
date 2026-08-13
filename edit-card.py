"""改写某张卡的背面（或正面），保持牌组 JSON 的原有格式不变。

    python edit-card.py seed/decks/10-golang.json 57 新背面.txt
    python edit-card.py seed/decks/10-golang.json 57 新正面.txt --front

新内容从文件读（UTF-8），避免命令行转义把 markdown 里的引号和换行搞坏。
写回一律用 json.dumps(ensure_ascii=False, indent=2) + 行尾换行 ——
牌组文件本来就是这个格式，这样 diff 里只会出现真正改动的那张卡。
"""
import json, io, sys, os

if len(sys.argv) < 4:
    sys.exit(__doc__)

path, idx, src = sys.argv[1], int(sys.argv[2]), sys.argv[3]
field = 'front' if '--front' in sys.argv else 'back'

deck = json.load(io.open(path, encoding='utf-8'))
cards = deck['cards']
if not 0 <= idx < len(cards):
    sys.exit(f'卡片下标 {idx} 越界：{path} 只有 {len(cards)} 张')

new = io.open(src, encoding='utf-8').read().replace('\r\n', '\n').rstrip('\n')
if not new.strip():
    sys.exit('新内容是空的，拒绝写入')

old = cards[idx][field]
if old == new:
    print(f'内容没变，未写入：{os.path.basename(path)} #{idx}')
    sys.exit(0)

cards[idx][field] = new
io.open(path, 'w', encoding='utf-8', newline='\n').write(
    json.dumps(deck, ensure_ascii=False, indent=2) + '\n')

print(f'已改 {os.path.basename(path)} #{idx} 的 {field}：{len(old)} 字 -> {len(new)} 字')
print(f'  正面: {cards[idx]["front"][:50]}')
