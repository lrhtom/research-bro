// ============================================================
//  算法题库（OJ）的验收测试
//
//  挑的都是「错了就会静默地骗人」的地方，不是为了凑覆盖率：
//
//    1. 输出比对：行尾空白 / CRLF / 结尾空行不算错（这三样判 WA 是误伤），
//       但真不一样时必须说清第几行、两边各是什么
//    2. 标签分节解析：缺分节要抛（触发整题重试），坏 JSON 要能被 jsonrepair 救回来，
//       count 要按类型钳住 —— 模型给 large 塞 50 个的话生成和判题都会失控
//    3. 标签过滤：搜「树」不能把「树状数组」也搜出来
//    4. 测试点列表只给预览与体积，不能把几 MB 的正文一起端出来
//    5. 删题要连测试点和提交一起删干净（靠外键级联，得真的开着）
//    6. 设置：Python 路径清空要回落成 'python'，并发数要钳在 1~6
//
//  真正跑 Python 的那部分（runPython / judgeSubmission）不在这里测 ——
//  那需要机器上装着 Python，跑起来还慢。这里只测不依赖外部环境的纯逻辑与库操作。
// ============================================================

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { initSchema, useDatabase } from './db.js';
import { compareOutput } from './oj-judge.js';
import {
    extractTag, parseGeneratorResponse, parsePlans, parseProblemResponse, stripCodeFence,
} from './oj-parse.js';
import {
    deleteProblem, getOjSettings, getProblem, getSampleCases, insertProblem, insertSubmission,
    insertTestCase, listAllTags, listProblems, listSubmissions, listTestCaseMetas,
    listTestCasesFull, saveOjSettings, toggleFavorite, updateProblem, updateSubmission,
} from './oj-store.js';
import type { NewOjProblem } from './oj-store.js';

let conn: Database.Database;

beforeEach(() => {
    conn = new Database(':memory:');
    initSchema(conn);
    useDatabase(conn);
});

afterEach(() => {
    conn.close();
});

function makeProblem(patch: Partial<NewOjProblem> = {}): number {
    return insertProblem({
        type: 'algo',
        title: '两数之和',
        difficulty: '简单',
        tags: ['数组', '哈希表'],
        statementMd: '## 题目描述\n给定数组…',
        solutionCode: 'print(1)',
        solutionLang: 'python',
        timeLimitMs: 2000,
        memoryLimitMb: 256,
        status: 'ready',
        genPrompt: '出一道简单题',
        genWarnings: [],
        ...patch,
    });
}

// ============================================================
//  1. 输出比对
// ============================================================

describe('compareOutput', () => {
    it('行尾空白、CRLF、结尾空行都不算错', () => {
        // 这三样肉眼看不出区别，判 WA 纯属误伤：Windows 上 print 出来就是 CRLF，
        // 而 Python 的 print 天然在最后多一个换行
        expect(compareOutput('1 2 3\n', '1 2 3').equal).toBe(true);
        expect(compareOutput('1 2 3\n', '1 2 3\r\n').equal).toBe(true);
        expect(compareOutput('1 2 3', '1 2 3   \n\n\n').equal).toBe(true);
        expect(compareOutput('a\nb\n', 'a  \r\nb\t\r\n\r\n').equal).toBe(true);
    });

    it('两边都空算相等', () => {
        expect(compareOutput('', '').equal).toBe(true);
        expect(compareOutput('\n\n', '').equal).toBe(true);
    });

    it('行中间的空白仍然算数', () => {
        // 只 trim 行尾，不 trim 行内 —— "1 2" 和 "12" 是两个不同的答案
        expect(compareOutput('1 2', '12').equal).toBe(false);
    });

    it('不一致时报出第一处不同的行号与两边内容', () => {
        const r = compareOutput('1\n2\n3', '1\n9\n3');
        expect(r.equal).toBe(false);
        expect(r.message).toContain('第 2 行');
        expect(r.message).toContain('期望「2」');
        expect(r.message).toContain('实际「9」');
    });

    it('实际输出多出几行时说得出是「多出来」', () => {
        const r = compareOutput('1', '1\n2');
        expect(r.equal).toBe(false);
        expect(r.message).toContain('第 2 行');
        expect(r.message).toContain('期望的输出已经结束');
        expect(r.message).toContain('实际还多出「2」');
    });

    it('实际输出少了几行时说得出是「提前结束」', () => {
        const r = compareOutput('1\n2', '1');
        expect(r.equal).toBe(false);
        expect(r.message).toContain('实际输出已经结束');
        expect(r.message).toContain('期望共 2 行');
    });

    it('超长的行会被截断，错误信息不至于刷屏', () => {
        const long = 'x'.repeat(500);
        const r = compareOutput(long, 'y'.repeat(500));
        expect(r.equal).toBe(false);
        expect(r.message!.length).toBeLessThan(300);
        expect(r.message).toContain('…');
    });
});

