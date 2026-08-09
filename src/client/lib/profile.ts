// ============================================================
//  个人资料 —— 站里唯一跟「你是谁」有关的一点点状态
//
//  这个站没有登录，也不打算有：一个进程一个库文件，用的人只有一个。
//  所以「个人中心」不是账号系统，只是把名字、签名和几条自己的主页链接
//  存进 settings 表 —— 没有密码、没有会话、没有鉴权，改完直接生效。
//
//  名字要显示在每一页的侧栏底部，但它几乎不变。为此在模块级缓存一份，
//  页面之间来回切不会每次都打一遍 /api/settings；个人中心里改完之后
//  由 publish 把新值推给所有订阅者，侧栏当场跟着变。
// ============================================================

import { useEffect, useState } from 'react';
import { apiGetSettings, apiSetSettingStrict } from './api';

export interface ProfileLink {
    title: string;
    url: string;
}

export interface Profile {
    name: string;
    tagline: string;
    /** 空 = 用用户名首字母；`data:image/…` = 一张图；其余 = 一个 emoji / 短文字 */
    avatar: string;
    links: ProfileLink[];
}

/** 没设置过时用这个名字。页面上随时能改掉，不是写死的身份 */
export const DEFAULT_NAME = 'lrhtom';

/** 名字要塞进侧栏那一条，太长会把布局撑破 */
export const NAME_MAX = 24;
export const TAGLINE_MAX = 60;
/** 链接条数上限：这是「我的几个主页」，不是书签管理器 */
export const LINKS_MAX = 12;

/** emoji 头像留几个码点 —— 带肤色或 ZWJ 的 emoji 一个就能占四五个 */
export const AVATAR_TEXT_MAX = 8;
/** 图片头像的 data URI 长度上限。128px WebP 正常十几 KB，超这么多说明哪里不对 */
export const AVATAR_MAX_CHARS = 200_000;

export const EMPTY_PROFILE: Profile = { name: DEFAULT_NAME, tagline: '', avatar: '', links: [] };

const KEY_NAME = 'profile.name';
const KEY_TAGLINE = 'profile.tagline';
const KEY_AVATAR = 'profile.avatar';
const KEY_LINKS = 'profile.links';

// ---------- 解析 ----------

function parseLinks(raw: string | undefined): ProfileLink[] {
    if (!raw) return [];
    try {
        const arr: unknown = JSON.parse(raw);
        if (!Array.isArray(arr)) return [];
        return arr.flatMap((item) => {
            const o = item as { title?: unknown; url?: unknown };
            const title = typeof o?.title === 'string' ? o.title.trim() : '';
            const url = typeof o?.url === 'string' ? normalizeUrl(o.url) : null;
            return title && url ? [{ title, url }] : [];
        }).slice(0, LINKS_MAX);
    } catch {
        return [];      // 存坏了就当没有 —— 一行脏数据不该让整页打不开
    }
}

/** 头像是图还是字，判据只有一条：是不是 `data:image/` 开头 */
export function isImageAvatar(value: string): boolean {
    return value.startsWith('data:image/');
}

function parseAvatar(raw: string | undefined): string {
    const v = (raw ?? '').trim();
    if (!v) return '';
    // 图片超长就当没设过：与其把一坨脏数据塞进 <img src>，不如退回首字母
    if (isImageAvatar(v)) return v.length <= AVATAR_MAX_CHARS ? v : '';
    return Array.from(v).slice(0, AVATAR_TEXT_MAX).join('');
}

export function parseProfile(settings: Record<string, string>): Profile {
    return {
        name: (settings[KEY_NAME] ?? '').trim() || DEFAULT_NAME,
        tagline: (settings[KEY_TAGLINE] ?? '').trim(),
        avatar: parseAvatar(settings[KEY_AVATAR]),
        links: parseLinks(settings[KEY_LINKS]),
    };
}

/**
 * 只放行 http / https。
 *
 * 这些 URL 会被原样渲染成 <a href>，而内容是从输入框来的 ——
 * javascript: 之类的伪协议必须在存进去之前就挡掉，不能指望渲染时再防。
 * 没写协议的按 https 补全，省得每次都要手打前缀。
 */
export function normalizeUrl(raw: string): string | null {
    const s = raw.trim();
    if (!s) return null;
    try {
        const u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(s) ? s : 'https://' + s);
        return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
    } catch {
        return null;
    }
}

/** 头像上那个字：中文取第一个字，英文取首字母大写 */
export function initial(name: string): string {
    return (name.trim()[0] ?? '?').toUpperCase();
}

// ---------- 缓存与订阅 ----------

let cached: Profile | null = null;
let inflight: Promise<Profile> | null = null;
const subscribers = new Set<(p: Profile) => void>();

export function loadProfile(): Promise<Profile> {
    if (cached) return Promise.resolve(cached);
    if (!inflight) {
        inflight = apiGetSettings()
            .then((s) => { cached = parseProfile(s); return cached; })
            .catch(() => EMPTY_PROFILE)     // 接口挂了，侧栏也得显示得出东西
            .finally(() => { inflight = null; });
    }
    return inflight;
}

export function subscribeProfile(fn: (p: Profile) => void): () => void {
    subscribers.add(fn);
    return () => { subscribers.delete(fn); };
}

function publish(next: Profile): Profile {
    cached = next;
    subscribers.forEach((fn) => fn(next));
    return next;
}

// ---------- 写 ----------
//
// 每一项单独存一个 settings key，改名字不会连带把链接重写一遍。

export async function saveName(name: string): Promise<Profile> {
    const clean = name.trim().slice(0, NAME_MAX) || DEFAULT_NAME;
    await apiSetSettingStrict(KEY_NAME, clean);
    return publish({ ...(cached ?? EMPTY_PROFILE), name: clean });
}

export async function saveTagline(tagline: string): Promise<Profile> {
    const clean = tagline.trim().slice(0, TAGLINE_MAX);
    await apiSetSettingStrict(KEY_TAGLINE, clean);
    return publish({ ...(cached ?? EMPTY_PROFILE), tagline: clean });
}

/** 传空串就是恢复默认（用用户名首字母） */
export async function saveAvatar(value: string): Promise<Profile> {
    const clean = parseAvatar(value);
    if (isImageAvatar(value) && !clean) throw new Error('这张图太大了，换一张');
    await apiSetSettingStrict(KEY_AVATAR, clean);
    return publish({ ...(cached ?? EMPTY_PROFILE), avatar: clean });
}

export async function saveLinks(links: ProfileLink[]): Promise<Profile> {
    const clean = links.slice(0, LINKS_MAX);
    await apiSetSettingStrict(KEY_LINKS, JSON.stringify(clean));
    return publish({ ...(cached ?? EMPTY_PROFILE), links: clean });
}

// ---------- 给组件用 ----------

/** 订阅当前资料。先给缓存值（可能是默认值），拿到真数据后再刷一次。 */
export function useProfile(): Profile {
    const [profile, setProfile] = useState<Profile>(() => cached ?? EMPTY_PROFILE);

    useEffect(() => {
        let alive = true;
        void loadProfile().then((p) => { if (alive) setProfile(p); });
        const off = subscribeProfile(setProfile);
        return () => { alive = false; off(); };
    }, []);

    return profile;
}
