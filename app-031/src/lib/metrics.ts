// 统一取数：排样结果页 / 材料统计 / 打印单据标签 / 本机存档全部从这一批函数取数。
// 精度口径（页面与单据上照此写明）：
//   面积：内部一律 mm² 整数累计；换算平方米保留 2 位小数（1m² = 1_000_000mm²）。
//   利用率：保留 1 位小数百分数（如 75.4%），内部为分数 usedAreaMm2 / boardAreaMm2。
//   余料尺寸：整 mm（四舍五入）；可用判定两边 ≥300mm。
//   走刀次数：整数；修边刀同规格板叠切只计 1 次，内部贯通刀逐板计。
import type { Job, NestResult, SheetResult } from '../types'
import { countSawOps } from './cuts'

export const AREA_DECIMALS = 2 // 平方米小数位
export const UTIL_DECIMALS = 1 // 利用率百分数小数位
export const MM2_PER_M2 = 1_000_000

export const DEFAULT_UTIL_FLOOR_PCT = 75

/** 本单利用率下限（百分数），旧存档缺字段取 75。 */
export function utilFloorPct(job: Job): number {
  const v = job.utilFloorPct
  return typeof v === 'number' && v >= 1 && v <= 99 ? v : DEFAULT_UTIL_FLOOR_PCT
}

export function fmtM2(mm2: number): string {
  return `${(mm2 / MM2_PER_M2).toFixed(AREA_DECIMALS)}`
}

export function fmtUtil(frac: number): string {
  return `${(frac * 100).toFixed(UTIL_DECIMALS)}%`
}

export function totalPartCount(result: NestResult): number {
  return result.sheets.reduce((a, s) => a + s.placements.length, 0)
}

export function overallUtilization(result: NestResult): number {
  const used = result.sheets.reduce((a, s) => a + s.usedAreaMm2, 0)
  const total = result.sheets.reduce((a, s) => a + s.boardAreaMm2, 0)
  return total > 0 ? used / total : 0
}

export function usableOffcutAreaMm2(result: NestResult): number {
  return result.sheets.reduce(
    (a, s) => a + s.offcuts.filter((o) => o.usable).reduce((x, o) => x + o.areaMm2, 0),
    0
  )
}

/** 车间实际走刀次数（修边同规格叠切计 1 次）。结果上缓存值与现算值必须一致。 */
export function sawOps(result: NestResult): number {
  return countSawOps(result.sheets)
}

export function boardWasteMm2(sheet: SheetResult): number {
  // 浪费 = 板面积 - 零件净面积（锯路/修边计入浪费，利用率分子不含锯路）
  return Math.max(0, sheet.boardAreaMm2 - sheet.usedAreaMm2)
}

/** 按板汇总的用料与余料（材料统计页/下料单共用）。 */
export interface BoardMaterialRow {
  index: number
  boardId: string
  boardName: string
  spec: string
  thicknessMm: number
  pieces: number
  boardAreaMm2: number
  usedAreaMm2: number
  wasteMm2: number
  offcutAreaMm2: number
  utilization: number
  sawOps: number
}

export function boardMaterialRows(result: NestResult): BoardMaterialRow[] {
  return result.sheets.map((s) => {
    const offcutAreaMm2 = s.offcuts.filter((o) => o.usable).reduce((a, o) => a + o.areaMm2, 0)
    return {
      index: s.index,
      boardId: s.boardId,
      boardName: s.boardName,
      spec: `${s.wMm}×${s.hMm}`,
      thicknessMm: s.thicknessMm,
      pieces: s.placements.length,
      boardAreaMm2: s.boardAreaMm2,
      usedAreaMm2: s.usedAreaMm2,
      wasteMm2: s.boardAreaMm2 - s.usedAreaMm2,
      offcutAreaMm2,
      utilization: s.usedAreaMm2 / s.boardAreaMm2,
      sawOps: countSawOps([s])
    }
  })
}

/**
 * 刷新结果上的所有派生缓存（调板确认后调用，与主排样同源）：
 * 刀路与利用率由各板自身更新；这里只刷新全局缓存字段。
 */
export function refreshResultCaches(result: NestResult): void {
  result.sawOps = countSawOps(result.sheets)
  result.usableOffcutAreaMm2 = usableOffcutAreaMm2(result)
  result.boardsUsed = result.sheets.length
}
