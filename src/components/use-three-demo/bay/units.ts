/**
 * 旧单位换算（移植自 firstapp `race-scene/units.ts`）。
 *
 * 海湾大桥的桥高/桥宽/车道线周期等常量在原始美术稿里按"旧单位"标定,
 * 1 米 = 4.36 旧单位。搬过来时保留这套换算,几何尺寸才能与 firstapp 逐米对齐 ——
 * 改这里等于改桥的比例,不要动。
 *
 * 约定:**入参世界坐标已经是米**,旧单位只用于本目录内写死的常量。
 */
export const LEGACY_UNITS_PER_METRE = 4.36

/** 旧单位 → 米 */
export const fromLegacyUnits = (value: number): number => value / LEGACY_UNITS_PER_METRE