// ============================================================
//  2. 解析 AI 的回复
// ============================================================

describe('extractTag / stripCodeFence', () => {
    it('取第一个匹配并去掉两头空白', () => {
        expect(extractTag('<title>  你好  </title><title>第二个</title>', 'title')).toBe('你好');
    });

    it('没有这个分节时返回 null', () => {
        expect(extractTag('什么都没有', 'title')).toBeNull();
    });

    it('剥掉整体包着的围栏', () => {
        expect(stripCodeFence('```python\nprint(1)\n```')).toBe('print(1)');
        expect(stripCodeFence('```\nprint(1)\n```')).toBe('print(1)');
    });

    it('正文里本来就有代码块时不误剥', () => {
        // 开头是围栏但结尾不是，说明这是一段**含**代码块的文本，不是一整块代码
        const text = '```python\nprint(1)\n```\n后面还有字';
        expect(stripCodeFence(text)).toBe(text);
    });
});

describe('parsePlans', () => {
    it('按类型钳住 count —— large 给 50 个也只留 5 个', () => {
        // 不钳的话生成阶段要跑 50 遍标准解、判题时每次提交也要跑 50 个大数据点
        const plans = parsePlans(JSON.stringify([
            { name: '大数据', kind: 'large', count: 50, description: 'n 取上限', isSample: false },
        ]));
        expect(plans[0].count).toBe(5);
    });

    it('count 缺失时按类型垫默认值', () => {
        const plans = parsePlans(JSON.stringify([
            { name: '小数据', kind: 'small', description: '随机', isSample: false },
        ]));
        expect(plans[0].count).toBe(15);
    });

    it('kind 不认识时回退 special，而不是整题失败', () => {
        const plans = parsePlans(JSON.stringify([
            { name: '奇怪的', kind: 'weird', description: '', isSample: false },
        ]));
        expect(plans[0].kind).toBe('special');
    });

    it('坏 JSON 能被 jsonrepair 救回来', () => {
        // 尾逗号 + 单引号，都是模型常犯的
        const plans = parsePlans("[{'name': '样例', 'kind': 'sample', 'description': '小', 'isSample': true,},]");
        expect(plans).toHaveLength(1);
        expect(plans[0].kind).toBe('sample');
    });

    it('救不回来就抛，交给上层整题重试', () => {
        expect(() => parsePlans('这根本不是 JSON')).toThrow();
        expect(() => parsePlans('[]')).toThrow();
    });

    it('isSample 没给时按 kind 推', () => {
        const plans = parsePlans(JSON.stringify([
            { name: '样例', kind: 'sample', description: '' },
            { name: '大的', kind: 'large', description: '' },
        ]));
        expect(plans[0].isSample).toBe(true);
        expect(plans[1].isSample).toBe(false);
    });
});

