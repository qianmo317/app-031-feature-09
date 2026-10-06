// 排样合法性总校验（唯一判定入口）：微调与调板确认都不许另起一套。
// 逐项：余隙（相邻净距 ≥ 锯路、四周 ≥ 修边）、不重叠、guillotine 贯通合法、
// 逐刀切割模拟还原每一块件、利用率分子=零件净面积、件数守恒（与清单或显式期望一致）。
import type { Job, NestResult, Placement, SheetResult } from '../types'
import { guillotineViolation, type Rect } from './geometry'
import { simulate } from './cuts'

export interface VerifyIssue {
  area: string
  detail: string
}

export interface VerifyReport {
  ok: boolean
  issues: VerifyIssue[]
  sheetsChecked: number
  piecesChecked: number
}

/** 单块板校验：余隙/修边、不重叠、贯通合法、逐刀模拟、利用率复算。 */
export function verifySheet(sheet: SheetResult, kerf: number, trim: number): string[] {
  const errs: string[] = []
  const w = sheet.wMm
  const h = sheet.hMm
  const ps = sheet.placements

  // 四周边界（修边区）与净距（锯路）
  for (const p of ps) {
    if (p.x < trim - 0.06) errs.push(`零件 ${p.code} 越过左侧修边区`)
    if (p.y < trim - 0.06) errs.push(`零件 ${p.code} 越过底边修边区`)
    if (p.x + p.lenMm > w - trim + 0.06) errs.push(`零件 ${p.code} 越过右侧修边区`)
    if (p.y + p.widMm > h - trim + 0.06) errs.push(`零件 ${p.code} 越过顶边修边区`)
  }
  for (let i = 0; i < ps.length; i++) {
    for (let j = i + 1; j < ps.length; j++) {
      const a = ps[i]
      const b = ps[j]
      const ox = Math.min(a.x + a.lenMm, b.x + b.lenMm) - Math.max(a.x, b.x)
      const oy = Math.min(a.y + a.widMm, b.y + b.widMm) - Math.max(a.y, b.y)
      if (ox > 0.06 && oy > 0.06) errs.push(`零件 ${a.code} 与 ${b.code} 重叠`)
      if (ox > 0.06) {
        const gap =
          Math.abs(a.y + a.widMm - b.y) < Math.abs(a.y - (b.y + b.widMm))
            ? b.y - (a.y + a.widMm)
            : a.y - (b.y + b.widMm)
        if (gap > 0.06 && gap < kerf - 0.6)
          errs.push(`零件 ${a.code} 与 ${b.code} 净距 ${gap.toFixed(2)}mm < 锯路 ${kerf}mm`)
      }
      if (oy > 0.06) {
        const gap =
          Math.abs(a.x + a.lenMm - b.x) < Math.abs(a.x - (b.x + b.lenMm))
            ? b.x - (a.x + a.lenMm)
            : a.x - (b.x + b.lenMm)
        if (gap > 0.06 && gap < kerf - 0.6)
          errs.push(`零件 ${a.code} 与 ${b.code} 净距 ${gap.toFixed(2)}mm < 锯路 ${kerf}mm`)
      }
    }
  }
  if (errs.length > 0) return errs.map((e) => `板${sheet.index + 1}：${e}`)

  // guillotine 贯通合法性
  const bounds: Rect = { x: trim, y: trim, w: w - 2 * trim, h: h - 2 * trim }
  const v = guillotineViolation(
    ps.map((p) => ({ id: p.instanceId, x: p.x, y: p.y, w: p.lenMm, h: p.widMm })),
    bounds,
    kerf
  )
  if (v) errs.push(`板${sheet.index + 1}：${v}`)

  // 逐刀模拟：每块件都能被切出来
  const sim = simulate(w, h, kerf, sheet.steps, ps)
  if (!sim.ok) errs.push(...sim.errors.map((e) => `板${sheet.index + 1}：${e}`))

  // 利用率/净面积复算
  const net = ps.reduce((a, p) => a + p.origLen * p.origWid, 0)
  if (Math.abs(net - sheet.usedAreaMm2) > 1)
    errs.push(`板${sheet.index + 1}：usedArea 与零件净面积不一致`)
  if (sheet.boardAreaMm2 > 0 && Math.abs(net / sheet.boardAreaMm2 - sheet.utilization) > 1e-9)
    errs.push(`板${sheet.index + 1}：利用率复算不一致`)

  return errs
}

/** 逐刀核到每一块件：每块件是否都能被按序贯通刀切成（simulate 逐件核对的明细版）。 */
export function coverageByPart(
  sheet: SheetResult,
  kerf: number
): { instanceId: string; code: string; covered: boolean }[] {
  const sim = simulate(sheet.wMm, sheet.hMm, kerf, sheet.steps, sheet.placements)
  if (sim.ok)
    return sheet.placements.map((p) => ({ instanceId: p.instanceId, code: p.code, covered: true }))
  // 有错误时：错误信息里点名的件标记为未覆盖（找不到对应矩形的件）
  return sheet.placements.map((p) => ({
    instanceId: p.instanceId,
    code: p.code,
    covered: !sim.errors.some((e) => e.includes(p.code))
  }))
}

/**
 * 整份结果总校验。expectedPieces 给出时校验件数守恒（调板前后件数必须相等）。
 */
export function verifyResult(job: Job, result: NestResult, expectedPieces?: number): VerifyReport {
  const issues: VerifyIssue[] = []
  let piecesChecked = 0
  for (const sheet of result.sheets) {
    const errs = verifySheet(sheet, job.kerfMm, job.trimMm)
    for (const e of errs) issues.push({ area: '排样内核', detail: e })
    piecesChecked += sheet.placements.length
  }
  if (expectedPieces !== undefined && piecesChecked !== expectedPieces) {
    issues.push({
      area: '守恒',
      detail: `件数不一致：期望 ${expectedPieces} 件，结果 ${piecesChecked} 件`
    })
  }
  // 实例键唯一（重复确认/重复挪件的兜底）
  const keys = new Set<string>()
  for (const s of result.sheets)
    for (const p of s.placements) {
      if (keys.has(p.instanceId))
        issues.push({ area: '守恒', detail: `同一件 ${p.code}（${p.instanceId}）被排了两次` })
      keys.add(p.instanceId)
    }
  return { ok: issues.length === 0, issues, sheetsChecked: result.sheets.length, piecesChecked }
}

/** 手工微调单板校验（与 applyAdjustment 原来调用的同一判定一致）。 */
export function verifyAdjustment(
  job: Job,
  sheet: SheetResult,
  placements: Placement[]
): string | null {
  const bounds: Rect = {
    x: job.trimMm,
    y: job.trimMm,
    w: sheet.wMm - 2 * job.trimMm,
    h: sheet.hMm - 2 * job.trimMm
  }
  const violation = guillotineViolation(
    placements.map((p) => ({ id: p.instanceId, x: p.x, y: p.y, w: p.lenMm, h: p.widMm })),
    bounds,
    job.kerfMm
  )
  if (violation) return violation
  return null
}
