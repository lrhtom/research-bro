// ============================================================
//  自己存下来的口语场景
//
//  内置场景写死在 src/shared/speaking.ts（那是代码，跟着版本走）；
//  这里放你自己写的、或者「随机来一个」抽到觉得好用的那些。
//  两者在选场景那一格并排显示，区别只有「能不能删」。
//
//  内容审核在**存的时候**做一次（路由层调 check-scenario 那套），
//  存进来之后文本不再变，每次开练重审只是白花钱。
// ============================================================

import { db, nowIso } from './db.js';

const LABEL_MAX = 60;
const SCENARIO_MAX = 2000;

interface ScenarioRecord {
    id: number;
    label: string;
    scenario: string;
    created_at: string;
    updated_at: string;
}

export interface SavedScenario {
    id: number;
    label: string;
    scenario: string;
    updatedAt: string;
}

export class ScenarioError extends Error {
    constructor(message: string, readonly status = 400) {
        super(message);
    }
}

function toView(r: ScenarioRecord): SavedScenario {
    return { id: r.id, label: r.label, scenario: r.scenario, updatedAt: r.updated_at };
}

export function listScenarios(): SavedScenario[] {
    const rows = db().prepare(
        'SELECT * FROM speaking_scenarios ORDER BY updated_at DESC, id DESC',
    ).all() as ScenarioRecord[];
    return rows.map(toView);
}

export function getScenario(id: number): SavedScenario | null {
    const row = db().prepare('SELECT * FROM speaking_scenarios WHERE id = ?')
        .get(id) as ScenarioRecord | undefined;
    return row ? toView(row) : null;
}

export function createScenario(input: { label?: unknown; scenario?: unknown }): SavedScenario {
    const scenario = String(input.scenario ?? '').trim();
    if (!scenario) throw new ScenarioError('场景描述不能为空');
    if (scenario.length > SCENARIO_MAX) throw new ScenarioError(`场景描述太长了（上限 ${SCENARIO_MAX} 字）`);

    // 名字留空就拿描述开头顶上 —— 列表里不该出现一行没名字的
    const label = String(input.label ?? '').trim().slice(0, LABEL_MAX) || scenario.slice(0, 20);

    const now = nowIso();
    const info = db().prepare(
        `INSERT INTO speaking_scenarios (label, scenario, created_at, updated_at)
         VALUES (?, ?, ?, ?)`,
    ).run(label, scenario, now, now);
    return getScenario(Number(info.lastInsertRowid))!;
}

/** 只改传进来的字段 */
export function updateScenario(
    id: number,
    patch: { label?: unknown; scenario?: unknown },
): SavedScenario | null {
    if (!getScenario(id)) return null;

    const sets: string[] = [];
    const args: unknown[] = [];

    if ('label' in patch) {
        sets.push('label = ?');
        args.push(String(patch.label ?? '').trim().slice(0, LABEL_MAX));
    }
    if ('scenario' in patch) {
        const s = String(patch.scenario ?? '').trim();
        if (!s) throw new ScenarioError('场景描述不能为空');
        if (s.length > SCENARIO_MAX) throw new ScenarioError(`场景描述太长了（上限 ${SCENARIO_MAX} 字）`);
        sets.push('scenario = ?'); args.push(s);
    }

    if (sets.length) {
        sets.push('updated_at = ?');
        args.push(nowIso());
        db().prepare(`UPDATE speaking_scenarios SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);
    }

    const row = db().prepare('SELECT label, scenario FROM speaking_scenarios WHERE id = ?').get(id) as
        { label: string; scenario: string };
    if (!row.label) {
        db().prepare('UPDATE speaking_scenarios SET label = ? WHERE id = ?')
            .run(row.scenario.slice(0, 20), id);
    }
    return getScenario(id);
}

export function deleteScenario(id: number): boolean {
    return db().prepare('DELETE FROM speaking_scenarios WHERE id = ?').run(id).changes > 0;
}
