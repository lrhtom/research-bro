// ============================================================
//  演示：TLS 握手（1.2 与 1.3 对照）
//  HTTPS 比 HTTP 多的就是中间这一层。重点讲清三件事：
//  非对称加密只用来「换钥匙」、证书用来「验身份」、真正传数据用对称加密。
// ============================================================

(function () {

// ---------- 一、剧本（纯数据）----------

const TLS = {};

TLS.FLOWS = {
    v12: {
        name: 'TLS 1.2',
        rtt: 2,
        desc: '经典流程，需要 <b>2 个 RTT</b> 才能开始传数据（再加上底下 TCP 三次握手的 1 RTT）。',
        steps: [
            {
                from: 'c', msg: 'ClientHello',
                detail: '支持的 TLS 版本 / 密码套件列表 / 客户端随机数 Random_C',
                note: '客户端把「我支持哪些加密算法」和一个随机数摊开给服务端。此时<b>全是明文</b>。',
                kind: 'plain',
            },
            {
                from: 's', msg: 'ServerHello',
                detail: '选定的密码套件 / 服务端随机数 Random_S',
                note: '服务端从列表里挑一套双方都支持的算法，并给出自己的随机数。',
                kind: 'plain',
            },
            {
                from: 's', msg: 'Certificate',
                detail: '服务端证书链（含公钥）',
                note: '把证书发过来。<b>证书的作用是证明「这个公钥确实属于这个域名」</b>，而不是用来加密数据的。',
                kind: 'cert',
            },
            {
                from: 's', msg: 'ServerKeyExchange + ServerHelloDone',
                detail: 'ECDHE 参数 + 用私钥对参数的签名',
                note: '如果用 ECDHE（现在的主流），服务端在这里发出密钥交换参数，'
                    + '并<b>用私钥签名</b>证明这些参数确实是它发的（防中间人替换）。',
                kind: 'asym',
            },
            {
                from: 'c', msg: '（客户端验证证书）',
                detail: '检查签发 CA / 有效期 / 域名匹配 / 是否被吊销',
                note: '客户端顺着证书链一级级验到本地信任的<b>根 CA</b>。验不过就是那个红色警告页。',
                kind: 'verify', local: true,
            },
            {
                from: 'c', msg: 'ClientKeyExchange',
                detail: '客户端的 ECDHE 参数',
                note: '双方各自用「自己的私有参数 + 对方的公开参数」算出<b>同一个预主密钥</b>，'
                    + '而这个值从来没有在网络上传输过。',
                kind: 'asym',
            },
            {
                from: 'c', msg: '（生成会话密钥）',
                detail: 'MasterSecret = PRF(预主密钥, Random_C, Random_S)',
                note: '两个随机数在这里派上用场：保证即使复用同一组密钥参数，每次会话的密钥也不同。',
                kind: 'derive', local: true,
            },
            {
                from: 'c', msg: 'ChangeCipherSpec + Finished',
                detail: '之后的报文都用对称密钥加密',
                note: 'Finished 里是<b>前面所有握手消息的哈希</b>，用新密钥加密发出 —— '
                    + '一旦中间有人篡改过任何一条握手消息，这里就对不上。',
                kind: 'sym',
            },
            {
                from: 's', msg: 'ChangeCipherSpec + Finished',
                detail: '服务端同样确认',
                note: '双方校验通过，握手完成。',
                kind: 'sym',
            },
            {
                from: 'both', msg: '开始传输应用数据',
                detail: '全部用对称加密（AES-GCM / ChaCha20-Poly1305）',
                note: '<b>从这里开始，非对称加密就退场了</b>，因为它太慢，只适合用来安全地交换那把对称密钥。',
                kind: 'data',
            },
        ],
    },
    v13: {
        name: 'TLS 1.3',
        rtt: 1,
        desc: '大幅精简，只要 <b>1 个 RTT</b>；重连时还能 <b>0-RTT</b>。HTTP/3 直接内置了它。',
        steps: [
            {
                from: 'c', msg: 'ClientHello',
                detail: '版本 / 密码套件 / Random_C + <b>直接带上 ECDHE 公钥参数</b>',
                note: '关键改动：客户端<b>赌</b>服务端会选哪套算法，第一条消息就把密钥参数一起发了，省掉一个来回。',
                kind: 'plain',
            },
            {
                from: 's', msg: 'ServerHello + 证书 + Finished',
                detail: 'Random_S + 服务端 ECDHE 参数，之后的部分已经加密',
                note: '服务端一次性把该给的全给了。<b>从证书开始的内容就已经是加密的了</b> —— '
                    + '1.2 里证书是明文，能被中间设备看到你在访问哪个站点。',
                kind: 'asym',
            },
            {
                from: 'c', msg: '（验证证书 + 生成会话密钥）',
                detail: '验证书链 + 用 HKDF 派生密钥',
                note: '客户端此时已经能算出会话密钥了。',
                kind: 'verify', local: true,
            },
            {
                from: 'c', msg: 'Finished + 应用数据',
                detail: '握手确认与第一批数据一起发出',
                note: '<b>1 个 RTT 就开始传数据。</b>',
                kind: 'data',
            },
            {
                from: 'c', msg: '（下次重连：0-RTT）',
                detail: '用上次会话的 PSK，第一个包就带应用数据',
                note: '代价是 0-RTT 数据<b>无法防重放攻击</b>，所以只能用于幂等请求（比如 GET）。',
                kind: 'data', optional: true,
            },
        ],
    },
};

TLS.KINDS = {
    plain: { label: '明文', color: '#9ca3af' },
    cert: { label: '证书', color: '#f59e0b' },
    asym: { label: '非对称', color: '#a855f7' },
    verify: { label: '本地校验', color: '#6b7280' },
    derive: { label: '派生密钥', color: '#6b7280' },
    sym: { label: '对称加密', color: '#10b981' },
    data: { label: '应用数据', color: '#4f46e5' },
};

if (typeof module !== 'undefined' && module.exports) module.exports = TLS;
if (typeof window !== 'undefined') window.TLSModel = TLS;

// ---------- 二、界面 ----------

if (typeof window === 'undefined' || !window.Viz) return;

const h = Viz.h, svg = Viz.svg, T = Viz.text;
const state = { ver: 'v12', step: 0 };

function flow() { return TLS.FLOWS[state.ver]; }

function buildSeq() {
    const st = flow().steps;
    const W = 800, ROW = 56, PT = 58, PB = 20;
    const H = PT + st.length * ROW + PB;
    const CX = 150, SX = 650;

    const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'seq-svg', preserveAspectRatio: 'xMidYMid meet' });

    const defs = svg('defs');
    const mk = svg('marker', { id: 'tlsArrow', viewBox: '0 0 10 10', refX: '9', refY: '5',
        markerWidth: '7', markerHeight: '7', orient: 'auto-start-reverse' });
    mk.appendChild(svg('path', { d: 'M0 0L10 5L0 10z', fill: '#6b7280' }));
    defs.appendChild(mk);
    root.appendChild(defs);

    const head = (x, label, sub) => {
        root.appendChild(svg('rect', { x: x - 78, y: 10, width: 156, height: 34, rx: 8, class: 'seq-actor' }));
        root.appendChild(T({ x, y: 26, 'text-anchor': 'middle', class: 'seq-actor-name' }, label));
        root.appendChild(T({ x, y: 38, 'text-anchor': 'middle', class: 'seq-actor-sub' }, sub));
    };
    head(CX, '浏览器', 'Client');
    head(SX, '服务器', 'Server');

    [CX, SX].forEach((x) => root.appendChild(svg('line', { x1: x, x2: x, y1: 44, y2: H - PB, class: 'seq-life' })));

    st.forEach((s, i) => {
        const y = PT + i * ROW;
        const g = svg('g', { opacity: i <= state.step ? 1 : 0.15 });
        const kind = TLS.KINDS[s.kind] || TLS.KINDS.plain;

        if (s.local) {
            // 自己算，不发消息：画一个贴在生命线上的方块
            const x = s.from === 'c' ? CX : SX;
            g.appendChild(svg('rect', { x: x - 12, y: y - 13, width: 24, height: 26, rx: 4, class: 'tls-self' }));
            g.appendChild(T({ x: x + 22, y: y - 1, class: 'seq-msg' }, s.msg));
            g.appendChild(T({ x: x + 22, y: y + 13, class: 'seq-detail' }, s.detail.replace(/<[^>]+>/g, '')));
        } else if (s.from === 'both') {
            g.appendChild(svg('rect', { x: CX, y: y - 13, width: SX - CX, height: 26, rx: 6, fill: kind.color, opacity: 0.14 }));
            g.appendChild(T({ x: (CX + SX) / 2, y: y - 1, 'text-anchor': 'middle', class: 'seq-msg' }, s.msg));
            g.appendChild(T({ x: (CX + SX) / 2, y: y + 13, 'text-anchor': 'middle', class: 'seq-detail' }, s.detail));
        } else {
            const x1 = s.from === 'c' ? CX : SX;
            const x2 = s.from === 'c' ? SX : CX;
            const dir = x2 > x1 ? 1 : -1;
            g.appendChild(svg('line', {
                x1: x1 + dir * 16, y1: y, x2: x2 - dir * 16, y2: y,
                stroke: kind.color, 'stroke-width': 2, 'marker-end': 'url(#tlsArrow)',
                'stroke-dasharray': s.optional ? '5 4' : '',
            }));
            g.appendChild(T({ x: (x1 + x2) / 2, y: y - 8, 'text-anchor': 'middle', class: 'seq-msg' }, s.msg));
            g.appendChild(T({ x: (x1 + x2) / 2, y: y + 14, 'text-anchor': 'middle', class: 'seq-detail' },
                s.detail.replace(/<[^>]+>/g, '')));
        }

        // 左侧的加密性质标签
        g.appendChild(svg('rect', { x: 2, y: y - 9, width: 52, height: 18, rx: 4, fill: kind.color, opacity: 0.18 }));
        g.appendChild(T({ x: 28, y: y + 4, 'text-anchor': 'middle', class: 'tls-kind', fill: kind.color }, kind.label));
        root.appendChild(g);
    });

    return root;
}

