// ============================================================
//  演示：WAL（预写日志）与崩溃恢复
//  三条泳道共用一根时间轴：内存脏页 / redo log（分成用户态 buffer、OS page cache、磁盘三层）/ 磁盘数据页。
//  随便挑一个时刻「断电」，再点「重启恢复」，看 redo 前滚 + undo 回滚是怎么把账算平的。
//  最要命的一点：innodb_flush_log_at_trx_commit = 2 和 0 的区别，
//  只有在「进程被 kill」和「主机断电」这两种崩溃下才看得出来 —— 这也是最容易讲错的地方。
//  上半 WAL.* 是纯函数（不碰 DOM，可单独测），下半是界面。
// ============================================================

(function () {

// ---------- 一、模型（纯函数）----------

const WAL = {};

// 每 7 个 tick 相当于「1 秒」—— InnoDB 的 master thread 每秒会 write + fsync 一次 redo log
WAL.BG_EVERY = 7;

/**
 * 演示用的事件序列（写死的，不用随机，保证可复现）。
 * T1、T3、T4 会提交；T2 从头到尾没提交 —— 它就是用来看 undo 的。
 */
WAL.scenario = function () {
    return [
        { t: 1, trx: 'T1', type: 'begin' },
        { t: 2, trx: 'T1', type: 'write', page: 'A', before: 100, after: 150 },
        { t: 3, trx: 'T2', type: 'begin' },
        { t: 4, trx: 'T2', type: 'write', page: 'B', before: 200, after: 250 },
        { t: 5, trx: 'T1', type: 'write', page: 'C', before: 300, after: 350 },
        { t: 6, trx: 'T1', type: 'commit' },
        { t: 7, trx: 'T2', type: 'write', page: 'A', before: 150, after: 180 },
        { t: 9, trx: 'T3', type: 'begin' },
        { t: 10, trx: 'T3', type: 'write', page: 'D', before: 400, after: 450 },
        { t: 11, trx: 'T3', type: 'commit' },
        { t: 12, trx: null, type: 'checkpoint' },
        { t: 13, trx: 'T2', type: 'write', page: 'D', before: 450, after: 500 },
        { t: 15, trx: 'T4', type: 'begin' },
        { t: 16, trx: 'T4', type: 'write', page: 'E', before: 500, after: 550 },
        { t: 17, trx: 'T4', type: 'commit' },
    ];
};

WAL.MAX_T = 19;
WAL.PAGES = ['A', 'B', 'C', 'D', 'E'];
WAL.INITIAL = { A: 100, B: 200, C: 300, D: 400, E: 500 };

/**
 * 跑到 crashAt 时刻（含）为止，返回那一刻的完整状态。
 *
 * opt = {
 *   flushMode: 1 | 2 | 0,   // innodb_flush_log_at_trx_commit
 *   crashAt: number,
 * }
 *
 * 三层日志位置的含义（这是本演示的核心）：
 *   logBuf  —— MySQL 进程自己的内存（redo log buffer）。进程一死就没了。
 *   osCache —— 已经 write() 给内核，但没 fsync。MySQL 死了它还在，主机断电就没了。
 *   logDisk —— fsync 过了，真的在盘上。断电也在。
 */
WAL.simulate = function (opt) {
    opt = opt || {};
    const mode = opt.flushMode == null ? 1 : opt.flushMode;
    const crashAt = opt.crashAt == null ? WAL.MAX_T : opt.crashAt;
    const events = WAL.scenario();

    const st = {
        logBuf: [], osCache: [], logDisk: [],
        dirty: {},                              // buffer pool 里改过没刷盘的页
        disk: Object.assign({}, WAL.INITIAL),   // 磁盘上的数据页
        mem: Object.assign({}, WAL.INITIAL),    // buffer pool 里此刻的值（内存视图）
        committedApp: [],                       // 应用层已经收到「提交成功」的事务
        checkpointLsn: 0,
        log: [],                                // 所有产生过的 redo 记录（含还没落盘的）
    };

    let lsn = 0;
    const timeline = [];

    const flushBufToOs = () => { while (st.logBuf.length) st.osCache.push(st.logBuf.shift()); };
    const fsyncOsToDisk = () => { while (st.osCache.length) st.logDisk.push(st.osCache.shift()); };

    for (let t = 1; t <= crashAt; t++) {
        const evs = events.filter((e) => e.t === t);
        evs.forEach((e) => {
            if (e.type === 'write') {
                lsn++;
                const rec = {
                    lsn, t, trx: e.trx, page: e.page,
                    before: e.before, after: e.after, kind: 'write',
                };
                st.log.push(rec);
                st.logBuf.push(rec);
                st.dirty[e.page] = e.after;
                st.mem[e.page] = e.after;
            } else if (e.type === 'commit') {
                lsn++;
                const rec = { lsn, t, trx: e.trx, kind: 'commit' };
                st.log.push(rec);
                st.logBuf.push(rec);
                // 提交时按 flushMode 决定日志走到哪一层
                if (mode === 1) { flushBufToOs(); fsyncOsToDisk(); }
                else if (mode === 2) { flushBufToOs(); }
                // mode 0：什么都不做，就躺在用户态 buffer 里
                st.committedApp.push(e.trx);
            } else if (e.type === 'checkpoint') {
                // ★ Write-Ahead 的字面意思就在这里：
                //   往磁盘写任何一个脏页之前，必须先保证描述这个页改动的日志已经落盘。
                //   否则「页写下去了、日志没写」，崩溃后既无法重放也无法回滚，账就永远算不平了。
                //   （InnoDB 里对应的是刷页之前先 log_write_up_to() 到该页的 LSN。）
                flushBufToOs(); fsyncOsToDisk();
                // 然后才把脏页刷回磁盘，并记下 checkpoint LSN。
                // 注意它会把「未提交事务改过的页」也刷下去 —— 这就是 steal 策略，undo 存在的理由
                Object.keys(st.dirty).forEach((p) => { st.disk[p] = st.dirty[p]; });
                st.dirty = {};
                st.checkpointLsn = lsn;
                st.log.push({ lsn, t, trx: null, kind: 'checkpoint' });
            }
        });
        // 后台线程每秒 write + fsync 一次（三种 flushMode 都有这一步）
        if (t % WAL.BG_EVERY === 0) { flushBufToOs(); fsyncOsToDisk(); }

        timeline.push({
            t,
            logBuf: st.logBuf.slice(), osCache: st.osCache.slice(), logDisk: st.logDisk.slice(),
            dirty: Object.assign({}, st.dirty), disk: Object.assign({}, st.disk),
        });
    }

    return { state: st, timeline, mode, crashAt, lsn };
};

/**
 * 崩溃。kind='kill' 进程被杀（OS 还活着）/ 'power' 主机断电。
 * 返回崩溃之后<b>硬盘上真实存在</b>的东西。
 */
WAL.crash = function (sim, kind) {
    const st = sim.state;
    // 进程被 kill：用户态的 log buffer 没了，但已经 write() 进 OS page cache 的东西
    //              操作系统还会替你写下去 —— 所以它算活着。
    // 主机断电：用户态和内核的内存一起没，只有 fsync 过的才算数。
    const survived = kind === 'kill'
        ? st.logDisk.concat(st.osCache)
        : st.logDisk.slice();

    const lost = kind === 'kill'
        ? st.logBuf.slice()
        : st.logBuf.concat(st.osCache);

    // 脏页在内存里，两种崩溃都没了；磁盘数据页保持崩溃那一刻的样子
    return {
        kind, durableLog: survived, lostRecords: lost,
        disk: Object.assign({}, st.disk),
        committedApp: st.committedApp.slice(),
        checkpointLsn: st.checkpointLsn,
    };
};

/**
 * 重启恢复：先 redo 前滚，再 undo 回滚。
 *
 * redo 阶段的关键（也是最反直觉的一点）：
 *   它<b>不管这条记录属于哪个事务、有没有提交</b>，一律重放。
 *   目的是先把磁盘恢复成「崩溃那一瞬间内存里的样子」，
 *   至于哪些该留哪些该扔，交给下一步的 undo。
 */
WAL.recover = function (crashed) {
    const pages = Object.assign({}, crashed.disk);
    const writes = crashed.durableLog.filter((r) => r.kind === 'write');
    const commits = {};
    crashed.durableLog.forEach((r) => { if (r.kind === 'commit') commits[r.trx] = true; });

    // ① redo 前滚：按 LSN 从小到大，全部重放
    const redoSteps = [];
    writes.slice().sort((a, b) => a.lsn - b.lsn).forEach((r) => {
        const from = pages[r.page];
        pages[r.page] = r.after;
        redoSteps.push({
            lsn: r.lsn, trx: r.trx, page: r.page, from, to: r.after,
            committed: !!commits[r.trx],
            skipped: r.lsn <= crashed.checkpointLsn,
        });
    });

    // ② undo 回滚：日志里有写但没有 commit 记录的事务，按 LSN 从大到小撤销
    const openTrx = [];
    writes.forEach((r) => { if (!commits[r.trx] && openTrx.indexOf(r.trx) < 0) openTrx.push(r.trx); });
    const undoSteps = [];
    writes.filter((r) => !commits[r.trx]).sort((a, b) => b.lsn - a.lsn).forEach((r) => {
        const from = pages[r.page];
        pages[r.page] = r.before;
        undoSteps.push({ lsn: r.lsn, trx: r.trx, page: r.page, from, to: r.before });
    });

    // ③ 应用层以为提交成功、但日志没落盘的事务 —— 这才是真正的「丢数据」
    const lostCommits = crashed.committedApp.filter((tx) => !commits[tx]);

    // 正确答案：只有 durableLog 里有 commit 记录的事务的改动才该留下
    const expected = Object.assign({}, WAL.INITIAL);
    writes.slice().sort((a, b) => a.lsn - b.lsn).forEach((r) => {
        if (commits[r.trx]) expected[r.page] = r.after;
    });

    let correct = true;
    Object.keys(expected).forEach((p) => { if (expected[p] !== pages[p]) correct = false; });

    return {
        pages, expected, correct,
        redoSteps, undoSteps, openTrx, lostCommits,
        committedTrx: Object.keys(commits),
        redoSkippable: redoSteps.filter((s) => s.skipped).length,
    };
};

/**
 * 打脸 B：三种 flushMode × 两种崩溃，各丢多少已提交的事务。
 * crashAt 默认取「T4 刚提交完、后台还没来得及刷」那一刻。
 */
WAL.lossMatrix = function (crashAt) {
    const at = crashAt == null ? 18 : crashAt;
    const out = [];
    [1, 2, 0].forEach((mode) => {
        const sim = WAL.simulate({ flushMode: mode, crashAt: at });
        const row = { mode, kill: null, power: null };
        ['kill', 'power'].forEach((kind) => {
            const c = WAL.crash(sim, kind);
            const rec = WAL.recover(c);
            row[kind] = {
                lostCommits: rec.lostCommits.slice(),
                lostRecords: c.lostRecords.length,
                correct: rec.correct,
                pages: rec.pages,
            };
        });
        out.push(row);
    });
    return { at, rows: out };
};

/**
 * 第三点：WAL 为什么快。
 * 不用 WAL：提交时要把这次改的 n 个数据页各自写回它们在磁盘上的原位置 → n 次随机 I/O。
 * 用 WAL  ：提交时只把 redo 记录顺序追加到日志尾巴 → 1 次顺序写 + 1 次 fsync；
 *           脏页由后台慢慢合并着刷（而且同一个页被改 10 次也只用刷 1 次）。
 */
WAL.ioCompare = function (nPages, randomMs, seqMs) {
    const direct = nPages * randomMs;
    const wal = seqMs;
    return {
        nPages, randomMs, seqMs, direct, wal,
        speedup: wal > 0 ? direct / wal : Infinity,
    };
};

if (typeof module !== 'undefined' && module.exports) module.exports = WAL;
if (typeof window !== 'undefined') window.WALModel = WAL;

// ---------- 二、界面 ----------

if (typeof window === 'undefined' || !window.Viz) return;

const h = Viz.h, svg = Viz.svg;

const state = {
    mode: 1,
    crashAt: 18,
    crashKind: 'power',
    recovered: false,
    nPages: 12,
    randomMs: 8,
    seqMs: 1,
};

let rootEl = null;

// ---------- 三泳道时间轴 ----------

const LANES = [
    { key: 'evt', name: '事务动作', sub: '谁在什么时候干了什么' },
    { key: 'buf', name: 'redo log buffer', sub: 'MySQL 进程内存 · 进程一死就没' },
    { key: 'os', name: 'OS page cache', sub: '内核内存 · 断电就没' },
    { key: 'disk', name: 'ib_logfile（磁盘）', sub: 'fsync 过了 · 断电也在' },
    { key: 'dirty', name: 'Buffer Pool 脏页', sub: '内存 · 崩溃就没' },
    { key: 'data', name: '磁盘数据页 .ibd', sub: '崩溃时留在盘上的值' },
];

function buildLanes(sim) {
    const W = 700, PAD_L = 136, PAD_R = 14, PAD_T = 24;
    const LH = 40;
    const H = PAD_T + LANES.length * LH + 26;
    const iw = W - PAD_L - PAD_R;
    const X = (t) => PAD_L + ((t - 0.5) / WAL.MAX_T) * iw;

    const root = svg('svg', {
        viewBox: '0 0 ' + W + ' ' + H, class: 'wal-svg',
        preserveAspectRatio: 'xMidYMid meet', role: 'img', 'aria-label': 'WAL 三层日志时间轴',
    });

    // 泳道底色 + 名字
    LANES.forEach((l, i) => {
        const y = PAD_T + i * LH;
        root.appendChild(svg('rect', {
            x: PAD_L, y: y + 2, width: iw, height: LH - 5, rx: 5,
            class: 'wal-lane wal-lane-' + l.key,
        }));
        const n = svg('text', { x: PAD_L - 8, y: y + 17, class: 'wal-lane-n', 'text-anchor': 'end' });
        n.textContent = l.name;
        root.appendChild(n);
        const s = svg('text', { x: PAD_L - 8, y: y + 30, class: 'wal-lane-s', 'text-anchor': 'end' });
        s.textContent = l.sub;
        root.appendChild(s);
    });

    // 时间刻度
    for (let t = 1; t <= WAL.MAX_T; t += 3) {
        const x = X(t);
        root.appendChild(svg('line', { x1: x, x2: x, y1: PAD_T - 4, y2: PAD_T + LANES.length * LH, class: 'wal-grid' }));
        const lb = svg('text', { x, y: PAD_T - 8, class: 'wal-tick', 'text-anchor': 'middle' });
        lb.textContent = 't=' + t;
        root.appendChild(lb);
    }

    // 每秒的后台刷盘标记
    for (let t = WAL.BG_EVERY; t <= WAL.MAX_T; t += WAL.BG_EVERY) {
        if (t > state.crashAt) break;
        const x = X(t) + 6;
        root.appendChild(svg('line', {
            x1: x, x2: x, y1: PAD_T + LH, y2: PAD_T + 4 * LH, class: 'wal-bg-flush',
        }));
        const lb = svg('text', { x: x + 3, y: PAD_T + LH + 11, class: 'wal-bg-l' });
        lb.textContent = '后台每秒 fsync';
        root.appendChild(lb);
    }

    // 事务动作
    const evs = WAL.scenario().filter((e) => e.t <= state.crashAt);
    const trxColor = { T1: 0, T2: 1, T3: 2, T4: 3 };
    evs.forEach((e) => {
        const x = X(e.t);
        const y = PAD_T + 6;
        let txt = '', cls = 'wal-ev-w';
        if (e.type === 'begin') { txt = e.trx + ' 开始'; cls = 'wal-ev-b'; }
        else if (e.type === 'commit') { txt = e.trx + ' COMMIT'; cls = 'wal-ev-c'; }
        else if (e.type === 'checkpoint') { txt = 'checkpoint'; cls = 'wal-ev-k'; }
        else { txt = e.trx + ' 改 ' + e.page; }
        const g = svg('g', { class: 'wal-ev ' + cls + (e.trx ? ' wal-t' + trxColor[e.trx] : '') });
        g.appendChild(svg('rect', { x: x - 2, y, width: 4, height: 22, rx: 2, class: 'wal-ev-bar' }));
        const t1 = svg('text', { x: x + 4, y: y + (e.t % 2 ? 9 : 20), class: 'wal-ev-t' });
        t1.textContent = txt;
        g.appendChild(t1);
        root.appendChild(g);
    });

    // redo 记录：画在它「崩溃那一刻实际所在的那一层」
    const st = sim.state;
    const place = (list, laneIdx, cls) => {
        list.forEach((r) => {
            if (r.kind === 'checkpoint') return;
            const x = X(r.t);
            const y = PAD_T + laneIdx * LH + 9;
            root.appendChild(svg('rect', {
                x: x - 9, y, width: 18, height: 20, rx: 4, class: 'wal-rec ' + cls,
            }));
            const t1 = svg('text', { x, y: y + 14, class: 'wal-rec-t', 'text-anchor': 'middle' });
            t1.textContent = r.kind === 'commit' ? '✓' : r.page;
            root.appendChild(t1);
        });
    };
    place(st.logBuf, 1, 'wal-rec-buf');
    place(st.osCache, 2, 'wal-rec-os');
    place(st.logDisk, 3, 'wal-rec-disk');

    // 脏页
    Object.keys(st.dirty).forEach((p, i) => {
        const x = PAD_L + 12 + i * 46;
        const y = PAD_T + 4 * LH + 9;
        root.appendChild(svg('rect', { x, y, width: 40, height: 20, rx: 4, class: 'wal-page wal-page-dirty' }));
        const t1 = svg('text', { x: x + 20, y: y + 14, class: 'wal-page-t', 'text-anchor': 'middle' });
        t1.textContent = p + '=' + st.dirty[p];
        root.appendChild(t1);
    });
    if (!Object.keys(st.dirty).length) {
        const t1 = svg('text', { x: PAD_L + 12, y: PAD_T + 4 * LH + 23, class: 'wal-empty' });
        t1.textContent = '（此刻没有脏页）';
        root.appendChild(t1);
    }

    // 磁盘数据页
    WAL.PAGES.forEach((p, i) => {
        const x = PAD_L + 12 + i * 46;
        const y = PAD_T + 5 * LH + 9;
        const changed = st.disk[p] !== WAL.INITIAL[p];
        root.appendChild(svg('rect', {
            x, y, width: 40, height: 20, rx: 4,
            class: 'wal-page' + (changed ? ' wal-page-w' : ''),
        }));
        const t1 = svg('text', { x: x + 20, y: y + 14, class: 'wal-page-t', 'text-anchor': 'middle' });
        t1.textContent = p + '=' + st.disk[p];
        root.appendChild(t1);
    });

    // 崩溃线
    const cx = X(state.crashAt) + 8;
    root.appendChild(svg('line', {
        x1: cx, x2: cx, y1: PAD_T - 14, y2: PAD_T + LANES.length * LH, class: 'wal-crash',
    }));
    const cl = svg('text', { x: cx + 4, y: PAD_T - 16, class: 'wal-crash-l' });
    cl.textContent = '💥 ' + (state.crashKind === 'power' ? '主机断电' : 'MySQL 被 kill');
    root.appendChild(cl);

    return root;
}

// ---------- 渲染 ----------

function render() {
    if (!rootEl) return;
    rootEl.innerHTML = '';

    const sim = WAL.simulate({ flushMode: state.mode, crashAt: state.crashAt });
    const crashed = WAL.crash(sim, state.crashKind);
    const rec = WAL.recover(crashed);

    // ── 场景 ──
    const ctl = h('div.controls');
    ctl.appendChild(h('label.ctl.ctl-wide', null,
        h('span.ctl-name', { text: '💥 在哪一刻崩溃' }),
        h('input', {
            type: 'range', min: '2', max: String(WAL.MAX_T), step: '1', value: String(state.crashAt),
            oninput: (e) => { state.crashAt = Number(e.target.value); state.recovered = false; render(); },
        }),
        h('b.ctl-val', { text: 't = ' + state.crashAt })
    ));
    ctl.appendChild(h('div.ctl-btns', null,
        h('button.mini' + (state.crashKind === 'kill' ? '.primary' : ''), {
            onclick: () => { state.crashKind = 'kill'; state.recovered = false; render(); },
        }, 'MySQL 被 kill'),
        h('button.mini' + (state.crashKind === 'power' ? '.danger' : ''), {
            onclick: () => { state.crashKind = 'power'; state.recovered = false; render(); },
        }, '主机断电'),
        h('button.mini.primary', {
            onclick: () => { state.recovered = !state.recovered; render(); },
        }, state.recovered ? '收起恢复过程' : '▶ 重启恢复')
    ));

    rootEl.appendChild(h('section.card', null,
        h('h3.sec-title', { html: '<i class="fas fa-scroll"></i> 场景：改数据之前，先把「我要改成什么」写进日志' }),
        h('p.sec-note', {
            html: 'WAL 就一条规矩：<b>数据页可以慢慢刷，但日志必须先落盘</b>（Write-Ahead Logging）。'
                + '有了这条，崩溃之后就能靠日志把账重新算平。<br>'
                + '下面这段里 <b>T1 / T3 / T4 提交了，T2 从头到尾没提交</b> —— '
                + 'T2 就是专门用来看 undo 的。'
                + '拖滑块选一个崩溃时刻，再点「重启恢复」。',
        }),
        h('p.sec-note', { html: '<code>innodb_flush_log_at_trx_commit</code> 设成几：' }),
        Viz.segmented({
            options: [
                { v: 1, label: '1（默认，最安全）' },
                { v: 2, label: '2（写给 OS，不 fsync）' },
                { v: 0, label: '0（连 write 都不做）' },
            ],
            value: state.mode,
            onPick: (v) => { state.mode = Number(v); state.recovered = false; render(); },
        }),
        ctl
    ));

    // ── 三泳道 ──
    rootEl.appendChild(h('section.card', null,
        h('h3.sec-title', { html: '<i class="fas fa-layer-group"></i> 崩溃那一瞬间，每条 redo 记录躺在哪一层' }),
        h('p.sec-note', {
            html: '这张图最值得看的是<b>纵向</b>：同一条 redo 记录，画在哪一行取决于它此刻走到了哪 —— '
                + '还在<b>进程内存</b>里、已经交给<b>内核</b>了、还是真的 <b>fsync 到盘</b>了。'
                + '换一下上面的 flushMode，看这些方块整体往下掉。',
        }),
        Viz.legend([
            { cls: 'wal-lg-buf', text: '还在 log buffer（危险）' },
            { cls: 'wal-lg-os', text: '在 OS page cache（半安全）' },
            { cls: 'wal-lg-disk', text: '已 fsync 落盘（安全）' },
            { cls: 'wal-lg-dirty', text: '脏页（内存里）' },
        ]),
        buildLanes(sim),
        h('div.seq-note', { html: laneVerdict(sim, crashed, rec) })
    ));

    // ── 恢复过程 ──
    if (state.recovered) {
        rootEl.appendChild(recoverCard(crashed, rec));
    } else {
        rootEl.appendChild(h('section.card', null,
            h('h3.sec-title', { html: '<i class="fas fa-rotate-right"></i> 重启恢复' }),
            h('p.sec-note', {
                html: '点上面那个「▶ 重启恢复」按钮，看 redo 前滚 + undo 回滚是怎么走的。'
                    + '<b>剧透一句：redo 会把未提交事务的记录也一起重放</b>，'
                    + '这是很多人第一次看会愣一下的地方。',
            })
        ));
    }

    // ── 打脸 B：三种 flushMode × 两种崩溃 ──
    rootEl.appendChild(lossCard());

    // ── WAL 为什么快 ──
    rootEl.appendChild(speedCard());

    // ── 机制 ──
    rootEl.appendChild(h('section.card', null,
        h('h3.sec-title', { html: '<i class="fas fa-list-ol"></i> 为什么非得有 redo 和 undo 两套' }),
        Viz.flowList([
            {
                t: '⓪ 先说清「Write-Ahead」四个字的字面意思',
                f: '// 刷任何一个脏页到磁盘之前：\nlog_write_up_to(page->newest_LSN);   // 先把该页对应的日志刷下去\nbuf_flush_page(page);                // 才允许写这个页',
                r: '日志永远跑在数据前面 —— 这就是 WAL 的全部规矩',
                hi: '违反它的后果很具体：如果脏页先落盘、日志没落盘，'
                    + '崩溃后磁盘上就有一个「日志里查无此事」的改动 —— '
                    + '既没法重放（不知道要做什么）也没法回滚（不知道原来是什么），账永远算不平。'
                    + '<b>上面 t=12 的 checkpoint 就是先刷日志再刷页的</b>，'
                    + '把 flushMode 调成 0 后拖到 t=12 附近看，日志方块会被 checkpoint 强行拽到磁盘那一行。',
            },
            {
                t: '① no-force：提交时<b>不</b>强制把脏页刷盘 → 所以需要 redo',
                f: 'COMMIT 时只保证 redo 记录落盘\n数据页什么时候刷，后台说了算',
                r: '提交快了，代价是崩溃后磁盘上可能缺已提交的改动 → 用 redo 补回来',
                hi: '如果提交时非要把所有相关数据页都刷下去（force），那就是 N 次随机 I/O，'
                    + '提交延迟直接爆炸。no-force 是性能的来源，redo 是它的代价。',
            },
            {
                t: '② steal：脏页可以在事务<b>还没提交</b>时就被刷盘 → 所以需要 undo',
                f: 'buffer pool 满了要腾位置，\n它才不管这个页属于哪个还没提交的事务',
                r: '于是磁盘上可能已经有了未提交的改动 → 用 undo 擦掉',
                hi: '上面那张图里 t=12 的 checkpoint 就把 T2（未提交）改过的页刷下去了。'
                    + '如果不允许 steal，buffer pool 就得一直攥着长事务的脏页，内存扛不住。',
            },
            {
                t: '③ 恢复第一步 redo 前滚：<b>不管提交没提交，全部重放</b>',
                f: 'for (rec of durableLog) page[rec.page] = rec.after;',
                r: '目的是先把磁盘恢复成「崩溃那一瞬间内存里的样子」',
                hi: '这一步最反直觉。为什么连未提交的也要重放？'
                    + '因为 undo 也是靠日志记录的，得先让整个数据库回到崩溃前的一致快照，'
                    + '才能在这个基础上准确地回滚。而且这样 redo 阶段不用判断事务状态，'
                    + '<b>可以纯顺序扫一遍日志，快得多</b>。',
            },
            {
                t: '④ 恢复第二步 undo 回滚：把没有 COMMIT 记录的事务撤掉',
                f: '按 LSN 从大到小，page[rec.page] = rec.before;',
                r: '倒着来是关键 —— 同一个页被改了多次时，只有倒着撤才能还原',
                hi: 'undo 信息不在 redo log 里，它在<b>回滚段（undo log）</b>里，'
                    + '而 undo log 本身也是被 redo 保护的页。'
                    + 'MVCC 的一致性读也是靠这套 undo 链回溯出旧版本的 —— 一套东西两个用途。',
            },
            {
                t: '⑤ 结果：已 COMMIT 的一条不少，未 COMMIT 的一条不留',
                f: '这就是 ACID 里 D（持久性）和 A（原子性）的实现',
                r: '恢复完的状态 = 只有已提交事务生效的那个状态',
            },
        ])
    ));

    // ── 面试 ──
    rootEl.appendChild(h('section.card', null,
        h('h3.sec-title', { html: '<i class="fas fa-comments"></i> 面试怎么答' }),
        Viz.qa([
            {
                q: 'WAL 为什么能让数据库变快？',
                a: '因为它把「<b>N 次随机写</b>」换成了「<b>1 次顺序写</b>」。'
                    + '一个事务可能改了分散在磁盘各处的十几个页，'
                    + '要保证持久性就得在提交前把它们全刷下去 —— 那是十几次随机 I/O。'
                    + 'WAL 只需要把「我把 X 改成了 Y」顺序追加到日志尾巴，一次写 + 一次 fsync 就完事。<br>'
                    + '还有第二层好处：<b>脏页可以合并刷</b>。同一个页在一秒内被改了 10 次，'
                    + '后台只需要刷 1 次；而不用 WAL 的话得刷 10 次。',
            },
            {
                q: '恢复时为什么要先 redo 再 undo？redo 连未提交的也重放，不是白做吗？',
                a: '不白做。<b>redo 的目标不是「恢复到提交状态」，而是「恢复到崩溃那一瞬间的内存状态」。</b>'
                    + '只有先回到那个状态，undo 才有一个准确的基准去回滚。<br>'
                    + '而且这样设计让 redo 阶段可以<b>纯顺序扫日志、不做任何判断</b>，'
                    + '速度极快（顺序读）。'
                    + '如果 redo 时就要判断「这个事务提交没有」，那得先把整个日志扫一遍建事务表，'
                    + '反而更慢。<b>先无脑前滚、再精确回滚</b>是 ARIES 恢复算法的核心思路。',
            },
            {
                q: 'innodb_flush_log_at_trx_commit = 1 / 2 / 0 有什么区别？',
                a: '差别在提交时日志走到哪一层：<br>'
                    + '<b>1</b>：write() + fsync()，记录真的进了盘。<b>断电也不丢。</b>代价是每次提交一次 fsync。<br>'
                    + '<b>2</b>：只 write()，交给操作系统的 page cache，不 fsync。'
                    + '<b>MySQL 进程被 kill 不丢</b>（数据在内核里，OS 会替你写下去），'
                    + '<b>但主机断电会丢最多 1 秒</b>。<br>'
                    + '<b>0</b>：连 write() 都不做，记录躺在 MySQL 自己的内存里，靠后台线程每秒刷一次。'
                    + '<b>进程被 kill 就会丢最多 1 秒</b>，断电当然也丢。<br>'
                    + '<b>2 和 0 的区别就在「进程崩溃」这一种场景上</b> —— 这是最容易讲错的点，'
                    + '因为很多人以为 0 和 2 都是「丢 1 秒」，其实 2 能扛住进程崩溃。',
            },
            {
                q: 'redo log 写满了会怎样？',
                a: 'redo log 是<b>固定大小的环形</b>结构，写到头会绕回来覆盖旧的。'
                    + '但只有「对应的脏页已经刷盘」的那部分才能被覆盖，'
                    + '所以写满时 InnoDB 必须停下来<b>强制刷脏页并推进 checkpoint</b>，'
                    + '这一下叫 <b>sharp checkpoint</b> —— 几乎全库卡住，比脏页超限还狠。<br>'
                    + '症状是写入 TPS 周期性地掉到接近 0。'
                    + '解法是调大 <code>innodb_log_file_size</code>（8.0 里是 '
                    + '<code>innodb_redo_log_capacity</code>）。'
                    + '代价是崩溃恢复要重放的日志更多，启动更慢 —— <b>拿恢复时间换运行时吞吐</b>。',
            },
            {
                q: 'binlog 和 redo log 是一回事吗？',
                a: '完全两回事。<b>redo log</b> 是 InnoDB 存储引擎的、物理层面的（「第 5 页第 30 字节改成 X」）、'
                    + '循环覆盖的，作用是<b>崩溃恢复</b>。'
                    + '<b>binlog</b> 是 MySQL Server 层的、逻辑层面的（「这条 SQL / 这一行变成了什么」）、'
                    + '追加不覆盖的，作用是<b>主从复制和时间点恢复</b>。<br>'
                    + '两者要保持一致，靠的是<b>两阶段提交</b>：'
                    + 'redo 先写 prepare → 写 binlog → redo 写 commit。'
                    + '崩溃恢复时如果发现 redo 是 prepare 状态，就去看 binlog 里有没有这个事务：'
                    + '有就提交，没有就回滚。',
            },
        ])
    ));

    // ── 坑 ──
    rootEl.appendChild(h('section.card', null,
        h('h3.sec-title', { html: '<i class="fas fa-triangle-exclamation"></i> 必须知道的坑' }),
        Viz.pitfalls([
            ['fsync 说「写完了」不代表数据真的在盘上',
             '硬盘自己有写缓存（write cache）。很多消费级 SSD / 机械盘在收到 fsync 时'
             + '<b>只是把数据放进自己的 DRAM 缓存就返回成功</b>，掉电照样丢。'
             + '企业级盘靠<b>掉电保护电容</b>解决这个问题，RAID 卡靠<b>带电池的写缓存（BBU）</b>。'
             + '所以「我设了 flush_log_at_trx_commit=1 就绝对不丢」这句话，'
             + '<b>前提是你的存储真的实现了 fsync 语义</b>。'],
            ['设成 2 或 0，「丢 1 秒」是最好情况不是最坏情况',
             '那个「1 秒」来自后台线程的刷盘周期，但如果磁盘 I/O 被打满、'
             + '或者刷盘线程被别的事情堵住，实际间隔可能远大于 1 秒。'
             + '<b>不要把它当成一个有保证的上界</b>，它只是个典型值。'],
            ['双写缓冲（doublewrite）解决的是另一个问题',
             '很多人把 doublewrite 和 redo log 混在一起。'
             + 'redo log 防的是「改动丢了」，doublewrite 防的是「<b>页写坏了</b>」—— '
             + 'InnoDB 页是 16KB 而磁盘扇区是 4KB，写一半掉电会产生<b>部分写（torn page）</b>，'
             + '这种坏页 redo 也救不了（redo 记的是增量，得先有个完整的老页才能应用）。'
             + '所以 InnoDB 先把页顺序写进 doublewrite buffer，再写到真实位置。'],
            ['长事务会把 undo log 撑爆',
             'undo log 要保留到「没有任何事务还需要看这个旧版本」为止。'
             + '一个开着不提交的长事务（哪怕它只是个 <code>SELECT</code>）'
             + '会让所有它开始之后产生的 undo 都没法清理，'
             + '<b>ibdata / undo 表空间能涨到几百 GB</b>，而且历史链表变长会让 MVCC 读越来越慢。'
             + '查 <code>information_schema.innodb_trx</code> 里的 <code>trx_started</code> 找长事务。'],
            ['恢复时间不只取决于 redo 大小',
             '崩溃恢复要重放的量 = <b>checkpoint age</b>（当前 LSN 减去已刷盘 LSN），'
             + '不是 redo 文件的总大小。'
             + '调大 redo 文件会让 checkpoint age 有机会涨得更大，恢复自然更慢。'
             + '另外 undo 阶段的耗时取决于<b>崩溃时有多少未提交的长事务</b>，'
             + '一个改了千万行还没提交的事务，回滚可能比重启本身久得多。'],
        ])
    ));

    // ── 说明 ──
    rootEl.appendChild(h('section.card.foot-note', null,
        h('h3.sec-title', { html: '<i class="fas fa-circle-info"></i> 关于这个演示' }),
        h('p', {
            html: '简化的地方（不少，一个个说清楚）：<br>'
                + '① 时间单位是抽象的 tick，「每 ' + WAL.BG_EVERY + ' 个 tick」当作后台线程的「每 1 秒」。'
                + '真实的 InnoDB master thread 行为比这复杂（还有自适应刷新、脏页比例触发等等）。<br>'
                + '② redo 记录被简化成「页 X 从 a 变成 b」这种<b>整值赋值</b>，'
                + '真实 redo 是<b>物理逻辑（physiological）</b>的 —— 记的是「在某页的某个偏移做某种操作」，'
                + '所以它必须<b>幂等</b>，而且要靠页头的 LSN 判断这条记录要不要应用。'
                + '本演示因为是整值赋值，天然幂等，就没画 LSN 比对那一步。<br>'
                + '③ undo 信息在这里是直接挂在 redo 记录上的（<code>before</code> 字段）。'
                + '真实 InnoDB 的 undo 在<b>独立的回滚段</b>里，而 undo log 页本身又受 redo 保护 —— '
                + '是两层结构，不是一层。<br>'
                + '④ checkpoint 被简化成「把当前所有脏页一次刷完」（sharp checkpoint）。'
                + '真实 InnoDB 用的是<b>模糊检查点（fuzzy checkpoint）</b>，边跑边刷，不会停顿。<br>'
                + '⑤ 没有模拟 binlog、两阶段提交、组提交（group commit）、doublewrite buffer。<br>'
                + '⑥ 「进程被 kill 时 OS page cache 里的数据能活下来」这一条是对的，'
                + '但前提是操作系统本身没崩、也没被强制 reset。'
                + 'kernel panic 的效果等同于断电。',
        }),
        h('p', {
            html: '「WAL 为什么快」那一段的随机/顺序 I/O 耗时是<b>可调的假想值</b>，'
                + '用来看数量级关系，不代表任何具体硬件。'
                + '真实差距在机械盘上能到两三个数量级，在 NVMe SSD 上小得多'
                + '（但 fsync 的固定开销仍然存在，所以 WAL 依然划算）。',
        })
    ));
}

function laneVerdict(sim, crashed, rec) {
    const st = sim.state;
    const modeName = { 1: '1（每次提交都 fsync）', 2: '2（只 write，不 fsync）', 0: '0（连 write 都不做）' }[state.mode];
    let s = '当前 <code>innodb_flush_log_at_trx_commit = ' + modeName + '</code>，'
        + '崩溃方式是<b>' + (state.crashKind === 'power' ? '主机断电' : 'MySQL 进程被 kill') + '</b>。<br>'
        + '崩溃这一刻：log buffer 里躺着 <b>' + st.logBuf.length + '</b> 条，'
        + 'OS page cache 里 <b>' + st.osCache.length + '</b> 条，'
        + '磁盘上 <b>' + st.logDisk.length + '</b> 条。<br>';
    if (state.crashKind === 'kill') {
        s += '进程被 kill：<b>log buffer 那 ' + st.logBuf.length + ' 条没了</b>'
            + '（那是 MySQL 自己的内存），'
            + '但 OS page cache 里那 ' + st.osCache.length + ' 条<b>还活着</b> —— '
            + '数据已经交给内核了，进程死不死跟它没关系，操作系统迟早会写下去。';
    } else {
        s += '主机断电：<b>log buffer 和 OS page cache 一起没</b>，共 '
            + crashed.lostRecords.length + ' 条记录蒸发，'
            + '只有 fsync 过的那 ' + st.logDisk.length + ' 条算数。';
    }
    if (rec.lostCommits.length) {
        s += '<br><b class="wal-red">后果：' + rec.lostCommits.join('、')
            + ' 明明已经告诉应用「提交成功」了，但日志没落盘 —— 这些事务真的丢了。</b>'
            + '这就是把 flush_log_at_trx_commit 调成 2 或 0 要承担的风险。';
    } else {
        s += '<br><b class="wal-green">后果：已提交的事务一条没丢。</b>';
    }
    return s;
}

function recoverCard(crashed, rec) {
    const card = h('section.card', null,
        h('h3.sec-title', { html: '<i class="fas fa-rotate-right"></i> 重启恢复：redo 前滚 → undo 回滚' })
    );

    // 阶段一
    card.appendChild(h('h4.wal-phase', { html: '① redo 前滚 —— 顺序扫日志，<b>不管提交没提交，全部重放</b>' }));
    const t1 = h('div.mv-matrix-wrap');
    const tb1 = h('table.mv-matrix');
    tb1.appendChild(h('tr', null,
        h('th', { text: 'LSN' }), h('th', { text: '事务' }), h('th', { text: '页' }),
        h('th', { text: '磁盘上现在是' }), h('th', { text: '重放成' }), h('th', { text: '这个事务提交了吗' })
    ));
    rec.redoSteps.forEach((s) => {
        tb1.appendChild(h('tr', null,
            h('td', { text: '#' + s.lsn }),
            h('td.mv-strong', { text: s.trx }),
            h('td', { text: s.page }),
            h('td.dl-num', { text: String(s.from) }),
            h('td.dl-num', { text: String(s.to) }),
            h('td' + (s.committed ? '.ok' : '.bad'), {
                text: s.committed ? '提交了' : '没提交 —— 照样重放！',
            })
        ));
    });
    t1.appendChild(tb1);
    card.appendChild(t1);
    card.appendChild(h('div.flow-hi', {
        html: '看最后一列：<b>' + (rec.openTrx.join('、') || '（没有）')
            + ' 根本没提交，它们的记录也被原封不动重放了。</b>'
            + '这不是 bug —— redo 的目标是先把磁盘恢复成「崩溃那一瞬间内存里的样子」，'
            + '这样 undo 才有个准确的基准可以往回撤。'
            + '而且这么做 redo 阶段可以纯顺序扫、不做任何判断，快得多。',
    }));

    // 阶段二
    card.appendChild(h('h4.wal-phase', {
        html: '② undo 回滚 —— 把没有 COMMIT 记录的事务撤掉（<b>按 LSN 倒着来</b>）',
    }));
    if (!rec.undoSteps.length) {
        card.appendChild(h('p.flow-empty', { text: '这次崩溃时没有未提交的事务需要回滚。' }));
    } else {
        const t2 = h('div.mv-matrix-wrap');
        const tb2 = h('table.mv-matrix');
        tb2.appendChild(h('tr', null,
            h('th', { text: '倒序 LSN' }), h('th', { text: '事务' }), h('th', { text: '页' }),
            h('th', { text: '撤销前' }), h('th', { text: '撤回成' })
        ));
        rec.undoSteps.forEach((s) => {
            tb2.appendChild(h('tr', null,
                h('td', { text: '#' + s.lsn }),
                h('td.mv-strong', { text: s.trx }),
                h('td', { text: s.page }),
                h('td.dl-num', { text: String(s.from) }),
                h('td.dl-num', { text: String(s.to) })
            ));
        });
        t2.appendChild(tb2);
        card.appendChild(t2);
        card.appendChild(h('div.flow-hi', {
            html: '<b>为什么必须倒着撤？</b>因为同一个页可能被改了很多次。'
                + '正着撤的话，先把 D 从 450 撤回 400、再把 D 从 500 撤回 450，结果就错了。'
                + '倒着来才能一层层剥回去。',
        }));
    }

    // 结果
    card.appendChild(h('h4.wal-phase', { html: '③ 对账：恢复出来的和「应该是什么」一样吗' }));
    const t3 = h('div.mv-matrix-wrap');
    const tb3 = h('table.mv-matrix');
    tb3.appendChild(h('tr', null,
        h('th', { text: '页' }), h('th', { text: '一开始' }),
        h('th', { text: '崩溃时磁盘上是' }), h('th', { text: '恢复后' }),
        h('th', { text: '应该是（只算已提交事务）' }), h('th', { text: '' })
    ));
    WAL.PAGES.forEach((p) => {
        const good = rec.pages[p] === rec.expected[p];
        tb3.appendChild(h('tr', null,
            h('td.mv-strong', { text: p }),
            h('td.dl-num', { text: String(WAL.INITIAL[p]) }),
            h('td.dl-num', { text: String(crashed.disk[p]) }),
            h('td.dl-num', { text: String(rec.pages[p]) }),
            h('td.dl-num', { text: String(rec.expected[p]) }),
            h('td' + (good ? '.ok' : '.bad'), { text: good ? '✓ 对上了' : '✗ 对不上' })
        ));
    });
    t3.appendChild(tb3);
    card.appendChild(t3);
    card.appendChild(h('div.seq-note', {
        html: '<b>结论：已 COMMIT 的一条不少，未 COMMIT 的一条不留。</b><br>'
            + '已提交并且日志落盘的事务：<b>' + (rec.committedTrx.join('、') || '（无）') + '</b> —— 全部生效。<br>'
            + '未提交的事务：<b>' + (rec.openTrx.join('、') || '（无）') + '</b> —— 痕迹全部抹掉。<br>'
            + (rec.lostCommits.length
                ? '<b class="wal-red">但是：' + rec.lostCommits.join('、')
                  + ' 的 COMMIT 记录没能落盘，恢复之后它们等于没发生过 —— '
                  + '而应用那边已经收到「成功」了。这就是数据丢失。</b>'
                : '<b class="wal-green">而且没有任何「应用以为成功了但其实丢了」的事务。</b>')
            + '<br>顺带一提：真实恢复只需要重放 <b>checkpoint 之后</b>的记录，'
            + '本次里 checkpoint 之前有 ' + rec.redoSkippable + ' 条其实可以跳过 —— '
            + 'checkpoint 打得越勤，恢复越快，代价是平时刷盘更频繁。',
    }));
    return card;
}

function lossCard() {
    const m = WAL.lossMatrix(18);
    const desc = {
        1: ['1', '提交时 write + fsync，记录真进盘'],
        2: ['2', '提交时只 write，交给内核，不 fsync'],
        0: ['0', '提交时啥也不干，靠后台每秒刷'],
    };
    const wrap = h('div.mv-matrix-wrap');
    const tbl = h('table.mv-matrix');
    tbl.appendChild(h('tr', null,
        h('th', { text: 'flush_log_at_trx_commit' }),
        h('th', { text: '提交时干了什么' }),
        h('th', { text: 'MySQL 进程被 kill' }),
        h('th', { text: '主机断电 / kernel panic' })
    ));
    m.rows.forEach((r) => {
        const kl = r.kill.lostCommits, pl = r.power.lostCommits;
        tbl.appendChild(h('tr', null,
            h('td.mv-strong', { text: desc[r.mode][0] }),
            h('td', { text: desc[r.mode][1] }),
            h('td' + (kl.length ? '.bad' : '.ok'), {
                text: kl.length ? '丢 ' + kl.join('、') : '不丢',
            }),
            h('td' + (pl.length ? '.bad' : '.ok'), {
                text: pl.length ? '丢 ' + pl.join('、') : '不丢',
            })
        ));
    });
    wrap.appendChild(tbl);

    return h('section.card', null,
        h('h3.sec-title', { html: '<i class="fas fa-face-flushed"></i> 打脸时刻：2 和 0 的区别，只有在「进程崩溃」时才看得见' }),
        h('p.sec-note', {
            html: '同一个崩溃时刻（t=18，T4 刚提交完、后台还没来得及刷），三种配置 × 两种崩溃：',
        }),
        wrap,
        h('div.wal-mem', null,
            memLevel('MySQL 进程内存', 'redo log buffer', 'kill 就没　断电也没', 'bad',
                'mode 0 的记录停在这一层'),
            memLevel('内核内存', 'OS page cache', 'kill 还在　断电就没', 'mid',
                'mode 2 的记录停在这一层'),
            memLevel('物理磁盘', 'ib_logfile0/1', 'kill 还在　断电也在', 'ok',
                'mode 1 的记录到了这一层')
        ),
        h('div.seq-note', {
            html: '<b>这就是最容易讲错的地方。</b>很多人以为「2 和 0 都是最多丢 1 秒」，'
                + '其实两者的差别正好卡在<b>「谁的内存」</b>上：<br>'
                + '<b>0</b> 的记录停在 <b>MySQL 自己的内存</b>里 —— '
                + '进程一被 kill（OOM killer、误操作、崩溃）就跟着没了。<br>'
                + '<b>2</b> 的记录已经通过 <code>write()</code> 交给了<b>内核</b> —— '
                + 'MySQL 进程死了，操作系统还活着，它会替你把这些数据写下去，所以<b>不丢</b>。'
                + '只有整台机器断电（或 kernel panic）才会连内核的内存一起丢。<br>'
                + '<b>所以：0 比 2 更危险，而且危险在一个概率高得多的场景上</b>'
                + '（进程崩溃比机房断电常见太多了）。'
                + '想省 fsync 就用 2，别用 0 —— 两者的性能差距很小，风险差距很大。',
        })
    );
}

function memLevel(where, what, fate, cls, note) {
    return h('div.wal-mem-l.wal-mem-' + cls, null,
        h('div.wal-mem-w', { text: where }),
        h('div.wal-mem-n', { text: what }),
        h('div.wal-mem-f', { text: fate }),
        h('div.wal-mem-note', { text: note })
    );
}

function speedCard() {
    const io = WAL.ioCompare(state.nPages, state.randomMs, state.seqMs);
    const ctl = h('div.controls');
    ctl.appendChild(Viz.slider({
        label: '一个事务改了几个页', min: 1, max: 40, step: 1, value: state.nPages,
        fmt: (v) => v + ' 个', onInput: (v) => { state.nPages = v; render(); },
    }));
    ctl.appendChild(Viz.slider({
        label: '一次随机 I/O', min: 1, max: 20, step: 1, value: state.randomMs,
        fmt: (v) => v + ' ms', onInput: (v) => { state.randomMs = v; render(); },
    }));
    ctl.appendChild(Viz.slider({
        label: '一次顺序追加', min: 1, max: 10, step: 1, value: state.seqMs,
        fmt: (v) => v + ' ms', onInput: (v) => { state.seqMs = v; render(); },
    }));

    // 对比条
    const W = 700, H = 128;
    const root = svg('svg', {
        viewBox: '0 0 ' + W + ' ' + H, class: 'wal-svg',
        preserveAspectRatio: 'xMidYMid meet', role: 'img', 'aria-label': '顺序写 vs 随机写',
    });
    const maxV = Math.max(io.direct, io.wal, 1);
    const PAD_L = 118, iw = W - PAD_L - 90;
    [['不用 WAL：直接刷 ' + io.nPages + ' 个数据页', io.direct, 'wal-bar-bad', io.nPages + ' 次随机 I/O'],
     ['用 WAL：顺序追加日志', io.wal, 'wal-bar-ok', '1 次顺序写 + fsync']].forEach(([name, v, cls, sub], i) => {
        const y = 18 + i * 52;
        const lb = svg('text', { x: PAD_L - 8, y: y + 17, class: 'wal-bar-l', 'text-anchor': 'end' });
        lb.textContent = name;
        root.appendChild(lb);
        root.appendChild(svg('rect', { x: PAD_L, y, width: iw, height: 26, rx: 5, fill: '#f1f3f6' }));
        root.appendChild(svg('rect', {
            x: PAD_L, y, width: Math.max(3, (v / maxV) * iw), height: 26, rx: 5, class: cls,
        }));
        const vl = svg('text', { x: PAD_L + iw + 6, y: y + 17, class: 'wal-bar-v' });
        vl.textContent = v + ' ms';
        root.appendChild(vl);
        const sl = svg('text', { x: PAD_L + 8, y: y + 17, class: 'wal-bar-sub' });
        sl.textContent = sub;
        root.appendChild(sl);
    });

    return h('section.card', null,
        h('h3.sec-title', { html: '<i class="fas fa-gauge-high"></i> WAL 为什么快：N 次随机 I/O 换成 1 次顺序追加' }),
        h('p.sec-note', {
            html: '一个事务改的那十几个页，在磁盘上是<b>东一块西一块</b>的 —— '
                + '要在提交前保证它们持久，就得挨个寻道写过去。'
                + 'WAL 的做法是：只把「我把 X 改成了 Y」<b>追加到日志文件的尾巴</b>，'
                + '磁头（或 SSD 的写入位置）根本不用动。',
        }),
        ctl,
        root,
        Viz.cmpGrid([
            { h: '不用 WAL', v: io.direct + ' ms', d: io.nPages + ' 次随机写', cls: 'cmp-bad' },
            { h: '用 WAL', v: io.wal + ' ms', d: '1 次顺序写', cls: 'cmp-ok' },
            { h: '提交延迟差', v: io.speedup.toFixed(1) + '×', d: '而且脏页还能合并刷', cls: 'cmp-save' },
        ]),
        h('div.seq-note', {
            html: '还有<b>第二层</b>好处经常被忽略：<b>脏页可以合并刷</b>。'
                + '一个热点页在一秒内被 100 个事务改过，后台只需要刷<b>一次</b>；'
                + '而「提交时必须刷数据页」的方案要刷 100 次。'
                + '在写密集的负载下，这一层省下来的比上面那个倍数还多。<br>'
                + '代价是：崩溃后要花时间重放日志 —— <b>WAL 是拿「恢复时间」换「运行时吞吐」</b>。',
        })
    );
}

Viz.register({
    id: 'wal',
    cat: 'db',
    title: 'WAL 与崩溃恢复',
    subtitle: 'redo · undo · checkpoint',
    icon: 'fa-scroll',
    blurb: '随便挑个时刻断电，看数据库怎么把账重新算平',
    mount(container) {
        rootEl = h('div.fsrs-root');
        container.appendChild(rootEl);
        state.mode = 1; state.crashAt = 18; state.crashKind = 'power';
        state.recovered = false;
        state.nPages = 12; state.randomMs = 8; state.seqMs = 1;
        render();
    },
    unmount() {
        rootEl = null;
    },
});

})();
