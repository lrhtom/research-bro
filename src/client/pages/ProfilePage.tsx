// ============================================================
//  个人中心
//
//  这里**没有账号系统**，也不需要有：站是单机单人的，一个进程一个库文件。
//  所以这一页干的事只有三件 —— 说清楚你叫什么、你在这个站里攒下了什么、
//  以及把你自己那几个外站主页收在一处。改动直接写进 SQLite 的 settings 表，
//  不需要登录，也没有密码可填。
//
//  统计数字全部现算：四个接口并发拉，谁挂了就只让那一格显示「—」，
//  不会因为口语记录读不到就整页空白。
// ============================================================

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import AppShell from '@/components/AppShell';
import Avatar from '@/components/Avatar';
import { Skeleton } from '@/components/Loading';
import {
    apiListPlans, apiListSpeakingSessions, apiListTables, apiStats,
} from '@/lib/api';
import { fileToAvatarDataUrl } from '@/lib/avatar';
import {
    AVATAR_TEXT_MAX, DEFAULT_NAME, LINKS_MAX, NAME_MAX, TAGLINE_MAX,
    isImageAvatar, normalizeUrl, saveAvatar, saveLinks, saveName, saveTagline, useProfile,
    type ProfileLink,
} from '@/lib/profile';

/** 头像的几个现成 emoji。给个起点，省得每次都要去别处复制一个过来 */
const EMOJI_PRESETS = ['🐱', '🦊', '🐧', '🦉', '🌊', '🍀', '⚡', '📚', '🧊', '🍵'];

/** 一格统计。value 为 null 表示这一格没读到数 */
interface Stat {
    label: string;
    value: number | null;
    unit: string;
    hint: string;
    to: string;
    icon: string;
}

export default function ProfilePage() {
    useEffect(() => { document.title = '个人中心 · 工具箱'; }, []);

    const profile = useProfile();

    return (
        <AppShell title="个人中心" subtitle="Profile · 名字、足迹与我的主页">
            <p className="u-aside">
                <i className="fas fa-circle-info" />
                这个站<b>没有账号系统，也不需要登录注册</b> ——
                下面改的东西都只写进本机 SQLite 的 settings 表，换台电脑就没有了。
                名字随时能改，它只影响侧栏和这一页的显示。
            </p>

            <IdentityCard name={profile.name} tagline={profile.tagline} avatar={profile.avatar} />

            <div className="u-head">
                <h2><i className="fas fa-shoe-prints" /> 站内足迹</h2>
            </div>
            <p className="u-note">现算的，不是缓存。点任意一格进对应的工具。</p>
            <Footprint />

            <div className="u-head">
                <h2><i className="fas fa-link" /> 我的主页</h2>
                <span className="count u-num">{profile.links.length} 条</span>
            </div>
            <p className="u-note">
                自己在外站的主页收在这儿 —— 比如 Codeforces、力扣、GitHub 的个人页。
                <b>本站不去对方站点查任何东西</b>，只是把你填的地址存下来做个跳板。
            </p>
            <LinkManager links={profile.links} />
        </AppShell>
    );
}

// ---------- 身份 ----------

function IdentityCard({ name, tagline, avatar }: { name: string; tagline: string; avatar: string }) {
    const [editingAvatar, setEditingAvatar] = useState(false);

    return (
        <>
            <section className="me-card">
                <button
                    type="button"
                    className="me-avatar-btn"
                    onClick={() => setEditingAvatar((v) => !v)}
                    aria-expanded={editingAvatar}
                    title="换头像"
                >
                    <Avatar name={name} avatar={avatar} className="me-avatar" />
                    <span className="me-avatar-hint"><i className="fas fa-camera" /></span>
                </button>

                <div className="me-fields">
                    <InlineField
                        label="用户名"
                        value={name}
                        placeholder={DEFAULT_NAME}
                        max={NAME_MAX}
                        big
                        onSave={saveName}
                    />
                    <InlineField
                        label="一句话签名"
                        value={tagline}
                        placeholder="还没写，点一下加一句"
                        max={TAGLINE_MAX}
                        onSave={saveTagline}
                    />
                </div>
            </section>

            {editingAvatar && <AvatarEditor avatar={avatar} onClose={() => setEditingAvatar(false)} />}
        </>
    );
}

