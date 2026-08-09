// ============================================================
//  ZIP 打包器的测试
//
//  自己写的 ZIP，最怕的是「我自己的解析器读得通，资源管理器打不开」。
//  所以这里不写自家的解析器去自证 —— 直接把包写到磁盘，
//  交给 **Windows 自带的 Expand-Archive** 解，解出来的文件逐字节比对。
//  这才叫验证格式对不对。
// ============================================================

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { crc32, dedupeNames, makeZip, safeEntryName } from './zip.js';

const FIXED = new Date('2026-08-08T10:30:00');

let dir: string;

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zip-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

async function writeZip(entries: Array<{ name: string; data: Uint8Array }>): Promise<string> {
    const blob = makeZip(entries, FIXED);
    const file = path.join(dir, 'out.zip');
    fs.writeFileSync(file, Buffer.from(await blob.arrayBuffer()));
    return file;
}

/** 用系统自带的解压器解包，返回解出来的目录 */
function expand(zipPath: string): string {
    const out = path.join(dir, 'extracted');
    execFileSync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${out}' -Force`,
    ], { stdio: 'pipe', timeout: 60_000 });
    return out;
}

const bytes = (s: string) => new TextEncoder().encode(s);

// ------------------------------------------------------------

describe('CRC-32', () => {
    it('对得上标准测试向量', () => {
        // 规范里人尽皆知的那个：CRC32("123456789") == 0xCBF43926
        expect(crc32(bytes('123456789'))).toBe(0xcbf43926);
        expect(crc32(new Uint8Array(0))).toBe(0);
        expect(crc32(bytes('a'))).toBe(0xe8b7be43);
    });
});

describe('系统解压器能打开', () => {
    it('单个文本文件：内容逐字节一致', async () => {
        const zip = await writeZip([{ name: '表格.md', data: bytes('| a | b |\n| - | - |\n') }]);
        const out = expand(zip);
        expect(fs.readFileSync(path.join(out, '表格.md'), 'utf8')).toBe('| a | b |\n| - | - |\n');
    });

    it('多个文件：一个都不少，内容各自对得上', async () => {
        const entries = [
            { name: 'one.md', data: bytes('第一个') },
            { name: 'two.md', data: bytes('第二个') },
            { name: 'three.md', data: bytes('第三个') },
        ];
        const out = expand(await writeZip(entries));
        expect(fs.readdirSync(out).sort()).toEqual(['one.md', 'three.md', 'two.md']);
        for (const e of entries) {
            expect(fs.readFileSync(path.join(out, e.name), 'utf8')).toBe(new TextDecoder().decode(e.data));
        }
    });

    it('中文文件名不乱码（靠本地头里的 UTF-8 标志位）', async () => {
        const out = expand(await writeZip([{ name: '学术三线表 · 表 4.2.md', data: bytes('x') }]));
        expect(fs.readdirSync(out)).toContain('学术三线表 · 表 4.2.md');
    });

    it('二进制内容不被破坏（模拟 PNG）', async () => {
        // 带 PNG magic 和一堆 0x00 / 0xFF —— 最容易在编码环节被改坏的字节
        const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 255, 254, 0, 1, 127, 128]);
        const out = expand(await writeZip([{ name: 'a.png', data: png }]));
        expect(new Uint8Array(fs.readFileSync(path.join(out, 'a.png')))).toEqual(png);
    });

    it('子目录结构能还原', async () => {
        const out = expand(await writeZip([
            { name: 'png/表一.png', data: bytes('p1') },
            { name: 'markdown/表一.md', data: bytes('m1') },
        ]));
        expect(fs.readFileSync(path.join(out, 'png', '表一.png'), 'utf8')).toBe('p1');
        expect(fs.readFileSync(path.join(out, 'markdown', '表一.md'), 'utf8')).toBe('m1');
    });

    it('空文件也能打进去（0 字节的表格不该让整个包报废）', async () => {
        const out = expand(await writeZip([
            { name: 'empty.md', data: new Uint8Array(0) },
            { name: 'ok.md', data: bytes('有内容') },
        ]));
        expect(fs.statSync(path.join(out, 'empty.md')).size).toBe(0);
        expect(fs.readFileSync(path.join(out, 'ok.md'), 'utf8')).toBe('有内容');
    });

    it('几十个文件的包依然完整', async () => {
        const entries = Array.from({ length: 40 }, (_, i) => ({
            name: `表 ${i + 1}.md`,
            data: bytes(`内容 ${i + 1}`.repeat(20)),
        }));
        const out = expand(await writeZip(entries));
        expect(fs.readdirSync(out)).toHaveLength(40);
        expect(fs.readFileSync(path.join(out, '表 40.md'), 'utf8')).toBe('内容 40'.repeat(20));
    });
});

describe('文件名清洗', () => {
    it('去掉 Windows 上的非法字符', () => {
        expect(safeEntryName('表/4.2: 技术选型?')).toBe('表4.2 技术选型');
        expect(safeEntryName('a\\b*c"d<e>f|g')).toBe('abcdefg');
    });

    it('开头的点会变隐藏文件，要削掉', () => {
        expect(safeEntryName('...gitignore')).toBe('gitignore');
    });

    it('清洗完变空的，退回兜底名', () => {
        expect(safeEntryName('///')).toBe('未命名');
        expect(safeEntryName('   ', '表格')).toBe('表格');
    });

    it('过长的名字会截断（文件系统有上限）', () => {
        expect(safeEntryName('长'.repeat(300)).length).toBe(120);
    });
});

describe('同名去重', () => {
    it('第二个开始加序号，序号插在扩展名前面', () => {
        expect(dedupeNames(['a.png', 'a.png', 'a.png', 'b.png']))
            .toEqual(['a.png', 'a (2).png', 'a (3).png', 'b.png']);
    });

    it('大小写不同也算同名（Windows 文件系统不区分大小写）', () => {
        expect(dedupeNames(['A.md', 'a.md'])).toEqual(['A.md', 'a (2).md']);
    });

    it('没有扩展名时序号加在末尾', () => {
        expect(dedupeNames(['表', '表'])).toEqual(['表', '表 (2)']);
    });

    it('重名的表真的能各自解出来，不会互相覆盖', async () => {
        const names = dedupeNames(['同名.md', '同名.md']);
        const out = expand(await writeZip([
            { name: names[0], data: bytes('第一份') },
            { name: names[1], data: bytes('第二份') },
        ]));
        expect(fs.readdirSync(out)).toHaveLength(2);
        expect(fs.readFileSync(path.join(out, '同名.md'), 'utf8')).toBe('第一份');
        expect(fs.readFileSync(path.join(out, '同名 (2).md'), 'utf8')).toBe('第二份');
    });
});
