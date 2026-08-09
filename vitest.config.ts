import { defineConfig } from 'vitest/config';

// 单独一份配置：vite.config.ts 的 root 指向 src/client（前端源码），
// 而测试跑的是服务端逻辑，根目录得是仓库根。分开写比互相迁就清楚。
export default defineConfig({
    test: {
        environment: 'node',
        include: ['src/**/*.test.ts'],
        // better-sqlite3 是原生模块，不要让 Vite 去处理它
        server: { deps: { external: ['better-sqlite3'] } },
    },
});
