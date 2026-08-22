// OJ 里那几种一眼要认出来的小标签：判定、难度、测试点类型、题目状态。
//
// 全部只吐一个 <span class="oj-badge oj-xxx">，配色落在 styles/oj.css 里 ——
// 这个项目不写工具类，颜色不进 JSX。

import type { OjDifficulty, OjProblemStatus, OjTestCaseKind, OjVerdict } from '../../../shared/oj';
import { OJ_KIND_LABELS, OJ_VERDICT_LABELS } from '../../../shared/oj';

export function VerdictBadge({ verdict, full = false }: { verdict: OjVerdict; full?: boolean }) {
    return (
        <span className={`oj-badge oj-verdict v-${verdict.toLowerCase()}`} title={OJ_VERDICT_LABELS[verdict]}>
            {verdict === 'JUDGING' && <i className="fas fa-spinner fa-spin" />}
            {verdict}
            {full && <em>{OJ_VERDICT_LABELS[verdict]}</em>}
        </span>
    );
}

const DIFFICULTY_CLASS: Record<OjDifficulty, string> = {
    简单: 'd-easy',
    中等: 'd-mid',
    困难: 'd-hard',
};

export function DifficultyBadge({ difficulty }: { difficulty: OjDifficulty }) {
    return <span className={`oj-badge oj-diff ${DIFFICULTY_CLASS[difficulty]}`}>{difficulty}</span>;
}

export function KindBadge({ kind }: { kind: OjTestCaseKind }) {
    return <span className={`oj-badge oj-kind k-${kind}`}>{OJ_KIND_LABELS[kind]}</span>;
}

const STATUS_TEXT: Record<OjProblemStatus, { label: string; icon: string; cls: string }> = {
    generating: { label: '生成中', icon: 'fa-spinner fa-spin', cls: 's-gen' },
    // ready 不给徽章：绝大多数题都是这个状态，人人都戴的牌子等于没戴，
    // 只会把真正需要注意的 partial / failed 淹掉
    ready: { label: '', icon: '', cls: '' },
    partial: { label: '部分失败', icon: 'fa-triangle-exclamation', cls: 's-partial' },
    failed: { label: '生成失败', icon: 'fa-circle-xmark', cls: 's-failed' },
};

export function StatusBadge({ status, title }: { status: OjProblemStatus; title?: string }) {
    const s = STATUS_TEXT[status];
    if (!s.label) return null;
    return (
        <span className={`oj-badge oj-status ${s.cls}`} title={title}>
            <i className={'fas ' + s.icon} /> {s.label}
        </span>
    );
}