describe('parseProblemResponse', () => {
    const good = `
<title>区间求和</title>
<difficulty>中等</difficulty>
<time_limit_ms>3000</time_limit_ms>
<memory_limit_mb>256</memory_limit_mb>
<tags>数组,前缀和</tags>
<statement>
## 题目描述
求和。
</statement>
<solution>
print(sum(map(int, input().split())))
</solution>
<plans>
[{"name":"样例1","kind":"sample","count":1,"description":"n=5","isSample":true}]
</plans>`;

    it('正常回复能完整解析出来', () => {
        const p = parseProblemResponse(good);
        expect(p.title).toBe('区间求和');
        expect(p.difficulty).toBe('中等');
        expect(p.timeLimitMs).toBe(3000);
        expect(p.tags).toEqual(['数组', '前缀和']);
        expect(p.statementMd).toContain('求和');
        expect(p.solutionCode).toContain('print');
        expect(p.plans).toHaveLength(1);
    });

    it('缺必需分节时抛错，并点名缺的是哪几个', () => {
        const e = (() => { try { parseProblemResponse('<title>只有标题</title>'); } catch (err) { return err as Error; } })();
        expect(e?.message).toContain('<statement>');
        expect(e?.message).toContain('<solution>');
        expect(e?.message).toContain('<plans>');
    });

    it('时限超出范围会被钳回来', () => {
        // 模型偶尔会写 60000ms，那是把整台机器占一分钟
        const p = parseProblemResponse(good.replace('<time_limit_ms>3000', '<time_limit_ms>60000'));
        expect(p.timeLimitMs).toBe(5000);
    });

    it('难度不合法时退回中等，不整题失败', () => {
        const p = parseProblemResponse(good.replace('<difficulty>中等', '<difficulty>地狱'));
        expect(p.difficulty).toBe('中等');
    });
});

describe('parseGeneratorResponse', () => {
    it('取 <generator> 里的代码并剥掉围栏', () => {
        expect(parseGeneratorResponse('<generator>\n```python\nprint(1)\n```\n</generator>'))
            .toBe('print(1)');
    });

    it('模型忘了贴标签、只回一个围栏代码块时能救回来', () => {
        expect(parseGeneratorResponse('好的：\n```python\nprint(1)\n```')).toBe('print(1)');
    });

    it('有多个围栏时不猜，直接抛让它重来', () => {
        // 多个围栏说明它在解释思路，猜哪一个都可能猜错，而猜错的代价是
        // 一整个测试计划的数据全是错的 —— 那比重试一次贵得多
        expect(() => parseGeneratorResponse('```a\n1\n```\n```b\n2\n```')).toThrow();
    });
});

// ============================================================
//  3~5. 库操作
// ============================================================

describe('题库查询', () => {
    it('标签过滤是精确匹配：搜「树」不会把「树状数组」带出来', () => {
        // tags 存的是 JSON 数组文本，按带引号的 "树" 匹配才不会子串误命中。
        // 这条错了的表现是：点一下「树」标签，出来一堆线段树/树状数组的题，
        // 而没人会想到这是 SQL LIKE 的问题
        makeProblem({ title: '二叉树遍历', tags: ['树'] });
        makeProblem({ title: '区间加', tags: ['树状数组'] });

        expect(listProblems({ tag: '树' }).total).toBe(1);
        expect(listProblems({ tag: '树' }).items[0].title).toBe('二叉树遍历');
        expect(listProblems({ tag: '树状数组' }).total).toBe(1);
    });

    it('标题搜索里的 % 和 _ 当普通字符，不当通配符', () => {
        makeProblem({ title: '百分之百' });
        makeProblem({ title: 'a%b' });
        expect(listProblems({ search: '%' }).total).toBe(1);
        expect(listProblems({ search: '%' }).items[0].title).toBe('a%b');
    });

    it('列表带出测试点数、提交数与「解没解出来」', () => {
        const id = makeProblem();
        insertTestCase({
            problemId: id, idx: 1, kind: 'sample', planName: 's', planDesc: '',
            isSample: true, input: '1', output: '1', generatorCode: '',
        });
        const sub = insertSubmission({ problemId: id, language: 'python', code: 'x' });

        let item = listProblems({}).items[0];
        expect(item.testCaseCount).toBe(1);
        expect(item.submissionCount).toBe(1);
        expect(item.solved).toBe(false);

        updateSubmission(sub, { verdict: 'AC', score: 100, timeMs: 12, caseResults: [] });
        item = listProblems({}).items[0];
        expect(item.solved).toBe(true);
    });

    it('只看收藏 / 切换收藏', () => {
        const id = makeProblem();
        makeProblem({ title: '另一道' });

        expect(listProblems({ favoriteOnly: true }).total).toBe(0);
        expect(toggleFavorite(id)).toBe(true);
        expect(listProblems({ favoriteOnly: true }).total).toBe(1);
        expect(toggleFavorite(id)).toBe(false);
        expect(listProblems({ favoriteOnly: true }).total).toBe(0);
        // 不存在的题返回 null，而不是假装切成功了
        expect(toggleFavorite(99999)).toBeNull();
    });

    it('分页', () => {
        for (let i = 0; i < 5; i++) makeProblem({ title: `题 ${i}` });
        const p1 = listProblems({ page: 1, pageSize: 2 });
        expect(p1.items).toHaveLength(2);
        expect(p1.total).toBe(5);
        expect(listProblems({ page: 3, pageSize: 2 }).items).toHaveLength(1);
    });

    it('标签统计按出现次数从多到少', () => {
        makeProblem({ tags: ['图', 'DFS'] });
        makeProblem({ tags: ['图'] });
        const tags = listAllTags();
        expect(tags[0]).toEqual({ tag: '图', count: 2 });
        expect(tags.find((t) => t.tag === 'DFS')?.count).toBe(1);
    });
});

