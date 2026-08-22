// ============================================================
//  大模型档案的测试
//
//  盯的是四件「错了要么泄密、要么整个应用突然不能用」的事：
//    1. 明文 key 绝不出现在任何返回值里
//    2. 改配置时不传 key = 不动它（页面不回显明文，只改别名必须做得到）
//    3. 删掉正在用的那一套，自动退到别的，而不是让全站失去模型
//    4. 老库升上来时，旧的单套 settings 配置被原样迁成一条档案
// ============================================================

import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';

import { getSetting, initSchema, setSetting, useDatabase } from './db.js';
import {
    LlmModelError, activeModel, createModel, deleteModel, listModels, normUrl,
    setActive, shapeRequestBody, updateModel,
} from './llm-models.js';

const KEY_A = 'sk-aaaaaaaaaaaaaaaaaaaa1111';
const KEY_B = 'sk-bbbbbbbbbbbbbbbbbbbb2222';

beforeEach(() => {
    const conn = new Database(':memory:');
    initSchema(conn);
    useDatabase(conn);
});

function addA() {
    return createModel({ alias: '便宜的那个', model: 'deepseek-chat', baseUrl: 'https://api.deepseek.com/v1', apiKey: KEY_A });
}
function addB() {
    return createModel({ alias: '写代码用', model: 'gpt-4o-mini', baseUrl: 'https://api.openai.com/v1', apiKey: KEY_B });
}

describe('别名与模型名是两个字段', () => {
    it('列表上显示别名，发请求用模型名，两个都留着', () => {
        const m = addA();
        expect(m.alias).toBe('便宜的那个');
        expect(m.model).toBe('deepseek-chat');
        expect(activeModel()?.model).toBe('deepseek-chat');
    });

    it('别名留空就拿模型名顶上 —— 列表里不该出现一行没名字的', () => {
        const m = createModel({ alias: '  ', model: 'qwen-plus', baseUrl: 'https://x.test/v1', apiKey: KEY_A });
        expect(m.alias).toBe('qwen-plus');
    });

    it('别名被改空了同样退回模型名', () => {
        const m = addA();
        expect(updateModel(m.id, { alias: '' })?.alias).toBe('deepseek-chat');
    });

    it('模型名和地址是必填，地址还得是 http(s)', () => {
        expect(() => createModel({ model: '', baseUrl: 'https://x.test/v1' })).toThrow(LlmModelError);
        expect(() => createModel({ model: 'm', baseUrl: '' })).toThrow(LlmModelError);
        expect(() => createModel({ model: 'm', baseUrl: 'api.x.test/v1' })).toThrow(/http/);
    });

    it('地址末尾的斜杠被抹掉，免得拼出 //chat/completions', () => {
        const m = createModel({ model: 'm', baseUrl: 'https://x.test/v1///', apiKey: KEY_A });
        expect(m.baseUrl).toBe('https://x.test/v1');
    });
});

describe('明文 key 只进不出', () => {
    it('列表与单条都只给打码后的样子', () => {
        addA();
        const [m] = listModels();
        expect(m.keyHint).not.toContain(KEY_A);
        expect(m.keyHint.startsWith('sk-a')).toBe(true);
        expect(m.keyHint.endsWith('1111')).toBe(true);
        expect(m.hasKey).toBe(true);
        expect(JSON.stringify(listModels())).not.toContain(KEY_A);
    });

    it('短 key 整条打码，不泄露长度以外的任何信息', () => {
        createModel({ model: 'm', baseUrl: 'https://x.test/v1', apiKey: 'short' });
        expect(listModels()[0].keyHint).toBe('•••••');
    });

    it('没填 key 的档案标出来 —— 选中它会连不上，得让人一眼看见', () => {
        createModel({ model: 'm', baseUrl: 'https://x.test/v1' });
        expect(listModels()[0].hasKey).toBe(false);
        expect(listModels()[0].keyHint).toBe('');
    });

    it('只有内部取配置那条路拿得到明文', () => {
        addA();
        expect(activeModel()?.apiKey).toBe(KEY_A);
    });
});

describe('改配置', () => {
    it('不传 apiKey = 不动原来那把（只改别名必须做得到）', () => {
        const m = addA();
        updateModel(m.id, { alias: '换个名字' });
        expect(activeModel()?.apiKey).toBe(KEY_A);
        expect(listModels()[0].alias).toBe('换个名字');
    });

    it('传了空串 = 明确要清掉', () => {
        const m = addA();
        updateModel(m.id, { apiKey: '' });
        expect(activeModel()?.apiKey).toBe('');
        expect(listModels()[0].hasKey).toBe(false);
    });

    it('改不存在的那一条返回 null，不是抛错', () => {
        expect(updateModel(999, { alias: 'x' })).toBeNull();
    });
});

describe('选用哪一套', () => {
    it('头一套自动选中 —— 填完就能用，不用再点一下', () => {
        const a = addA();
        expect(listModels().find((m) => m.active)?.id).toBe(a.id);
    });

    it('后加的不会抢走选中状态', () => {
        const a = addA();
        addB();
        expect(activeModel()?.id).toBe(a.id);
    });

    it('切过去之后 activeModel 跟着换', () => {
        addA();
        const b = addB();
        expect(setActive(b.id)).toBe(true);
        expect(activeModel()?.model).toBe('gpt-4o-mini');
        expect(activeModel()?.apiKey).toBe(KEY_B);
    });

    it('切到不存在的 id 返回 false，当前选择不受影响', () => {
        const a = addA();
        expect(setActive(999)).toBe(false);
        expect(activeModel()?.id).toBe(a.id);
    });

    it('删掉正在用的那一套，自动退到还剩下的 —— 不能让全站失去模型', () => {
        const a = addA();
        const b = addB();
        setActive(b.id);

        expect(deleteModel(b.id)).toBe(true);
        expect(activeModel()?.id).toBe(a.id);
        expect(activeModel()?.apiKey).toBe(KEY_A);
    });

    it('删光了就是 null，由调用方去走环境变量兜底', () => {
        const a = addA();
        deleteModel(a.id);
        expect(activeModel()).toBeNull();
    });
});

