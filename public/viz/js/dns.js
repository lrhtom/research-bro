// ============================================================
//  演示：DNS 解析全过程
//  一次 www.example.com 到底走了几跳、每一跳问了什么、回了什么。
//  重点点破两件事：① 递归查询和迭代查询发生在不同的段上，不是一回事；
//  ② 根和 TLD 返回的是 referral（NS + glue），从来不是最终答案。
//  上半 DNS.* 是纯函数（不碰 DOM，可单独测），下半是界面。
// ============================================================

(function () {

// ---------- 一、模型（纯函数）----------

const DNS = {};

/**
 * 模拟耗时（ms）。都是抽象的量级估计，不是实测值。
 * 之所以要把「本地缓存命中」和「跨洋问权威」拉开三个数量级，
 * 是因为这个演示要讲清楚的就是这个差距。
 */
DNS.COST = {
    browserHit: 0.5, browserMiss: 0.1,   // 进程内查一张 map
    osHit: 1.2, osMiss: 0.2,             // 一次系统调用
    resolver: 8,                          // 客户端 ↔ 本地 DNS 的一个 RTT
    root: 45, tld: 38, auth: 30,          // 本地 DNS ↔ 各级权威的 RTT
};

/** 各级缓存能把 TTL 留多久（下游只会更短，绝不会更长）*/
DNS.CAP = { browser: 60, os: 120, resolver: Infinity };

/** 客户端位置。CDN 的权威服务器会按这个返回不同的 A 记录。 */
DNS.CLIENTS = [
    { id: 'sh', label: '上海 · 电信', ip: '116.228.10.7' },
    { id: 'gz', label: '广州 · 联通', ip: '113.108.44.2' },
    { id: 'us', label: '美国 · 洛杉矶', ip: '104.28.60.9' },
];

/** hosts 文件。它的优先级高于一切 DNS 查询。 */
DNS.HOSTS = {
    'localhost': '127.0.0.1',
    'dev.example.com': '127.0.0.1',
};

/**
 * 整个「世界」的权威数据，按区（zone）组织。
 *   delegations —— 我不管这一段，但我知道该问谁（→ referral：NS 记录 + glue A 记录）
 *   records     —— 我就是这一段的权威，答案在我这
 * 根区的 key 是空字符串。
 */
DNS.ZONES = {
    '': {
        role: 'root', title: '根域名服务器', server: 'a.root-servers.net', ip: '198.41.0.4',
        negTtl: 86400,
        delegations: {
            'com': { ns: 'a.gtld-servers.net', glue: '192.5.6.30', ttl: 172800 },
            'net': { ns: 'a.gtld-servers.net', glue: '192.5.6.30', ttl: 172800 },
        },
    },
    'com': {
        role: 'tld', title: '.com TLD 服务器', server: 'a.gtld-servers.net', ip: '192.5.6.30',
        negTtl: 900,
        delegations: {
            'example.com': { ns: 'ns1.example.com', glue: '93.184.216.34', ttl: 172800 },
        },
    },
    'net': {
        role: 'tld', title: '.net TLD 服务器', server: 'a.gtld-servers.net', ip: '192.5.6.30',
        negTtl: 900,
        delegations: {
            'cdn.net': { ns: 'ns1.cdn.net', glue: '104.18.9.7', ttl: 172800 },
            'edge.net': { ns: 'ns1.edge.net', glue: '23.55.60.10', ttl: 172800 },
        },
    },
    'example.com': {
        role: 'auth', title: 'example.com 权威服务器', server: 'ns1.example.com', ip: '93.184.216.34',
        negTtl: 300,     // SOA 的 MINIMUM 字段 → 负缓存能存多久
        records: {
            'example.com': [
                { type: 'A', value: '93.184.216.34', ttl: 300 },
                { type: 'AAAA', value: '2606:2800:220:1:248:1893:25c8:1946', ttl: 300 },
                { type: 'NS', value: 'ns1.example.com', ttl: 172800 },
                { type: 'MX', value: '10 mail.example.com', ttl: 3600 },
                { type: 'TXT', value: 'v=spf1 include:_spf.example.com ~all', ttl: 3600 },
            ],
            'www.example.com': [
                { type: 'A', value: '93.184.216.34', ttl: 300 },
                { type: 'AAAA', value: '2606:2800:220:1:248:1893:25c8:1946', ttl: 300 },
            ],
            // 一层 CNAME：站点把 www 挂到 CDN 上
            'shop.example.com': [{ type: 'CNAME', value: 'shop.example.com.cdn.net', ttl: 300 }],
            // 两层 CNAME：CDN 内部还要再转一手到边缘节点
            'deep.example.com': [{ type: 'CNAME', value: 'deep.example.com.cdn.net', ttl: 300 }],
            // 配错的一对：A → B → A
            'loop-a.example.com': [{ type: 'CNAME', value: 'loop-b.example.com', ttl: 300 }],
            'loop-b.example.com': [{ type: 'CNAME', value: 'loop-a.example.com', ttl: 300 }],
        },
    },
    'cdn.net': {
        role: 'auth', title: 'cdn.net 权威服务器（CDN 调度）', server: 'ns1.cdn.net', ip: '104.18.9.7',
        negTtl: 60,
        records: {
            // geo：同一个名字，按来源 IP 返回不同的 A —— CDN 就近调度的全部秘密
            'shop.example.com.cdn.net': [
                { type: 'A', geo: { sh: '106.75.20.11', gz: '120.232.44.9', us: '104.18.9.7' }, ttl: 30 },
            ],
            'deep.example.com.cdn.net': [{ type: 'CNAME', value: 'node7.edge.net', ttl: 60 }],
        },
    },
    'edge.net': {
        role: 'auth', title: 'edge.net 权威服务器（边缘节点）', server: 'ns1.edge.net', ip: '23.55.60.10',
        negTtl: 60,
        records: {
            'node7.edge.net': [
                { type: 'A', geo: { sh: '106.75.30.77', gz: '120.232.55.77', us: '23.55.60.77' }, ttl: 30 },
            ],
        },
    },
};

// ---- 小工具 ----

function fmtSec(s) {
    if (s == null || !isFinite(s)) return '∞';
    if (s >= 86400) return Math.round(s / 86400) + ' 天';
    if (s >= 3600) return (s / 3600).toFixed(1) + ' 小时';
    if (s >= 60) return Math.floor(s / 60) + ' 分' + (Math.round(s % 60) ? Math.round(s % 60) + ' 秒' : '');
    return (Math.round(s * 10) / 10) + ' 秒';
}
DNS.fmtSec = fmtSec;

/** name 是不是落在 zone 里（zone='' 表示根，谁都算）*/
function isSubOf(name, zone) {
    if (zone === '') return true;
    return name === zone || name.endsWith('.' + zone);
}

/** 由深到浅列出所有祖先名，含自己，不含根 */
function ancestors(name) {
    const out = [];
    let cur = name;
    while (cur) {
        out.push(cur);
        const i = cur.indexOf('.');
        cur = i < 0 ? '' : cur.slice(i + 1);
    }
    return out;
}

function valueOf(rr, client) {
    return rr.geo ? rr.geo[client] : rr.value;
}

// ---- 缓存 ----

function put(cache, key, entry, ttl, now) {
    if (!(ttl > 0)) return null;
    const e = Object.assign({ key: key, ttl0: ttl, expireAt: now + ttl }, entry);
    cache[key] = e;
    return e;
}

/** 取一条；已过期就地删掉（TTL 到 0 就不存在了，没有「宽限期」）*/
function get(cache, key, now) {
    const e = cache[key];
    if (!e) return null;
    if (e.expireAt <= now) { delete cache[key]; return null; }
    return e;
}

DNS.newWorld = function () {
    return { now: 0, browser: {}, os: {}, resolver: {} };
};

/** 把时钟往前拨 sec 秒，顺手把过期的记录清掉 */
DNS.advance = function (world, sec) {
    world.now += sec;
    ['browser', 'os', 'resolver'].forEach((lv) => {
        Object.keys(world[lv]).forEach((k) => {
            if (world[lv][k].expireAt <= world.now) delete world[lv][k];
        });
    });
    return world;
};

/** 某一时刻三级缓存里各有什么（剩余 TTL 已算好），给界面用 */
DNS.snapshot = function (world, at) {
    const t = at == null ? world.now : at;
    const out = {};
    ['browser', 'os', 'resolver'].forEach((lv) => {
        out[lv] = Object.keys(world[lv])
            .map((k) => world[lv][k])
            .filter((e) => e.expireAt > t)
            .map((e) => ({
                key: e.key, label: e.label, value: e.value, kind: e.kind,
                ttl: e.expireAt - t, ttl0: e.ttl0,
            }))
            .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    });
    return out;
};

/** 手工往本地 DNS 缓存里塞一条委派（做「只有 TLD 的 NS 还在」这种场景）*/
DNS.seedNS = function (world, zone) {
    const i = zone.indexOf('.');
    const parent = i < 0 ? '' : zone.slice(i + 1);
    const del = ((DNS.ZONES[parent] || {}).delegations || {})[zone];
    if (!del) return world;
    put(world.resolver, 'NS:' + zone, {
        kind: 'NS', label: 'NS ' + zone, value: del.ns + ' (glue ' + del.glue + ')',
    }, del.ttl, world.now);
    return world;
};

// ---- 一台服务器收到查询后回什么 ----

/**
 * zoneName 这台服务器面对 qname 的查询会回：
 *   referral（我不管，去问那边）/ answer / cname / nxdomain / nodata / refused
 * 这是整个演示最要紧的一个函数：根和 TLD 永远走 referral 分支。
 */
DNS.respond = function (zoneName, qname, qtype) {
    const z = DNS.ZONES[zoneName];
    if (!z) return { kind: 'refused' };

    // ① 有没有更深一层的委派？有就转介，绝不给最终答案
    let best = null;
    const dels = z.delegations || {};
    Object.keys(dels).forEach((d) => {
        if (isSubOf(qname, d) && (best === null || d.length > best.length)) best = d;
    });
    if (best) {
        return {
            kind: 'referral', zone: best, ns: dels[best].ns,
            glue: dels[best].glue, ttl: dels[best].ttl,
            inBailiwick: isSubOf(dels[best].ns, best),
        };
    }

    // ② 我就是权威
    const rrs = (z.records || {})[qname];
    if (rrs) {
        const cn = rrs.find((r) => r.type === 'CNAME');
        if (cn) return { kind: 'cname', target: cn.value, ttl: cn.ttl, rr: cn };
        const a = rrs.find((r) => r.type === (qtype || 'A'));
        if (a) return { kind: 'answer', rr: a, ttl: a.ttl };
        return { kind: 'nodata', ttl: z.negTtl || 300, all: rrs };
    }

    // ③ 名字在我这一区里，但确实没有 → NXDOMAIN（带 SOA，可被负缓存）
    if (isSubOf(qname, zoneName)) return { kind: 'nxdomain', ttl: z.negTtl || 300 };
    return { kind: 'refused' };
};

// ---- 本地 DNS 缓存里能不能直接回答（要顺着 CNAME 链走）----

function cacheChase(world, name) {
    const chain = [];
    const seen = {};
    let cur = name;
    for (let i = 0; i < 10; i++) {
        if (seen[cur]) return { kind: 'loop', name: cur, chain: chain };
        seen[cur] = true;
        const nx = get(world.resolver, 'NX:' + cur, world.now);
        if (nx) return { kind: 'nx', name: cur, chain: chain, ttl: nx.expireAt - world.now };
        const a = get(world.resolver, 'A:' + cur, world.now);
        if (a) return { kind: 'answer', name: cur, chain: chain, value: a.value, ttl: a.expireAt - world.now };
        const c = get(world.resolver, 'CNAME:' + cur, world.now);
        if (c) { chain.push({ from: cur, to: c.value, ttl: c.expireAt - world.now }); cur = c.value; continue; }
        return { kind: 'miss', name: cur, chain: chain };
    }
    return { kind: 'loop', name: cur, chain: chain };
}

// ---- 迭代查询：本地 DNS 一跳一跳往下问 ----

function iterStep(zoneName, qname, r, client) {
    const z = DNS.ZONES[zoneName];
    const cost = z.role === 'root' ? DNS.COST.root : (z.role === 'tld' ? DNS.COST.tld : DNS.COST.auth);
    const s = {
        mode: 'iterative', act: 'msg', from: 'resolver', to: z.role,
        zone: zoneName, server: z.server, serverIp: z.ip, title: z.title,
        query: 'A? ' + qname,
        qtag: 'RD=0 迭代',
        ms: cost, lines: [],
    };

    if (r.kind === 'referral') {
        s.replyKind = 'referral';
        s.reply = '↩ referral 转介 —— 不是答案';
        s.lines = [
            r.zone + '.   NS   ' + r.ns + '   TTL ' + fmtSec(r.ttl),
            'glue：' + r.ns + '   A   ' + r.glue,
        ];
        s.note = '<b>' + z.title + '</b> 根本不知道 <code>' + qname + '</code> 的地址，'
            + '它只知道「<code>' + r.zone + '</code> 这一段交给谁管」。'
            + '于是它回一条 <b>NS 记录</b>（下一步该问谁）外加一条 <b>glue A 记录</b>（那台服务器的 IP）。'
            + '<b>这就是 referral —— 也是整个 DNS 里最常被讲错的一步：根和 TLD 从来不返回最终答案，'
            + '它们只负责指路。</b>'
            + (r.inBailiwick
                ? '　这里 <code>' + r.ns + '</code> 本身就在 <code>' + r.zone + '</code> 里面，'
                  + '不给 glue 的话，要查它的地址就得先解析 <code>' + r.zone + '</code>，成了死循环 —— '
                  + '所以这种情况下 <b>glue 是强制的</b>。'
                : '　这里 <code>' + r.ns + '</code> 不在 <code>' + r.zone + '</code> 里，'
                  + 'glue 并非强制，但带上能省一次解析，实际都会带。');
    } else if (r.kind === 'cname') {
        s.replyKind = 'cname';
        s.reply = '↩ CNAME 别名 —— 还得再解析一轮';
        s.lines = [
            qname + '.   CNAME   ' + r.target + '   TTL ' + fmtSec(r.ttl),
            '本地 DNS 现在要拿 ' + r.target + ' 从头再走一遍',
        ];
        s.note = '权威服务器说：这个名字是个<b>别名</b>，真名叫 <code>' + r.target + '</code>。'
            + '本地 DNS 只好把它当成一个全新的查询，<b>再走一整轮「根 → TLD → 权威」</b>。'
            + 'CNAME 链每多一层，解析就多一轮 —— 这是 CDN 接入后首屏变慢的一个真实来源。';
    } else if (r.kind === 'answer') {
        const ip = valueOf(r.rr, client);
        s.replyKind = 'answer';
        s.reply = '✓ 权威答案（AA=1）';
        s.lines = [qname + '.   ' + r.rr.type + '   ' + ip + '   TTL ' + fmtSec(r.rr.ttl)];
        s.note = '<b>' + z.title + '</b> 对这个名字是权威的，直接给出答案，AA 标志位置 1。';
        if (r.rr.geo) {
            const c = DNS.CLIENTS.filter((x) => x.id === client)[0];
            s.lines.push('※ 同一个名字，' + DNS.CLIENTS.map((x) => x.label + '→' + r.rr.geo[x.id]).join('　'));
            s.note += '　<b>注意这台服务器是按来源 IP 给的答案</b>：你现在是「'
                + (c ? c.label : client) + '」，拿到的是 <code>' + ip + '</code>；'
                + '换个地方问，同一个名字会返回另一台机器。'
                + '<b>CDN 的「就近调度」就是这么做的 —— 没有任何魔法，就是权威服务器按查询来源 IP 返回不同的 A 记录。</b>';
        }
    } else if (r.kind === 'nxdomain') {
        s.replyKind = 'nxdomain';
        s.reply = '✗ NXDOMAIN —— 这个名字不存在';
        s.lines = [
            '同时带回一条 SOA 记录，MINIMUM = ' + r.ttl + 's',
            '本地 DNS 会把「不存在」这件事也缓存起来（负缓存，RFC 2308）',
        ];
        s.note = '权威服务器明确说「没有这个名字」。'
            + '<b>关键点：「不存在」也是一个要被缓存的答案。</b>'
            + '否则一个拼错的域名被反复请求，每次都要从根重新走一遍，'
            + '根和 TLD 会被这类垃圾查询打爆。缓存多久由响应里那条 SOA 的 MINIMUM 决定。';
    } else if (r.kind === 'nodata') {
        s.replyKind = 'nxdomain';
        s.reply = '✗ NODATA —— 名字在，但没有这个类型';
        s.lines = ['rcode 仍是 NOERROR，只是 answer 段是空的'];
        s.note = 'NODATA 和 NXDOMAIN 是两回事：名字存在，只是没有你要的那种记录（比如只有 A 没有 AAAA）。';
    } else {
        s.replyKind = 'nxdomain';
        s.reply = '✗ REFUSED';
        s.lines = [];
        s.note = '这台服务器不负责这个名字，也不给转介。';
    }
    return s;
}

/** 对一个名字跑一轮迭代（从缓存里能到达的最深委派开始），返回终态 */
function iterateOnce(world, qname, res, push, client) {
    let zone = '';
    const anc = ancestors(qname);
    for (let i = 0; i < anc.length; i++) {
        if (get(world.resolver, 'NS:' + anc[i], world.now)) { zone = anc[i]; break; }
    }
    res.startZone = zone;

    for (let guard = 0; guard < 10; guard++) {
        const z = DNS.ZONES[zone];
        if (!z) return { kind: 'servfail' };
        const r = DNS.respond(zone, qname, 'A');
        push(iterStep(zone, qname, r, client));
        res.iterativeQueries++;
        if (r.kind === 'referral') {
            put(world.resolver, 'NS:' + r.zone, {
                kind: 'NS', label: 'NS ' + r.zone, value: r.ns + ' (glue ' + r.glue + ')',
            }, r.ttl, world.now);
            zone = r.zone;
            continue;
        }
        return r;
    }
    return { kind: 'servfail' };
}

// ---- 主入口：完整解析一次 ----

/**
 * 解析 qname。会就地改 world（各级缓存被填上），这正是我们要看的东西。
 * 返回 { steps[], hops, recursiveQueries, iterativeQueries, rounds, answer, status, totalMs, ... }
 *   hops = steps.length，也就是「一共经过了几站」，含本地缓存查询那两站。
 */
DNS.resolve = function (world, qname0, opts) {
    opts = opts || {};
    const client = opts.client || DNS.CLIENTS[0].id;
    const qname = String(qname0 || '').toLowerCase().replace(/\.+$/, '');
    const steps = [];
    let ms = 0;
    const push = (s) => { s.i = steps.length; ms += s.ms; s.atMs = Math.round(ms * 10) / 10; steps.push(s); return s; };

    const res = {
        qname: qname, client: client, steps: steps,
        status: 'OK', answer: null, answerTtl: 0, servedBy: null,
        chain: [qname], rounds: 0, cnameLinks: 0, loopAt: null,
        hops: 0, localLookups: 0, recursiveQueries: 0, iterativeQueries: 0,
        negCacheHit: false, totalMs: 0, startZone: null, filled: [],
    };
    const done = () => {
        res.hops = steps.length;
        res.totalMs = Math.round(ms * 10) / 10;
        return res;
    };

    // ① 浏览器自己的那张 DNS 表
    const bHit = get(world.browser, 'A:' + qname, world.now);
    push({
        mode: 'local', act: 'self', from: 'browser', to: 'browser',
        query: '查浏览器自己的 DNS 缓存　' + qname,
        qtag: '本进程内',
        replyKind: bHit ? 'hit' : 'miss',
        reply: bHit ? '✓ 命中 ' + bHit.value : '未命中',
        lines: bHit
            ? ['剩余 TTL ' + fmtSec(bHit.expireAt - world.now) + '，一个网络包都不用发']
            : ['Chrome 打开 chrome://net-internals/#dns 能看到这张表'],
        ms: bHit ? DNS.COST.browserHit : DNS.COST.browserMiss,
        note: bHit
            ? '<b>热查询在第一跳就短路了。</b>整个解析到此为止 —— 没有系统调用，没有网络包，'
              + '耗时只有微秒级。这就是为什么同一个页面里第二次请求同一个域名几乎是「零成本」。'
            : '浏览器有自己的一张 DNS 表，独立于操作系统。Chrome 一般把 TTL 压到 <b>60 秒封顶</b>，'
              + '所以就算权威给了 1 天的 TTL，浏览器也只留 1 分钟。',
    });
    res.localLookups++;
    if (bHit) {
        res.answer = bHit.value; res.answerTtl = bHit.expireAt - world.now; res.servedBy = 'browser';
        return done();
    }

    // ② 操作系统：hosts 优先，然后是系统 stub resolver 的缓存
    const hostsIp = DNS.HOSTS[qname];
    const oHit = hostsIp ? null : get(world.os, 'A:' + qname, world.now);
    push({
        mode: 'local', act: 'msg', from: 'browser', to: 'os',
        query: 'getaddrinfo("' + qname + '")',
        qtag: '系统调用',
        replyKind: (hostsIp || oHit) ? 'hit' : 'miss',
        reply: hostsIp ? '✓ hosts 文件命中 ' + hostsIp : (oHit ? '✓ 系统缓存命中 ' + oHit.value : '未命中'),
        lines: hostsIp
            ? ['hosts 的优先级高于一切 DNS 查询，命中就彻底不发包了']
            : (oHit
                ? ['剩余 TTL ' + fmtSec(oHit.expireAt - world.now) + '，顺手回填浏览器缓存']
                : ['hosts 里没有；系统 stub resolver 的缓存里也没有',
                   'Windows 看 ipconfig /displaydns，Linux 多半是 systemd-resolved 在管']),
        ms: (hostsIp || oHit) ? DNS.COST.osHit : DNS.COST.osMiss,
        note: hostsIp
            ? '<b>hosts 文件是最短路径</b>：它在所有缓存和所有 DNS 查询之前。'
              + '本地开发把域名指到 127.0.0.1、线上应急切流量，靠的都是它。'
            : (oHit
                ? '操作系统这一层（stub resolver）命中了。注意<b>它回填给浏览器的是「剩余 TTL」，不是原始 TTL</b> —— '
                  + '缓存只会缩短寿命，不会给记录续命。'
                : '操作系统这一层也没有。接下来才轮到真正的 DNS 协议：'
                  + '<b>系统里的 stub resolver 把这个问题原样丢给「本地 DNS」</b>，'
                  + '也就是 DHCP 下发的那个、或者你手工配的 8.8.8.8 / 223.5.5.5。'),
    });
    res.localLookups++;
    if (hostsIp) {
        res.answer = hostsIp; res.servedBy = 'hosts'; res.answerTtl = Infinity;
        return done();
    }
    if (oHit) {
        const left = oHit.expireAt - world.now;
        put(world.browser, 'A:' + qname, { kind: 'A', label: 'A ' + qname, value: oHit.value },
            Math.min(left, DNS.CAP.browser), world.now);
        res.answer = oHit.value; res.answerTtl = left; res.servedBy = 'os';
        return done();
    }

    // ③ 递归查询：客户端 → 本地 DNS。「你帮我查到底，别让我自己跑」
    const chase = cacheChase(world, qname);
    const rHit = chase.kind === 'answer';
    push({
        mode: 'recursive', act: 'msg', from: 'os', to: 'resolver',
        query: 'A? ' + qname + '　RD=1',
        qtag: '递归查询',
        replyKind: rHit ? 'hit' : (chase.kind === 'nx' ? 'nxdomain' : (chase.kind === 'loop' ? 'nxdomain' : 'miss')),
        reply: rHit ? '✓ 本地 DNS 缓存命中 ' + chase.value
            : (chase.kind === 'nx' ? '✗ 负缓存命中：NXDOMAIN'
                : (chase.kind === 'loop' ? '✗ 缓存里的 CNAME 成环' : '未命中 → 本地 DNS 接管，开始迭代')),
        lines: rHit
            ? ['剩余 TTL ' + fmtSec(chase.ttl) + '　'
               + (chase.chain.length ? '（顺着 ' + chase.chain.length + ' 层 CNAME 链找到的）' : '')]
            : (chase.kind === 'nx'
                ? ['「这个名字不存在」本身也被缓存了，剩余 ' + fmtSec(chase.ttl),
                   '所以这次一个字节都没打扰根 / TLD / 权威']
                : ['RD=1 的意思是「请你递归」：要么给我最终答案，要么给我错误，别给我转介',
                   '接下来的每一跳都是本地 DNS 自己跑的，客户端只是在等']),
        ms: DNS.COST.resolver,
        note: '<b>这一跳是「递归查询」，而且整条链路上只有这一跳是递归的。</b>'
            + '客户端发出的报文里 RD（Recursion Desired）位是 1，含义是：'
            + '「我不想自己一级一级跑，你负责查到底，直接把最终答案给我。」'
            + '本地 DNS 必须承诺这件事 —— 它要么返回最终答案，要么返回错误，'
            + '<b>绝不会把「你去问根服务器吧」这种转介甩回给客户端</b>。'
            + (rHit ? '　这次它缓存里就有，于是连一次迭代都不用做。'
                : (chase.kind === 'nx' ? '　这次命中的是<b>负缓存</b>：连「不存在」都是缓存过的。'
                    : '　这次没命中，它接下来要做的事情，全部是<b>迭代</b>。')),
    });
    res.recursiveQueries++;

    if (rHit) {
        const left = chase.ttl;
        put(world.os, 'A:' + qname, { kind: 'A', label: 'A ' + qname, value: chase.value },
            Math.min(left, DNS.CAP.os), world.now);
        put(world.browser, 'A:' + qname, { kind: 'A', label: 'A ' + qname, value: chase.value },
            Math.min(left, DNS.CAP.browser), world.now);
        res.answer = chase.value; res.answerTtl = left; res.servedBy = 'resolver';
        chase.chain.forEach((c) => { res.chain.push(c.to); res.cnameLinks++; });
        return done();
    }
    if (chase.kind === 'nx') {
        res.status = 'NXDOMAIN'; res.negCacheHit = true; res.servedBy = 'resolver';
        return done();
    }
    if (chase.kind === 'loop') {
        res.status = 'CNAME_LOOP'; res.loopAt = chase.name; res.servedBy = 'resolver';
        return done();
    }

    // ④ 迭代查询：本地 DNS → 根 → TLD → 权威，一跳只问出「下一步问谁」
    let target = chase.name;
    const visited = {};
    res.chain = [qname];
    let ttlMin = Infinity;
    chase.chain.forEach((c) => { res.chain.push(c.to); res.cnameLinks++; ttlMin = Math.min(ttlMin, c.ttl); });
    res.chain.forEach((n) => { visited[n] = true; });

    let final = null, rounds = 0, overflow = true;
    while (rounds < 8) {
        rounds++;
        res.rounds = rounds;
        const r = iterateOnce(world, target, res, push, client);

        if (r.kind === 'answer') {
            const ip = valueOf(r.rr, client);
            ttlMin = Math.min(ttlMin, r.rr.ttl);
            put(world.resolver, 'A:' + target, { kind: 'A', label: 'A ' + target, value: ip }, r.rr.ttl, world.now);
            res.answer = ip; final = r; overflow = false;
            break;
        }
        if (r.kind === 'cname') {
            put(world.resolver, 'CNAME:' + target, { kind: 'CNAME', label: 'CNAME ' + target, value: r.target },
                r.ttl, world.now);
            ttlMin = Math.min(ttlMin, r.ttl);
            res.chain.push(r.target);
            res.cnameLinks++;
            if (visited[r.target]) {
                res.status = 'CNAME_LOOP'; res.loopAt = r.target; overflow = false;
                break;
            }
            visited[r.target] = true;
            target = r.target;
            continue;
        }
        if (r.kind === 'nxdomain') {
            res.status = 'NXDOMAIN'; overflow = false;
            put(world.resolver, 'NX:' + target, {
                kind: 'NX', label: 'NXDOMAIN ' + target, value: '（负缓存）',
            }, r.ttl, world.now);
            break;
        }
        if (r.kind === 'nodata') { res.status = 'NODATA'; overflow = false; break; }
        res.status = 'SERVFAIL'; overflow = false; break;
    }
    if (overflow) res.status = 'SERVFAIL';

    if (res.status === 'OK' && final) {
        res.answerTtl = ttlMin;
        put(world.os, 'A:' + qname, { kind: 'A', label: 'A ' + qname, value: res.answer },
            Math.min(ttlMin, DNS.CAP.os), world.now);
        put(world.browser, 'A:' + qname, { kind: 'A', label: 'A ' + qname, value: res.answer },
            Math.min(ttlMin, DNS.CAP.browser), world.now);
        res.servedBy = 'authoritative';
        res.filled = [
            { lv: '本地 DNS', ttl: ttlMin },
            { lv: '操作系统', ttl: Math.min(ttlMin, DNS.CAP.os) },
            { lv: '浏览器', ttl: Math.min(ttlMin, DNS.CAP.browser) },
        ];
    }
    return done();
};

// ---- 现成的对照实验 ----

/** 冷查询 vs 紧接着的热查询（用一次性的世界，纯函数）*/
DNS.hotVsCold = function (qname, client) {
    const w = DNS.newWorld();
    const cold = DNS.resolve(w, qname, { client: client });
    const hot = DNS.resolve(w, qname, { client: client });
    return { cold: cold, hot: hot, speedup: cold.totalMs / hot.totalMs };
};

/** TTL 阶梯：查一次之后分别等 N 秒再查，看是哪一级接住的 */
DNS.ttlLadder = function (qname, client, marks) {
    marks = marks || [0, 30, 70, 150, 350];
    const w = DNS.newWorld();
    const out = [];
    let prev = 0;
    marks.forEach((m, i) => {
        if (i > 0) DNS.advance(w, m - prev);
        prev = m;
        out.push({ after: m, r: DNS.resolve(w, qname, { client: client }) });
    });
    return out;
};

if (typeof module !== 'undefined' && module.exports) module.exports = DNS;
if (typeof window !== 'undefined') window.DNSModel = DNS;

// ---------- 二、界面 ----------

if (typeof window === 'undefined' || !window.Viz) return;

const h = Viz.h, svg = Viz.svg, T = Viz.text;

const DOMAINS = [
    { v: 'www.example.com', label: 'www.example.com', tip: '最普通的一次解析：一路问到权威，拿一条 A 记录' },
    { v: 'shop.example.com', label: 'shop…（1 层 CNAME）', tip: '站点挂到 CDN 上：权威回 CNAME，还得再解析一轮' },
    { v: 'deep.example.com', label: 'deep…（2 层 CNAME）', tip: 'CDN 内部再转一手到边缘节点：三轮解析' },
    { v: 'dev.example.com', label: 'dev…（hosts 命中）', tip: 'hosts 文件里写死了，DNS 一个包都不发' },
    { v: 'nosuch.example.com', label: 'nosuch…（NXDOMAIN）', tip: '不存在的名字。看「不存在」怎么被负缓存' },
    { v: 'loop-a.example.com', label: 'loop-a…（CNAME 成环）', tip: '配错的 A→B→A，看解析器怎么刹车' },
];

const LANES = [
    { id: 'browser', name: '浏览器', sub: 'Chrome / Firefox' },
    { id: 'os', name: '操作系统', sub: 'hosts + stub resolver' },
    { id: 'resolver', name: '本地 DNS', sub: '递归解析器 8.8.8.8' },
    { id: 'root', name: '根服务器', sub: 'a.root-servers.net' },
    { id: 'tld', name: 'TLD 服务器', sub: '.com / .net' },
    { id: 'auth', name: '权威服务器', sub: 'ns1.example.com 等' },
];
const LANE_X = { browser: 178, os: 349, resolver: 520, root: 691, tld: 862, auth: 1033 };

const state = {
    world: null,
    qname: 'www.example.com',
    client: 'sh',
    result: null,
    step: 0,
    elapsed: 0,        // 滑块：距离上一次解析已经过去多少秒（还没真正推进时钟）
    presetName: '冷查询（缓存全空）',
};

// ---------- 时序图 ----------

/** 粗略估个文字宽度：中文按 1em，ASCII 按 0.55em */
function tw(str, size) {
    let w = 0;
    const s = String(str == null ? '' : str);
    for (let i = 0; i < s.length; i++) w += (s.charCodeAt(i) > 255 ? 1 : 0.55);
    return w * size;
}

function labelWithBg(x, y, str, cls, anchor, size) {
    const g = svg('g');
    const w = tw(str, size) + 10;
    const bx = anchor === 'start' ? x - 5 : (anchor === 'end' ? x - w + 5 : x - w / 2);
    g.appendChild(svg('rect', { x: bx, y: y - size + 1, width: w, height: size + 6, rx: 3, class: 'dns-lbl-bg' }));
    g.appendChild(T({ x: x, y: y, 'text-anchor': anchor || 'middle', class: cls }, str));
    return g;
}

function markers() {
    const defs = svg('defs');
    const mk = (id, color) => {
        const m = svg('marker', {
            id: id, viewBox: '0 0 10 10', refX: '9', refY: '5',
            markerWidth: '7', markerHeight: '7', orient: 'auto-start-reverse',
        });
        m.appendChild(svg('path', { d: 'M0 0L10 5L0 10z', fill: color }));
        return m;
    };
    defs.appendChild(mk('dnsALocal', '#94a3b8'));
    defs.appendChild(mk('dnsARec', '#4f46e5'));
    defs.appendChild(mk('dnsAIt', '#0d9488'));
    defs.appendChild(mk('dnsBMiss', '#9ca3af'));
    defs.appendChild(mk('dnsBHit', '#10b981'));
    defs.appendChild(mk('dnsBRef', '#f59e0b'));
    defs.appendChild(mk('dnsBAns', '#10b981'));
    defs.appendChild(mk('dnsBCname', '#db2777'));
    defs.appendChild(mk('dnsBNx', '#ef4444'));
    return defs;
}

const REPLY_STYLE = {
    miss: { cls: 'dns-back-miss', mk: 'dnsBMiss', tx: 'dns-r-miss' },
    hit: { cls: 'dns-back-hit', mk: 'dnsBHit', tx: 'dns-r-hit' },
    referral: { cls: 'dns-back-ref', mk: 'dnsBRef', tx: 'dns-r-ref' },
    answer: { cls: 'dns-back-ans', mk: 'dnsBAns', tx: 'dns-r-ans' },
    cname: { cls: 'dns-back-cname', mk: 'dnsBCname', tx: 'dns-r-cname' },
    nxdomain: { cls: 'dns-back-nx', mk: 'dnsBNx', tx: 'dns-r-nx' },
};
const MODE_STYLE = {
    local: { arrow: 'dns-arr-local', mk: 'dnsALocal', band: 'dns-band-local', name: '本地', sub: '不发包' },
    recursive: { arrow: 'dns-arr-rec', mk: 'dnsARec', band: 'dns-band-rec', name: '递归', sub: 'RD=1' },
    iterative: { arrow: 'dns-arr-it', mk: 'dnsAIt', band: 'dns-band-it', name: '迭代', sub: 'RD=0' },
};

function buildSeq() {
    const res = state.result;
    const st = res.steps;
    const W = 1120, PT = 100, PB = 30;
    const showBack = state.step >= st.length - 1 && res.recursiveQueries > 0 && res.servedBy !== 'resolver'
        && res.servedBy !== 'browser' && res.servedBy !== 'os' && res.servedBy !== 'hosts';

    // 先量每一行多高（回复里带几条记录，行就多高）
    const rows = [];
    let y = PT;
    st.forEach((s) => {
        const nl = (s.lines || []).length;
        const hgt = 66 + nl * 13 + 12;
        rows.push({ s: s, top: y, h: hgt });
        y += hgt;
    });
    const backTop = y;
    if (showBack) y += 58;
    const H = y + PB;

    const root = svg('svg', {
        viewBox: '0 0 ' + W + ' ' + H, class: 'dns-svg',
        preserveAspectRatio: 'xMidYMid meet', role: 'img',
        'aria-label': 'DNS 解析时序图',
    });
    root.appendChild(markers());

    // ---- 递归 / 迭代 / 本地 的分段色带 + 左侧括号标注 ----
    let k = 0;
    while (k < rows.length) {
        const mode = rows[k].s.mode;
        let j = k;
        while (j + 1 < rows.length && rows[j + 1].s.mode === mode) j++;
        const top = rows[k].top - 10, bot = rows[j].top + rows[j].h - 12;
        const ms = MODE_STYLE[mode];
        root.appendChild(svg('rect', { x: 6, y: top, width: W - 12, height: bot - top, rx: 10, class: ms.band }));
        // 左侧竖括号 + 名字
        root.appendChild(svg('rect', { x: 10, y: top + 6, width: 4, height: bot - top - 12, rx: 2, class: ms.band + '-bar' }));
        const cy = (top + bot) / 2;
        root.appendChild(T({ x: 22, y: cy - 2, class: 'dns-band-name ' + ms.band + '-t' }, ms.name));
        root.appendChild(T({ x: 22, y: cy + 12, class: 'dns-band-name ' + ms.band + '-t' }, '查询'));
        root.appendChild(T({ x: 22, y: cy + 26, class: 'dns-band-sub' }, ms.sub));
        k = j + 1;
    }

    // ---- 角色头 + 生命线 ----
    LANES.forEach((L) => {
        const x = LANE_X[L.id];
        root.appendChild(svg('rect', { x: x - 78, y: 10, width: 156, height: 38, rx: 9, class: 'seq-actor' }));
        root.appendChild(T({ x: x, y: 27, 'text-anchor': 'middle', class: 'seq-actor-name' }, L.name));
        root.appendChild(T({ x: x, y: 40, 'text-anchor': 'middle', class: 'seq-actor-sub' }, L.sub));
        root.appendChild(svg('line', { x1: x, x2: x, y1: 48, y2: H - 12, class: 'seq-life' }));
    });

    // ---- 每一步 ----
    rows.forEach((row, idx) => {
        const s = row.s;
        const lit = idx <= state.step;
        const g = svg('g', { opacity: lit ? 1 : 0.15 });
        const top = row.top;
        const ms = MODE_STYLE[s.mode];
        const rs = REPLY_STYLE[s.replyKind] || REPLY_STYLE.miss;
        const yq = top + 20, yr = top + 42;

        // 步号
        g.appendChild(svg('circle', { cx: 66, cy: yq, r: 10, class: 'dns-num-bg' }));
        g.appendChild(T({ x: 66, y: yq + 4, 'text-anchor': 'middle', class: 'dns-num' }, String(idx + 1)));

        if (s.act === 'self') {
            // 自查缓存：生命线上打一个回环
            const x = LANE_X[s.from];
            g.appendChild(svg('path', {
                d: 'M' + (x + 4) + ' ' + yq + ' H' + (x + 64) + ' V' + (yq + 20) + ' H' + (x + 10),
                class: ms.arrow, fill: 'none', 'marker-end': 'url(#' + ms.mk + ')',
            }));
            g.appendChild(labelWithBg(x + 74, yq + 2, s.query, 'dns-q', 'start', 12));
            g.appendChild(labelWithBg(x + 74, yr + 14, s.reply, 'dns-r ' + rs.tx, 'start', 11.5));
            (s.lines || []).forEach((ln, i) => {
                g.appendChild(T({ x: x + 74, y: top + 66 + 13 + i * 13, class: 'dns-rr' }, ln));
            });
        } else {
            const x1 = LANE_X[s.from], x2 = LANE_X[s.to];
            const dir = x2 > x1 ? 1 : -1;
            const ax1 = x1 + dir * 8, ax2 = x2 - dir * 10;
            const mid = (ax1 + ax2) / 2;

            // 去程
            g.appendChild(svg('line', {
                x1: ax1, y1: yq, x2: ax2, y2: yq, class: ms.arrow, 'marker-end': 'url(#' + ms.mk + ')',
            }));
            g.appendChild(labelWithBg(mid, yq - 7, s.query, 'dns-q', 'middle', 12));
            // 模式徽标贴在箭头起点
            g.appendChild(svg('rect', { x: ax1 + 2, y: yq + 4, width: tw(s.qtag, 10) + 12, height: 15, rx: 4, class: ms.band + '-tag' }));
            g.appendChild(T({ x: ax1 + 8, y: yq + 15, class: 'dns-tag ' + ms.band + '-t' }, s.qtag));

            // 回程（虚线，反向）
            g.appendChild(svg('line', {
                x1: ax2, y1: yr, x2: ax1, y2: yr, class: rs.cls, 'marker-end': 'url(#' + rs.mk + ')',
            }));
            g.appendChild(labelWithBg(mid, yr + 15, s.reply, 'dns-r ' + rs.tx, 'middle', 11.5));
            (s.lines || []).forEach((ln, i) => {
                g.appendChild(T({ x: mid, y: top + 66 + 13 + i * 13, 'text-anchor': 'middle', class: 'dns-rr' }, ln));
            });
            if (s.server) {
                g.appendChild(T({ x: x2, y: top + 8, 'text-anchor': 'middle', class: 'dns-srv' },
                    s.server + '  ' + s.serverIp));
            }
        }
        root.appendChild(g);
    });

    // ---- 递归应答：最终答案一次性交回 ----
    if (showBack) {
        const g = svg('g');
        const x1 = LANE_X.resolver, x2 = LANE_X.browser;
        const yy = backTop + 22;
        g.appendChild(svg('line', {
            x1: x1 - 8, y1: yy, x2: x2 + 10, y2: yy, class: 'dns-back-final', 'marker-end': 'url(#dnsBAns)',
        }));
        g.appendChild(labelWithBg((x1 + x2) / 2, yy - 7,
            '递归应答：' + (res.status === 'OK' ? res.answer : res.status) + '　一次性交回发起方', 'dns-r dns-r-ans', 'middle', 12));
        g.appendChild(T({ x: (x1 + x2) / 2, y: yy + 16, 'text-anchor': 'middle', class: 'dns-rr' },
            '同时逐级写入缓存：本地 DNS ' + fmtSec(res.answerTtl)
            + ' / 系统 ' + fmtSec(Math.min(res.answerTtl, DNS.CAP.os))
            + ' / 浏览器 ' + fmtSec(Math.min(res.answerTtl, DNS.CAP.browser))));
        root.appendChild(g);
    }

    return root;
}

// ---------- 各版块 ----------

function statusText(res) {
    if (res.status === 'OK') return '✓ ' + res.answer;
    if (res.status === 'NXDOMAIN') return '✗ NXDOMAIN（不存在）';
    if (res.status === 'CNAME_LOOP') return '✗ CNAME 成环，已终止';
    return '✗ ' + res.status;
}

const SERVED = {
    browser: '浏览器缓存', hosts: 'hosts 文件', os: '操作系统缓存',
    resolver: '本地 DNS 缓存', authoritative: '权威服务器（走完全程）',
};

function buildControls() {
    const box = h('div.controls');

    box.appendChild(Viz.slider({
        label: '快进', min: 0, max: 600, step: 5, value: state.elapsed,
        fmt: (v) => v + ' 秒后',
        onInput: (v) => { state.elapsed = v; render(); },
    }));

    box.appendChild(h('div.ctl-btns', null,
        h('button.mini.primary', {
            onclick: () => {
                if (state.elapsed > 0) { DNS.advance(state.world, state.elapsed); state.elapsed = 0; }
                state.presetName = '在当前时刻手动再查一次';
                runQuery();
            },
        }, h('i.fas.fa-rotate-right'), ' 在这个时刻再查一次'),
        h('button.mini.danger', {
            onclick: () => { preset('cold'); },
        }, '清空所有缓存')
    ));
    return box;
}

function presetButtons() {
    const defs = [
        ['cold', '① 冷查询（缓存全空）'],
        ['hot', '② 立刻再查一次'],
        ['b70', '③ 等 70 秒（浏览器过期）'],
        ['o150', '④ 等 150 秒（系统也过期）'],
        ['a350', '⑤ 等 350 秒（A 记录全过期）'],
        ['tldonly', '⑥ 只剩 .com 的 NS 在缓存里'],
    ];
    const box = h('div.dns-presets');
    defs.forEach((d) => {
        box.appendChild(h('button.mini' + (d[0] === 'cold' ? '' : ''), {
            onclick: () => preset(d[0]),
        }, d[1]));
    });
    return box;
}

function preset(kind) {
    const q = state.qname, c = state.client;
    state.world = DNS.newWorld();
    state.elapsed = 0;
    if (kind === 'hot') { DNS.resolve(state.world, q, { client: c }); DNS.advance(state.world, 5); state.presetName = '热查询：5 秒前刚查过'; }
    else if (kind === 'b70') { DNS.resolve(state.world, q, { client: c }); DNS.advance(state.world, 70); state.presetName = '70 秒后：浏览器缓存（60s 封顶）已过期'; }
    else if (kind === 'o150') { DNS.resolve(state.world, q, { client: c }); DNS.advance(state.world, 150); state.presetName = '150 秒后：浏览器 + 系统缓存都过期了'; }
    else if (kind === 'a350') { DNS.resolve(state.world, q, { client: c }); DNS.advance(state.world, 350); state.presetName = '350 秒后：A 记录（TTL 300s）也过期了'; }
    else if (kind === 'tldonly') { DNS.seedNS(state.world, 'com'); state.presetName = '只有 .com 的 NS 还在本地 DNS 缓存里'; }
    else state.presetName = '冷查询（缓存全空）';
    runQuery();
}

function runQuery() {
    state.result = DNS.resolve(state.world, state.qname, { client: state.client });
    state.step = 0;
    render();
}

function buildResultBar() {
    const res = state.result;
    const cls = res.status === 'OK' ? 'ok' : 'bad';
    return h('div.dns-resultbar.dns-rb-' + cls, null,
        h('div.dns-rb-item', null, h('span', { text: '最终结果' }), h('b', { text: statusText(res) })),
        h('div.dns-rb-item', null, h('span', { text: '总跳数' }), h('b', { text: res.hops + ' 跳' })),
        h('div.dns-rb-item', null, h('span', { text: '递归 / 迭代' }),
            h('b', { text: res.recursiveQueries + ' 次 / ' + res.iterativeQueries + ' 次' })),
        h('div.dns-rb-item', null, h('span', { text: '解析轮数' }), h('b', { text: res.rounds + ' 轮' })),
        h('div.dns-rb-item', null, h('span', { text: '模拟耗时' }), h('b', { text: res.totalMs + ' ms' })),
        h('div.dns-rb-item', null, h('span', { text: '谁给的答案' }), h('b', { text: SERVED[res.servedBy] || '—' }))
    );
}

function buildCachePanel() {
    const at = state.world.now + state.elapsed;
    const snap = DNS.snapshot(state.world, at);
    const grid = h('div.dns-cache-grid');

    const col = (lv, title, capNote) => {
        const box = h('div.dns-cc');
        box.appendChild(h('div.dns-cc-h', { html: '<b>' + Viz.esc(title) + '</b><small>' + capNote + '</small>' }));
        const items = snap[lv];
        if (!items.length) { box.appendChild(h('div.dns-cc-empty', { text: '（空 —— 这一级会完全穿透）' })); return box; }
        items.forEach((e) => {
            const pct = Math.max(0, Math.min(1, e.ttl / e.ttl0)) * 100;
            box.appendChild(h('div.dns-ci', null,
                h('div.dns-ci-k', { text: e.label || e.key }),
                h('div.dns-ci-v', { text: String(e.value) }),
                h('div.dns-ttl', null, h('i.dns-ttl-f', { style: 'width:' + pct.toFixed(1) + '%' })),
                h('div.dns-ci-t', { text: '剩余 ' + fmtSec(e.ttl) })
            ));
        });
        return box;
    };

    grid.appendChild(col('browser', '浏览器缓存', 'TTL 封顶 60 秒'));
    grid.appendChild(col('os', '操作系统缓存', 'TTL 封顶 120 秒'));
    grid.appendChild(col('resolver', '本地 DNS 缓存', '按记录原始 TTL'));
    return grid;
}

function buildLadder() {
    const rows = DNS.ttlLadder(state.qname, state.client);
    const t = h('table.mv-matrix');
    const head = h('tr', null,
        h('th', { text: '距上次查询' }), h('th', { text: '谁回答的' }),
        h('th', { text: '跳数' }), h('th', { text: '迭代次数' }),
        h('th', { text: '模拟耗时' }), h('th', { text: '说明' }));
    t.appendChild(head);
    const why = [
        '第一次，什么都没有，一路问到权威',
        '浏览器缓存还在（TTL 60s 封顶），第一跳直接短路',
        '浏览器过期了，但系统缓存（120s）还在',
        '浏览器 + 系统都过期，本地 DNS 缓存（300s）接住',
        'A 记录也过期了 —— 但 NS 记录 TTL 是 2 天，还在！所以直接问权威，省掉根和 TLD 两跳',
    ];
    rows.forEach((row, i) => {
        t.appendChild(h('tr' + (i === 0 ? '' : ''), null,
            h('td', { text: row.after + ' 秒' }),
            h('td', { text: SERVED[row.r.servedBy] || '—' }),
            h('td.mv-strong', { text: row.r.hops + '' }),
            h('td', { text: row.r.iterativeQueries + '' }),
            h('td', { text: row.r.totalMs + ' ms' }),
            h('td', { text: why[i] || '' })
        ));
    });
    return h('div.mv-matrix-wrap', null, t);
}

function buildGeoTable() {
    const t = h('table.mv-matrix');
    t.appendChild(h('tr', null,
        h('th', { text: '你在哪' }), h('th', { text: 'www.example.com（自建，无 CDN）' }),
        h('th', { text: 'shop.example.com（挂 CDN，1 层 CNAME）' })));
    DNS.CLIENTS.forEach((c) => {
        const a = DNS.resolve(DNS.newWorld(), 'www.example.com', { client: c.id });
        const b = DNS.resolve(DNS.newWorld(), 'shop.example.com', { client: c.id });
        t.appendChild(h('tr', null,
            h('td', { text: c.label + '（' + c.ip + '）' }),
            h('td', { text: a.answer }),
            h('td.ok', { text: b.answer })
        ));
    });
    return h('div.mv-matrix-wrap', null, t);
}

function buildChain() {
    const res = state.result;
    if (res.chain.length < 2) return null;
    const box = h('div.dns-chain');
    res.chain.forEach((n, i) => {
        if (i) box.appendChild(h('span.dns-chain-a', { html: '<i class="fas fa-arrow-right"></i> CNAME' }));
        const isLoop = res.status === 'CNAME_LOOP' && i === res.chain.length - 1;
        box.appendChild(h('span.dns-chain-n' + (isLoop ? '.dns-chain-loop' : ''), { text: n }));
    });
    if (res.status === 'OK') {
        box.appendChild(h('span.dns-chain-a', { html: '<i class="fas fa-arrow-right"></i> A' }));
        box.appendChild(h('span.dns-chain-n.dns-chain-ip', { text: res.answer }));
    }
    return box;
}

function buildRRTable() {
    const rows = [
        ['A', 'IPv4 地址', '名字 → 32 位 IPv4。绝大多数解析的终点。'],
        ['AAAA', 'IPv6 地址', '名字 → 128 位 IPv6。双栈环境下浏览器会同时发 A 和 AAAA 两个查询（Happy Eyeballs 谁先到用谁）。'],
        ['CNAME', '别名', '名字 → 另一个名字，「真名在那边，你自己再查一遍」。CDN 接入基本都靠它。'],
        ['NS', '这一段归谁管', '把一个子区委派出去。referral 回的就是它。TTL 通常很长（1~2 天）。'],
        ['MX', '收信的服务器', '带优先级数字，越小越优先。注意 <b>MX 的值必须是能解析出 A 的名字，不能指向 CNAME</b>。'],
        ['TXT', '任意文本', '本来是备注，实际被 SPF / DKIM / DMARC 和各种「域名所有权验证」征用了。'],
    ];
    const t = h('table.mv-matrix');
    t.appendChild(h('tr', null, h('th', { text: '类型' }), h('th', { text: '一句话' }), h('th', { text: '实际怎么用' })));
    rows.forEach((r) => {
        t.appendChild(h('tr', null,
            h('td.mv-strong', { text: r[0] }), h('td', { text: r[1] }), h('td', { html: r[2] })));
    });
    return h('div.mv-matrix-wrap', null, t);
}

// ---------- 渲染 ----------

let rootEl = null;

function render() {
    if (!rootEl) return;
    const res = state.result;
    const st = res.steps;
    if (state.step > st.length - 1) state.step = st.length - 1;
    const cur = st[Math.max(0, Math.min(state.step, st.length - 1))];
    rootEl.innerHTML = '';

    const dom = DOMAINS.filter((d) => d.v === state.qname)[0] || DOMAINS[0];

    // ---- 1. 场景 + 控制 ----
    const scene = Viz.card('fa-signs-post', '查一个域名，看它到底走了多远',
        '选一个域名、选一个「缓存有多热」的起点，然后一步步走。'
        + '<b>当前场景：' + Viz.esc(state.presetName) + '</b>　—　' + dom.tip);
    scene.appendChild(h('div.dns-ctl-row', null,
        h('span.dns-ctl-lb', { text: '查什么' }),
        Viz.segmented({
            value: state.qname,
            options: DOMAINS.map((d) => ({ v: d.v, label: d.label })),
            onPick: (v) => { state.qname = v; preset('cold'); },
        })
    ));
    scene.appendChild(h('div.dns-ctl-row', null,
        h('span.dns-ctl-lb', { text: '你在哪' }),
        Viz.segmented({
            value: state.client,
            options: DNS.CLIENTS.map((c) => ({ v: c.id, label: c.label })),
            onPick: (v) => { state.client = v; preset('cold'); },
        })
    ));
    scene.appendChild(h('div.dns-ctl-row', null,
        h('span.dns-ctl-lb', { text: '缓存状态' }), presetButtons()
    ));
    scene.appendChild(buildControls());
    rootEl.appendChild(scene);

    // ---- 2. 主视图：时序图 ----
    const nav = h('div.seq-nav', null,
        h('button.mini', { onclick: () => { state.step = Math.max(0, state.step - 1); render(); } }, '← 上一步'),
        h('span.seq-progress', { text: (state.step + 1) + ' / ' + st.length }),
        h('button.mini.primary', { onclick: () => { state.step = Math.min(st.length - 1, state.step + 1); render(); } }, '下一步 →'),
        h('button.mini', { onclick: () => { state.step = st.length - 1; render(); } }, '全部展开'),
        h('button.mini', { onclick: () => { state.step = 0; render(); } }, '回到第 1 步')
    );

    const seqCard = Viz.card('fa-timeline', '一次解析，逐跳看',
        '灰的是还没走到的步骤。<b>左边的色带把「递归」和「迭代」明确分成了两段</b> —— '
        + '这是整个 DNS 里最容易被混为一谈的地方：'
        + '<b>客户端 → 本地 DNS 是递归</b>（你帮我查到底，别让我自己跑）；'
        + '<b>本地 DNS → 根 / TLD / 权威 是迭代</b>（每一跳只告诉它下一步该问谁）。'
        + '一次解析里递归查询<b>永远只有 1 次</b>，迭代查询才是变化的那部分。');
    seqCard.appendChild(Viz.legend([
        { cls: 'dns-k-rec', text: '递归查询（RD=1，客户端 ↔ 本地 DNS）' },
        { cls: 'dns-k-it', text: '迭代查询（RD=0，本地 DNS ↔ 各级服务器）' },
        { cls: 'dns-k-ref', text: 'referral 转介：NS + glue，不是答案' },
        { cls: 'dns-k-ans', text: '权威答案 / 缓存命中' },
        { cls: 'dns-k-cname', text: 'CNAME：还要再解析一轮' },
        { cls: 'dns-k-nx', text: 'NXDOMAIN' },
    ]));
    // 时序图固定 1120 宽，窄屏整体缩放会把 9.5px 的记录文字压到看不清，
    // 所以外面套一层横向滚动容器：宁可让用户左右拖，也别缩成马赛克。
    seqCard.appendChild(h('div.dns-scroll', null, buildSeq()));
    seqCard.appendChild(nav);
    seqCard.appendChild(h('div.seq-note', { html: '<b>第 ' + (state.step + 1) + ' 步：</b>' + cur.note }));
    seqCard.appendChild(buildResultBar());
    rootEl.appendChild(seqCard);

    // ---- 3. 打脸时刻：冷 vs 热 ----
    const hv = DNS.hotVsCold(state.qname, state.client);
    const speed = hv.hot.totalMs > 0 ? Math.round(hv.cold.totalMs / hv.hot.totalMs) : 0;
    const face = Viz.card('fa-bolt', '打脸时刻：同一个域名，冷查和热查差了两个数量级',
        '下面这组数字是用同一个域名跑出来的：先在空缓存上查一次（冷），紧接着再查一次（热）。');
    face.appendChild(Viz.cmpGrid([
        { h: '冷查询 · 缓存全空', v: hv.cold.totalMs + ' ms', d: hv.cold.hops + ' 跳，一路问到权威服务器', cls: 'cmp-bad' },
        { h: '热查询 · 浏览器缓存命中', v: hv.hot.totalMs + ' ms', d: hv.hot.hops + ' 跳，第一跳就短路返回', cls: 'cmp-ok' },
        { h: '差距', v: speed + ' 倍', d: '这就是 dns-prefetch 存在的理由', cls: 'cmp-save' },
    ]));
    face.appendChild(h('div.flow-hi', {
        html: '<b>为什么首屏优化必须做 DNS 预解析？</b>'
            + '因为这 ' + hv.cold.totalMs + 'ms 是<b>串行阻塞</b>在最前面的：'
            + 'DNS 没查完，TCP 握不了手；TCP 没握完，TLS 谈不了；TLS 没谈完，第一个字节发不出去。'
            + '页面里只要引了第三方域名（CDN、字体、埋点、支付），每个新域名都要单独付一次这个钱。'
            + '在 <code>&lt;head&gt;</code> 里写一行 <code>&lt;link rel="dns-prefetch" href="//cdn.example.com"&gt;</code>，'
            + '浏览器就会在解析 HTML 的同时把这次解析<b>提前并行做掉</b>，'
            + '等真正要发请求时缓存已经热了 —— 也就是把上面这一列的 ' + hv.cold.totalMs + 'ms 变成 ' + hv.hot.totalMs + 'ms。'
            + '想连 TCP + TLS 一起提前做，就用 <code>preconnect</code>（更贵，别一次写十个）。',
    }));
    rootEl.appendChild(face);

    // ---- 4. 三级缓存现状 ----
    rootEl.appendChild(Viz.card('fa-database', '三级缓存现在长什么样',
        '拖上面的「快进」滑块，能看到每条记录的剩余 TTL 一起往下掉，掉到 0 就直接消失。'
        + '<b>注意一个常被忽略的性质：下游缓存拿到的是「剩余 TTL」，不是原始 TTL</b> —— '
        + '缓存只会缩短一条记录的寿命，永远不会给它续命。'
        + '当前时刻：<b>t = ' + (state.world.now + state.elapsed) + ' 秒</b>'
        + (state.elapsed ? '（滑块预览中，点「在这个时刻再查一次」才会真正推进）' : ''),
        buildCachePanel()
    ));

    // ---- 5. TTL 阶梯 ----
    rootEl.appendChild(Viz.card('fa-stairs', 'TTL 阶梯：隔多久再查，是哪一级接住的',
        '同一个域名，查完之后分别等 0 / 30 / 70 / 150 / 350 秒再查一次。'
        + '<b>最后一行是这个演示里最反直觉的一行，别跳过。</b>',
        buildLadder(),
        h('div.flow-hi', {
            html: '<b>最后一行为什么不是回到 ' + DNS.ttlLadder(state.qname, state.client)[0].r.hops + ' 跳？</b>'
                + 'A 记录的 TTL 是 300 秒，350 秒后确实过期了。但 <b>NS 记录的 TTL 是 172800 秒（2 天）</b>，'
                + '本地 DNS 早就把「com 归谁管、example.com 归谁管」记住了。'
                + '所以它<b>根本不用再问根和 TLD，直接去问权威服务器</b>。'
                + '这也是为什么真实世界里根服务器的负载远没有想象中大 —— '
                + '绝大多数查询在到达根之前就被各级缓存和长 TTL 的 NS 记录挡掉了。',
        })
    ));

    // ---- 6. CNAME 链与 CDN ----
    const cn = Viz.card('fa-link', 'CNAME 链：CDN 的就近调度就是这么做的，没有魔法',
        '域名挂到 CDN 上，本质就是给它配一条 CNAME 指向 CDN 的域名。'
        + '之后每次解析都要<b>多走一整轮</b>「根 → TLD → 权威」，'
        + '而 CDN 的权威服务器会<b>按查询来源 IP 返回不同的 A 记录</b>，把你导到最近的边缘节点。');
    const chain = buildChain();
    if (chain) {
        cn.appendChild(h('div.sec-note', { html: '本次解析走过的链（' + res.rounds + ' 轮）：' }));
        cn.appendChild(chain);
    }
    cn.appendChild(h('div.sec-note', {
        html: '换个位置看同一个名字返回什么（下面这张表是分别用三个来源现算的）：',
    }));
    cn.appendChild(buildGeoTable());
    cn.appendChild(h('div.flow-hi', {
        html: '<b>顺带点破一个到处被问的问题：为什么根域名（example.com）不能用 CNAME？</b>'
            + '因为 RFC 1034 规定 <b>CNAME 不能和其它记录共存</b> —— 一个名字一旦有了 CNAME，'
            + '就不能再有别的记录。而根域名<b>必须</b>有 NS 记录（不然没人知道这个区归谁管），'
            + '通常还得有 SOA、MX。两者直接冲突，所以 <code>example.com CNAME xxx.cdn.net</code> 是非法的。'
            + '各家 CDN 的解法是搞私有记录类型 <b>ALIAS / ANAME / CNAME Flattening</b>：'
            + '权威服务器在<b>响应时</b>自己去把目标解析成 A，然后<b>以 A 记录的形式</b>返回给你，'
            + '区文件里看着像 CNAME，线上传输的是 A —— 于是绕开了「不能共存」这条规矩。'
            + '代价是它是私有扩展，换 DNS 服务商不一定能带走。',
    }));
    rootEl.appendChild(cn);

    // ---- 7. 记录类型 ----
    rootEl.appendChild(Viz.card('fa-table-list', '常见记录类型，一句话说清用途', null, buildRRTable()));

    // ---- 8. 面试 ----
    rootEl.appendChild(Viz.card('fa-comments', '面试这么答', null, Viz.qa(QA)));

    // ---- 9. 坑 ----
    rootEl.appendChild(Viz.card('fa-triangle-exclamation', '必须知道的坑', null, Viz.pitfalls(PITFALLS)));

    // ---- 10. 口径 ----
    rootEl.appendChild(h('section.card.foot-note', null,
        h('h3.sec-title', { html: '<i class="fas fa-circle-info"></i> 关于这个演示的口径与简化' }),
        h('p', {
            html: '<b>耗时全是模拟的。</b><code>' + DNS.COST.root + 'ms</code>（根）、'
                + '<code>' + DNS.COST.tld + 'ms</code>（TLD）、<code>' + DNS.COST.auth + 'ms</code>（权威）、'
                + '<code>' + DNS.COST.resolver + 'ms</code>（客户端↔本地 DNS）都是写死的常量，'
                + '只为把「本地命中」和「跨网问权威」的数量级差距做出来。'
                + '真实值取决于你在哪、用哪家 DNS、有没有任播命中近点，波动很大。<b>整个演示不用任何随机数</b>，'
                + '同样的操作序列结果永远一样。',
        }),
        h('p', {
            html: '<b>刻意忽略掉的东西：</b>EDNS0（含 ECS，也就是把客户端子网带给权威服务器，'
                + '真实 CDN 调度很依赖它）、DNSSEC 的签名与验证链、'
                + 'QNAME minimisation（现代解析器不会把完整域名告诉根，只问它需要知道的那一段）、'
                + '13 个根 NS 之间的选路与 SRTT 探测、TCP fallback 与 EDNS0 大包、'
                + 'AAAA 与 A 的并行查询（Happy Eyeballs）、多条 A 记录的轮询与客户端排序、'
                + '负载均衡器 / 智能 DNS 的线路划分。',
        }),
        h('p', {
            html: '<b>模型上的简化：</b>每个「区」只画了一台服务器（真实世界每级都有多台，且是任播）；'
                + 'hosts 只做了精确匹配；负缓存只做在本地 DNS 这一级（真实的系统 stub resolver 也会缓存否定答案）；'
                + '浏览器 / 系统缓存只存最终的 A，不存 CNAME 链（这与 <code>getaddrinfo</code> 只返回地址的行为一致）。',
        })
    ));
}

const QA = [
    {
        q: 'DNS 为什么用 UDP？什么时候会用 TCP？',
        a: '<b>因为绝大多数查询一问一答就完事，用 TCP 太亏。</b>一次 TCP 要先三次握手（1 个 RTT）'
            + '再发查询（1 个 RTT），还要维护连接状态；而 DNS 响应通常几十到几百字节，'
            + 'UDP 一来一回就搞定，丢了直接重发，代价比握手低得多。服务器也不用为每个查询维护连接，'
            + '同样的硬件能扛高得多的 QPS。<br>'
            + '<b>会切到 TCP 的三种情况：</b>① 响应超过 512 字节（DNS 报文的传统上限），'
            + '服务器把 TC（Truncated）位置 1，客户端看到就用 TCP 重问一遍 —— 现在更常见的做法是先用 '
            + '<b>EDNS0</b> 把 UDP 缓冲区声明成 1232/4096 字节，实在还放不下才降级到 TCP；'
            + '② <b>区传送 AXFR / IXFR</b>（主从服务器同步整个区文件，数据量大且必须可靠），协议规定只能走 TCP；'
            + '③ DNSSEC 带签名后响应普遍变大，触发 TC 的概率高很多。<br>'
            + '面试补一句：UDP 无连接、易伪造源地址，这正是 <b>DNS 缓存投毒</b>和 <b>DNS 放大攻击</b>的根源。',
    },
    {
        q: 'DNS 劫持是怎么发生的？DoH / DoT 解决了什么，又没解决什么？',
        a: '<b>传统 DNS 是明文 UDP，没有任何认证</b>，所以路径上任何一方都能改：'
            + '运营商把你要的域名解析到自己的广告页；公共 WiFi 返回一个钓鱼站点；'
            + '攻击者抢在真答案之前伪造一个响应包（缓存投毒，Kaminsky 攻击就是这一类）。<br>'
            + '<b>DoT</b>（DNS over TLS，853 端口）和 <b>DoH</b>（DNS over HTTPS，443 端口）'
            + '把查询装进 TLS 里，解决了两件事：<b>不可窃听</b>（中间人看不到你在查什么）、'
            + '<b>不可篡改</b>（改了 TLS 会失败）。DoH 因为混在 443 的普通 HTTPS 流量里，还额外获得了<b>难以被单独封锁</b>的性质 —— '
            + '这也是它有争议的地方，企业和校园网的内网域名解析、家长控制、安全网关都会被它绕过。<br>'
            + '<b>没解决的：</b>① 你把信任从运营商转移给了 DoH 提供商（Cloudflare / Google），'
            + '它照样看得见你的全部查询，隐私是<b>转移</b>不是<b>消失</b>；'
            + '② 只保护「客户端 ↔ 本地 DNS」这一段，本地 DNS 再往上问根 / TLD / 权威那些迭代查询<b>依然是明文</b>；'
            + '③ 拿到 IP 之后 TLS 握手里的 SNI 仍然明文暴露你要访问哪个站（要靠 ECH 才能盖住）。'
            + '要保证「答案没被改」而不是「没被看见」，那是 <b>DNSSEC</b> 的活，和 DoH/DoT 是正交的两件事。',
    },
    {
        q: 'TTL 设多长合适？',
        a: '<b>这是「省解析时间」和「改起来多快」之间的取舍，没有普适答案，只有取舍口诀。</b><br>'
            + '设长（比如 1 小时～1 天）：缓存命中率高、解析快、权威服务器压力小、抗 DDoS 更好（缓存还在就还能访问）；'
            + '代价是<b>你想改 IP 的时候全世界要等这么久才跟上</b>。<br>'
            + '设短（30～60 秒）：切换快、故障转移灵敏；代价是查询量成倍上涨、首屏更容易吃到解析延迟、'
            + '权威服务器一挂影响面立刻扩大。<br>'
            + '<b>实操上最重要的一条：要改 IP，提前把 TTL 调小。</b>'
            + '比如原本 TTL 是 3600，你打算周六换机房，那就<b>至少提前一个 TTL 周期（这里是 1 小时，稳妥起见提前一天）</b>'
            + '把 TTL 改成 60；等旧 TTL 在全网自然过期后，所有缓存拿到的都是「60 秒版本」；'
            + '这时候再改 IP，一分钟内全网切完；切完观察稳定了，再把 TTL 调回去。'
            + '<b>顺序反了（先改 IP 再改 TTL）等于白改</b> —— 缓存里存的还是老 TTL 的老记录。<br>'
            + '另外别忘了：<b>你控制不了下游是否守规矩</b>。有些运营商 DNS 会强行拉长 TTL，'
            + '浏览器又会强行压短（Chrome 约 60 秒封顶），所以切流量永远要有 TTL 之外的兜底（双活、健康检查、客户端重试）。',
    },
    {
        q: '为什么根服务器只有 13 个？真的只有 13 台机器吗？',
        a: '<b>13 是「逻辑地址」的数量，不是机器数量。</b>根本原因是<b>早期 DNS 报文的 512 字节 UDP 上限</b>：'
            + '根提示（priming）响应要在一个不分片的 UDP 包里装下所有根服务器的名字和 IPv4 地址，'
            + '算下来最多塞得进 13 条，于是就定成了 a~m 共 13 个名字。<br>'
            + '<b>但实际机器有上千台。</b>靠的是 <b>任播（Anycast）</b>：'
            + '同一个 IP 在全球几百个位置同时被通告到 BGP 里，路由自然把你的包送到<b>网络上最近的那一台</b>。'
            + '所以「访问根服务器要跨洋」是个误解 —— 大部分地区都有本地根镜像，几毫秒就能到。<br>'
            + '再补两句能加分的：① 有了 EDNS0 之后 512 字节的限制早就不是问题了，'
            + '但 13 这个数字已经固化在所有解析器的根提示文件里，改动收益太小没人动；'
            + '② 现在还有 <b>RFC 8806（Local Root）</b>这种玩法 —— 直接把整个根区文件同步到本地解析器上，'
            + '根查询连出网都不用。加上长 TTL 的 NS 缓存和 QNAME minimisation，'
            + '<b>真正打到根的查询量比大多数人想的少得多</b>。',
    },
    {
        q: '递归查询和迭代查询到底怎么区分？',
        a: '<b>看的是「谁负责把这件事办完」，不是看跳数。</b><br>'
            + '<b>递归</b>：我把问题交给你，你必须给我最终答案或者错误，<b>不许把「你去问别人」甩回给我</b>。'
            + '发生在 <b>客户端（stub resolver）→ 本地 DNS</b> 这一段，报文里 RD 位 = 1。<br>'
            + '<b>迭代</b>：我问你，你只需要告诉我「下一步该问谁」就行，剩下的我自己跑。'
            + '发生在 <b>本地 DNS → 根 / TLD / 权威</b>，报文里 RD 位 = 0。<br>'
            + '所以一次完整解析里，<b>递归查询永远只有 1 次，迭代查询有 N 次</b>。'
            + '大量资料说「DNS 解析是递归的」或者干脆把两者混着讲，是最常见的一个错误。'
            + '追问点：根服务器<b>不提供</b>递归服务（RA 位为 0），你就算把 RD 置 1 它也只会回转介；'
            + '而一台配置错误、对全世界开放递归的服务器叫 <b>open resolver</b>，是 DNS 放大攻击的弹药库。',
    },
];

const PITFALLS = [
    ['以为根服务器会返回最终答案',
        '这是最普遍的误解。根<b>只知道 TLD 归谁管</b>，TLD <b>只知道二级域归谁管</b>，'
        + '它们返回的永远是 <b>referral</b>：一条 NS 记录（下一步问谁）+ 一条 glue A 记录（那台服务器的 IP）。'
        + '面试里如果你说「根服务器返回了 example.com 的 IP」，基本就挂了。'
        + '顺带记住 glue 为什么必须存在：<code>example.com</code> 的 NS 是 <code>ns1.example.com</code>，'
        + '它自己就在这个区里面，不给 IP 的话你得先解析 <code>example.com</code> 才能查它 —— 死循环。'],
    ['把 TTL 当成「一定 N 秒后失效」',
        'TTL 是<b>上限建议</b>，不是保证。往短了说：浏览器会自己压（Chrome 约 60 秒封顶），'
        + '连接池里已经建好的连接根本不重新解析；往长了说：一些运营商 DNS 会无视你的 TTL 强行拉长，'
        + '有些客户端、JVM（老版本 <code>networkaddress.cache.ttl</code> 默认永久缓存）会一直不刷新。'
        + '<b>所以切流量绝不能只依赖 TTL 到期</b>，一定要有双活 / 健康检查 / 客户端重试兜底。'
        + '还有个反直觉点：<b>下游缓存拿到的是剩余 TTL 不是原始 TTL</b>，缓存不会给记录续命。'],
    ['给根域名配 CNAME',
        '<code>example.com CNAME xxx.cdn.net</code> 是<b>非法</b>的。'
        + 'RFC 1034 规定 CNAME 不能和其它记录共存，而根域名必须有 NS（还常有 SOA / MX），直接冲突。'
        + '很多 DNS 服务商甚至会直接拒绝保存。要在根域名上用 CDN，只能用各家的私有类型 '
        + '<b>ALIAS / ANAME / CNAME Flattening</b> —— 它们在响应时由权威服务器自己解析目标、'
        + '<b>以 A 记录的形式</b>返回，绕开了共存限制。缺点是私有扩展、换服务商可能带不走，'
        + '而且解析结果是<b>权威服务器所在位置</b>算出来的就近节点，未必是你所在位置的最优点。'
        + '同理，<b>MX 的值也不能指向 CNAME</b>，这是另一个经常被踩的坑。'],
    ['忘了「不存在」也会被缓存',
        'NXDOMAIN 会被<b>负缓存</b>（RFC 2308），时长由响应里那条 SOA 的 MINIMUM 字段决定。'
        + '好处是拼错的域名不会反复穿透到根；<b>坑在于你刚加好的新域名可能几分钟内还是解析不了</b> —— '
        + '因为你在配置之前先访问过一次，「不存在」这个结论已经被缓存住了。'
        + '所以：<b>新域名先配好再第一次访问</b>；出问题时先本地 <code>ipconfig /flushdns</code>，'
        + '再用 <code>dig @8.8.8.8</code> 绕过本地 DNS 对比，能立刻分辨是你的缓存还是上游的问题。'],
    ['CNAME 链越接越长而没人管',
        '每多一层 CNAME 就多一整轮「根 → TLD → 权威」。'
        + '实际业务里「自家域名 → 云厂商 → CDN → 边缘调度」四层套下来很常见，'
        + '首屏白白多掉几十甚至上百毫秒。而且链上任意一环挂掉，整条链全废。'
        + '<b>链的有效 TTL 取链上最小值</b>，所以最里层一个 30 秒的 TTL 会把整条链拖成 30 秒刷新一次。'
        + '配错了还可能成环（A→B→A），靠解析器自己刹车返回错误 —— 这属于配置事故，别指望它自愈。'],
    ['把 open resolver 直接暴露到公网',
        '一台对全世界提供递归服务的 DNS 就是 <b>DNS 放大攻击</b>的弹药库：'
        + '攻击者伪造受害者的源 IP 发一个几十字节的查询，你替他把几千字节的响应打到受害者身上，'
        + '放大几十倍。自建 DNS 一定要限制递归服务的来源网段（ACL），'
        + '权威服务器则应当<b>完全关闭递归</b>（RA=0）—— 权威和递归混在一台上是典型的配置错误。'],
];

Viz.register({
    id: 'dns',
    cat: 'net',
    title: 'DNS 解析',
    subtitle: '递归 · 迭代 · 缓存 TTL',
    icon: 'fa-signs-post',
    blurb: '一次域名解析走了几跳，递归和迭代到底差在哪，缓存怎么把它压到 0.5ms',
    mount(container) {
        rootEl = h('div.fsrs-root');
        container.appendChild(rootEl);
        state.qname = 'www.example.com';
        state.client = 'sh';
        state.elapsed = 0;
        preset('cold');
    },
    unmount() {
        state.world = null;
        state.result = null;
        rootEl = null;
    },
});

})();
