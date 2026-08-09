// 单张卡片的编辑器：正面纯文本，背面 Markdown，右边实时预览。

import { useState } from 'react';
import Markdown from '@/components/cards/Markdown';

interface Props {
    initialFront?: string;
    initialBack?: string;
    onSave: (front: string, back: string) => void;
    onCancel: () => void;
}

export default function CardEditor({ initialFront = '', initialBack = '', onSave, onCancel }: Props) {
    const [front, setFront] = useState(initialFront);
    const [back, setBack] = useState(initialBack);

    return (
        <div className="fc-card-editor">
            <label>
                <span>正面（问题）</span>
                <textarea
                    className="fc-front-input"
                    value={front}
                    onChange={(e) => setFront(e.target.value)}
                    placeholder="要问自己的问题"
                    autoFocus
                />
            </label>

            <div className="fc-back-grid">
                <label>
                    <span>背面（Markdown）</span>
                    <textarea
                        className="fc-back-input"
                        spellCheck={false}
                        value={back}
                        onChange={(e) => setBack(e.target.value)}
                        placeholder={'答案。支持 **粗体**、`代码`、列表、表格…'}
                    />
                </label>
                <div className="fc-back-preview-wrap">
                    <span>预览</span>
                    <Markdown className="fc-markdown fc-back-preview" source={back} />
                </div>
            </div>

            <div className="fc-form-actions">
                <button
                    type="button"
                    className="fc-btn fc-btn-primary"
                    disabled={!front.trim()}
                    onClick={() => onSave(front, back)}
                >
                    <i className="fas fa-check" /> 保存
                </button>
                <button type="button" className="fc-btn" onClick={onCancel}>取消</button>
            </div>
        </div>
    );
}
