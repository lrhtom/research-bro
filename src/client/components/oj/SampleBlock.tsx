// 样例的输入/输出对。
//
// 题面里**不含**样例（出题的提示词明确禁止了），样例一律从标成 sample 的
// 测试点渲染出来。这么做是为了让题面上写的样例和真正被判的数据永远是同一份 ——
// 让 AI 在题面里另写一组样例的话，它跟测试点对不上是迟早的事，
// 而那种「照着题面样例写、跑起来却 WA」的题最消磨人。

import { useState } from 'react';
import type { OjTestCase } from '../../../shared/oj';

function CopyButton({ text }: { text: string }) {
    const [done, setDone] = useState(false);

    return (
        <button
            type="button"
            className="fc-btn fc-btn-quiet oj-copy"
            onClick={() => {
                void navigator.clipboard.writeText(text).then(() => {
                    setDone(true);
                    setTimeout(() => setDone(false), 1400);
                }).catch(() => { /* 剪贴板被浏览器拦了就当没点过，不弹错 */ });
            }}
        >
            <i className={'fas ' + (done ? 'fa-check' : 'fa-copy')} /> {done ? '已复制' : '复制'}
        </button>
    );
}

export default function SampleBlock({ samples }: { samples: OjTestCase[] }) {
    if (samples.length === 0) {
        return (
            <p className="fc-warn oj-no-sample">
                <i className="fas fa-circle-info" /> 这道题没有样例测试点 —— 生成时样例那几个计划全失败了。
                「测试数据」那一栏里能看到实际的输入输出。
            </p>
        );
    }

    return (
        <div className="oj-samples">
            {samples.map((s, i) => (
                <div key={s.id} className="oj-sample">
                    <div className="oj-sample-head">样例 {i + 1}</div>
                    <div className="oj-sample-cols">
                        <div className="oj-sample-col">
                            <div className="oj-sample-label">输入 <CopyButton text={s.input} /></div>
                            <pre>{s.input}</pre>
                        </div>
                        <div className="oj-sample-col">
                            <div className="oj-sample-label">输出 <CopyButton text={s.output} /></div>
                            <pre>{s.output}</pre>
                        </div>
                    </div>
                </div>
            ))}
        </div>
    );
}
