// ============================================================
//  AI 悬浮球
//
//  全站右下角那颗球。拖得动、会贴边、点开是一个四页签的小面板：
//    · 问 AI —— 站内助手，能查能跳能记待办（工具循环在服务端，见 routes-assistant.ts）
//    · 翻译 —— 走站内已配好的大模型，顺带给单词的近义说法
//    · 待办 —— 存本机 SQLite
//    · 快捷 —— 同上
//  面板右上角还有一个截图按钮，把当前页面存成 PNG。
//
//  这是从另一个项目（aIELTS 的 GlobalAssistantBall）移过来的，
//  砍掉了那边特有的几样东西并说明理由：
//    · 每日签到 / 积分   —— 这个站没有账号，也没有积分这回事
//    · 中英界面切换      —— 全站中文，没有第二套文案
//    · MCP 三端点协商    —— 单机单进程，前后端一起发版，没有协商的必要
//    · 浏览器自动化 Agent（Playwright 点页面）+ 读前端源码
//                        —— 攻击面大、依赖重，换成一组只碰站内数据的工具
//    · 多引擎翻译（Google/DeepL/…） —— 会多出一套 key 和一个会挂的外部依赖，
//                        站里既然已经有大模型，就用它
//
//  全站每一页都有它，沉浸式的背卡片和口语房间也不例外。
//  代价知道两条，都可以接受：背卡片的数字键评分在焦点落进面板输入框时会失灵
//  （关掉面板就好），口语房间里两边都想用麦克风时只有一边听得到
//  （浏览器同一时刻只给一个 SpeechRecognition 实例）。
//  默认贴边收起，不点开就不会碍事。
// ============================================================

import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
    apiAssistantChat, apiAssistantStatus, apiClearDoneTodos, apiCreateShortcut, apiCreateTodo,
    apiDeleteShortcut, apiDeleteTodo, apiListShortcuts, apiListTodos, apiTranslate,
    apiUpdateShortcut, apiUpdateTodo,
    type AssistantPageContext,
} from '@/lib/api';
import AiModelSelect from '@/components/ai/AiModelSelect';
import { renderMarkdown } from '@/lib/markdown';
import { Recognizer, speechRecognitionSupported, speechSynthesisSupported } from '@/lib/speech';
import type { AssistantShortcut, AssistantStep, AssistantTodo } from '../../shared/types';

type Tab = 'chat' | 'translate' | 'todo' | 'links';
type DockSide = 'left' | 'right' | null;

interface Profile {
    name: string;
    role: string;
    goal: string;
    style: string;
}

interface ChatMsg {
    id: string;
    role: 'user' | 'assistant';
    content: string;
}

const BALL = 56;
/** 贴边后露在外面的那一条 */
const PEEK = 16;
/** 松手时离边多近算贴边 */
const DOCK_ZONE = 56;
/** 贴边展开时离边留的缝 */
const REVEAL_GAP = 10;
const PAD = 12;

const K_POS = 'assistant.ball.pos';
const K_PROFILE = 'assistant.profile';
const K_TOOLS = 'assistant.tools';

/** 页面摘要最多采多少个元素。再多也只是把上下文撑满，帮不上忙。 */
const CONTEXT_MAX_ELEMENTS = 40;

const DEFAULT_PROFILE: Profile = {
    name: '小工',
    role: '你是「工具箱」这个自建站点的常驻助手，既懂站里每个工具怎么用，也能陪着聊技术和学习方法。',
    goal: '帮我把手上的事往前推一步：能直接给答案就给答案，该跳去哪个工具就把我送过去。',
    style: '中文回答，先给结论再给理由。能一句话说清就不要写三段。用 Markdown，但别为了排版而排版。',
};

const LANGS: Array<{ code: string; label: string; speech: string }> = [
    { code: 'zh', label: '中文', speech: 'zh-CN' },
    { code: 'en', label: 'English', speech: 'en-GB' },
    { code: 'ja', label: '日本語', speech: 'ja-JP' },
    { code: 'fr', label: 'Français', speech: 'fr-FR' },
    { code: 'de', label: 'Deutsch', speech: 'de-DE' },
    { code: 'es', label: 'Español', speech: 'es-ES' },
];

const STEP_ICON: Record<AssistantStep['kind'], string> = {
    thinking: 'fa-brain',
    action: 'fa-screwdriver-wrench',
    observation: 'fa-clipboard-check',
    error: 'fa-triangle-exclamation',
};

const STEP_LABEL: Record<AssistantStep['kind'], string> = {
    thinking: '在想下一步',
    action: '调用',
    observation: '结果',
    error: '出错',
};

function clamp(v: number, min: number, max: number) {
    return Math.max(min, Math.min(max, v));
}

/**
 * 视口尺寸。
 *
 * 后台标签页里加载时 innerWidth/innerHeight 会是 0，直接拿来算球的落点
 * 会算出负坐标，球就停在屏幕外面了 —— 所以 0 一律当成一个体面的默认值，
 * 等第一次真正的 resize 事件来了再纠正。
 */
