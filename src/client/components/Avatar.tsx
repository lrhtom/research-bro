// 头像：一张图、一个 emoji，或者退回用用户名首字母。
//
// 侧栏和个人中心都要画它。做成一个组件而不是各画各的 ——
// 否则「图片要 object-fit、文字要居中」这套判断迟早会在两处长得不一样。
// 尺寸和配色由调用方通过 className 给（.rail-me-avatar / .me-avatar）。

import { initial, isImageAvatar } from '@/lib/profile';

interface Props {
    name: string;
    avatar: string;
    /** 决定大小与配色的那个类名 */
    className: string;
}

export default function Avatar({ name, avatar, className }: Props) {
    if (isImageAvatar(avatar)) {
        // alt 留空 + aria-hidden：旁边永远跟着用户名的文字，
        // 读屏再念一遍头像只是重复
        return <img className={className + ' is-image'} src={avatar} alt="" aria-hidden="true" />;
    }

    return (
        <span className={className} aria-hidden="true">
            {avatar || initial(name)}
        </span>
    );
}
