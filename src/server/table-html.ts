// ============================================================
//  表格 HTML 的服务端处理：清洗 + 形状解析
//
//  旧版这两件事在浏览器里用 DOMParser 做（见 tools/three-line-table/js/backup.js）。
//  现在写库这一步在服务端，用 node-html-parser 重做一遍 —— 好处是
//  「进库的 HTML 一定是洗过的」，不管它是从编辑器来的还是从备份文件恢复的。
// ============================================================

import { parse } from 'node-html-parser';

/** 会被整段丢掉的标签：能执行脚本、能发起请求、或者在三线表里没有意义 */
const DROP_TAGS = 'script, iframe, object, embed, link, meta, base, form, svg, audio, video';

/** 带 URL 语义的属性，需要防 javascript: 协议 */
const URL_ATTRS = /^(src|href|xlink:href|action|formaction)$/;

export interface TableShape {
    rows: number;
    cols: number;
    caption: string;
}

/**
 * 清洗一段表格 HTML。
 *
 * 备份文件可能来自别处，里面的 HTML 会被塞回页面渲染，必须先洗一遍：
 * 去掉可执行标签、on* 事件处理器、javascript: 协议。
 * node-html-parser 只做字符串解析，不执行脚本也不发请求，洗完再用是安全的。
 */
export function sanitizeTableHtml(html: string): string {
    const root = parse(String(html ?? ''), {
        // 让 <script> / <style> 的内容也进解析树，这样才能被 querySelectorAll 找到并整段删掉
        blockTextElements: { script: true, noscript: true, style: true, pre: true },
    });

    root.querySelectorAll(DROP_TAGS).forEach((node) => node.remove());

    root.querySelectorAll('*').forEach((el) => {
        Object.keys(el.attributes).forEach((raw) => {
            const name = raw.toLowerCase();
            const val = String(el.attributes[raw] ?? '');
            if (name.startsWith('on')) {
                el.removeAttribute(raw);
            } else if (URL_ATTRS.test(name) && /^\s*javascript:/i.test(val)) {
                el.removeAttribute(raw);
            }
        });
    });

    return root.toString();
}

/** 解析出行列数与表题，用于列表展示 —— 对应 tables 表里的三个派生列 */
export function tableShape(html: string): TableShape {
    try {
        const root = parse(String(html ?? ''));
        const table = root.querySelector('table');
        if (!table) return { rows: 0, cols: 0, caption: '' };

        const headRow = table.querySelector('thead tr');
        const cols = headRow ? headRow.childNodes.filter(isElement).length : 0;
        const rows = table.querySelectorAll('tbody tr').length;
        const cap = table.querySelector('caption');
        return { rows, cols, caption: cap ? cap.textContent.trim() : '' };
    } catch {
        return { rows: 0, cols: 0, caption: '' };
    }
}

/** 里面到底有没有一张表 —— 恢复备份时用来筛掉无效条目 */
export function looksLikeTable(html: string): boolean {
    return /<table[\s>]/i.test(String(html ?? ''));
}

function isElement(node: { nodeType: number }): boolean {
    return node.nodeType === 1;
}