function viewportSize() {
    if (typeof window === 'undefined') return { w: 1280, h: 720 };
    return { w: window.innerWidth || 1280, h: window.innerHeight || 720 };
}

function uid(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function speechLangOf(code: string): string {
    return LANGS.find((l) => l.code === code)?.speech ?? 'en-GB';
}

/** 念一段话。用浏览器自带的合成，免费、不用 key（跟口语练习同一套）。 */
function speak(text: string, langCode: string): void {
    if (!speechSynthesisSupported() || !text.trim()) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text.slice(0, 1000));
    u.lang = speechLangOf(langCode);
    window.speechSynthesis.speak(u);
}

/**
 * 采一份当前页面的摘要给助手。
 *
 * 只取可见的按钮 / 链接 / 输入框和标题的文字，**不取 selector** ——
 * 助手不点页面，selector 对它没用，只会白占上下文。
 * 密码框和隐藏框整个跳过，助手没有任何理由知道它们存在。
 */
function collectPageContext(exclude: HTMLElement | null): AssistantPageContext {
    const picked: AssistantPageContext['elements'] = [];
    const seen = new Set<Element>();

    const nodes = document.querySelectorAll<HTMLElement>(
        'h1, h2, button, a[href], input, textarea, select, [role="tab"]',
    );

    for (const el of nodes) {
        if (picked.length >= CONTEXT_MAX_ELEMENTS) break;
        if (seen.has(el) || (exclude && exclude.contains(el))) continue;
        seen.add(el);

        const tag = el.tagName.toLowerCase();
        const type = (el.getAttribute('type') ?? '').toLowerCase();
        if (tag === 'input' && (type === 'password' || type === 'hidden')) continue;

        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;

        const label = (el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').trim();
        const text = tag === 'input' || tag === 'textarea' || tag === 'select'
            ? ''
            : (el.innerText || '').trim();
        if (!text && !label) continue;

        picked.push({ tag, text: text.slice(0, 80), label: label.slice(0, 80) });
    }

    return { path: window.location.pathname, title: document.title, elements: picked };
}

function loadJson<T>(key: string, fallback: T): T {
    try {
        const raw = localStorage.getItem(key);
        if (!raw) return fallback;
        return { ...fallback, ...(JSON.parse(raw) as object) } as T;
    } catch {
        return fallback;
    }
}

export default function AssistantBall() {
    const navigate = useNavigate();

    const rootRef = useRef<HTMLDivElement | null>(null);

    // ---------- 位置与贴边 ----------

    const [viewport, setViewport] = useState(viewportSize);
    const [pos, setPos] = useState(() => {
        const saved = loadJson(K_POS, { x: NaN, y: NaN, dock: null as DockSide });
        const { w, h } = viewportSize();
        const raw = Number.isFinite(saved.x) && Number.isFinite(saved.y)
            ? saved
            : { x: w - BALL - 28, y: h - BALL - 96, dock: null as DockSide };
        return {
            dock: raw.dock,
            x: raw.dock ? raw.x : clamp(raw.x, PAD, Math.max(PAD, w - BALL - PAD)),
            y: clamp(raw.y, PAD, Math.max(PAD, h - BALL - PAD)),
        };
    });
    const [revealed, setRevealed] = useState(false);
    const [dragging, setDragging] = useState(false);
    const [hovering, setHovering] = useState(false);

    const posRef = useRef(pos);
    const dragRef = useRef<{ px: number; py: number; x: number; y: number } | null>(null);
    const movedRef = useRef(false);

    useEffect(() => { posRef.current = pos; }, [pos]);

    const dockedX = useCallback((side: Exclude<DockSide, null>, show: boolean, w: number) => (
        side === 'left'
            ? (show ? REVEAL_GAP : -BALL + PEEK)
            : (show ? w - BALL - REVEAL_GAP : w - PEEK)
    ), []);

    // ---------- 面板 ----------

    const [open, setOpen] = useState(false);
    const [tab, setTab] = useState<Tab>('chat');
    const [toast, setToast] = useState('');
    const toastTimer = useRef<number | null>(null);

    const notify = useCallback((msg: string) => {
        setToast(msg);
        if (toastTimer.current) window.clearTimeout(toastTimer.current);
        toastTimer.current = window.setTimeout(() => setToast(''), 2200);
    }, []);

    const [llmReady, setLlmReady] = useState(true);

    // ---------- 对话 ----------

    const [profile, setProfile] = useState<Profile>(() => loadJson(K_PROFILE, DEFAULT_PROFILE));
    const [profileOpen, setProfileOpen] = useState(false);
    const [useTools, setUseTools] = useState(() => localStorage.getItem(K_TOOLS) !== '0');
    const [msgs, setMsgs] = useState<ChatMsg[]>([]);
    const [chatInput, setChatInput] = useState('');
    const [replying, setReplying] = useState(false);
    const [steps, setSteps] = useState<AssistantStep[]>([]);
    const [stepsOpen, setStepsOpen] = useState(false);
    const chatViewRef = useRef<HTMLDivElement | null>(null);
    const abortRef = useRef<AbortController | null>(null);

    // ---------- 翻译 ----------

    const [from, setFrom] = useState('zh');
    const [to, setTo] = useState('en');
    const [srcText, setSrcText] = useState('');
    const [dstText, setDstText] = useState('');
    const [synonyms, setSynonyms] = useState<string[]>([]);
    const [translating, setTranslating] = useState(false);
    const [listening, setListening] = useState(false);
    const recognizerRef = useRef<Recognizer | null>(null);
    /** 开始听之前输入框里已有的内容，识别结果接在它后面 */
    const listenBaseRef = useRef('');

    // ---------- 待办 / 快捷 ----------

    const [todos, setTodos] = useState<AssistantTodo[]>([]);
    const [todoInput, setTodoInput] = useState('');
    const [links, setLinks] = useState<AssistantShortcut[]>([]);
    const [linkTitle, setLinkTitle] = useState('');
    const [linkUrl, setLinkUrl] = useState('');

    const [shooting, setShooting] = useState(false);

    // ---------- 副作用 ----------

    useEffect(() => {
        const onResize = () => {
            const w = window.innerWidth;
            const h = window.innerHeight;
            setViewport({ w, h });
            setPos((p) => ({
                dock: p.dock,
                x: p.dock ? dockedX(p.dock, revealed, w) : clamp(p.x, PAD, w - BALL - PAD),
                y: clamp(p.y, PAD, h - BALL - PAD),
            }));
        };
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
    }, [dockedX, revealed]);

    // 贴边状态下「露头 / 缩回」就是改一下 x
    useEffect(() => {
        setPos((p) => (p.dock ? { ...p, x: dockedX(p.dock, revealed, viewport.w) } : p));
    }, [revealed, viewport.w, dockedX]);

    useEffect(() => {
        if (!dragging) return;

        const onMove = (e: PointerEvent) => {
            const d = dragRef.current;
            if (!d) return;
            const dx = e.clientX - d.px;
            const dy = e.clientY - d.py;
            if (Math.abs(dx) + Math.abs(dy) > 5) movedRef.current = true;
            setPos({
                dock: null,
                x: clamp(d.x + dx, -BALL + PEEK, viewport.w - PEEK),
                y: clamp(d.y + dy, PAD, viewport.h - BALL - PAD),
            });
        };

        const onUp = () => {
            setDragging(false);
            dragRef.current = null;

            const cur = posRef.current;
            const nearLeft = cur.x <= DOCK_ZONE;
            const nearRight = cur.x >= viewport.w - BALL - DOCK_ZONE;

            // 只有「用户自己挪过」的位置才记到本地。窗口缩放时的自动夹取不记 ——
            // 否则在小窗口里开一次页面，就把大屏上摆好的位置冲掉了。
            const settle = (next: typeof cur) => {
                setPos(next);
                try { localStorage.setItem(K_POS, JSON.stringify(next)); } catch { /* 无痕模式 */ }
            };

            if (nearLeft || nearRight) {
                const side: Exclude<DockSide, null> = nearLeft ? 'left' : 'right';
                const show = open || hovering;
                setRevealed(show);
                settle({
                    dock: side,
                    x: dockedX(side, show, viewport.w),
                    y: clamp(cur.y, PAD, viewport.h - BALL - PAD),
                });
                return;
            }

            setRevealed(false);
            settle({
                dock: null,
                x: clamp(cur.x, PAD, viewport.w - BALL - PAD),
                y: clamp(cur.y, PAD, viewport.h - BALL - PAD),
            });
        };

        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        return () => {
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
        };
    }, [dragging, hovering, open, viewport.w, viewport.h, dockedX]);

    // 面板一打开就把数据取回来；没配大模型的话面板里直接说明，不让人白打一段字
    useEffect(() => {
        if (!open) return;
        void apiAssistantStatus().then((s) => setLlmReady(s.llmConfigured)).catch(() => { /* 取不到就当配了 */ });
        void apiListTodos().then(setTodos).catch(() => { /* 静默，面板里会是空列表 */ });
        void apiListShortcuts().then(setLinks).catch(() => { /* 同上 */ });
    }, [open]);

    // 新消息进来就滚到底
    useEffect(() => {
        const el = chatViewRef.current;
        if (el) el.scrollTop = el.scrollHeight;
    }, [msgs, steps, replying, tab]);

    // Esc 关面板。捕获阶段拿，抢在页面自己的快捷键前面。
    useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== 'Escape') return;
            e.stopPropagation();
            setOpen(false);
        };
        document.addEventListener('keydown', onKey, true);
        return () => document.removeEventListener('keydown', onKey, true);
    }, [open]);

    // 卸载时把还在跑的东西收干净
    useEffect(() => () => {
        abortRef.current?.abort();
        recognizerRef.current?.abort();
        if (speechSynthesisSupported()) window.speechSynthesis.cancel();
    }, []);

    // ---------- 球的交互 ----------

    const onBallDown = (e: React.PointerEvent<HTMLButtonElement>) => {
        e.preventDefault();
        if (pos.dock) setRevealed(true);
        movedRef.current = false;
        setDragging(true);
        dragRef.current = { px: e.clientX, py: e.clientY, x: posRef.current.x, y: posRef.current.y };
    };

    const onBallClick = () => {
        // 拖完松手浏览器也会补一个 click，靠这个标记把它吃掉
        if (movedRef.current) { movedRef.current = false; return; }
        setOpen((o) => {
            const next = !o;
            if (next) setRevealed(true);
            else if (pos.dock && !hovering) setRevealed(false);
            return next;
        });
    };

    // ---------- 对话 ----------

    const saveProfile = () => {
        const next: Profile = {
            name: profile.name.trim() || DEFAULT_PROFILE.name,
            role: profile.role.trim() || DEFAULT_PROFILE.role,
            goal: profile.goal.trim() || DEFAULT_PROFILE.goal,
            style: profile.style.trim() || DEFAULT_PROFILE.style,
        };
        setProfile(next);
        try { localStorage.setItem(K_PROFILE, JSON.stringify(next)); } catch { /* 无痕模式 */ }
        notify('人设已保存');
    };

    const resetProfile = () => {
        setProfile(DEFAULT_PROFILE);
        try { localStorage.removeItem(K_PROFILE); } catch { /* 无痕模式 */ }
        notify('已恢复默认人设');
    };

    const toggleTools = () => {
        setUseTools((v) => {
            const next = !v;
            try { localStorage.setItem(K_TOOLS, next ? '1' : '0'); } catch { /* 无痕模式 */ }
            return next;
        });
    };

    const send = useCallback(async () => {
        const text = chatInput.trim();
        if (!text || replying) return;

        const mine: ChatMsg = { id: uid(), role: 'user', content: text };
        const history = [...msgs, mine];
        setMsgs(history);
        setChatInput('');
        setSteps([]);
        setReplying(true);

        const replyId = uid();
        let got = false;
        const ac = new AbortController();
        abortRef.current = ac;

        try {
            const { error } = await apiAssistantChat(
                {
                    messages: history.map((m) => ({ role: m.role, content: m.content })),
                    profile,
                    page: collectPageContext(rootRef.current),
                    tools: useTools,
                },
                {
                    onStep: (s) => setSteps((prev) => [...prev, s]),
                    onNavigate: (path) => navigate(path),
                    onDelta: (piece) => {
                        got = true;
                        setMsgs((prev) => {
                            const found = prev.find((m) => m.id === replyId);
                            if (found) {
                                return prev.map((m) => (
                                    m.id === replyId ? { ...m, content: m.content + piece } : m
                                ));
                            }
                            return [...prev, { id: replyId, role: 'assistant' as const, content: piece }];
                        });
                    },
                },
                ac.signal,
            );
            if (error) notify(error);
            else if (!got) notify('助手没有返回内容');
        } catch (err) {
            if ((err as Error)?.name !== 'AbortError') {
                notify(err instanceof Error ? err.message : '助手回复失败');
            }
        } finally {
            setReplying(false);
            abortRef.current = null;
        }
    }, [chatInput, replying, msgs, profile, useTools, navigate, notify]);

    const stopReply = () => {
        abortRef.current?.abort();
        abortRef.current = null;
        setReplying(false);
    };

    const clearChat = () => {
        stopReply();
        setMsgs([]);
        setSteps([]);
        notify('对话已清空');
    };

    // ---------- 翻译 ----------

    const translate = useCallback(async () => {
        const text = srcText.trim();
        if (!text) { notify('先写点要翻的内容'); return; }
        if (from === to) { notify('两边选的是同一种语言'); return; }

        setTranslating(true);
        setSynonyms([]);
        try {
            const r = await apiTranslate({ text, from, to });
            setDstText(r.text);
            setSynonyms(r.synonyms);
        } catch (err) {
            notify(err instanceof Error ? err.message : '翻译失败');
        } finally {
            setTranslating(false);
        }
    }, [srcText, from, to, notify]);

    const startListening = () => {
        if (!speechRecognitionSupported()) { notify('这个浏览器不支持语音输入，用 Chrome 或 Edge'); return; }
        listenBaseRef.current = srcText;

        const rec = new Recognizer({
            onResult: ({ final, interim }) => {
                const base = listenBaseRef.current;
                const said = `${final} ${interim}`.trim();
                setSrcText(base && said ? `${base} ${said}` : (said || base));
            },
            onError: (code) => {
                notify(code === 'not-allowed' ? '麦克风没有授权，改用键盘输入' : `语音识别出错：${code}`);
                setListening(false);
                recognizerRef.current = null;
            },
            onEnd: () => {
                setListening(false);
                recognizerRef.current = null;
            },
        }, speechLangOf(from));

        if (!rec.start()) { notify('语音识别启动失败，稍后再试'); return; }
        recognizerRef.current = rec;
        setListening(true);
    };

    const stopListening = () => {
        recognizerRef.current?.stop();
        recognizerRef.current = null;
        setListening(false);
    };

    const swapLangs = () => {
        setFrom(to);
        setTo(from);
        setSrcText(dstText);
        setDstText(srcText);
        setSynonyms([]);
    };

    // ---------- 待办 ----------

    const addTodo = async () => {
        const text = todoInput.trim();
        if (!text) return;
        setTodoInput('');
        try {
            const created = await apiCreateTodo(text);
            setTodos((prev) => [created, ...prev]);
        } catch (err) {
            notify(err instanceof Error ? err.message : '待办没能存上');
        }
    };

    // 先改界面再发请求，失败了整份拉回来 —— 勾一下待办要是等一个来回才变色，手感很差
    const toggleTodo = async (item: AssistantTodo) => {
        setTodos((prev) => prev.map((t) => (t.id === item.id ? { ...t, done: !t.done } : t)));
        try {
            await apiUpdateTodo(item.id, { done: !item.done });
        } catch {
            notify('状态没同步上，已刷新');
            setTodos(await apiListTodos().catch(() => todos));
        }
    };

    const removeTodo = async (id: number) => {
        const backup = todos;
        setTodos((prev) => prev.filter((t) => t.id !== id));
        try {
            await apiDeleteTodo(id);
        } catch {
            notify('删除失败');
            setTodos(backup);
        }
    };

    const clearDone = async () => {
        const backup = todos;
        setTodos((prev) => prev.filter((t) => !t.done));
        try {
            const { removed } = await apiClearDoneTodos();
            notify(removed > 0 ? `清掉了 ${removed} 条` : '没有已完成的');
        } catch {
            notify('清理失败');
            setTodos(backup);
        }
    };

    // ---------- 快捷方式 ----------

    const addLink = async () => {
        const title = linkTitle.trim();
        const url = linkUrl.trim();
        if (!title || !url) return;
        try {
            const created = await apiCreateShortcut({ title, url });
            setLinks((prev) => [...prev, created]);
            setLinkTitle('');
            setLinkUrl('');
        } catch (err) {
            notify(err instanceof Error ? err.message : '快捷方式没能存上');
        }
    };

    const removeLink = async (id: number) => {
        const backup = links;
        setLinks((prev) => prev.filter((s) => s.id !== id));
        try {
            await apiDeleteShortcut(id);
        } catch {
            notify('删除失败');
            setLinks(backup);
        }
    };

    const toggleLinkTarget = async (item: AssistantShortcut) => {
        const next = !item.openInNewTab;
        setLinks((prev) => prev.map((s) => (s.id === item.id ? { ...s, openInNewTab: next } : s)));
        try {
            await apiUpdateShortcut(item.id, { openInNewTab: next });
        } catch {
            notify('没改上');
            setLinks((prev) => prev.map((s) => (s.id === item.id ? { ...s, openInNewTab: !next } : s)));
        }
    };

    const openLink = (item: AssistantShortcut) => {
        if (item.url.startsWith('/') && !item.openInNewTab) { navigate(item.url); return; }
        if (item.openInNewTab) { window.open(item.url, '_blank', 'noopener,noreferrer'); return; }
        window.location.href = item.url;
    };

    // ---------- 截图 ----------

    /**
     * 把当前页面存成 PNG。
     *
     * 截之前先把助手自己 display:none 掉 —— 用 html2canvas 的 ignoreElements
     * 也能排除，但那条路上尺寸为 0 的画布偶尔会让它自己在 createPattern 里炸掉，
     * 直接从布局里拿掉最稳。
     */
    const screenshot = async () => {
        if (shooting) return;
        const root = rootRef.current;
        if (!root) return;

        setShooting(true);
        const prev = root.style.display;
        root.style.display = 'none';
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

        try {
            const { default: html2canvas } = await import('html2canvas');
            const canvas = await html2canvas(document.body, {
                backgroundColor: getComputedStyle(document.body).backgroundColor || '#ffffff',
                scale: 2,
                useCORS: true,
                logging: false,
                imageTimeout: 0,
            });
            if (!canvas.width || !canvas.height) throw new Error('画布为空');

            const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'));
            if (!blob) throw new Error('转 PNG 失败');

            const name = `工具箱截图_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.png`;
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = name;
            a.click();
            URL.revokeObjectURL(url);
            notify('截图已保存');
        } catch (err) {
            notify(err instanceof Error ? err.message : '截图失败');
        } finally {
            root.style.display = prev;
            setShooting(false);
        }
    };

    const panelSide = pos.dock === 'right' || pos.x > viewport.w / 2 ? 'left' : 'right';
    const panelUp = pos.y > viewport.h / 2;
    const remaining = todos.filter((t) => !t.done).length;

    return (
        <div
            ref={rootRef}
            className={`ab-root${dragging ? ' is-dragging' : ''}`}
            style={{ left: `${pos.x}px`, top: `${pos.y}px` }}
            onMouseEnter={() => { setHovering(true); if (pos.dock) setRevealed(true); }}
            onMouseLeave={() => {
                setHovering(false);
                if (pos.dock && !open && !dragging) setRevealed(false);
            }}
        >
            <button
                type="button"
                className={`ab-ball${open ? ' is-open' : ''}${replying ? ' is-busy' : ''}`}
                onPointerDown={onBallDown}
                onClick={onBallClick}
                title={open ? '收起助手' : '打开 AI 助手（拖到屏幕边缘可以贴边收起）'}
                aria-label="AI 助手"
                aria-expanded={open}
            >
                <span className="ab-ball-text">AI</span>
            </button>

            {open && (
                <div className={`ab-panel ab-panel--${panelSide}${panelUp ? ' ab-panel--up' : ''}`}>
                    <div className="ab-head">
                        <b className="ab-head-title">
                            <i className="fas fa-wand-magic-sparkles" /> {profile.name}
                        </b>
                        <div className="ab-head-btns">
                            <button
                                type="button" className="ab-icon" onClick={screenshot}
                                disabled={shooting} title="把当前页面存成 PNG"
                            >
                                <i className={`fas ${shooting ? 'fa-spinner fa-spin' : 'fa-camera'}`} />
                            </button>
                            <button
                                type="button" className="ab-icon" onClick={() => setOpen(false)}
                                title="收起（Esc）"
                            >
                                <i className="fas fa-xmark" />
                            </button>
                        </div>
                    </div>

                    <div className="ab-tabs" role="tablist">
                        {([
                            ['chat', 'fa-comment-dots', '问 AI'],
                            ['translate', 'fa-language', '翻译'],
                            ['todo', 'fa-list-check', '待办'],
                            ['links', 'fa-link', '快捷'],
                        ] as Array<[Tab, string, string]>).map(([key, icon, label]) => (
                            <button
                                key={key}
                                type="button"
                                role="tab"
                                aria-selected={tab === key}
                                className={`ab-tab${tab === key ? ' is-active' : ''}`}
                                onClick={() => setTab(key)}
                            >
                                <i className={`fas ${icon}`} />
                                <span>{label}</span>
                                {key === 'todo' && remaining > 0 && (
                                    <em className="ab-tab-dot">{remaining}</em>
                                )}
                            </button>
                        ))}
                    </div>

                    {!llmReady && (tab === 'chat' || tab === 'translate') && (
                        <p className="ab-warn">
                            <i className="fas fa-circle-exclamation" />
                            还没配大模型 —— 去
                            <button type="button" onClick={() => { navigate('/me'); setOpen(false); }}>
                                个人中心 · AI 配置
                            </button>
                            加一套（接口地址 + API Key + 模型名），这里就能用了。
                        </p>
                    )}

                    {/* ---------------- 问 AI ---------------- */}
                    {tab === 'chat' && (
                        <div className="ab-body ab-chat">
                            <div className="ab-chat-bar">
                                <button
                                    type="button"
                                    className={`ab-chip${useTools ? ' is-on' : ''}`}
                                    onClick={toggleTools}
                                    title="开着时助手可以检索站内页面、带你跳转、增删待办；关掉就是纯聊天，每轮少一次模型调用"
                                >
                                    <i className="fas fa-screwdriver-wrench" /> 站内操作
                                </button>
                                {/* 换模型就在手边。管理（加/改/删）在个人中心的「AI 配置」里 */}
                                <AiModelSelect
                                    variant="compact"
                                    onChange={() => setLlmReady(true)}
                                />
                                <button
                                    type="button"
                                    className={`ab-chip${profileOpen ? ' is-on' : ''}`}
                                    onClick={() => setProfileOpen((v) => !v)}
                                >
                                    <i className="fas fa-id-badge" /> 人设
                                </button>
                                <button type="button" className="ab-chip" onClick={clearChat}>
                                    <i className="fas fa-eraser" /> 清空
                                </button>
                            </div>

                            {profileOpen && (
                                <div className="ab-profile">
                                    <label>
                                        <span>叫什么</span>
                                        <input
                                            type="text" value={profile.name}
                                            onChange={(e) => setProfile((p) => ({ ...p, name: e.target.value }))}
                                        />
                                    </label>
                                    <label>
                                        <span>它是谁</span>
                                        <textarea
                                            value={profile.role}
                                            onChange={(e) => setProfile((p) => ({ ...p, role: e.target.value }))}
                                        />
                                    </label>
                                    <label>
                                        <span>要做到</span>
                                        <textarea
                                            value={profile.goal}
                                            onChange={(e) => setProfile((p) => ({ ...p, goal: e.target.value }))}
                                        />
                                    </label>
                                    <label>
                                        <span>说话方式</span>
                                        <textarea
                                            value={profile.style}
                                            onChange={(e) => setProfile((p) => ({ ...p, style: e.target.value }))}
                                        />
                                    </label>
                                    <div className="ab-profile-foot">
                                        <button type="button" onClick={resetProfile}>恢复默认</button>
                                        <button type="button" className="is-primary" onClick={saveProfile}>保存</button>
                                    </div>
                                    <p className="ab-note">
                                        人设只影响口吻和侧重点；「不许编站里没有的页面」那几条约束在服务端，改不掉。
                                    </p>
                                </div>
                            )}

                            <div className="ab-chat-view" ref={chatViewRef}>
                                {steps.length > 0 && (
                                    <div className="ab-steps">
                                        <button
                                            type="button"
                                            className="ab-steps-head"
                                            onClick={() => setStepsOpen((v) => !v)}
                                            aria-expanded={stepsOpen}
                                        >
                                            <i className={`fas fa-chevron-${stepsOpen ? 'down' : 'right'}`} />
                                            思考过程（{steps.length} 步）
                                        </button>
                                        {stepsOpen && (
                                            <ol className="ab-steps-list">
                                                {steps.map((s, i) => (
                                                    <li key={`${s.kind}-${s.step}-${i}`} className={`is-${s.kind}`}>
                                                        <i className={`fas ${STEP_ICON[s.kind]}`} />
                                                        <span className="ab-step-label">{STEP_LABEL[s.kind]}</span>
                                                        {s.action && <code>{s.action}</code>}
                                                        {s.summary && <span className="ab-step-sum">{s.summary}</span>}
                                                        {s.reason && <span className="ab-step-why">{s.reason}</span>}
                                                    </li>
                                                ))}
                                            </ol>
                                        )}
                                    </div>
                                )}

                                {msgs.length === 0 && !replying && (
                                    <div className="ab-empty">
                                        <p>问点什么都行。它知道站里有哪些工具，也能顺手帮你记一条待办。</p>
                                        <div className="ab-suggest">
                                            {[
                                                '站里有哪些工具？',
                                                '我想看一致性哈希是怎么回事',
                                                '记一条待办：明天把三线表导出成 PNG',
                                            ].map((q) => (
                                                <button key={q} type="button" onClick={() => setChatInput(q)}>{q}</button>
                                            ))}
                                        </div>
                                    </div>
                                )}

                                {msgs.map((m) => (
                                    <div key={m.id} className={`ab-msg is-${m.role}`}>
                                        <div className="ab-msg-who">{m.role === 'user' ? '我' : profile.name}</div>
                                        {m.role === 'assistant' ? (
                                            <div
                                                className="ab-md"
                                                // 内容来自本机大模型，仍然过一遍 DOMPurify（见 lib/markdown）
                                                dangerouslySetInnerHTML={{ __html: renderMarkdown(m.content) }}
                                            />
                                        ) : (
                                            <div className="ab-msg-text">{m.content}</div>
                                        )}
                                    </div>
                                ))}

                                {replying && msgs[msgs.length - 1]?.role !== 'assistant' && (
                                    <div className="ab-msg is-assistant">
                                        <div className="ab-msg-who">{profile.name}</div>
                                        <div className="ab-typing"><i /><i /><i /></div>
                                    </div>
                                )}
                            </div>

                            <div className="ab-send">
                                <textarea
                                    value={chatInput}
                                    onChange={(e) => setChatInput(e.target.value)}
                                    onKeyDown={(e) => {
                                        if (e.nativeEvent.isComposing) return;
                                        if (e.key === 'Enter' && !e.shiftKey) {
                                            e.preventDefault();
                                            void send();
                                        }
                                    }}
                                    placeholder="说点什么…… Enter 发送，Shift+Enter 换行"
                                    rows={2}
                                />
                                {replying ? (
                                    <button type="button" className="ab-send-btn is-stop" onClick={stopReply}>
                                        <i className="fas fa-stop" />
                                    </button>
                                ) : (
                                    <button
                                        type="button"
                                        className="ab-send-btn"
                                        onClick={() => void send()}
                                        disabled={!chatInput.trim()}
                                    >
                                        <i className="fas fa-paper-plane" />
                                    </button>
                                )}
                            </div>
                        </div>
                    )}

                    {/* ---------------- 翻译 ---------------- */}
                    {tab === 'translate' && (
                        <div className="ab-body ab-tr">
                            <div className="ab-tr-langs">
                                <select value={from} onChange={(e) => setFrom(e.target.value)} aria-label="源语言">
                                    {LANGS.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
                                </select>
                                <button type="button" className="ab-icon" onClick={swapLangs} title="互换">
                                    <i className="fas fa-right-left" />
                                </button>
                                <select value={to} onChange={(e) => setTo(e.target.value)} aria-label="目标语言">
                                    {LANGS.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
                                </select>
                            </div>

                            <div className="ab-tr-head">
                                <span>原文</span>
                                <div>
                                    <button
                                        type="button" className="ab-icon"
                                        onClick={() => speak(srcText, from)} title="朗读原文"
                                    >
                                        <i className="fas fa-volume-high" />
                                    </button>
                                    <button
                                        type="button"
                                        className={`ab-icon${listening ? ' is-live' : ''}`}
                                        onClick={listening ? stopListening : startListening}
                                        title={listening ? '停止语音输入' : '语音输入（Chrome / Edge）'}
                                    >
                                        <i className={`fas ${listening ? 'fa-circle-stop' : 'fa-microphone'}`} />
                                    </button>
                                </div>
                            </div>
                            <textarea
                                className="ab-tr-in"
                                value={srcText}
                                onChange={(e) => setSrcText(e.target.value)}
                                placeholder="要翻译的内容"
                                rows={3}
                            />

                            <button
                                type="button" className="ab-primary"
                                onClick={() => void translate()} disabled={translating}
                            >
                                {translating ? '翻译中…' : '翻译'}
                            </button>

                            <div className="ab-tr-head">
                                <span>译文</span>
                                <button
                                    type="button" className="ab-icon"
                                    onClick={() => speak(dstText, to)} title="朗读译文"
                                >
                                    <i className="fas fa-volume-high" />
                                </button>
                            </div>
                            <div className="ab-tr-out" aria-live="polite">
                                {dstText || <span className="ab-muted">译文会显示在这里</span>}
                            </div>

                            {synonyms.length > 0 && (
                                <div className="ab-syn">
                                    <span className="ab-muted">换个说法</span>
                                    <div>
                                        {synonyms.map((s) => (
                                            <button key={s} type="button" onClick={() => speak(s, to)} title="点一下念出来">
                                                {s}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            )}
                        </div>
                    )}

                    {/* ---------------- 待办 ---------------- */}
                    {tab === 'todo' && (
                        <div className="ab-body ab-todo">
                            <div className="ab-row">
                                <input
                                    type="text"
                                    value={todoInput}
                                    onChange={(e) => setTodoInput(e.target.value)}
                                    onKeyDown={(e) => {
                                        if (e.nativeEvent.isComposing) return;
                                        if (e.key === 'Enter') void addTodo();
                                    }}
                                    placeholder="要做的事，回车添加"
                                />
                                <button
                                    type="button" className="ab-primary is-slim"
                                    onClick={() => void addTodo()} disabled={!todoInput.trim()}
                                >
                                    添加
                                </button>
                            </div>

                            {todos.length > 0 && (
                                <div className="ab-todo-meta">
                                    <span>还剩 {remaining} 条</span>
                                    {todos.some((t) => t.done) && (
                                        <button type="button" onClick={() => void clearDone()}>清掉已完成</button>
                                    )}
                                </div>
                            )}

                            <ul className="ab-list">
                                {todos.length === 0 && <li className="ab-empty-line">还没有待办</li>}
                                {todos.map((t) => (
                                    <li key={t.id} className={t.done ? 'is-done' : ''}>
                                        <button
                                            type="button" className="ab-check"
                                            onClick={() => void toggleTodo(t)}
                                            aria-label={t.done ? '标为未完成' : '标为已完成'}
                                        >
                                            {t.done && <i className="fas fa-check" />}
                                        </button>
                                        <span className="ab-list-text">{t.text}</span>
                                        <button
                                            type="button" className="ab-icon"
                                            onClick={() => void removeTodo(t.id)} aria-label="删除"
                                        >
                                            <i className="fas fa-xmark" />
                                        </button>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}

                    {/* ---------------- 快捷方式 ---------------- */}
                    {tab === 'links' && (
                        <div className="ab-body ab-links">
                            <div className="ab-row is-stack">
                                <input
                                    type="text" value={linkTitle}
                                    onChange={(e) => setLinkTitle(e.target.value)}
                                    placeholder="名字"
                                />
                                <input
                                    type="text" value={linkUrl}
                                    onChange={(e) => setLinkUrl(e.target.value)}
                                    onKeyDown={(e) => {
                                        if (e.nativeEvent.isComposing) return;
                                        if (e.key === 'Enter') void addLink();
                                    }}
                                    placeholder="https://… 或 /tools/…（站内路径）"
                                />
                                <button
                                    type="button" className="ab-primary is-slim"
                                    onClick={() => void addLink()}
                                    disabled={!linkTitle.trim() || !linkUrl.trim()}
                                >
                                    添加
                                </button>
                            </div>

                            <ul className="ab-list">
                                {links.length === 0 && <li className="ab-empty-line">还没有快捷方式</li>}
                                {links.map((s) => (
                                    <li key={s.id}>
                                        <button
                                            type="button" className="ab-link-go"
                                            onClick={() => openLink(s)} title={s.url}
                                        >
                                            <i className={`fas ${s.url.startsWith('/') ? 'fa-location-arrow' : 'fa-up-right-from-square'}`} />
                                            <span className="ab-list-text">{s.title}</span>
                                        </button>
                                        <button
                                            type="button"
                                            className={`ab-icon${s.openInNewTab ? ' is-on' : ''}`}
                                            onClick={() => void toggleLinkTarget(s)}
                                            title={s.openInNewTab ? '当前：新标签页打开' : '当前：本页打开'}
                                        >
                                            <i className="fas fa-window-restore" />
                                        </button>
                                        <button
                                            type="button" className="ab-icon"
                                            onClick={() => void removeLink(s.id)} aria-label="删除"
                                        >
                                            <i className="fas fa-xmark" />
                                        </button>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}

                    {toast && <div className="ab-toast">{toast}</div>}
                </div>
            )}
        </div>
    );
}