/**
 * 换头像。三条路：传一张图、挑一个 emoji、或者恢复成用户名首字母。
 *
 * 图片**不上传**：在浏览器里裁成正方形、缩到 128px、压成 WebP，
 * 最后以 data URI 的形式跟名字一样存进 settings 表。
 * 这也是为什么这里不需要任何上传接口和静态文件目录。
 */
function AvatarEditor({ avatar, onClose }: { avatar: string; onClose: () => void }) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    // 当前如果是图片，emoji 框留空 —— 不该把一坨 data URI 摊在输入框里
    const [emoji, setEmoji] = useState(isImageAvatar(avatar) ? '' : avatar);
    const fileRef = useRef<HTMLInputElement>(null);

    const run = async (job: () => Promise<unknown>) => {
        if (busy) return;
        setBusy(true);
        setError('');
        try {
            await job();
        } catch (e) {
            setError(e instanceof Error ? e.message : '换头像失败');
        } finally {
            setBusy(false);
        }
    };

    const onPickFile = (file: File | undefined) => {
        if (!file) return;
        void run(async () => {
            await saveAvatar(await fileToAvatarDataUrl(file));
            onClose();
        });
        // 清空 input，否则连着选同一个文件不会再触发 change
        if (fileRef.current) fileRef.current.value = '';
    };

    return (
        <section className="me-avatar-editor">
            <div className="me-avatar-row">
                <span className="me-avatar-row-label">上传图片</span>
                <input
                    ref={fileRef}
                    type="file"
                    accept="image/*"
                    className="u-input me-avatar-file"
                    disabled={busy}
                    onChange={(e) => onPickFile(e.target.files?.[0])}
                />
            </div>
            <p className="me-avatar-tip">
                图片<b>不会上传到任何地方</b> —— 在你自己的浏览器里裁成方形、缩到 128 像素、压好之后，
                跟用户名一样存进本机数据库。
            </p>

            <div className="me-avatar-row">
                <span className="me-avatar-row-label">用 emoji</span>
                <div className="me-emoji-picks">
                    {EMOJI_PRESETS.map((e) => (
                        <button
                            key={e}
                            type="button"
                            className={'me-emoji' + (emoji === e ? ' is-on' : '')}
                            disabled={busy}
                            onClick={() => { setEmoji(e); void run(() => saveAvatar(e)); }}
                        >
                            {e}
                        </button>
                    ))}
                </div>
            </div>

            <div className="me-avatar-row">
                <span className="me-avatar-row-label">或自己填</span>
                <input
                    className="u-input me-emoji-input"
                    value={emoji}
                    maxLength={AVATAR_TEXT_MAX}
                    placeholder="任意 emoji 或一两个字"
                    disabled={busy}
                    onChange={(e) => setEmoji(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') void run(() => saveAvatar(emoji)); }}
                />
                <button type="button" className="u-btn u-btn-primary" disabled={busy} onClick={() => void run(() => saveAvatar(emoji))}>
                    用这个
                </button>
            </div>

            <div className="me-avatar-actions">
                <button
                    type="button"
                    className="u-btn"
                    disabled={busy || !avatar}
                    onClick={() => { setEmoji(''); void run(() => saveAvatar('')); }}
                >
                    <i className="fas fa-rotate-left" /> 恢复成首字母
                </button>
                <button type="button" className="u-btn u-btn-quiet" disabled={busy} onClick={onClose}>
                    收起
                </button>
                {busy && <span className="me-field-tip"><i className="fas fa-spinner fa-spin" /> 处理中…</span>}
            </div>

            {error && <p className="u-note"><b className="is-error">{error}</b></p>}
        </section>
    );
}

/**
 * 点一下就地改的字段。
 *
 * 做成就地编辑而不是「编辑 → 表单 → 保存」三步，是因为这一页统共只有两个
 * 可改的字段，为它们开一个模态框太重了。
 */
function InlineField({
    label, value, placeholder, max, big = false, onSave,
}: {
    label: string;
    value: string;
    placeholder: string;
    max: number;
    big?: boolean;
    onSave: (v: string) => Promise<unknown>;
}) {
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState(value);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const inputRef = useRef<HTMLInputElement>(null);

    const open = () => { setDraft(value); setError(''); setEditing(true); };

    useEffect(() => {
        if (editing) inputRef.current?.select();
    }, [editing]);

    const commit = async () => {
        if (busy) return;
        if (draft.trim() === value) { setEditing(false); return; }
        setBusy(true);
        setError('');
        try {
            await onSave(draft);
            setEditing(false);
        } catch (e) {
            setError(e instanceof Error ? e.message : '保存失败');
        } finally {
            setBusy(false);
        }
    };

    if (!editing) {
        return (
            <div className={'me-field' + (big ? ' is-big' : '')}>
                <span className="me-field-label">{label}</span>
                <button type="button" className="me-field-view" onClick={open}>
                    <span className={value ? '' : 'is-empty'}>{value || placeholder}</span>
                    <i className="fas fa-pen" />
                </button>
            </div>
        );
    }

    return (
        <div className={'me-field' + (big ? ' is-big' : '')}>
            <span className="me-field-label">{label}</span>
            <div className="me-field-edit">
                <input
                    ref={inputRef}
                    className="u-input"
                    value={draft}
                    maxLength={max}
                    placeholder={placeholder}
                    disabled={busy}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') void commit();
                        if (e.key === 'Escape') setEditing(false);
                    }}
                />
                <button type="button" className="u-btn u-btn-primary" disabled={busy} onClick={() => void commit()}>
                    {busy ? '保存中' : '保存'}
                </button>
                <button type="button" className="u-btn" disabled={busy} onClick={() => setEditing(false)}>
                    取消
                </button>
            </div>
            <span className="me-field-tip">
                {error
                    ? <b className="is-error">{error}</b>
                    : <>回车保存，Esc 放弃 · 上限 {max} 字</>}
            </span>
        </div>
    );
}

