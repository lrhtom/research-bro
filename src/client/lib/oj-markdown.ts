// ============================================================
//  OJ · 题面渲染（Markdown + LaTeX）
//
//  跟记忆卡那份 renderMarkdown 分开写，因为题面多一样东西：**数学公式**。
//  出题的提示词硬性要求数据范围用行内 LaTeX 写（$n \le 10^5$），
//  不渲染的话满屏都是 `$n \\le 10^5$` 这样的源码，数据范围恰恰是
//  一道题里最需要一眼看清的部分。
//
//  三点取舍：
//
//    · **KaTeX 动态 import**。它加上字体有小三百 KB，而站里只有这一处用得上，
//      不该让首页也背着它。跟 mermaid 那边一个路子（见 lib/diagrams.ts）。
//    · **公式画不出来不吞内容**。throwOnError: false —— KaTeX 会把不认识的
//      式子原样标红显示。宁可看到源码，也不该看到空白。
//    · **仍然要过 DOMPurify**。题面是 AI 生成的，跟卡片一样不能假定可信。
//      只是白名单要放开 MathML，否则 KaTeX 的输出会被洗成一团乱。
// ============================================================

import { Marked, type Tokens } from 'marked';
import DOMPurify from 'dompurify';

type KatexModule = typeof import('katex');

let katexReady: Promise<KatexModule | null> | null = null;

/**
 * 把 KaTeX 和它的样式表一起装进来。
 *
 * 装不上就返回 null（离线、CDN 被墙、构建产物缺文件都可能）——
 * 调用方会退化成「公式按纯文本显示」，题面照样能读，不至于整页打不开。
 */
function ensureKatex(): Promise<KatexModule | null> {
    katexReady ??= (async () => {
        try {
            const [mod] = await Promise.all([
                import('katex'),
                import('katex/dist/katex.min.css'),
            ]);
            return mod;
        } catch (e) {
            console.error('[oj] KaTeX 没加载起来，公式将按纯文本显示', e);
            return null;
        }
    })();
    return katexReady;
}

/** 单独一个 marked 实例：全局那个被记忆卡设过 breaks: true，题面不要那个行为 */
function makeParser(katex: KatexModule | null) {
    const instance = new Marked({
        gfm: true,
        // 题面是正经 Markdown 文档，单个换行就该按 Markdown 原意折叠掉。
        // 记忆卡那边开 breaks 是因为卡片内容是随手写的短文本，两回事。
        breaks: false,
    });

    if (!katex) return instance;

    const render = (tex: string, displayMode: boolean): string => {
        try {
            return katex.renderToString(tex, {
                displayMode,
                // 画不出来就原样标红显示，绝不抛异常把整段题面带走
                throwOnError: false,
                // KaTeX 默认允许一部分能改动全局的宏，题面来自 AI，关掉
                trust: false,
                strict: false,
            });
        } catch {
            return displayMode ? `<pre>${escapeHtml(tex)}</pre>` : escapeHtml(tex);
        }
    };

    instance.use({
        extensions: [
            /**
             * 单个 `~` 原样输出。
             *
             * GFM 允许用**一个**波浪号做删除线（`~x~` 等价于 `~~x~~`）。
             * 题面里「喵~」是高频口头禅，于是两个「喵~」之间的整句话会被
             * 配成一对删除线 —— 实测 26 个「喵~」渲染出来只剩 13 个，
             * 中间 7 段正文全画着横线。
             *
             * 只拦单个 `~`（后面不跟另一个 `~`），`~~真正的删除线~~` 照常工作。
             * 扩展的 tokenizer 在内置的 del 之前跑，所以它先把这个字符吃掉。
             */
            {
                name: 'oj-tilde',
                level: 'inline',
                start: (src: string) => src.indexOf('~'),
                tokenizer(src: string) {
                    const m = /^~(?!~)/.exec(src);
                    if (!m) return undefined;
                    return { type: 'oj-tilde', raw: m[0], text: '~' } as Tokens.Generic;
                },
                renderer: () => '~',
            },
            {
                name: 'oj-math-block',
                level: 'block',
                start: (src: string) => src.indexOf('$$'),
                tokenizer(src: string) {
                    const m = /^\$\$([\s\S]+?)\$\$(?:\n|$)/.exec(src);
                    if (!m) return undefined;
                    return { type: 'oj-math-block', raw: m[0], text: m[1].trim() } as Tokens.Generic;
                },
                renderer: (token: Tokens.Generic) =>
                    `<div class="oj-math-block">${render(token.text as string, true)}</div>`,
            },
            {
                name: 'oj-math-inline',
                level: 'inline',
                start: (src: string) => src.indexOf('$'),
                tokenizer(src: string) {
                    // 开头的 $ 后面不能紧跟空白，结尾的 $ 前面也不能 ——
                    // 否则 "$5 起，最多 $20" 这种价格会被当成一段公式吃掉。
                    // 结尾的 $ 后面也不能紧跟数字，理由同上。
                    const m = /^\$(?![\s$])((?:\\.|[^$\\])+?)(?<![\s\\])\$(?!\d)/.exec(src);
                    if (!m) return undefined;
                    return { type: 'oj-math-inline', raw: m[0], text: m[1] } as Tokens.Generic;
                },
                renderer: (token: Tokens.Generic) => render(token.text as string, false),
            },
        ],
    });

    return instance;
}

function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string
    ));
}

/**
 * 渲染题面。异步是因为 KaTeX 要动态 import。
 *
 * 洗白名单里放开了 MathML —— KaTeX 同时输出一份 MathML（给读屏软件）
 * 和一份带 class 的 HTML（给肉眼）。只留 HTML 那半的话公式还是看得见，
 * 但读屏软件会把每个符号一个个念出来，等于没有无障碍支持。
 */
export async function renderStatement(md: string): Promise<string> {
    const katex = await ensureKatex();
    const raw = makeParser(katex).parse(md ?? '', { async: false }) as string;
    return DOMPurify.sanitize(raw, {
        USE_PROFILES: { html: true, mathMl: true, svg: true },
        // KaTeX 靠内联 style 摆位（每个符号的 height / vertical-align 都是算出来的），
        // 去掉 style 属性公式就会散架
        ADD_ATTR: ['style'],
    });
}
