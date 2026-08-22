// 题面。Markdown + LaTeX，渲染在 lib/oj-markdown.ts 里（那边要动态 import KaTeX，
// 所以是异步的），这里只负责把结果贴进 DOM 并处理好「贴到一半组件被卸载」。

import { useEffect, useState } from 'react';
import { renderStatement } from '@/lib/oj-markdown';

export default function Statement({ md }: { md: string }) {
    const [html, setHtml] = useState('');
    const [pending, setPending] = useState(true);

    useEffect(() => {
        // 组件卸载、或者 md 换了一份之后，上一次那个还没回来的渲染结果就作废了。
        // 不拦的话切题时会出现「新题面闪一下又被旧题面盖回去」——
        // 两次渲染的耗时不一样（第一次要连 KaTeX 一起装），后发的可能先到。
        let alive = true;
        setPending(true);
        void renderStatement(md)
            .then((h) => { if (alive) { setHtml(h); setPending(false); } })
            .catch(() => { if (alive) { setHtml(''); setPending(false); } });
        return () => { alive = false; };
    }, [md]);

    if (pending && !html) {
        return <div className="oj-statement is-loading"><i className="fas fa-spinner fa-spin" /> 正在渲染题面…</div>;
    }

    // 已经过 DOMPurify 洗过（含 MathML 白名单），见 lib/oj-markdown.ts
    return <div className="oj-statement" dangerouslySetInnerHTML={{ __html: html }} />;
}
