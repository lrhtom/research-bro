"""
把小林 interview 页的题目并进 seed/decks 的牌组，并拆开三副过宽的计划。

规矩：
  · 只搬**题目**和**出处链接**，小林的正文一个字都不抄；
  · 背面统一是「先自己答 → 点链接对照」的提示 + 锚点，答案待后续原创补写；
  · 跟现有卡片近似重复的题直接丢掉（二元组 Jaccard > 0.62）。

跑完用 `npm run seed -- --sync` 落库：缺的新建、已有的只改答案、FSRS 进度不动。
"""
import json, io, os, re, glob, unicodedata

SRC = 'xlc-index.json'
OUT = os.path.join('seed', 'decks')


def norm(s):
    s = unicodedata.normalize('NFKC', s).lower()
    return re.sub(r'[\s?？。，,.、：:（）()「」"\'’“”…—\-_/\\]+', '', s)


def toks(s):
    n = norm(s)
    return set(n[i:i + 2] for i in range(len(n) - 1)) or {n}


def is_question(t):
    return ('?' in t or '？' in t or len(t) > 12) and not re.match(r'^[\d.\s]*[一-鿿\w ]{1,10}$', t)


def back_of(label, group, anchor):
    where = f'{label} · {group}' if group else label
    return (
        '先自己答一遍，再点开原文对照 ——\n\n'
        f'[小林coding · {where}]({anchor})\n\n'
        '> 本站只收录了**题目与出处链接**，答案没有抄过来。\n'
        '> 这张卡的答案待补：想清楚之后用自己的话写回这里，才算真的会了。'
    )


# ---------- 现有卡片：读进来，供去重与拆分 ----------
existing = {}
for f in sorted(glob.glob(os.path.join(OUT, '*.json'))):
    d = json.load(io.open(f, encoding='utf-8'))
    existing[os.path.basename(f)] = d

# ---------- 小林题目：按来源页归好 ----------
idx = json.load(io.open(SRC, encoding='utf-8'))
harvest = {}          # slug -> [(question, group, anchor)]
for slug, v in idx.items():
    cur_group = ''
    rows = []
    for it in v['items']:
        t = it['text']
        if it['level'] == 2 and not is_question(t):
            cur_group = re.sub(r'^[一二三四五六七八九十\d]+[、.．]\s*', '', t).strip()
            continue
        if is_question(t):
            rows.append((t, cur_group, it['anchor']))
    harvest[slug] = (v['label'], rows)


# ---------- 拆分规则：把一副卡分到几个子牌组 ----------
def bucket_automation(t):
    s = norm(t)
    if any(k in s for k in ('接口', 'api', 'requests', 'http', 'pytest', 'restassured', '契约', 'mock')):
        return '接口'
    if any(k in s for k in ('web', 'selenium', 'webdriver', 'playwright', 'cypress', '页面', '元素', '定位', 'po模式', '浏览器')):
        return 'web'
    if any(k in s for k in ('app', 'appium', '移动', '安卓', 'android', 'ios', '真机')):
        return 'app'
    return '通用'


def bucket_devops(t):
    s = norm(t)
    if any(k in s for k in ('docker', '镜像', '容器', 'k8s', 'kubernetes', 'compose', 'dockerfile')):
        return '容器'
    if any(k in s for k in ('git', '分支', 'commit', 'merge', 'rebase', 'cherry', '冲突', '暂存')):
        return 'git'
    return 'cicd'


def bucket_sysdesign(t):
    s = norm(t)
    if any(k in s for k in ('消息队列', 'mq', 'kafka', 'rocketmq', 'rabbitmq', '消息', '积压', '削峰')):
        return 'mq'
    if any(k in s for k in ('设计模式', '单例', '工厂', '建造者', '观察者', '策略模式', '装饰', '适配器', '责任链')):
        return 'pattern'
    if any(k in s for k in ('分布式', 'cap', '一致性', 'raft', 'paxos', '两阶段', '2pc', 'tcc', 'seata', '雪花', '分布式锁')):
        return 'dist'
    return 'sysdesign'


