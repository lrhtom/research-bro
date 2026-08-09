import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
    // 前端源码单独放一层，index.html 就在它旁边
    root: r('./src/client'),

    // 30 个可视化演示的原生 JS 与 viz.css 原样放在仓库根的 public/，
    // dev 直接由 Vite 托管，build 时整个拷进 dist/client
    publicDir: r('./public'),

    plugins: [react()],

    resolve: {
        alias: { '@': r('./src/client') },
    },

    build: {
        outDir: r('./build/client'),
        // 清理交给 scripts/clean-build.mjs（build 脚本里先跑），这里必须关掉。
        // 原因：E: 盘是 FAT32 且卷已损坏，删目录会留下删不掉的幽灵目录，
        // Vite 的 emptyOutDir 每次都会在上次构建留下的 build/client/viz 上 EPERM。
        // 那个脚本只 unlink 文件、不碰目录，绕开这个坑。
        // 卷修好之后可以把它改回 true 并删掉那个脚本。
        emptyOutDir: false,
        sourcemap: true,
    },

    server: {
        // 前端 6767。PORT 有值就用它 —— npm run dev 会先探空闲端口再传进来
        port: Number(process.env.PORT ?? 6767),
        // 接口全部走 Express（src/server），开发时由 Vite 转发过去。
        // Express 那边只认 API_PORT，默认 6969 —— 跟前端的 PORT 分开，免得抢端口。
        proxy: {
            '/api': {
                target: `http://localhost:${process.env.API_PORT ?? 6969}`,
                changeOrigin: true,
                /**
                 * 代理连不上时要说人话。
                 *
                 * 默认行为是往浏览器丢一个干巴巴的 500，控制台只有一行
                 * ECONNREFUSED —— 而这时候真正该问的是「后端到底起来没有」。
                 * 后端因为端口被占而没起来，就是最常见的那一种。
                 */
                configure: (proxy) => {
                    proxy.on('error', (err) => {
                        console.error(
                            `[proxy] /api 转发失败：${err.message}\n`
                            + `        后端应该在 ${process.env.API_PORT ?? 6969} 上，去看 server 那一路的输出 ——`
                            + `端口被占用时它会打印出来。`,
                        );
                    });
                },
            },
        },
    },
});