// ---------- 站内足迹 ----------

function Footprint() {
    const [stats, setStats] = useState<Stat[] | null>(null);

    useEffect(() => {
        let alive = true;

        // 四个接口互不依赖，一起发；allSettled 保证一个挂了不影响其它三格
        void Promise.allSettled([
            apiListTables(),
            apiListPlans(),
            apiStats(null),
            apiListSpeakingSessions(),
        ]).then(([tables, plans, overview, sessions]) => {
            if (!alive) return;

            const planList = plans.status === 'fulfilled' ? plans.value.plans : null;
            const cardsDue = planList?.reduce((n, p) => n + p.stats.remaining, 0) ?? null;

            setStats([
                {
                    label: '三线表', icon: 'fa-table', to: '/tools/three-line-table',
                    value: tables.status === 'fulfilled' ? tables.value.length : null,
                    unit: '张', hint: '存在本机库里的表格',
                },
                {
                    label: '记忆卡', icon: 'fa-layer-group', to: '/tools/flashcards',
                    value: overview.status === 'fulfilled' ? overview.value.cards.total : null,
                    unit: '张', hint: planList ? `分在 ${planList.length} 个学习计划里` : '全部学习计划合计',
                },
                {
                    label: '今日待复习', icon: 'fa-bell', to: '/tools/flashcards',
                    value: cardsDue,
                    unit: '张', hint: cardsDue === 0 ? '今天的都学完了' : '各计划今日队列里还剩的',
                },
                {
                    label: '连续学习', icon: 'fa-fire', to: '/tools/flashcards/stats',
                    value: overview.status === 'fulfilled' ? overview.value.streakDays : null,
                    unit: '天', hint: '中间断一天就归零',
                },
                {
                    label: '口语练习', icon: 'fa-comments', to: '/tools/speaking/history',
                    value: sessions.status === 'fulfilled' ? sessions.value.length : null,
                    unit: '次', hint: '历次场景对话',
                },
            ]);
        });

        return () => { alive = false; };
    }, []);

    if (!stats) return <Skeleton rows={2} label="正在算站内足迹" className="me-stats-skeleton" />;

    return (
        <ul className="me-stats">
            {stats.map((s) => (
                <li key={s.label}>
                    <Link to={s.to}>
                        <span className="me-stat-head">
                            <i className={'fas ' + s.icon} />
                            {s.label}
                        </span>
                        <span className="me-stat-value">
                            <b className="u-num">{s.value ?? '—'}</b>
                            {s.value !== null && <em>{s.unit}</em>}
                        </span>
                        <span className="me-stat-hint">{s.value === null ? '这一项没读到' : s.hint}</span>
                    </Link>
                </li>
            ))}
        </ul>
    );
}