# 拆分方案：源文件 → [(子牌组文件名, 名称, 说明, 桶 key)]
SPLITS = {
    '03-test-automation.json': ('automation', bucket_automation, [
        ('03a-automation-core.json', '自动化测试 · 框架与通用', '分层策略、框架选型与设计、用例稳定性、数据与环境治理、报告与持续集成里的自动化位置。', '通用'),
        ('03b-api-automation.json', '接口自动化测试', '面试里问得最深的一层：请求构造与断言、依赖与鉴权、数据准备与清理、Mock 与契约、Java(RestAssured)/Python(requests+pytest) 两套实现。', '接口'),
        ('03c-web-automation.json', 'Web UI 自动化测试', '元素定位与等待策略、PO 模式、跨浏览器、脆弱用例治理，Selenium / Playwright 相关。', 'web'),
        ('03d-app-automation.json', 'App 自动化测试', 'Appium 与真机/云真机、安卓与 iOS 差异、弱网与权限、混合应用与 H5 切换。', 'app'),
    ]),
    '19-git-cicd-docker.json': ('devops', bucket_devops, [
        ('19a-git.json', 'Git', '分支模型与合并策略、rebase 与 merge 的取舍、冲突处理、找回丢失提交、代码评审相关操作。', 'git'),
        ('19b-container.json', '容器与镜像', 'Docker 镜像分层与构建优化、容器与虚拟机的区别、网络与存储、Compose 与编排入门。', '容器'),
        ('19c-cicd.json', 'CI/CD 与交付', '流水线设计、构建缓存与并行、环境与制品管理、自动化测试在流水线里的位置、发布与回滚策略。', 'cicd'),
    ]),
    '20-system-design-distributed.json': ('sysdesign', bucket_sysdesign, [
        ('20a-system-design.json', '系统设计', '容量估算、读写分离与缓存分层、限流降级熔断、幂等与重试、典型系统（短链、秒杀、feed）的拆解思路。', 'sysdesign'),
        ('20b-distributed.json', '分布式', 'CAP 与一致性模型、分布式锁、分布式 ID、分布式事务（2PC/TCC/本地消息表）、Raft 与选主。', 'dist'),
        ('20c-message-queue.json', '消息队列', '削峰与解耦、消息不丢不重与顺序性、积压治理，以及 Kafka / RocketMQ / RabbitMQ 的取舍。', 'mq'),
        ('20d-design-patterns.json', '设计模式', '常用模式的意图与适用边界，以及在测试框架、工程代码里的真实落点。', 'pattern'),
    ]),
}

# 合并方案：源文件 → 小林的哪几个 slug
MERGE = {
    '02-test-design-process.json': ['business_testing'],
    '04-performance-observability.json': ['performance_testing'],
    '10-golang.json': ['golang'],
    '11-data-structures-algorithms.json': ['data'],
    '14-operating-system.json': ['os'],
    '15-computer-network.json': ['network'],
    '16-database.json': ['mysql'],
    '17-redis-cache.json': ['redis'],
    '18-linux-troubleshooting.json': ['linux'],
}
SPLIT_SOURCES = {
    '03-test-automation.json': ['java_automation', 'python_automation'],
    '19-git-cicd-docker.json': ['docker', 'git'],
    '20-system-design-distributed.json': ['systemdesign', 'mq', 'cap'],
}

report = []
written = []


def make_cards(rows, ex_tokens):
    """把 (题, 分组, 锚点) 变成卡片，顺手去掉跟现有卡近似重复的"""
    out, dropped, seen = [], 0, set()
    for q, g, a in rows:
        tq = toks(q)
        if norm(q) in seen:
            dropped += 1
            continue
        if any(len(tq & e) / max(1, min(len(tq), len(e))) > 0.62 for e in ex_tokens):
            dropped += 1
            continue
        seen.add(norm(q))
        label = a.split('/')[-1].split('.')[0]
        out.append({'front': q, 'back': back_of(LABEL_OF[label], g, a)})
    return out, dropped


LABEL_OF = {slug: lab for slug, (lab, _) in harvest.items()}

# ---------- 一、直接合并的九副 ----------
for fname, slugs in MERGE.items():
    d = existing[fname]
    ex = [toks(c['front']) for c in d['cards']]
    rows = []
    for s in slugs:
        rows += harvest[s][1]
    new, dropped = make_cards(rows, ex)
    before = len(d['cards'])
    d['cards'].extend(new)
    io.open(os.path.join(OUT, fname), 'w', encoding='utf-8').write(
        json.dumps(d, ensure_ascii=False, indent=2) + '\n')
    written.append(fname)
    report.append(('合并', d['name'], before, len(new), dropped, len(d['cards'])))

# ---------- 二、拆开的三副 ----------
for fname, (_, bucket, subs) in SPLITS.items():
    d = existing[fname]
    old_by_bucket = {}
    for c in d['cards']:
        old_by_bucket.setdefault(bucket(c['front']), []).append(c)

    rows = []
    for s in SPLIT_SOURCES[fname]:
        rows += harvest[s][1]
    new_by_bucket = {}
    for q, g, a in rows:
        new_by_bucket.setdefault(bucket(q + ' ' + g), []).append((q, g, a))

    for sub_file, sub_name, sub_desc, key in subs:
        olds = old_by_bucket.get(key, [])
        ex = [toks(c['front']) for c in olds]
        news, dropped = make_cards(new_by_bucket.get(key, []), ex)
        deck = {
            'name': sub_name,
            'description': sub_desc,
            'dailyNewLimit': 12,
            'cards': olds + news,
        }
        io.open(os.path.join(OUT, sub_file), 'w', encoding='utf-8').write(
            json.dumps(deck, ensure_ascii=False, indent=2) + '\n')
        written.append(sub_file)
        report.append(('拆分', sub_name, len(olds), len(news), dropped, len(deck['cards'])))

print(f"{'':<4}{'牌组':<26}{'原有':>5}{'新增':>5}{'丢重':>5}{'合计':>6}")
print('-' * 54)
for kind, name, before, added, dropped, total in report:
    print(f"{kind:<4}{name[:24]:<26}{before:>5}{added:>5}{dropped:>5}{total:>6}")
print('-' * 54)
print(f"{'':<4}{'总计':<26}{sum(r[2] for r in report):>5}{sum(r[3] for r in report):>5}"
      f"{sum(r[4] for r in report):>5}{sum(r[5] for r in report):>6}")
print('\n写了', len(written), '个文件；旧的三副源文件需要手工移走：', list(SPLITS))
