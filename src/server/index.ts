// ============================================================
//  Express 入口
//
//  开发时：Vite 跑在 5173，把 /api 转发到这里（见 vite.config.ts）。
//  生产时：这里同时把 dist/client 与 public/ 一起托管，单进程一个端口。
// ============================================================

import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from './db.js';
import { tablesRouter } from './routes-tables.js';
import { cardsRouter } from './routes-cards.js';
import { speakingRouter } from './routes-speaking.js';
import { assistantRouter } from './routes-assistant.js';
import { notesRouter } from './routes-notes.js';
import { StudyError } from './study.js';
import { SpeakingError } from './speaking.js';
import { AssistantError } from './assistant.js';
import { LlmError } from './llm.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
// 开发时 Vite 和 Express 是同一条 npm 命令拉起来的两个子进程，继承同一份环境变量，
// 所以这里**只认 API_PORT**，绝不去读 PORT —— 否则外部工具给 dev server 指定
// 一个 PORT，两个子进程会一起抢同一个端口。
// 前端认 PORT（见 vite.config.ts），后端认 API_PORT，各管各的。
// 后端固定 6969（前端 6767，见 vite.config.ts）。
// 生产模式下这一个进程同时托管接口与打好的前端，所以生产访问的也是 6969。
const PORT = Number(process.env.API_PORT ?? 6969);

export function createApp(): express.Express {
    const app = express();

    // 三线表的 HTML 可能不小，给宽松一点
    app.use(express.json({ limit: '32mb' }));

    app.use('/api', tablesRouter);
    app.use('/api', cardsRouter);
    app.use('/api', speakingRouter);
    app.use('/api', assistantRouter);
    app.use('/api', notesRouter);

    // 只有在跑编译产物时才托管前端。
    //
    // 判断依据是自己在哪：生产是 node build/server/index.js（父目录叫 build），
    // 开发是 tsx src/server/index.ts（父目录叫 src）。
    // 不这么分的话，开发时这个端口会端出一份**过期的** build/client ——
    // 改了前端代码在 Vite 那个端口是新的、在这个端口还是旧的，极难发现。
    const runningFromDist = path.basename(path.dirname(HERE)) === 'build';
    const clientDist = path.join(ROOT, 'build', 'client');

    if (!runningFromDist) {
        // 开发模式下有人误开了这个端口，直接告诉他前端在哪，别让他对着旧页面调试
        app.get('/', (_req, res) => {
            res.status(404).type('text/plain; charset=utf-8').send(
                '这里是开发模式的接口服务（Express）。\n'
                + '前端由 Vite 托管，请打开 npm run dev 输出里 client 那一行的地址。\n'
                + '本端口只提供 /api/* 接口。\n',
            );
        });
    }

    if (runningFromDist && fs.existsSync(clientDist)) {
        app.use(express.static(clientDist, {
            index: false,
            setHeaders(res, filePath) {
                // assets/ 下的文件名都带内容哈希，内容一变文件名就变，可以放心长缓存
                if (filePath.includes(`${path.sep}assets${path.sep}`)) {
                    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
                }
            },
        }));

        // SPA 兜底：只接管「页面导航」，绝不接管静态资源。
        //
        // 之前这里是「非 /api 的一律回 index.html」，结果一个不存在的
        // /assets/index-xxxx.css 会拿到一份 HTML，浏览器报的是
        // "Refused to apply style ... MIME type ('text/html')" 这种看不懂的错，
        // 而不是干脆的 404 —— 排查起来非常费劲。带扩展名的路径一律照实 404。
        app.use((req, res, next) => {
            if (req.method !== 'GET' || req.path.startsWith('/api/')) { next(); return; }

            if (req.path.startsWith('/assets/') || path.extname(req.path) !== '') {
                res.status(404).type('text/plain; charset=utf-8').send('Not Found');
                return;
            }

            // index.html 绝不能被缓存：它引用的是带哈希的文件名，
            // 一旦浏览器缓存住旧的 index.html，就会去要一批已经不存在的资源。
            res.setHeader('Cache-Control', 'no-cache');
            res.sendFile(path.join(clientDist, 'index.html'));
        });
    }

    // 统一错误出口：带状态码的自定义错误照实透出去，其余一律 500
    app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
        if (err instanceof StudyError || err instanceof SpeakingError
            || err instanceof AssistantError || err instanceof LlmError) {
            res.status(err.status).json({ error: err.message });
            return;
        }
        console.error('[api] 未处理的错误', err);
        res.status(500).json({ error: err instanceof Error ? err.message : '服务端错误' });
    });

    return app;
}

// 被测试 import 时不要自己起服务
const isMain = process.argv[1]
    && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
    db();   // 建库 / 建表，早失败早知道

    const server = createApp().listen(PORT, () => {
        // 不能一进这个回调就报「已启动」。
        //
        // 实测（Windows + tsx，端口被别的进程占着）：这个回调**照样会被调用**，
        // 只是 server.listening 为 false、server.address() 为 null，
        // 紧接着才轮到下面的 error。照直打印的话，屏幕上先出现一行
        // 「工具箱服务已启动 → …」再出现「端口被占用」—— 前一行是假的，
        // 而人往往只看第一行。
        //
        // 所以以 address() 为准：它有值才是真的听上了。顺带用它报**实际**
        // 绑到的端口，而不是我们想要的那个。
        const addr = server.address();
        if (!addr || typeof addr !== 'object') return;
        console.log(`工具箱服务已启动 → http://localhost:${addr.port}`);
    });

    /**
     * 端口被别人占了要**响亮地死**，不能默默换一个继续跑。
     *
     * 没有这个监听时，EADDRINUSE 会变成一条未捕获异常 + 一屏英文栈，
     * 看不出发生了什么。更麻烦的是开发模式：Vite 那一路还活着，
     * 页面照常打开，而 /api 仍然往这个端口转发 —— 请求于是打到了
     * 占着端口的那个陌生程序上。页面不像坏了，只是数据全不对。
     *
     * 也不自动顺延端口：生产模式下你按 URL 去访问，服务却偷偷搬到了
     * 隔壁端口，那跟没起来一样难查。开发模式的顺延交给 scripts/dev.mjs
     * 在**拉起进程之前**做，那时候改端口前后端还能对齐。
     */
    server.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code !== 'EADDRINUSE') throw err;

        console.error(
            `\n[api] 端口 ${PORT} 已被另一个程序占用，接口没起来。\n`
            + `      · 开发：npm run dev（它会先探一个空端口，前后端一起对齐）\n`
            + `      · 生产：API_PORT=${PORT + 1} npm start\n`
            + `      查是谁占着（Windows）：netstat -ano | findstr :${PORT}\n`,
        );
        process.exit(1);
    });
}
