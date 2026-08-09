// ============================================================
//  把 seed/decks/*.json 灌进数据库
//
//  用法：
//      npm run seed              # 幂等追加：同名计划已存在就跳过
//      npm run seed -- --replace # 同名计划先删掉再重建
//      npm run seed -- --sync    # 只把改过的答案覆盖进已有卡片，进度一张不动
//      npm run seed -- --check   # 只校验不写库
//
//  走的是和网页导入完全相同的代码路径（normalizeDeck → createPlan → importCards），
//  所以卡片的 FSRS 初始状态跟手动导入的一模一样。
//
//  --replace 会连人带库删掉重建，FSRS 进度和复习流水一并没了；
//  已经开始复习之后再改答案文案（比如给答案补插图），要用 --sync：
//  按「同一副牌里 front 相同」认卡，只 UPDATE back，调度状态一个字段都不碰。
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { db } from '../src/server/db.js';
import {
    createCard, createPlan, deletePlan, importCards, listCards, listPlans, updateCard,
} from '../src/server/study.js';
import { normalizeDeck } from '../src/shared/card-import.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DECK_DIR = path.join(HERE, '..', 'seed', 'decks');

const args = process.argv.slice(2);
const replace = args.includes('--replace');
const sync = args.includes('--sync');
const checkOnly = args.includes('--check');

if (replace && sync) {
    console.error('✗ --replace 和 --sync 是两条相反的路，只能选一个');
    process.exit(1);
}

if (!fs.existsSync(DECK_DIR)) {
    console.error(`✗ 找不到牌组目录：${DECK_DIR}`);
    process.exit(1);
}

const files = fs.readdirSync(DECK_DIR).filter((f) => f.endsWith('.json')).sort();
if (files.length === 0) {
    console.error(`✗ ${DECK_DIR} 里没有 .json 文件`);
    process.exit(1);
}

interface Row {
    file: string;
    name: string;
    cards: number;
    status: string;
    note: string;
}

const rows: Row[] = [];
let hardError = false;

// ---------- 先全部解析校验，有问题的先报出来 ----------

interface Parsed {
    file: string;
    name: string;
    description: string;
    dailyNewLimit: number | undefined;
    cards: Array<{ front: string; back: string }>;
    warnings: string[];
}

const parsedDecks: Parsed[] = [];

for (const file of files) {
    const full = path.join(DECK_DIR, file);
    let raw: unknown;
    try {
        raw = JSON.parse(fs.readFileSync(full, 'utf8'));
    } catch (err) {
        rows.push({
            file, name: '—', cards: 0, status: '✗ JSON 非法',
            note: err instanceof Error ? err.message.slice(0, 80) : String(err),
        });
        hardError = true;
        continue;
    }

    const result = normalizeDeck(raw);
    if (!result.ok || !result.deck) {
        rows.push({ file, name: '—', cards: 0, status: '✗ 解析失败', note: result.error ?? '' });
        hardError = true;
        continue;
    }

    const meta = raw as { name?: unknown; description?: unknown };
    const name = typeof meta.name === 'string' && meta.name.trim()
        ? meta.name.trim()
        : path.basename(file, '.json');

    // 质量自检：front 太短基本就是只写了个名词，不符合「问题要完整无歧义」的要求
    const warnings = [...result.warnings];
    const shortFronts = result.deck.cards.filter((c) => c.front.length < 8).length;
    if (shortFronts > 0) warnings.push(`${shortFronts} 张卡的问题过短，可能只写了名词`);
    const emptyBacks = result.deck.cards.filter((c) => !c.back.trim()).length;
    if (emptyBacks > 0) warnings.push(`${emptyBacks} 张卡没有答案`);
    const dupes = result.deck.cards.length - new Set(result.deck.cards.map((c) => c.front)).size;
    if (dupes > 0) warnings.push(`${dupes} 张卡的问题重复`);

    parsedDecks.push({
        file,
        name,
        description: typeof meta.description === 'string' ? meta.description : '',
        dailyNewLimit: result.deck.dailyNewLimit,
        cards: result.deck.cards,
        warnings,
    });
}