describe('老库迁移', () => {
    it('旧的单套 settings 配置被搬成一条档案并选中', () => {
        setSetting('llm_base_url', 'https://api.deepseek.com/v1');
        setSetting('llm_model', 'deepseek-reasoner');
        setSetting('llm_api_key', KEY_A);

        const list = listModels();
        expect(list).toHaveLength(1);
        expect(list[0].model).toBe('deepseek-reasoner');
        expect(list[0].active).toBe(true);
        expect(activeModel()?.apiKey).toBe(KEY_A);
    });

    it('只搬一次 —— 反复读不会越搬越多', () => {
        setSetting('llm_api_key', KEY_A);
        listModels(); listModels(); activeModel();
        expect(listModels()).toHaveLength(1);
    });

    it('key 在环境变量里的不搬 —— 那些人特意不想让它落库', () => {
        setSetting('llm_base_url', 'https://api.deepseek.com/v1');
        expect(listModels()).toHaveLength(0);
        expect(getSetting('llm_active_model_id')).toBeFalsy();
    });

    it('已经自己建过档案就不再迁移', () => {
        addA();
        setSetting('llm_api_key', KEY_B);
        expect(listModels()).toHaveLength(1);
        expect(activeModel()?.apiKey).toBe(KEY_A);
    });
});

// ============================================================
//  接口地址的收拾 + 推理模型的请求体整形
//
//  两条都是「用户照着官方文档复制粘贴，然后撞上一个看不懂的报错」：
//    · OpenAI 文档给的是完整的 /v1/chat/completions，我们又要自己接一段，
//      拼出来 /v1/chat/completions/chat/completions → 404
//    · gpt-5.x / o 系列不认 max_tokens、也不让改 temperature → 400
// ============================================================

describe('normUrl：两种写法都收', () => {
    it('短形式原样留着', () => {
        expect(normUrl('https://api.deepseek.com/v1')).toBe('https://api.deepseek.com/v1');
    });

    it('照抄 OpenAI 文档的完整路径要把末尾剥掉', () => {
        expect(normUrl('https://api.openai.com/v1/chat/completions'))
            .toBe('https://api.openai.com/v1');
    });

    it('带尾斜杠的完整路径也要剥干净', () => {
        expect(normUrl('https://api.openai.com/v1/chat/completions/'))
            .toBe('https://api.openai.com/v1');
    });

    it('只删了一半（剩 /completions）的也认', () => {
        expect(normUrl('https://api.openai.com/v1/completions'))
            .toBe('https://api.openai.com/v1');
    });

    it('两头空白和多余斜杠一起收拾', () => {
        expect(normUrl('  https://api.moonshot.cn/v1///  ')).toBe('https://api.moonshot.cn/v1');
    });

    it('不误伤路径里正常的段', () => {
        // 通义那个兼容模式路径中间就有 compatible-mode，不能被当成要剥的东西
        expect(normUrl('https://dashscope.aliyuncs.com/compatible-mode/v1'))
            .toBe('https://dashscope.aliyuncs.com/compatible-mode/v1');
    });
});

describe('shapeRequestBody：推理模型的请求体', () => {
    const base = { model: 'x', messages: [], max_tokens: 800, temperature: 0.7, stream: false };

    it('普通模型一个字都不改', () => {
        const out = shapeRequestBody('deepseek-chat', { ...base, model: 'deepseek-chat' });
        expect(out.max_tokens).toBe(800);
        expect(out.temperature).toBe(0.7);
    });

    it('gpt-5.x：max_tokens 换名，temperature 整个丢掉', () => {
        const out = shapeRequestBody('gpt-5.6-sol', { ...base, model: 'gpt-5.6-sol' });
        expect(out.max_completion_tokens).toBe(800);
        expect(out).not.toHaveProperty('max_tokens');
        expect(out).not.toHaveProperty('temperature');
        // 别的字段不能顺手弄丢
        expect(out.stream).toBe(false);
        expect(out.model).toBe('gpt-5.6-sol');
    });

    it('o 系列同样处理', () => {
        for (const m of ['o1', 'o3-mini', 'o4-preview']) {
            const out = shapeRequestBody(m, { ...base, model: m });
            expect(out).not.toHaveProperty('temperature');
            expect(out.max_completion_tokens).toBe(800);
        }
    });

    it('带供应商前缀的转发名也认得出来', () => {
        const out = shapeRequestBody('openai/gpt-5.6-sol', { ...base, model: 'openai/gpt-5.6-sol' });
        expect(out.max_completion_tokens).toBe(800);
        expect(out).not.toHaveProperty('temperature');
    });

    it('名字里碰巧含 o1 的普通模型不受影响', () => {
        // 「以 o + 数字开头」才算，不是「含有」—— 否则 qwen-o1-ish 这类会被误判
        const out = shapeRequestBody('some-o1-model', { ...base, model: 'some-o1-model' });
        expect(out.temperature).toBe(0.7);
        expect(out.max_tokens).toBe(800);
    });
});
