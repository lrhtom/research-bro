// 把卡片答案里的 ```mermaid 代码块换成真正的图（流程图 / 时序图 / 思维导图…）。
//
// 两点取舍：
//   · mermaid 打包出来一兆多，所以是动态 import —— 一张图都没有的卡片不会碰它。
//   · 画失败就把原来的代码块留在原地，不吞内容：宁可看到源码，也不该看到空白。

import type { Mermaid } from 'mermaid';

let ready: Promise<Mermaid> | null = null;

function ensureMermaid(): Promise<Mermaid> {
    ready ??= import('mermaid').then(({ default: mermaid }) => {
        mermaid.initialize({
            startOnLoad: false,
            // securityLevel 'strict'：图里的标签会被 mermaid 自己洗一遍，
            // 卡片可以从任意 JSON 导入，同样不能假定它可信。
            securityLevel: 'strict',
            theme: 'base',
            fontFamily:
                "var(--font-inter, 'Inter'), -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif",
            themeVariables: {
                fontSize: '14px',
                primaryColor: '#eef2ff',
                primaryBorderColor: '#818cf8',
                primaryTextColor: '#1f2937',
                lineColor: '#94a3b8',
                secondaryColor: '#f1f5f9',
                tertiaryColor: '#fff7ed',
                noteBkgColor: '#fef9c3',
                noteBorderColor: '#facc15',
            },
            flowchart: { useMaxWidth: true, htmlLabels: true, curve: 'basis', padding: 12 },
            sequence: { useMaxWidth: true, wrap: true, width: 165, actorMargin: 42 },
            mindmap: { useMaxWidth: true, padding: 10 },
        });
        return mermaid;
    });
    return ready;
}

let seq = 0;

/** 渲染 root 里所有还没画过的 mermaid 代码块。可以对同一个容器重复调用。 */
export async function renderDiagrams(root: HTMLElement): Promise<void> {
    const blocks = Array.from(
        root.querySelectorAll<HTMLElement>('pre > code.language-mermaid'),
    );
    if (blocks.length === 0) return;

    const mermaid = await ensureMermaid();

    for (const code of blocks) {
        const pre = code.parentElement;
        // 上一轮渲染后 React 又重画了这块 HTML → pre 已经不在文档里了，跳过
        if (!pre || !pre.isConnected) continue;

        const source = code.textContent ?? '';
        if (!source.trim()) continue;

        try {
            const { svg } = await mermaid.render(`fc-diagram-${(seq += 1)}`, source);
            const figure = document.createElement('figure');
            figure.className = 'fc-diagram';
            figure.innerHTML = svg;
            pre.replaceWith(figure);
        } catch {
            // 语法写错了：保留代码块原样，顺手标记一下别再重试
            code.classList.remove('language-mermaid');
            code.classList.add('language-mermaid-broken');
        }
    }
}
