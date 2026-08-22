// 各工具内部的二级导航。
// 放一处是为了让「记忆卡」下面挂哪几项，在它的四个页面上完全一致 ——
// 分散写四遍，迟早有一页少一项。

import type { ShellSection } from '@/components/AppShell';

export const FLASHCARD_SECTIONS: ShellSection[] = [
    { to: '/tools/flashcards', label: '学习计划', icon: 'fa-layer-group', end: true },
    // 统计住在个人中心了。这里仍然留一项 —— 从记忆卡想看统计是最常见的动线，
    // 少了它就得先回首页再进个人中心
    { to: '/me', label: '学习统计', icon: 'fa-chart-line' },
];

export const SPEAKING_SECTIONS: ShellSection[] = [
    { to: '/tools/speaking', label: '开始练习', icon: 'fa-play', end: true },
    { to: '/tools/speaking/history', label: '练习记录', icon: 'fa-clock-rotate-left' },
];

export const OJ_SECTIONS: ShellSection[] = [
    { to: '/tools/oj', label: '题库', icon: 'fa-list-check', end: true },
    { to: '/tools/oj/generate', label: 'AI 出题', icon: 'fa-wand-magic-sparkles' },
    { to: '/tools/oj/submissions', label: '提交记录', icon: 'fa-clock-rotate-left' },
    { to: '/tools/oj/settings', label: '设置', icon: 'fa-gear' },
];
