// 「测试数据」那一栏：列出全部测试点，点开某一个看完整数据与造它的生成器。
//
// 列表只拿预览（前 200 字）与体积 —— 一道题的测试点加起来可能上百 MB，
// 全量下发会把详情页直接拖死。点开哪个才去要哪个的完整数据。

import { useEffect, useState } from 'react';
import type { OjTestCase, OjTestCaseMeta } from '../../../shared/oj';
import { apiOjTestcase, apiOjTestcases } from '@/lib/api';
import { bytesText } from '@/lib/format';
import { KindBadge } from './Badges';
import CodeEditor from './CodeEditor';

export default function TestcasesTab({ problemId }: { problemId: number }) {
    const [metas, setMetas] = useState<OjTestCaseMeta[] | null>(null);
    const [error, setError] = useState('');
    const [openId, setOpenId] = useState<number | null>(null);
    const [full, setFull] = useState<OjTestCase | null>(null);
    const [loadingFull, setLoadingFull] = useState(false);

    useEffect(() => {
        let alive = true;
        setMetas(null);
        setError('');
        void apiOjTestcases(problemId)
            .then((cs) => { if (alive) setMetas(cs); })
            .catch((e: unknown) => { if (alive) setError(e instanceof Error ? e.message : '拉不到测试点'); });
        return () => { alive = false; };
    }, [problemId]);

    useEffect(() => {
        if (openId === null) { setFull(null); return; }
        let alive = true;
        setLoadingFull(true);
        setFull(null);
        void apiOjTestcase(openId)
            .then((c) => { if (alive) { setFull(c); setLoadingFull(false); } })
            .catch(() => { if (alive) setLoadingFull(false); });
        return () => { alive = false; };
    }, [openId]);

    if (error) return <p className="fc-error">{error}</p>;
    if (metas === null) return <p className="u-note"><i className="fas fa-spinner fa-spin" /> 正在读测试点…</p>;
    if (metas.length === 0) {
        return <p className="u-empty">这道题一个测试点都没有 —— 生成时全部失败了，题目详情上方的警告里有原因。</p>;
    }

    const totalBytes = metas.reduce((s, m) => s + m.inputBytes + m.outputBytes, 0);

    return (
        <div className="oj-testcases">
            <p className="u-note">
                共 <b className="u-num">{metas.length}</b> 个测试点，
                合计 <b className="u-num">{bytesText(totalBytes)}</b>。
                点任意一行看完整数据和造它的那份生成器。
            </p>

            <div className="oj-table-wrap">
                <table className="oj-table">
                    <thead>
                        <tr>
                            <th>#</th>
                            <th>类型</th>
                            <th>计划</th>
                            <th>输入预览</th>
                            <th>输出预览</th>
                            <th>体积</th>
                        </tr>
                    </thead>
                    <tbody>
                        {metas.map((m) => (
                            <tr
                                key={m.id}
                                className={'oj-tc-row' + (openId === m.id ? ' on' : '')}
                                onClick={() => setOpenId(openId === m.id ? null : m.id)}
                            >
                                <td className="u-num">{m.idx}</td>
                                <td>
                                    <KindBadge kind={m.kind} />
                                    {m.isSample && <span className="oj-badge oj-sample-tag">样例</span>}
                                </td>
                                <td className="oj-tc-plan" title={m.planDesc}>{m.planName}</td>
                                <td><code className="oj-tc-preview">{m.inputPreview}</code></td>
                                <td><code className="oj-tc-preview">{m.outputPreview}</code></td>
                                <td className="u-num oj-tc-bytes">
                                    {bytesText(m.inputBytes)} / {bytesText(m.outputBytes)}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>

            {openId !== null && (
                <div className="oj-tc-detail">
                    {loadingFull && <p className="u-note"><i className="fas fa-spinner fa-spin" /> 正在读完整数据…</p>}
                    {full && (
                        <>
                            <div className="u-head">
                                <h2>测试点 #{full.idx} · {full.planName}</h2>
                                <button
                                    type="button"
                                    className="fc-btn fc-btn-quiet u-head-act"
                                    onClick={() => setOpenId(null)}
                                >
                                    <i className="fas fa-xmark" /> 收起
                                </button>
                            </div>

                            {full.planDesc && <p className="u-note">{full.planDesc}</p>}

                            <div className="oj-sample-cols">
                                <div className="oj-sample-col">
                                    <div className="oj-sample-label">
                                        输入 <span className="u-num">{bytesText(full.inputBytes)}</span>
                                    </div>
                                    {/* 大数据点可能有好几 MB，pre 自带滚动条，别让它把页面撑爆 */}
                                    <pre className="oj-tc-full">{full.input}</pre>
                                </div>
                                <div className="oj-sample-col">
                                    <div className="oj-sample-label">
                                        期望输出 <span className="u-num">{bytesText(full.outputBytes)}</span>
                                    </div>
                                    <pre className="oj-tc-full">{full.output}</pre>
                                </div>
                            </div>

                            {full.generatorCode && (
                                <>
                                    <div className="u-head"><h2><i className="fas fa-dice" /> 造这组数据的生成器</h2></div>
                                    <CodeEditor value={full.generatorCode} language="python" height="260px" readOnly />
                                </>
                            )}
                        </>
                    )}
                </div>
            )}
        </div>
    );
}