describe('测试点', () => {
    it('列表只给预览与体积，不把正文端出来', () => {
        // 一道题的测试点加起来可能上百 MB，列表全量下发会把详情页直接拖死
        const id = makeProblem();
        const big = 'x'.repeat(5000);
        insertTestCase({
            problemId: id, idx: 1, kind: 'large', planName: '大', planDesc: '',
            isSample: false, input: big, output: big, generatorCode: '',
        });

        const [meta] = listTestCaseMetas(id);
        expect(meta.inputPreview).toHaveLength(200);
        expect(meta.inputBytes).toBe(5000);
        expect(meta).not.toHaveProperty('input');

        // 判题那一路要的是全量
        expect(listTestCasesFull(id)[0].input).toHaveLength(5000);
    });

    it('体积在写入时算好，按 UTF-8 字节数而不是字符数', () => {
        // 中文一个字三字节。按字符数算的话，页面上会把 3MB 的点显示成 1MB
        const id = makeProblem();
        insertTestCase({
            problemId: id, idx: 1, kind: 'sample', planName: 's', planDesc: '',
            isSample: true, input: '中文', output: '', generatorCode: '',
        });
        expect(listTestCaseMetas(id)[0].inputBytes).toBe(6);
    });

    it('样例单独取，按 idx 排', () => {
        const id = makeProblem();
        insertTestCase({
            problemId: id, idx: 1, kind: 'sample', planName: 's1', planDesc: '',
            isSample: true, input: 'a', output: 'a', generatorCode: '',
        });
        insertTestCase({
            problemId: id, idx: 2, kind: 'large', planName: 'l', planDesc: '',
            isSample: false, input: 'b', output: 'b', generatorCode: '',
        });
        const samples = getSampleCases(id);
        expect(samples).toHaveLength(1);
        expect(samples[0].planName).toBe('s1');
    });
});

describe('删题', () => {
    it('测试点和提交跟着一起删干净', () => {
        // 靠的是外键 ON DELETE CASCADE。这条挂了的表现是库里堆着一堆
        // 指向已删题目的孤儿行，列表看不见但库文件一直在涨
        const id = makeProblem();
        insertTestCase({
            problemId: id, idx: 1, kind: 'sample', planName: 's', planDesc: '',
            isSample: true, input: 'a', output: 'a', generatorCode: '',
        });
        insertSubmission({ problemId: id, language: 'python', code: 'x' });

        expect(deleteProblem(id)).toBe(true);
        expect(getProblem(id)).toBeNull();
        expect(conn.prepare('SELECT COUNT(*) c FROM oj_test_cases').get()).toEqual({ c: 0 });
        expect(conn.prepare('SELECT COUNT(*) c FROM oj_submissions').get()).toEqual({ c: 0 });
    });

    it('删不存在的题返回 false', () => {
        expect(deleteProblem(99999)).toBe(false);
    });
});

