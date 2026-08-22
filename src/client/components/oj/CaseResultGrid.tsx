// 逐测试点的结果网格。
//
// 为什么是网格不是列表：一道题动辄一两百个测试点，列成一竖列要滚半天，
// 而这里真正要回答的问题只有两个 —— 「过了多少」和「第一个没过的在哪」。
// 一屏铺满的小方块最快答得上来，点开某一个才看它的具体报错。

import { useState } from 'react';
import type { OjCaseResult } from '../../../shared/oj';
import { OJ_KIND_LABELS, OJ_VERDICT_LABELS } from '../../../shared/oj';
import { msText } from '@/lib/format';

interface Props {
    results: OjCaseResult[];
    /** 一共多少个点。判题还在跑时它比 results.length 大，剩下的画成待评测的空格 */
    total?: number;
}

export default function CaseResultGrid({ results, total }: Props) {
    const [picked, setPicked] = useState<number | null>(null);

    const size = Math.max(total ?? 0, results.length);
    // 还没跑到的点补成 null，格子数从一开始就是最终数量 ——
    // 否则网格会随着判题一格一格长出来，整块跟着重排，看着很晃
    const cells: Array<OjCaseResult | null> = Array.from(
        { length: size },
        (_, i) => results[i] ?? null,
    );

    const current = picked === null ? null : results[picked] ?? null;

    return (
        <div className="oj-cases">
            <div className="oj-case-grid">
                {cells.map((r, i) => (
                    <button
                        key={i}
                        type="button"
                        className={'oj-case-cell ' + (r ? `v-${r.verdict.toLowerCase()}` : 'v-pending')
                            + (picked === i ? ' on' : '')}
                        disabled={!r}
                        title={r
                            ? `#${r.idx} ${OJ_KIND_LABELS[r.kind]} · ${OJ_VERDICT_LABELS[r.verdict]} · ${msText(r.timeMs)}`
                            : `#${i + 1} 排队中`}
                        onClick={() => setPicked(picked === i ? null : i)}
                    >
                        {i + 1}
                    </button>
                ))}
            </div>

            {current && (
                <div className={'oj-case-detail v-' + current.verdict.toLowerCase()}>
                    <div className="oj-case-detail-head">
                        <b>#{current.idx}</b>
                        <span className="oj-badge oj-kind">{OJ_KIND_LABELS[current.kind]}</span>
                        <span className={'oj-badge oj-verdict v-' + current.verdict.toLowerCase()}>
                            {current.verdict} {OJ_VERDICT_LABELS[current.verdict]}
                        </span>
                        <span className="u-num oj-case-time">{msText(current.timeMs)}</span>
                        <button type="button" className="fc-btn fc-btn-quiet" onClick={() => setPicked(null)}>
                            <i className="fas fa-xmark" />
                        </button>
                    </div>
                    <pre className="oj-case-msg">
                        {current.message || (current.verdict === 'AC' ? '这个点过了。' : '（没有更多信息）')}
                    </pre>
                </div>
            )}
        </div>
    );
}
