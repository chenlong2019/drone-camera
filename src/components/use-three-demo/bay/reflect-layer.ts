/**
 * 反射剔除层约定(bay 布景专用)。
 *
 * 树 / 路灯 / 中国结这些小装饰挂在本层:主相机与阴影相机都放行,唯独
 * 海面 ReflectorNode 的虚拟相机不看 —— 水面倒影被波浪坡度扰动 + 镜面权重只有
 * 0.62,这些细节在倒影里本就读不出来,却要为反射 pass 多付一整份绘制。
 * 见 bay-scenery.applyDecorLayers / bay-water 的 getVirtualCamera 补丁。
 */
export const DECOR_REFLECT_LAYER = 1

/** layer N 的位掩码 */
export const decorLayerMask = 1 << DECOR_REFLECT_LAYER
