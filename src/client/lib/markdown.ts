// 卡片背面的 Markdown 渲染。
//
// marked 负责转 HTML，DOMPurify 负责洗干净再塞进页面 ——
// 卡片内容可以从任意 JSON 文件导入，不能假定它是可信的。

import { marked } from 'marked';
import DOMPurify from 'dompurify';

marked.setOptions({
    gfm: true,
    breaks: true,     // 卡片内容里的单个换行就是换行，别按 Markdown 原意吃掉
});

export function renderMarkdown(src: string): string {
    const raw = marked.parse(src ?? '', { async: false }) as string;
    return DOMPurify.sanitize(raw, { USE_PROFILES: { html: true } });
}
