// ============================================================
//  开发模式启动器：先把端口谈妥，再拉起前后端
//
//  为什么要多这一层。Vite 的 /api 代理是**写死指向 API_PORT** 的
//  （见 vite.config.ts）。如果那个端口被别的程序占着 —— 而且那个程序
//  你还关不掉 —— 会出现最坏的一种情况：
//
//    1. Express 撞上 EADDRINUSE 起不来
//    2. 但 concurrently 的另一路（Vite）活得好好的，页面照常打开
//    3. Vite 仍然把 /api 往那个端口转发
//    4. 于是本站的接口请求全部打到那个陌生进程上 ——
//       GET 拿回一堆莫名其妙的东西，POST 等于把你的数据写给别人
//
//  最要命的是它**不像坏了**：页面能开、能点，只有数据不对。
//
//  所以在拉起任何子进程之前，这里先真的去 listen 一下确认端口空闲，
//  确认完再把最终端口塞进环境变量传下去 —— 前端和后端拿到的
//  一定是同一组数字，代理不可能指错地方。
//
//  手动指定仍然优先：API_PORT / PORT 有值就从那个值开始找。
// ============================================================

import { spawn } from 'node:child_process';
import net from 'node:net';

/** 往后最多顺延几个端口再放弃 */
const SPAN = 30;

/**
 * 前后端绑的地址不一样，所以要挨个试。
 *
 * Express 用 listen(port) 不带 host，绑的是通配（netstat 里是 0.0.0.0 + [::]）；
 * Vite 默认只听 localhost，netstat 里只有 [::1]。
 * 只探 0.0.0.0 的话，一个占着 [::1]:6767 的 Vite 是探不出来的 ——
 * 于是「探到空闲」，起来才发现撞了。三个地址全试一遍才算数。
 */
const PROBE_HOSTS = [undefined, '127.0.0.1', '::1'];

function canBind(port, host) {
    return new Promise((resolve) => {
        const srv = net.createServer();
        srv.once('error', (err) => {
            // 只有「被占用 / 没权限」才算冲突。这台机器没开 IPv6 时
            // 绑 ::1 会报 EADDRNOTAVAIL —— 那是这个地址不存在，不是被人占了
            resolve(!(err.code === 'EADDRINUSE' || err.code === 'EACCES'));
        });
        srv.once('listening', () => srv.close(() => resolve(true)));
        if (host === undefined) srv.listen(port);
        else srv.listen(port, host);
    });
}

/** 不查 netstat、不猜 —— 挨个地址真的 listen 一下再关掉 */
async function isFree(port) {
    for (const host of PROBE_HOSTS) {
        if (!await canBind(port, host)) return false;
    }
    return true;
}

/** 从 start 往后找一个空端口；taken 里的跳过（前后端不能撞在一起） */
async function pickPort(label, start, taken) {
    for (let p = start; p < start + SPAN; p++) {
        if (taken.has(p)) continue;
        if (await isFree(p)) {
            if (p !== start) {
                console.log(`[dev] ${label} 想用的 ${start} 被别的程序占着，改用 ${p}`);
            }
            taken.add(p);
            return p;
        }
    }
    throw new Error(
        `[dev] ${label}：从 ${start} 起连续 ${SPAN} 个端口全被占用。`
        + `\n      用 ${label}=<你确定空着的端口> 再跑一次。`,
    );
}

// 默认：前端 6767，后端 6969。被占了就各自往后顺延，前后端一起对齐。
const taken = new Set();
const apiPort = await pickPort('API_PORT', Number(process.env.API_PORT ?? 6969), taken);
const webPort = await pickPort('PORT', Number(process.env.PORT ?? 6767), taken);

console.log(`[dev] 接口 → http://localhost:${apiPort}   页面 → http://localhost:${webPort}`);

// shell: true —— Windows 上 npm 实际是 npm.cmd，不走 shell 找不到它
const child = spawn('npm', ['run', 'dev:all'], {
    stdio: 'inherit',
    shell: true,
    env: { ...process.env, API_PORT: String(apiPort), PORT: String(webPort) },
});

// Ctrl-C 要能一路传下去，否则 concurrently 那两个子进程会变成孤儿
for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => child.kill(sig));
}
child.on('exit', (code, signal) => {
    process.exit(signal ? 1 : (code ?? 0));
});
