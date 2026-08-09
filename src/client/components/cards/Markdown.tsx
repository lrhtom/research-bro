// 卡片正文的渲染出口：Markdown → HTML → 再把 mermaid 代码块换成图。
//
// 学习页和编辑器预览都走这里，两边的图长得一模一样。

import { useEffect, useMemo, useRef } from 'react';
import { renderMarkdown } from '@/lib/markdown';
import { renderDiagrams } from '@/lib/diagrams';

interface Props {
    source: string;
    className?: string;
}

export default function Markdown({ source, className }: Props) {
    const ref = useRef<HTMLDivElement>(null);
    const html = useMemo(() => renderMarkdown(source), [source]);

    // React 每次改 innerHTML 都会把上一轮画好的 SVG 冲掉，所以画图这一步
    // 跟着 html 走：内容变一次，就重新画一次。
    useEffect(() => {
        const el = ref.current;
        if (el) void renderDiagrams(el);
    }, [html]);

    return <div ref={ref} className={className} dangerouslySetInnerHTML={{ __html: html }} />;
}