// ---------- 写库 ----------

if (!checkOnly && !hardError) {
    const existing = new Map(listPlans().map((p) => [p.name, p.id]));

    for (const [i, deck] of parsedDecks.entries()) {
        const already = existing.get(deck.name);
        if (already !== undefined) {
            // --sync：认卡不认表，只覆盖 back，调度状态原样保留
            if (sync) {
                const byFront = new Map(listCards(already).map((c) => [c.front, c]));
                let changed = 0;
                let added = 0;
                const run = db().transaction(() => {
                    for (const c of deck.cards) {
                        const cur = byFront.get(c.front);
                        if (!cur) { createCard(already, c.front, c.back); added += 1; continue; }
                        if (cur.back !== c.back) { updateCard(cur.id, { back: c.back }); changed += 1; }
                    }
                });
                run();
                const orphan = byFront.size + added - deck.cards.length;
                rows.push({
                    file: deck.file, name: deck.name, cards: changed + added,
                    status: changed || added ? '↺ 已同步' : '= 无变化',
                    note: [
                        changed ? `${changed} 张答案更新` : '',
                        added ? `${added} 张新增` : '',
                        orphan > 0 ? `${orphan} 张库里有、文件里没有（未动）` : '',
                    ].filter(Boolean).join('；'),
                });
                continue;
            }
            if (!replace) {
                rows.push({
                    file: deck.file, name: deck.name, cards: 0,
                    status: '= 已存在，跳过', note: '加 --sync 覆盖答案 / --replace 重建',
                });
                continue;
            }
            deletePlan(already);
        }

        const plan = createPlan({
            name: deck.name,
            description: deck.description,
            dailyNewLimit: deck.dailyNewLimit ?? 15,
            // 文件名带序号（01-… 02-…），照这个顺序排，列表页才是按主线从上到下
            sortOrder: i,
        });
        const n = importCards(plan.id, deck.cards);
        rows.push({
            file: deck.file, name: deck.name, cards: n,
            status: already !== undefined ? '↻ 已重建' : '+ 已导入',
            note: deck.warnings.slice(0, 2).join('；'),
        });
    }
} else {
    for (const deck of parsedDecks) {
        rows.push({
            file: deck.file, name: deck.name, cards: deck.cards.length,
            status: checkOnly ? '· 仅校验' : '· 未写库',
            note: deck.warnings.slice(0, 2).join('；'),
        });
    }
}

// ---------- 汇报 ----------

const pad = (s: string, n: number) => {
    // 中文按两个宽度算，表格才不会歪
    const w = [...s].reduce((a, ch) => a + (ch.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
    return s + ' '.repeat(Math.max(0, n - w));
};

console.log('');
console.log(`${pad('文件', 34)}${pad('牌组', 36)}${pad('卡片', 6)}${pad('状态', 16)}备注`);
console.log('─'.repeat(120));
for (const r of rows) {
    console.log(
        `${pad(r.file, 34)}${pad(r.name.slice(0, 16), 36)}${pad(String(r.cards), 6)}${pad(r.status, 16)}${r.note}`,
    );
}

const total = rows.reduce((a, r) => a + r.cards, 0);
console.log('─'.repeat(120));
console.log(`共 ${rows.length} 副牌，本次${sync ? '同步' : '写入'} ${total} 张卡片`);

if (!checkOnly && !hardError) {
    const plans = listPlans();
    const cards = (db().prepare('SELECT COUNT(*) AS n FROM cards').get() as { n: number }).n;
    console.log(`数据库现有：${plans.length} 个学习计划 / ${cards} 张卡片`);
}

if (hardError) {
    console.error('\n✗ 有文件解析失败，已跳过写库。修好之后重跑。');
    process.exit(1);
}
