// 各工具内部的二级导航。
// 放一处是为了让「记忆卡」下面挂哪几项，在它的四个页面上完全一致 ——
// 分散写四遍，迟早有一页少一项。

import type { ShellSection } from '@/components/AppShell';

export const FLASHCARD_SECTIONS: ShellSection[] = [
    { to: '/tools/flashcards', label: '学习计划', icon: 'fa-layer-group', end: true },
    { to: '/tools/flashcards/stats', label: '学习统计', icon: 'fa-chart-line' },
];

export const SPEAKING_SECTIONS: ShellSection[] = [
    { to: '/tools/speaking', label: '开始练习', icon: 'fa-play', end: true },
    { to: '/tools/speaking/history', label: '练习记录', icon: 'fa-clock-rotate-left' },
];
