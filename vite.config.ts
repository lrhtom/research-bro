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

        /**
         * 强制 react / react-dom 全站只有一份实例。
         *
         * 装 @uiw/react-codemirror（算法题库的代码编辑器）之后踩到的：
         * 页面报「Invalid hook call … more than one copy of React」，
         * 然后整个应用白屏。npm ls react 显示磁盘上明明只有一份、全是 deduped ——
         * 多出来的那一份是 **Vite 的依赖预打包** 造的：第三方包被预构建成
         * 自己那一份产物时，可能带上另一条通往 react 的解析路径，
         * 于是 hooks 的那个全局单例就成了两个。
         *
         * dedupe 让这类包一律解析回根目录这一份。这是「装了个带 React 的库
         * 之后突然白屏」的标准解，跟具体是哪个库无关，所以往后新增
         * React 生态的依赖也不必再排查一次。
         */
        dedupe: ['react', 'react-dom'],
    },

    optimizeDeps: {
        // 预打包这两个重家伙，省得进题目页时才现场编译一遍（首次打开会卡好几秒）。
        // 它们都是动态 import 的，Vite 扫不到静态 import，不写在这儿就只能等到
        // 真正点进去那一刻才发现要优化，然后触发一次整页刷新。
        include: ['@uiw/react-codemirror', '@codemirror/lang-python', 'katex'],
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