let rootEl = null;

function render() {
    if (!rootEl) return;
    rootEl.innerHTML = '';
    const f = flow();
    const st = f.steps;
    const cur = st[Math.min(state.step, st.length - 1)];

    rootEl.appendChild(Viz.card('fa-lock', 'HTTPS 比 HTTP 多了什么',
        '就多了中间这一层。<b>先 TCP 三次握手，再 TLS 握手，最后才跑 HTTP</b> —— '
        + '这也是为什么 HTTPS 首次建连比 HTTP 慢。',
        h('div.tls-stack', null,
            h('div.tls-layer.l-http', { text: 'HTTP　（明文的请求与响应，原封不动）' }),
            h('div.tls-arrow', { text: '▼' }),
            h('div.tls-layer.l-tls', { text: 'TLS　（加密、验身份、防篡改 —— 新增的就是这层）' }),
            h('div.tls-arrow', { text: '▼' }),
            h('div.tls-layer.l-tcp', { text: 'TCP　（三次握手，可靠传输）' })
        )
    ));

    rootEl.appendChild(Viz.card('fa-code-compare', '选一个版本',
        f.desc,
        Viz.segmented({
            value: state.ver,
            options: [{ v: 'v12', label: 'TLS 1.2（经典，2-RTT）' }, { v: 'v13', label: 'TLS 1.3（现行，1-RTT）' }],
            onPick: (v) => { state.ver = v; state.step = 0; render(); },
        })
    ));

    const nav = h('div.seq-nav', null,
        h('button.mini', { onclick: () => { state.step = Math.max(0, state.step - 1); render(); } }, '← 上一步'),
        h('span.seq-progress', { text: `${state.step + 1} / ${st.length}` }),
        h('button.mini.primary', { onclick: () => { state.step = Math.min(st.length - 1, state.step + 1); render(); } }, '下一步 →'),
        h('button.mini', { onclick: () => { state.step = st.length - 1; render(); } }, '全部展开'),
        h('button.mini', { onclick: () => { state.step = 0; render(); } }, '重来')
    );

    rootEl.appendChild(Viz.card('fa-timeline', '握手全过程',
        '左边的小标签标出<b>这一步是明文还是加密、用的对称还是非对称</b> —— 面试追问基本就在这条线上。',
        buildSeq(), nav,
        h('div.seq-note', { html: '<b>第 ' + (state.step + 1) + ' 步：</b>' + cur.note })
    ));

    rootEl.appendChild(Viz.card('fa-key', '为什么要「对称 + 非对称」混着用',
        '这是 TLS 设计的核心，也是最常被追问的一题。',
        Viz.cmpGrid([
            { h: '非对称（RSA / ECDHE）', v: '慢', d: '只用来安全地交换密钥', cls: 'cmp-bad' },
            { h: '对称（AES-GCM）', v: '快', d: '用来加密真正的数据', cls: 'cmp-ok' },
            { h: '性能差距', v: '百倍量级', d: '所以必须混用', cls: 'cmp-save' },
        ]),
        h('p.sec-note', {
            html: '非对称加密解决的是<b>「在不安全的信道上，怎么让双方拥有同一把密钥」</b>这个鸡生蛋问题；'
                + '一旦密钥就位，它就功成身退，后面全用快得多的对称加密。'
                + '这套「用非对称换对称密钥」的做法叫<b>混合加密</b>。',
        })
    ));

    rootEl.appendChild(Viz.card('fa-certificate', '证书与 CA：解决「公钥是谁的」',
        '加密不等于安全 —— 如果中间人把服务端公钥换成自己的，你加密得再好也是加密给中间人看。'
        + '证书就是用来堵这个洞的。',
        Viz.flowList([
            { t: '① 证书里有什么', f: '域名 + 公钥 + 有效期 + 签发者\n+ CA 用自己私钥对以上内容的签名',
                r: '本质是「CA 担保：这个公钥属于这个域名」' },
            { t: '② 怎么验', f: '用 CA 的公钥去验签名\n→ CA 的公钥又在上一级证书里\n→ 一直验到操作系统/浏览器内置的根证书',
                r: '这条链叫证书链，根 CA 是信任的终点（预装在系统里）',
                hi: '所以<b>自签名证书会报警告</b>：它的签发者不在系统的信任列表里，没有人为它担保。' },
            { t: '③ 还要查什么', f: '域名是否匹配 / 是否过期 / 是否被吊销（CRL、OCSP）',
                r: '任何一条不过，浏览器就弹那个红色警告页' },
        ])
    ));

    rootEl.appendChild(Viz.card('fa-comments', '面试这么答', null, Viz.qa([
        { q: 'RSA 和 ECC 有什么区别？该选哪个？',
            a: '<b>RSA</b> 基于大整数分解，成熟兼容性好，但同等安全强度下密钥长得多（2048 位 RSA ≈ 224 位 ECC）。'
                + '<b>ECC</b>（椭圆曲线）密钥短、计算快、握手包更小，移动端优势明显，现在是首选。'
                + '注意 <code>ECDHE</code> 里的 E 是 Ephemeral（临时），每次握手换一组，这是前向安全的关键。' },
        { q: '什么是前向安全（Forward Secrecy）？',
            a: '即使服务器私钥<b>将来</b>泄露，攻击者也无法解密<b>之前</b>录下的流量。'
                + '因为会话密钥是由每次握手临时生成的 ECDHE 参数算出来的，私钥只用于签名（证明身份），不参与算密钥。'
                + '而老的 RSA 密钥交换没有这个性质 —— 私钥一泄露，历史流量全裸。TLS 1.3 干脆<b>只保留了 ECDHE</b>。' },
        { q: '两个随机数（Random_C / Random_S）有什么用？',
            a: '保证每次会话的密钥都不同，防重放。即使密钥交换参数被复用，混入不同随机数后派生出的会话密钥仍然不同。' },
        { q: 'HTTPS 一定安全吗？',
            a: '不一定。它保证<b>传输过程</b>不被窃听篡改、且对方身份可验证，但不保证服务端本身可信'
                + '（钓鱼网站也能申请到合法证书）。另外如果客户端信任了恶意根证书（企业代理、被安装了中间人证书），'
                + '流量依然可以被解密 —— 这就是抓包工具 Charles / Fiddler 的原理。' },
    ])));
}

Viz.register({
    id: 'tls-handshake',
    cat: 'net',
    title: 'TLS 握手',
    subtitle: 'HTTPS 比 HTTP 多的那一层',
    icon: 'fa-lock',
    blurb: '对称与非对称怎么配合，证书链怎么验到根 CA',
    mount(container) {
        rootEl = h('div.fsrs-root');
        container.appendChild(rootEl);
        state.ver = 'v12'; state.step = 0;
        render();
    },
    unmount() { rootEl = null; },
});

})();
