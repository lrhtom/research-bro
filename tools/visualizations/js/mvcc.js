// ============================================================
//  演示：MVCC 与事务隔离级别（InnoDB）
//  同一段并发操作，切隔离级别看 T1 两次读到的值为什么不一样。
//  核心是 ReadView 的四个字段 + 可见性判定规则。
// ============================================================

(function () {

// ---------- 一、模型（纯函数）----------

const MV = {};

MV.LEVELS = {
    RU: { name: '读未提交', en: 'READ UNCOMMITTED', dirty: true, repeat: false, phantom: false },
    RC: { name: '读已提交', en: 'READ COMMITTED', dirty: false, repeat: false, phantom: false },
    RR: { name: '可重复读', en: 'REPEATABLE READ', dirty: false, repeat: true, phantom: 'mostly' },
    SER: { name: '串行化', en: 'SERIALIZABLE', dirty: false, repeat: true, phantom: true },
};

/**
 * ReadView 可见性判定 —— InnoDB 的核心规则，四条按顺序判：
 *   rv = { creator, minId, maxId, active:Set }
 */
MV.visible = function (trxId, rv) {
    if (trxId === rv.creator) return true;          // 自己改的，看得见
    if (trxId < rv.minId) return true;              // 生成 ReadView 前就已提交
    if (trxId >= rv.maxId) return false;            // 生成 ReadView 之后才开始的事务
    return !rv.active.has(trxId);                   // 区间内：还活跃就不可见，否则可见
};

/** 沿版本链从最新往老找，返回第一个可见的版本 */
MV.readVersion = function (chain, rv) {
    for (let i = chain.length - 1; i >= 0; i--) {
        if (MV.visible(chain[i].trx, rv)) return chain[i];
    }
    return null;
};

/**
 * 跑固定剧本，按隔离级别算出每一步的状态。
 * 返回步骤数组，每步含版本链快照、ReadView、T1 读到的值。
 */
MV.run = function (level) {
    const chain = [{ trx: 90, value: 100, label: '初始值（很久以前某个已提交事务写的）' }];
    const active = new Set();
    let rv = null;             // T1 当前持有的 ReadView
    let nextId = 100;          // 下一个将要分配的事务 ID
    const steps = [];

    // max_trx_id 必须取「创建 ReadView 那一刻」的 nextId ——
    // 这正是 RR 能挡住后开事务的关键：T2 的 ID ≥ max_trx_id 就一律不可见。
    const mkRv = (creator) => ({
        creator,
        minId: active.size ? Math.min.apply(null, [...active]) : nextId,
        maxId: nextId,
        active: new Set(active),
    });

    const push = (o) => steps.push(Object.assign({
        chain: chain.map((c) => Object.assign({}, c)),
        rv: rv ? { creator: rv.creator, minId: rv.minId, maxId: rv.maxId, active: new Set(rv.active) } : null,
        active: new Set(active),
    }, o));

    // 1
    const T1 = nextId++;
    active.add(T1);
    push({ who: 'T1', sql: 'BEGIN;', note: `T1 开启事务，拿到事务 ID ${T1}。此时还没有 ReadView —— <b>ReadView 是第一次 SELECT 时才创建的</b>。` });

    // 2
    if (level !== 'RU' && level !== 'SER') rv = mkRv(T1);
    let v = level === 'RU' ? chain[chain.length - 1] : MV.readVersion(chain, rv);
    push({ who: 'T1', sql: 'SELECT balance FROM account WHERE id=1;', read: v ? v.value : null,
        note: level === 'RU'
            ? 'RU 不走 MVCC，直接读最新版本。'
            : 'T1 <b>创建 ReadView</b>，沿版本链找到第一个可见的版本。' });

    // 3
    const T2 = nextId++;
    active.add(T2);
    push({ who: 'T2', sql: 'BEGIN;', note: `T2 开启事务，事务 ID ${T2}。`
        + `<b>注意它比 T1 的 ReadView 里记的 max_trx_id 大或相等</b>，这一点马上就会起作用。` });

    // 4
    chain.push({ trx: T2, value: 200, label: '未提交', uncommitted: true });
    push({ who: 'T2', sql: 'UPDATE account SET balance=200 WHERE id=1;',
        note: '<b>更新不是覆盖</b>：旧值被写进 undo log 形成版本链，新版本记上 trx_id=101，此时尚未提交。' });

    // 5 —— RU 在这里就能读到脏数据
    if (level === 'RU') {
        v = chain[chain.length - 1];
        push({ who: 'T1', sql: 'SELECT balance FROM account WHERE id=1;', read: v.value, dirty: true,
            note: '<b>脏读发生了</b>：T2 还没提交，T1 就读到了 200。如果 T2 随后回滚，这个 200 从来没存在过。' });
    }

    // 6
    chain[chain.length - 1].uncommitted = false;
    chain[chain.length - 1].label = '已提交';
    active.delete(T2);
    push({ who: 'T2', sql: 'COMMIT;', note: 'T2 提交。注意 <b>T1 的 ReadView 是在 T2 提交之前生成的</b>，这一点决定了下一步。' });

    // 7 —— 分水岭
    if (level === 'RC') rv = mkRv(T1);            // RC：每次 SELECT 都重新生成
    v = level === 'RU' ? chain[chain.length - 1] : MV.readVersion(chain, rv);
    push({ who: 'T1', sql: 'SELECT balance FROM account WHERE id=1;', read: v ? v.value : null, key: true,
        note: level === 'RC'
            ? '<b>RC 每次 SELECT 都重新创建 ReadView</b>，新 ReadView 里 T2 已不在活跃列表 → 200 可见。'
              + '同一个事务里两次读到不同的值，这就是<b>不可重复读</b>。'
            : (level === 'RR'
                ? '<b>RR 全程复用第一次 SELECT 建的那个 ReadView</b>，其中 T2 仍在活跃列表里 → 200 不可见，'
                  + '沿版本链回退到旧版本，仍然读到 100。<b>可重复读达成。</b>'
                : (level === 'RU'
                    ? 'RU 依旧直接读最新已提交值。'
                    : 'SERIALIZABLE 下这些读会加锁，T2 的更新根本无法在 T1 结束前完成。')) });

    // 8
    active.delete(T1);
    push({ who: 'T1', sql: 'COMMIT;', note: 'T1 提交，事务结束。' });

    return steps;
};

if (typeof module !== 'undefined' && module.exports) module.exports = MV;
if (typeof window !== 'undefined') window.MVModel = MV;

// ---------- 二、界面 ----------

if (typeof window === 'undefined' || !window.Viz) return;

const h = Viz.h;
const state = { level: 'RR', step: 0, steps: [] };

function rebuild() {
    state.steps = MV.run(state.level);
    if (state.step >= state.steps.length) state.step = state.steps.length - 1;
}

function buildTimeline() {
    const box = h('div.mv-timeline');
    state.steps.forEach((s, i) => {
        const on = i <= state.step;
        const row = h('div.mv-row' + (on ? '.on' : '') + (i === state.step ? '.cur' : ''), {
            onclick: () => { state.step = i; render(); },
        });
        row.appendChild(h('div.mv-n', { text: String(i + 1) }));
        const t1 = h('div.mv-cell' + (s.who === 'T1' ? '.mine' : ''));
        const t2 = h('div.mv-cell' + (s.who === 'T2' ? '.other' : ''));
        (s.who === 'T1' ? t1 : t2).appendChild(h('code', { text: s.sql }));
        if (s.read != null) {
            (s.who === 'T1' ? t1 : t2).appendChild(
                h('span.mv-read' + (s.dirty ? '.dirty' : '') + (s.key ? '.key' : ''), { text: '读到 ' + s.read }));
        }
        row.appendChild(t1);
        row.appendChild(t2);
        box.appendChild(row);
    });
    return box;
}

function buildChain() {
    const s = state.steps[state.step];
    const box = h('div.mv-chain');
    s.chain.slice().reverse().forEach((c, idx) => {
        const visible = s.rv ? MV.visible(c.trx, s.rv) : true;
        box.appendChild(h('div.mv-ver' + (c.uncommitted ? '.uncommitted' : '') + (visible ? '.visible' : '.hidden'), null,
            h('div.mv-ver-head', null,
                h('b', { text: 'balance = ' + c.value }),
                h('span.mv-trx', { text: 'trx_id = ' + c.trx })),
            h('div.mv-ver-note', { text: c.label }),
            h('div.mv-ver-tag', {
                text: s.rv ? (visible ? '✓ 对 T1 可见' : '✗ 对 T1 不可见') : '（尚未创建 ReadView）',
            })
        ));
        if (idx < s.chain.length - 1) box.appendChild(h('div.mv-link', { html: '↓ <span>roll_pointer 指向更早的版本</span>' }));
    });
    return box;
}

function buildReadView() {
    const s = state.steps[state.step];
    if (!s.rv) return h('p.sec-note', { text: '此刻 T1 还没有 ReadView。' });
    const rv = s.rv;
    const item = (k, v, d) => h('div.rv-item', null,
        h('code.rv-k', { text: k }), h('b.rv-v', { text: v }), h('span.rv-d', { text: d }));
    return h('div.rv', null,
        item('creator_trx_id', String(rv.creator), '我自己的事务 ID'),
        item('m_ids', '[' + [...rv.active].join(', ') + ']', '创建这个 ReadView 时还活跃（未提交）的事务'),
        item('min_trx_id', String(rv.minId), 'm_ids 里最小的那个'),
        item('max_trx_id', String(rv.maxId), '下一个将要分配的事务 ID')
    );
}

let rootEl = null;

function render() {
    if (!rootEl) return;
    rebuild();
    rootEl.innerHTML = '';
    const s = state.steps[state.step];
    const lv = MV.LEVELS[state.level];

    rootEl.appendChild(Viz.card('fa-layer-group', '选一个隔离级别',
        `当前：<b>${lv.name} ${lv.en}</b>　`
        + (state.level === 'RR' ? '（<b>InnoDB 默认</b>）' : '')
        + '　同一段并发操作，切换级别看 T1 第二次读到什么。',
        Viz.segmented({
            value: state.level,
            options: Object.keys(MV.LEVELS).map((k) => ({ v: k, label: MV.LEVELS[k].name })),
            onPick: (v) => { state.level = v; state.step = 0; render(); },
        })
    ));

    const nav = h('div.seq-nav', null,
        h('button.mini', { onclick: () => { state.step = Math.max(0, state.step - 1); render(); } }, '← 上一步'),
        h('span.seq-progress', { text: `${state.step + 1} / ${state.steps.length}` }),
        h('button.mini.primary', { onclick: () => { state.step = Math.min(state.steps.length - 1, state.step + 1); render(); } }, '下一步 →'),
        h('button.mini', { onclick: () => { state.step = state.steps.length - 1; render(); } }, '走到底' ),
        h('button.mini', { onclick: () => { state.step = 0; render(); } }, '重来')
    );

    rootEl.appendChild(Viz.card('fa-code-branch', '两个事务的时间线',
        '点任意一行可以跳到那一步。左列是 T1（我们观察的事务），右列是 T2（来捣乱的）。',
        buildTimeline(), nav,
        h('div.seq-note', { html: '<b>第 ' + (state.step + 1) + ' 步：</b>' + s.note })
    ));

    rootEl.appendChild(Viz.card('fa-link', '版本链：UPDATE 不是覆盖，是往链上加一节',
        '这就是 MVCC 里的 <b>M（Multi-Version）</b>。'
        + '每行数据有两个隐藏列：<code>trx_id</code>（谁改的）和 <code>roll_pointer</code>（指向 undo log 里的上一版）。'
        + '读的时候从最新版本往回走，<b>找到第一个「对我可见」的版本就停</b>。',
        buildChain()
    ));

    rootEl.appendChild(Viz.card('fa-id-card', 'ReadView：判断「哪个版本对我可见」的依据',
        'ReadView 是<b>一致性读（快照读）</b>的核心。RC 和 RR 的全部区别，就在于它<b>什么时候被创建</b>。',
        buildReadView(),
        Viz.flowList([
            { t: '可见性判定规则（按顺序判，命中即停）',
                f: 'if (trx_id == creator_trx_id)  → 可见   // 自己改的\n'
                 + 'if (trx_id <  min_trx_id)      → 可见   // 创建 ReadView 前就提交了\n'
                 + 'if (trx_id >= max_trx_id)      → 不可见 // 创建 ReadView 之后才开始的\n'
                 + 'else 在 m_ids 里 ? 不可见 : 可见        // 区间内看它当时提没提交',
                r: '不可见就顺着 roll_pointer 往老版本找，直到找到可见的为止' },
            { t: 'RC 与 RR 的唯一区别',
                f: 'READ COMMITTED  : 每次 SELECT 都新建一个 ReadView\nREPEATABLE READ : 只在第一次 SELECT 时建，之后整个事务复用',
                r: '就这一行代码的差别，造成了「可不可重复读」',
                hi: '这是本题的<b>题眼</b>。很多人背得出隔离级别的定义，但答不出「靠什么实现的」—— '
                    + '答出这一句，档次立刻不一样。' },
        ])
    ));

    // 三个读现象
    rootEl.appendChild(Viz.card('fa-table', '四个级别挡住了哪些问题', null, buildMatrix()));

    rootEl.appendChild(Viz.card('fa-comments', '面试这么答', null, Viz.qa([
        { q: 'MySQL 的 RR 解决幻读了吗？',
            a: '<b>要分情况，这是最容易答错的一题。</b>'
                + '① <b>快照读</b>（普通 SELECT）：靠 MVCC，全程用同一个 ReadView，看不到新插入的行 —— 幻读被挡住。'
                + '② <b>当前读</b>（<code>SELECT ... FOR UPDATE</code>、<code>UPDATE</code>、<code>DELETE</code>）：'
                + '靠 <b>Next-Key Lock</b>（行锁 + 间隙锁）锁住范围，别人插不进来 —— 也被挡住。'
                + '③ 但存在特例：事务内先快照读、再当前读（或先读后改），仍可能观察到幻行。'
                + '所以严格说 <b>RR 大部分情况下解决了幻读，但不是理论上的完全解决</b>。' },
        { q: 'undo log、redo log、binlog 各是干什么的？',
            a: '<b>undo log</b>：记录「改之前是什么」，用于事务回滚 + MVCC 版本链（InnoDB 引擎层）。'
                + '<b>redo log</b>：记录「对页做了什么物理修改」，用于崩溃恢复，保证持久性 D（InnoDB 引擎层，循环写）。'
                + '<b>binlog</b>：记录逻辑操作，用于主从复制和数据恢复（MySQL Server 层，追加写）。'
                + '两阶段提交（redo prepare → binlog → redo commit）保证这两个日志一致。' },
        { q: '为什么 InnoDB 默认用 RR 而不是像别的数据库那样用 RC？',
            a: '历史原因：早期 binlog 只有 <code>statement</code> 格式，RC 下会导致主从数据不一致，'
                + '所以必须用 RR + 间隙锁来保证顺序。现在 binlog 用 <code>row</code> 格式后这个限制没了，'
                + '<b>很多互联网公司实际生产中会改成 RC</b>，因为间隙锁少、并发高、死锁概率低。' },
        { q: '快照读和当前读的区别？',
            a: '<b>快照读</b>读的是 ReadView 决定的历史版本，不加锁，普通 SELECT 走这条。'
                + '<b>当前读</b>读的是最新版本并加锁，'
                + '<code>SELECT...LOCK IN SHARE MODE</code>、<code>SELECT...FOR UPDATE</code>、'
                + '以及所有 <code>INSERT/UPDATE/DELETE</code> 都是当前读。' },
    ])));
}

function buildMatrix() {
    const rows = [
        ['读未提交 RU', '✗ 会脏读', '✗ 不可重复读', '✗ 幻读', '几乎不用'],
        ['读已提交 RC', '✓ 挡住', '✗ 不可重复读', '✗ 幻读', 'Oracle / PG 默认，互联网常用'],
        ['可重复读 RR', '✓ 挡住', '✓ 挡住', '△ 基本挡住', 'InnoDB 默认'],
        ['串行化 SER', '✓ 挡住', '✓ 挡住', '✓ 挡住', '全加锁，性能最差'],
    ];
    const tb = h('table.mv-matrix');
    const head = h('tr', null, h('th', { text: '隔离级别' }), h('th', { text: '脏读' }),
        h('th', { text: '不可重复读' }), h('th', { text: '幻读' }), h('th', { text: '备注' }));
    tb.appendChild(head);
    rows.forEach((r) => {
        const tr = h('tr' + (r[0].indexOf(MV.LEVELS[state.level].name) >= 0 ? '.on' : ''));
        r.forEach((c, i) => tr.appendChild(h('td' + (c.startsWith('✗') ? '.bad' : (c.startsWith('✓') ? '.ok' : '')),
            { text: c })));
        tb.appendChild(tr);
    });
    return h('div.mv-matrix-wrap', null, tb,
        h('p.sec-note', {
            html: '<b>脏读</b>＝读到别人没提交的数据；<b>不可重复读</b>＝同一行两次读值不同（别人 UPDATE 了）；'
                + '<b>幻读</b>＝同一范围两次查条数不同（别人 INSERT 了）。'
                + '注意后两者的区别：<b>一个针对行，一个针对范围</b>。',
        }));
}

Viz.register({
    id: 'mvcc',
    cat: 'db',
    title: 'MVCC 与事务隔离级别',
    subtitle: 'ReadView · 版本链 · 幻读',
    icon: 'fa-layer-group',
    blurb: '同一段并发操作，RC 和 RR 为什么读到不一样的值',
    mount(container) {
        rootEl = h('div.fsrs-root');
        container.appendChild(rootEl);
        state.level = 'RR'; state.step = 0;
        render();
    },
    unmount() { rootEl = null; },
});

})();
