// 免费素材：纯外链，数据在 lib/site-data.ts 的 assetSites。
//
// 分三类是按「做东西时缺的是什么」分的：缺形状去模型，缺表面去材质，缺声音去音频。
// 三类互不重叠，所以不做筛选器 —— 你打开这一页时已经知道自己缺哪一样了。
//
// 这一页最该先看清的那件事跟别的外链页都不同：不是「要不要钱」也不是
// 「要不要账号」，而是**这份素材能不能跟着我的成品一起发出去**。
// 素材是打包进交付物的，署名义务和再分发禁令都会在交付之后才咬人，
// 那时候已经改不动了。所以收录标准把这两条设成硬门槛（见 site-data 的说明），
// 页面顶上也先把这件事讲明白，再列站点。
//
// 「免注册」不给每条都挂标签，只标那唯一一条要注册的（account: true）——
// 十二条里十一条都挂「免注册」的话，剩下那条最需要被看见的反而淹掉了。

import { useEffect } from 'react';
import AppShell from '@/components/AppShell';
import { assetSites, type AssetSite } from '@/lib/site-data';

/**
 * 三档授权各自的说法与图标。三档都允许商用与再分发，差别只在细则多少。
 *
 * oss 那一档管的东西跟前两档不同：前两档说的是「这份素材的版权」，
 * oss 说的是「生成这份素材的**模型**的许可」—— 产物本身归你。
 * 之所以要分开写，是因为把 MIT 显示成「站点自有授权」是错的。
 */
const LICENSE: Record<AssetSite['license'], { label: string; icon: string }> = {
    cc0: { label: '公共领域', icon: 'fa-unlock' },
    permissive: { label: '站点自有授权', icon: 'fa-shield-halved' },
    oss: { label: '开源许可', icon: 'fa-code' },
};

export default function AssetsPage() {
    useEffect(() => { document.title = '免费素材 · 工具箱'; }, []);

    const models = assetSites.filter((a) => a.cat === 'model');
    const textures = assetSites.filter((a) => a.cat === 'texture');
    const audio = assetSites.filter((a) => a.cat === 'audio');
    const generators = assetSites.filter((a) => a.cat === 'generate');

    const cc0 = assetSites.filter((a) => a.license === 'cc0').length;
    const needAccount = assetSites.filter((a) => a.account).length;
    // 取最新那一条的核验日期，不是第一条 —— 后加的条目会带更新的日期
    const lastVerified = assetSites.reduce((a, s) => (s.verified > a ? s.verified : a), '');

    return (
        <AppShell title="免费素材" subtitle="Free Asset Libraries · 能随成品一起发出去的那些">
            <p className="u-aside">
                <i className="fas fa-circle-info" />
                这一页的收录标准比站里其他外链更严，多两条硬门槛：<b>不要求署名</b>、
                <b>允许随你的项目一起分发</b>。素材跟工具不一样 —— 工具你自己用完就算了，
                素材是要打包进成品发出去的，这两条一旦踩了，代价出现在交付之后，那时候已经改不动了。
                共 {assetSites.length} 条，其中 {cc0} 条是 CC0（公共领域，等于没有著作权）；
                {needAccount === 0 ? '全部免注册' : `只有 ${needAccount} 条要注册，已标出来`}。
                最近一次逐条打开核实 {lastVerified}。
            </p>

            <div className="u-head">
                <h2><i className="fas fa-cube" /> 3D 模型</h2>
                <span className="count u-num">{models.length} 个</span>
            </div>
            <p className="u-note">
                四家分工不重叠：<b>Poly Haven 写实</b>，另外三家都是低模但风格各不相同 ——
                Kenney 方正、Quaternius 圆润、KayKit 卡通且带成套人形动画。
                做原型或小游戏，先从低模那三家里挑一家<b>从头用到尾</b>，
                混着用最容易做出一个风格打架的场景。
            </p>
            <AssetList items={models} />

            <div className="u-head">
                <h2><i className="fas fa-layer-group" /> 材质 · 贴图 · HDRI</h2>
                <span className="count u-num">{textures.length} 个</span>
            </div>
            <p className="u-note">
                前两条覆盖日常的九成：<b>要材质去 ambientCG，要环境光去 Poly Haven</b>。
                3DTextures 是前者不够用时的补充。Texture Ninja 是另一回事 ——
                它给的是<b>实拍照片而不是做好的贴图</b>，拿来做旧、做脏、或者自己加工成材质。
            </p>
            <AssetList items={textures} />

            <div className="u-head">
                <h2><i className="fas fa-volume-high" /> 音效 · 音乐</h2>
                <span className="count u-num">{audio.length} 个</span>
            </div>
            <p className="u-note">
                前三家是挑好的，<b>点开就能用</b>：界面反馈音去 Kenney，成段 BGM 去 Mixkit，
                别的先搜 Pixabay。Freesound 排在最后是因为它要注册、还得自己筛授权 ——
                但真要找某个冷门具体的声音，只有它有。
            </p>
            <AssetList items={audio} />

            {generators.length > 0 && (
                <>
                    <div className="u-head">
                        <h2><i className="fas fa-wand-magic-sparkles" /> 图生 3D</h2>
                        <span className="count u-num">{generators.length} 个</span>
                    </div>
                    <p className="u-note">
                        跟上面三节是<b>两种动作</b>：那些你去翻、去挑，挑到的是别人做好的东西；
                        这一节是<b>喂一张图进去、等它算出一个网格</b>。
                        上面翻不到你要的那个小物件时走这条路 —— 质量到不了精修素材那一档，
                        做占位、做原型、做背景里的杂物够用。
                    </p>
                    <AssetList items={generators} />
                </>
            )}

            <p className="u-note">
                <i className="fas fa-triangle-exclamation" />{' '}
                <b>没收进来的那些，多半是故意的。</b>Poly Pizza（默认 CC-BY 要署名）、
                Sketchfab（结果里混着禁商用的 CC-BY-NC）、Mixamo（Adobe 账号墙）、
                Textures.com 与 HDRI Skies（条款禁止随项目再分发）、
                Zapsplat 与 Incompetech（免费档必须署名）都逐条核实过，
                因为踩了上面那两条硬门槛才没列 —— 不是漏了。理由记在
                <code>src/client/lib/site-data.ts</code> 的注释里。
            </p>
            <p className="u-note">
                <i className="fas fa-earth-europe" />{' '}
                <b>图生 3D 那一节为什么没收更热门的腾讯混元</b>：Hunyuan3D 2.1 是
                HuggingFace 上赞数最高的一个，但它的许可证第一行就写着
                <b>不适用于欧盟、英国和韩国</b>，而且条款把<b>生成出来的产物</b>也一并
                圈进了地域限制（原文 “must not use… Output or results… outside the Territory”）。
                也就是说人在英国的话，连它生成的模型都是没授权的 —— 不是模型跑不跑得动的问题。
                TRELLIS 的 MIT 没有这一层。
            </p>
            <p className="u-note">
                <i className="fas fa-circle-info" />{' '}
                <b>CC0 也不是万能的。</b>素材本身放弃了著作权，但它<b>画的东西</b>可能另有权利：
                商标、logo、可识别的人脸、受保护的建筑外观，这些不因为素材是 CC0 就能随便用在商业项目上。
                翻到看着像某个真实品牌或真人的素材时，多想一步。
            </p>
        </AppShell>
    );
}

