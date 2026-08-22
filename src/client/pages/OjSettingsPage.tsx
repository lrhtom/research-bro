// OJ 的设置。真正属于这一块的只有两项：**Python 路径**和**生成并发数**。
//
// 接口地址 / API Key / 模型名不在这儿另存一套 —— 那是全站共用的一份，
// 这一页只摆一个下拉栏选用哪个。原来的 ai_oj 是个独立应用，自己带一套
// API 配置是应该的；并进工具箱之后再存第二份，结果只会是
// 「口语练习换了模型，出题还在用旧的」这种谁都想不到的事。
//
// 增删改在个人中心的「AI 配置」面板里做，全站就那一处。

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import AppShell from '@/components/AppShell';
import AiModelSelect from '@/components/ai/AiModelSelect';
import { apiOjSaveSettings, apiOjSettings, apiOjTestPython } from '@/lib/api';
import { OJ_SECTIONS } from '@/lib/nav';
import type { OjSettings } from '../../shared/oj';

export default function OjSettingsPage() {
    const [settings, setSettings] = useState<OjSettings | null>(null);
    const [pythonPath, setPythonPath] = useState('');
    const [concurrency, setConcurrency] = useState(3);

    const [busy, setBusy] = useState('');
    const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
    const [pyResult, setPyResult] = useState<{ ok: boolean; message: string } | null>(null);

    useEffect(() => {
        document.title = 'OJ 设置 · 工具箱';
        void apiOjSettings()
            .then((s) => {
                setSettings(s.settings);
                setPythonPath(s.settings.pythonPath);
                setConcurrency(s.settings.genConcurrency);
            })
            .catch((e: unknown) => setMsg({ kind: 'err', text: e instanceof Error ? e.message : '读不出来' }));
    }, []);

    async function save() {
        setBusy('save');
        setMsg(null);
        try {
            const next = await apiOjSaveSettings({ pythonPath, genConcurrency: concurrency });
            setSettings(next);
            setPythonPath(next.pythonPath);
            setConcurrency(next.genConcurrency);
            setMsg({ kind: 'ok', text: '存好了，立刻生效。' });
        } catch (e) {
            setMsg({ kind: 'err', text: e instanceof Error ? e.message : '保存失败' });
        } finally {
            setBusy('');
        }
    }

    async function testPy() {
        setBusy('py');
        setPyResult(null);
        try {
            // 先把当前填的存下去再测 —— 不然测的是上一次存的那个路径，
            // 人改了输入框却看到旧结果，会以为改动没生效
            const next = await apiOjSaveSettings({ pythonPath, genConcurrency: concurrency });
            setSettings(next);
            setPyResult(await apiOjTestPython());
        } catch (e) {
            setPyResult({ ok: false, message: e instanceof Error ? e.message : '测不了' });
        } finally {
            setBusy('');
        }
    }

    const dirty = settings !== null
        && (settings.pythonPath !== pythonPath || settings.genConcurrency !== concurrency);

    return (
        <AppShell title="OJ 设置" subtitle="Judge & Generation Settings" sections={OJ_SECTIONS} width="medium">
            <p className="u-aside">
                <i className="fas fa-circle-info" />
                判题是在<b>这台电脑上真的跑 Python</b> —— 你的代码、AI 写的数据生成器、AI 写的标准解，
                三样都在子进程里执行，不联网也能判。所以下面这个 Python 路径必须填对，
                不然出题和判题都动不了。
            </p>

            <div className="u-head"><h2><i className="fas fa-robot" /> AI 模型</h2></div>
            <p className="u-note">
                出题用的就是这一套。要加、改、删模型，去
                <Link to="/me">个人中心</Link> 的「AI 配置」——
                那是全站唯一管模型的地方，这里只负责选一个。
            </p>
            <AiModelSelect />

            <div className="u-head"><h2><i className="fab fa-python" /> 判题环境</h2></div>

            <div className="config-card oj-settings">
                <label className="oj-field">
                    <span>Python 路径</span>
                    <input
                        value={pythonPath}
                        onChange={(e) => setPythonPath(e.target.value)}
                        placeholder="python"
                        spellCheck={false}
                    />
                    <em className="u-note">
                        一般填 <code>python</code> 就行。Windows 上如果 <code>python</code> 会被商店的占位程序劫持，
                        改填 <code>py</code> 或者绝对路径，比如 <code>C:\Python312\python.exe</code>。
                    </em>
                </label>

                <label className="oj-field">
                    <span>出题时的并发数：<b className="u-num">{concurrency}</b></span>
                    <input
                        type="range"
                        min={1}
                        max={6}
                        value={concurrency}
                        onChange={(e) => setConcurrency(Number(e.target.value))}
                    />
                    <em className="u-note">
                        同时给几个测试计划造数据。调大出题快，但会同时跑好几个 Python 进程。
                        判题的时候这一路会<b>自动让路</b> —— 判 TLE 靠的是墙钟计时，
                        让出题在旁边抢 CPU 会把本来能过的代码判成超时。
                    </em>
                </label>

                <div className="oj-gen-actions">
                    <button
                        type="button"
                        className="u-btn u-btn-primary"
                        disabled={busy !== '' || !dirty}
                        onClick={() => void save()}
                    >
                        <i className={'fas ' + (busy === 'save' ? 'fa-spinner fa-spin' : 'fa-floppy-disk')} />
                        {dirty ? ' 保存' : ' 已是最新'}
                    </button>
                    <button
                        type="button"
                        className="fc-btn"
                        disabled={busy !== ''}
                        onClick={() => void testPy()}
                    >
                        <i className={'fas ' + (busy === 'py' ? 'fa-spinner fa-spin' : 'fa-vial')} /> 测一下 Python
                    </button>
                </div>

                {pyResult && (
                    <p className={pyResult.ok ? 'fc-ok' : 'fc-error'}>
                        <i className={'fas ' + (pyResult.ok ? 'fa-circle-check' : 'fa-circle-xmark')} />
                        {' '}{pyResult.message}
                    </p>
                )}

                {msg && (
                    <p className={msg.kind === 'ok' ? 'fc-ok' : 'fc-error'}>
                        <i className={'fas ' + (msg.kind === 'ok' ? 'fa-circle-check' : 'fa-circle-xmark')} />
                        {' '}{msg.text}
                    </p>
                )}
            </div>

            <div className="u-head"><h2><i className="fas fa-database" /> 数据存在哪儿</h2></div>
            <p className="u-note">
                题目、测试点、提交记录全在本机的 <code>data/app.db</code> 里，跟三线表、记忆卡、
                口语练习记录同一个库文件，<b>不上传任何地方</b>。
                单个大数据测试点可能有几 MB，几十道题下来库文件会明显变大 —— 不做的题记得删掉。
            </p>
        </AppShell>
    );
}