describe('提交', () => {
    it('列表联查带出题目名', () => {
        const id = makeProblem({ title: '联查测试' });
        insertSubmission({ problemId: id, language: 'python', code: 'x' });
        expect(listSubmissions({}).items[0].problemTitle).toBe('联查测试');
    });

    it('逐点结果坏掉时只丢坏的那条，不让整个列表挂掉', () => {
        // case_results 是 JSON 列，外部工具改坏一行不该让提交记录页整页白屏
        const id = makeProblem();
        const sub = insertSubmission({ problemId: id, language: 'python', code: 'x' });
        conn.prepare('UPDATE oj_submissions SET case_results = ? WHERE id = ?').run(
            JSON.stringify([
                { caseId: 1, idx: 1, kind: 'sample', verdict: 'AC', timeMs: 5 },
                { caseId: 2, idx: 2, verdict: '不存在的判定', timeMs: 5 },   // 判定不合法
                { caseId: 3, idx: 3, kind: 'small', verdict: 'WA' },          // 少了 timeMs
                null,
            ]),
            sub,
        );
        const results = listSubmissions({}).items[0].caseResults;
        expect(results).toHaveLength(1);
        expect(results[0].verdict).toBe('AC');
    });

    it('按题目过滤', () => {
        const a = makeProblem({ title: 'A' });
        const b = makeProblem({ title: 'B' });
        insertSubmission({ problemId: a, language: 'python', code: 'x' });
        insertSubmission({ problemId: b, language: 'python', code: 'y' });
        expect(listSubmissions({ problemId: a }).total).toBe(1);
        expect(listSubmissions({}).total).toBe(2);
    });
});

describe('题目更新', () => {
    it('只认白名单里的字段，别的键一律忽略', () => {
        const id = makeProblem();
        // solutionCode 不在可改字段里 —— 标准解一旦改了，已有测试点的
        // 期望输出就跟它对不上了，那道题会静默地变成一道错题
        updateProblem(id, { status: 'partial', genWarnings: ['某计划失败'] });
        updateProblem(id, { solutionCode: '改掉' } as never);

        const p = getProblem(id)!;
        expect(p.status).toBe('partial');
        expect(p.genWarnings).toEqual(['某计划失败']);
        expect(p.solutionCode).toBe('print(1)');
    });

    it('空补丁不炸也不动数据', () => {
        const id = makeProblem();
        const before = getProblem(id)!.updatedAt;
        updateProblem(id, {});
        expect(getProblem(id)!.updatedAt).toBe(before);
    });
});

describe('设置', () => {
    it('默认值', () => {
        expect(getOjSettings()).toEqual({ pythonPath: 'python', genConcurrency: 3 });
    });

    it('Python 路径清空要回落成 python', () => {
        // 存一个空串的话，之后每次 spawn 都失败，而报出来的错
        // （ENOENT ''）完全看不出是设置被清掉了
        saveOjSettings({ pythonPath: '   ' });
        expect(getOjSettings().pythonPath).toBe('python');
    });

    it('并发数钳在 1~6', () => {
        saveOjSettings({ genConcurrency: 99 });
        expect(getOjSettings().genConcurrency).toBe(6);
        saveOjSettings({ genConcurrency: 0 });
        expect(getOjSettings().genConcurrency).toBe(1);
    });

    it('只改一项不影响另一项', () => {
        saveOjSettings({ pythonPath: 'py', genConcurrency: 5 });
        saveOjSettings({ genConcurrency: 2 });
        expect(getOjSettings()).toEqual({ pythonPath: 'py', genConcurrency: 2 });
    });
});
