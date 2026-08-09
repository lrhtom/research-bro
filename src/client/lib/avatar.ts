// ============================================================
//  头像图片处理 —— 全程在浏览器里做，图片一个字节都不上传
//
//  最终存进 settings 表的是一段 data URI，所以进库之前必须先压：
//  手机拍的原图动辄几 MB，直接塞进 SQLite 的一行文本里既慢又蠢。
//  统一居中裁成正方形、缩到 128px、转 WebP —— 结果通常十几 KB。
//
//  裁而不是拉伸：直接把长方形缩成正方形会把人脸压扁，
//  取中间那一块方形才是「头像」该有的样子。
// ============================================================

import { AVATAR_MAX_CHARS } from './profile';

export const AVATAR_SIZE = 128;

function loadImage(file: File): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
        img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('这张图片读不出来')); };
        img.src = url;
    });
}

/** 把用户挑的文件变成一段可以直接存库的 data URI。失败时抛中文原因。 */
export async function fileToAvatarDataUrl(file: File): Promise<string> {
    if (!file.type.startsWith('image/')) throw new Error('只收图片文件');

    const img = await loadImage(file);
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    if (!side) throw new Error('这张图片读不出来');

    const canvas = document.createElement('canvas');
    canvas.width = AVATAR_SIZE;
    canvas.height = AVATAR_SIZE;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('这台浏览器不支持 canvas，换个浏览器试试');

    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(
        img,
        (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side,
        0, 0, AVATAR_SIZE, AVATAR_SIZE,
    );

    // WebP 体积明显小过 JPEG；不认识 webp 的浏览器会悄悄退回 PNG（那个反而更大），
    // 所以这里显式判一下，退回时改用 JPEG
    let url = canvas.toDataURL('image/webp', 0.85);
    if (!url.startsWith('data:image/webp')) url = canvas.toDataURL('image/jpeg', 0.85);

    if (url.length > AVATAR_MAX_CHARS) throw new Error('这张图压完还是太大，换一张');
    return url;
}