function AssetList({ items }: { items: AssetSite[] }) {
    if (items.length === 0) return <p className="u-empty">这一组暂时是空的。</p>;

    return (
        <ul className="link-list">
            {items.map((a) => {
                const lic = LICENSE[a.license];
                return (
                    <li key={a.href}>
                        <a className="link-row" href={a.href} target="_blank" rel="noopener noreferrer">
                            <span className="link-icon"><i className={'fas ' + a.icon} /></span>

                            <span className="link-main">
                                <span className="link-titles">
                                    <b>{a.title}</b>
                                    <em>{a.en}</em>
                                </span>

                                <span className="link-desc">{a.desc}</span>

                                {/* 注意事项排在描述之后、标签之前：它是「决定怎么用」的信息，
                                    不像编程比赛的停办提示那样决定「要不要往下读」 */}
                                {a.caveat && (
                                    <span className="asset-caveat">
                                        <i className="fas fa-circle-exclamation" />
                                        {a.caveat}
                                    </span>
                                )}

                                <span className="link-meta">
                                    {/* 授权用 is-safe（强调色）—— 这一页每一条的授权都是过关的，
                                        绿灯是如实反映，不是装饰 */}
                                    <span className="link-host is-safe">
                                        <i className={'fas ' + lic.icon} />
                                        {a.licenseLabel} · {lic.label}
                                    </span>
                                    {a.account && (
                                        <span className="link-host">
                                            <i className="fas fa-user-lock" />
                                            要注册账号
                                        </span>
                                    )}
                                    {a.badges.map((b) => <span key={b} className="tool-badge">{b}</span>)}
                                    <span className="tool-badge">{a.verified} 核验</span>
                                </span>
                            </span>

                            <span className="link-go" aria-hidden="true">
                                <i className="fas fa-arrow-up-right-from-square" />
                            </span>
                        </a>
                    </li>
                );
            })}
        </ul>
    );
}
