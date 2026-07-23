// ============================================================
//  学术哥们 · 工具卡片数据
//  想新增一个工具 / 链接？只需在下面的 TOOLS 数组里加一个对象。
//
//  字段说明：
//    title    — 卡片主标题（中文）
//    subtitle — 英文副标题（小字）
//    desc     — 一段简介
//    icon     — FontAwesome 6 图标类名（如 'fa-table'）
//    href     — 跳转地址（自建工具填相对路径，外部服务填完整网址）
//    kind     — 'self' = 我们自建的工具 / 'link' = 外部链接
//    accent   — 主题色：indigo / pink / teal / amber / blue
//    badges   — 卡片底部的小标签数组（如 ['免费', '免注册']）
// ============================================================
const TOOLS = [
    {
        title: '学术三线表生成器',
        subtitle: 'Three-line Table Generator',
        desc: '在线制作标准学术三线表，支持多表管理、单元格批量样式设置，一键导出高清 PNG 与 Markdown。',
        icon: 'fa-table',
        href: 'tools/three-line-table/index.html',
        kind: 'self',
        accent: 'indigo',
        badges: ['免费', '本地保存', 'PNG 导出'],
    },
    {
        title: 'Word 转 PNG',
        subtitle: 'Word to PNG Converter',
        desc: '上传 Word 文档，一键转换为高清 PNG 图片。无需注册登录，不限次数，免费使用。',
        icon: 'fa-file-image',
        href: 'https://products.aspose.app/words/conversion/word-to-png',
        kind: 'link',
        accent: 'pink',
        badges: ['无限免费', '免注册'],
    },
];

// ---- 渲染逻辑（一般无需改动）----------------------------------

const KIND_META = {
    self: { label: '自建工具', icon: 'fa-screwdriver-wrench' },
    link: { label: '外部链接', icon: 'fa-arrow-up-right-from-square' },
};

/** 简单转义，避免数据里的特殊字符破坏 HTML */
function esc(str) {
    return String(str).replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
}

/** 根据一条工具数据生成一张卡片的 HTML */
function cardHTML(tool) {
    const meta = KIND_META[tool.kind] || KIND_META.self;
    const external = tool.kind === 'link';
    const accent = tool.accent || 'indigo';

    const badges = (tool.badges || [])
        .map((b) => `<span class="badge">${esc(b)}</span>`)
        .join('');

    const cta = external
        ? '前往使用 <i class="fas fa-arrow-up-right-from-square"></i>'
        : '打开工具 <i class="fas fa-arrow-right"></i>';

    const linkAttrs = external
        ? ' target="_blank" rel="noopener noreferrer"'
        : '';

    return `
    <a class="card accent-${esc(accent)}" href="${esc(tool.href)}"${linkAttrs}>
        <div class="card-top">
            <div class="card-icon"><i class="fas ${esc(tool.icon)}"></i></div>
            <span class="kind kind-${esc(tool.kind)}">
                <i class="fas ${meta.icon}"></i> ${meta.label}
            </span>
        </div>
        <h3 class="card-title">${esc(tool.title)}</h3>
        <p class="card-subtitle">${esc(tool.subtitle)}</p>
        <p class="card-desc">${esc(tool.desc)}</p>
        <div class="card-foot">
            <div class="badges">${badges}</div>
            <span class="cta">${cta}</span>
        </div>
    </a>`;
}

document.addEventListener('DOMContentLoaded', () => {
    const grid = document.getElementById('card-grid');
    const count = document.getElementById('tool-count');

    grid.innerHTML = TOOLS.map(cardHTML).join('');

    // 交错淡入动画
    grid.querySelectorAll('.card').forEach((card, i) => {
        card.style.animationDelay = `${i * 80}ms`;
    });

    if (count) count.textContent = `共 ${TOOLS.length} 个`;
});