// ---------- 我的主页 ----------

function LinkManager({ links }: { links: ProfileLink[] }) {
    const [title, setTitle] = useState('');
    const [url, setUrl] = useState('');
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);

    const full = links.length >= LINKS_MAX;

    const add = useCallback(async () => {
        if (busy) return;
        const name = title.trim();
        const href = normalizeUrl(url);
        if (!name) { setError('给它起个名字'); return; }
        if (!href) { setError('地址填得不对 —— 只收 http / https 开头的网址'); return; }
        if (links.some((l) => l.url === href)) { setError('这条已经在列表里了'); return; }

        setBusy(true);
        setError('');
        try {
            await saveLinks([...links, { title: name, url: href }]);
            setTitle('');
            setUrl('');
        } catch (e) {
            setError(e instanceof Error ? e.message : '保存失败');
        } finally {
            setBusy(false);
        }
    }, [busy, title, url, links]);

    const remove = useCallback(async (target: ProfileLink) => {
        try {
            await saveLinks(links.filter((l) => l !== target));
        } catch (e) {
            setError(e instanceof Error ? e.message : '删除失败');
        }
    }, [links]);

    // 只显示域名：标题已经说明是什么了，整条 URL 摊在卡片上没人读
    const hosts = useMemo(
        () => new Map(links.map((l) => {
            try { return [l.url, new URL(l.url).host] as const; } catch { return [l.url, l.url] as const; }
        })),
        [links],
    );

    return (
        <>
            {links.length > 0 && (
                <ul className="me-links">
                    {links.map((l) => (
                        <li key={l.url}>
                            <a href={l.url} target="_blank" rel="noopener noreferrer">
                                <b>{l.title}</b>
                                <span>{hosts.get(l.url)}</span>
                                <i className="fas fa-arrow-up-right-from-square" aria-hidden="true" />
                            </a>
                            <button
                                type="button"
                                className="u-icon-btn is-danger me-link-del"
                                title={`删除「${l.title}」`}
                                aria-label={`删除「${l.title}」`}
                                onClick={() => void remove(l)}
                            >
                                <i className="fas fa-xmark" />
                            </button>
                        </li>
                    ))}
                </ul>
            )}

            {full ? (
                <p className="u-note">已经到 {LINKS_MAX} 条上限了 —— 这是「我的几个主页」，不是书签管理器。</p>
            ) : (
                <div className="me-link-add">
                    <input
                        className="u-input"
                        value={title}
                        maxLength={NAME_MAX}
                        placeholder="名字，比如「我的 Codeforces」"
                        onChange={(e) => setTitle(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') void add(); }}
                    />
                    <input
                        className="u-input"
                        value={url}
                        placeholder="网址，不写 https:// 也行"
                        onChange={(e) => setUrl(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') void add(); }}
                    />
                    <button type="button" className="u-btn u-btn-primary" disabled={busy} onClick={() => void add()}>
                        <i className="fas fa-plus" /> 添加
                    </button>
                </div>
            )}

            {error && <p className="u-note"><b className="is-error">{error}</b></p>}
        </>
    );
}
