// ============================================================
//  构建前清理产物目录 —— 只删文件，绝不删目录
//
//  为什么不直接让 Vite 的 emptyOutDir 干这事：
//  项目所在的 E: 盘是 FAT32 且卷已损坏（fsutil dirty query E: 报 Dirty）。
//  在这个卷上删掉一个目录会留下「幽灵目录」—— dir 列得出来、进去是空的、
//  连 lstat 都返回 EPERM，任何进程都删不掉也改不了名。
//  于是 Vite 每次 emptyDir 都会在上一次构建留下的 build/client/viz 上失败，
//  构建再也跑不起来。
//
//  实测文件是能正常删的，只有目录会变幽灵。所以这里递归 unlink 所有文件、
//  保留目录结构，Vite 再往里写新产物即可（vite.config.ts 里 emptyOutDir: false）。
//
//  卷用 chkdsk E: /f 修好之后，这个脚本可以删掉、emptyOutDir 改回 true。
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = path.join(ROOT, 'build');

let removed = 0;
let failed = 0;

/** 递归删文件，目录一律留着 */
function wipeFiles(dir) {
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        // 幽灵目录读不了，跳过就是 —— 反正它也是空的
        return;
    }
    for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
            wipeFiles(full);
        } else {
            try { fs.unlinkSync(full); removed++; } catch { failed++; }
        }
    }
}

if (fs.existsSync(TARGET)) {
    wipeFiles(TARGET);
    console.log(`清理产物：删除 ${removed} 个文件${failed ? `，${failed} 个删不掉` : ''}（目录结构保留）`);
} else {
    fs.mkdirSync(TARGET, { recursive: true });
    console.log('产物目录不存在，已新建');
}
