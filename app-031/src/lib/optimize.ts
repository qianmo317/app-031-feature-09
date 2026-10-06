// 省板建议（排样结果页）：
// - 按下限挑出利用率偏低的板，逐块列出板上空档（尺寸/面积），并诊断别处的件能否挪进来；
// - 两条挪件路都在这里试算：
//   路 A「同板对换」：只重排这一张板，其它板一张不碰；代价是板数不变，常常省不下整张板；
//   路 B「跨板连锁」：重排该板所在板种的整组板，有机会真省一张；
//     代价是被牵动的每张板都要重排，已发到车间的标签/下料单作废，且可能多切几刀。
// 两条路都调用排样内核 nestJob —— 余隙、锯路、四周修边、纹理朝向、guillotine 贯通
// 合法性完全沿用同一套判定，不另立规则。
import type {
  Board,
  Job,
  NestResult,
  OffcutInfo,
  Part,
  Placement,
  SheetResult
} from '../types'
import {
  fitsClean,
  nestJob,
  NEST_STRATEGIES,
  orientsOf,
  summarizeResult
} from './packing'
import { countSawOps, simulate } from './cuts'
import { guillotineViolation, EPS, type Rect } from './geometry'
import { uid } from './format'

// ---------- 数据结构 ----------

export interface VoidInfo {
  id: string
  x: number
  y: number
  wMm: number
  hMm: number
  areaMm2: number
  usable: boolean
  /** 别处板上最适合挪进来的那件（同板种兼容前提下） */
  bestMover: {
    instanceId: string
    code: string
    name: string
    lenMm: number
    widMm: number
    fromSheet: number
    cabinet: string
    wasteMm2: number
  } | null
  /** 挪不进来的原因；bestMover 为 null 时非空 */
  blockReason: string | null
}

export type RouteId = 'swapLocal' | 'chainSheets'

export interface MoveInfo {
  instanceId: string
  code: string
  name: string
  fromSheet: number | null // null = 试算中新进件/组内新建
  toSheet: number
}

export interface RouteTrial {
  route: RouteId
  feasible: boolean
  reason: string
  // 试算结果（板数/刀路/走刀次数/余料/利用率都来自内核重算）
  boardsAfter: number
  boardsDelta: number
  sawOpsAfter: number
  sawOpsDelta: number
  offcutAreaMm2After: number
  offcutAreaDeltaMm2: number
  utilMinAfter: number
  utilAvgAfter: number
  utilMinBefore: number
  utilAvgBefore: number
  affectedSheetsBefore: number[] // 牵动的旧板号（1 起，展示用）
  sheetsAfterCount: number
  strategyId: string
  strategyLabel: string
  elapsedMs: number
  moves: MoveInfo[]
  /** 重排后的那一组板（compose 时用） */
  repackedSheets: SheetResult[]
  /** 这一组在旧结果里对应的板 index */
  oldIndices: number[]
  /** 试算所基于的结果版本签名（确认时必须仍是当前版本，防重复挪件） */
  baseSignature: string
  /** 路 A：重排对象单板；路 B：省板的是哪块板 */
  note: string
}

export interface SheetAdvice {
  sheetIndex: number
  utilization: number
  belowFloor: boolean
  voids: VoidInfo[]
  local: RouteTrial
  chain: RouteTrial
}

export interface OptimizeReport {
  floorPct: number
  generatedAt: number
  elapsedMs: number
  /** 仅含低于下限的板 */
  advices: SheetAdvice[]
  belowCount: number
  sheetsCount: number
  /** 所有低于下限的板中，路 B 可行的最优方案（同组只保留一份） */
  bestChain: { sheetIndex: number; trial: RouteTrial } | null
}

export interface OptimizePlan {
  id: string
  route: RouteId
  createdAt: number
  floorPct: number
  signature: string
  // 试算产物（确认时直接据此拼装，不再重新搜索：保证「所见即所得」）
  repackedSheets: SheetResult[]
  oldIndices: number[]
  beforeBoardCount: number
  afterBoardCount: number
}

// ---------- 试算 ----------

function internalCuts(s: SheetResult): number {
  return s.steps.filter((st) => st.kind === 'cut').length
}

function usableOffcutArea(s: SheetResult): number {
  return s.offcuts.filter((o) => o.usable).reduce((a, o) => a + o.areaMm2, 0)
}

function sheetGroupKey(s: SheetResult): string {
  // 余料板各自独立成组；常规板按板种（库存里同 boardId 的多张为一组）
  return s.boardId.startsWith('offcut_') ? `single:${s.index}` : `group:${s.boardId}`
}

/** 从一张板的就位零件反推合成零件（一实例一件，避免 qty 展开顺序错位）。 */
function syntheticParts(sheet: SheetResult): Part[] {
  return sheet.placements.map((pl) => ({
    id: `__rep_${sheet.index}_${pl.instanceId}`,
    code: pl.code,
    name: pl.name,
    lenMm: pl.origLen,
    widMm: pl.origWid,
    qty: 1,
    grain: pl.grain,
    edgeBands: pl.edgeBands,
    cabinet: pl.cabinet,
    exposed: pl.exposed,
    // 原来落在余料小板上的件不锁定板种，重排时允许落回同厚度任意板；
    // 常规板上的件继续锁定原板种（boardMatches 会按厚度兼容余料板）
    boardId: sheet.boardId.startsWith('offcut_') ? '' : sheet.boardId
  }))
}

interface RepackRun {
  result: NestResult
  strategyId: string
  strategyLabel: string
  elapsedMs: number
}

/** 用全部策略重排一批零件；返回所有合法（无未排下）结果。 */
function repackAllStrategies(
  parts: Part[],
  boards: Board[],
  kerf: number,
  trim: number,
  batchByCabinet: boolean
): RepackRun[] {
  const runs: RepackRun[] = []
  const job: Job = {
    id: '__repack__',
    name: '试算',
    createdAt: 0,
    boards,
    parts,
    kerfMm: kerf,
    trimMm: trim,
    useOffcutIds: [],
    batchByCabinet
  }
  for (const st of NEST_STRATEGIES) {
    const t0 = performance.now()
    const r = nestJob(job, { strategyId: st.id })
    const elapsedMs = Math.round(performance.now() - t0)
    if (r.unplaced.length === 0) runs.push({ result: r, strategyId: st.id, strategyLabel: st.label, elapsedMs })
  }
  return runs
}

function groupStats(sheets: SheetResult[]): {
  sawOps: number
  offcutArea: number
  utilMin: number
  utilAvg: number
} {
  return {
    sawOps: countSawOps(sheets),
    offcutArea: sheets.reduce((a, s) => a + usableOffcutArea(s), 0),
    utilMin: sheets.length ? Math.min(...sheets.map((s) => s.utilization)) : 0,
    utilAvg: sheets.length
      ? sheets.reduce((a, s) => a + s.utilization, 0) / sheets.length
      : 0
  }
}

/** 组重排的候选板：本组余料小板 + 全部常规板（不锁定板种的件可落到同厚度大板）。 */
function buildRepackBoards(group: SheetResult[], allStock: Board[]): Board[] {
  const boards: Board[] = []
  for (const s of group) {
    if (!s.boardId.startsWith('offcut_')) continue
    boards.push({
      id: s.boardId,
      name: s.boardName,
      wMm: s.wMm,
      hMm: s.hMm,
      thicknessMm: s.thicknessMm,
      material: s.material,
      priceCents: 0,
      quantity: 1,
      kind: 'offcut'
    })
  }
  const seen = new Set<string>()
  for (const b of allStock) {
    if (b.kind === 'offcut' || seen.has(b.id)) continue
    seen.add(b.id)
    boards.push({ ...b })
  }
  return boards
}

/** 生成一份不可行的试算结果。 */
function infeasible(
  route: RouteId,
  reason: string,
  beforeSheets: SheetResult[],
  oldIndices: number[],
  baseSignature = ''
): RouteTrial {
  const g = groupStats(beforeSheets)
  return {
    route,
    feasible: false,
    reason,
    boardsAfter: 0,
    boardsDelta: 0,
    sawOpsAfter: g.sawOps,
    sawOpsDelta: 0,
    offcutAreaMm2After: g.offcutArea,
    offcutAreaDeltaMm2: 0,
    utilMinAfter: g.utilMin,
    utilAvgAfter: g.utilAvg,
    utilMinBefore: g.utilMin,
    utilAvgBefore: g.utilAvg,
    affectedSheetsBefore: oldIndices.map((i) => i + 1),
    sheetsAfterCount: beforeSheets.length,
    strategyId: '',
    strategyLabel: '',
    elapsedMs: 0,
    moves: [],
    repackedSheets: [],
    oldIndices,
    baseSignature,
    note: ''
  }
}

function makeTrial(
  route: RouteId,
  run: RepackRun,
  oldSheets: SheetResult[],
  oldIndices: number[],
  baseSignature: string
): RouteTrial {
  const before = groupStats(oldSheets)
  const afterSheets = run.result.sheets
  const after = groupStats(afterSheets)
  const oldIndexOf = new Map<number, number>()
  oldSheets.forEach((s, k) => oldIndexOf.set(s.index, oldIndices[k]))
  const moves: MoveInfo[] = []
  for (const s of afterSheets) {
    for (const pl of s.placements) {
      const m = pl.instanceId.match(/^__rep_(\d+)_(.+)$/)
      if (!m) continue
      const fromGlobal = Number(m[1])
      moves.push({
        instanceId: m[1],
        code: pl.code,
        name: pl.name,
        fromSheet: (oldIndexOf.get(fromGlobal) ?? fromGlobal) + 1,
        toSheet: s.index + 1
      })
    }
  }
  const boardsDelta = afterSheets.length - oldSheets.length
  const note =
    route === 'swapLocal'
      ? '只重排本张板；其它板一张不动，板数不变'
      : boardsDelta < 0
        ? `整组重排后可少开 ${-boardsDelta} 张板；组内每张板都已重排`
        : '整组重排后板数未减少'
  return {
    route,
    feasible: true,
    reason: '',
    boardsAfter: afterSheets.length,
    boardsDelta,
    sawOpsAfter: after.sawOps,
    sawOpsDelta: after.sawOps - before.sawOps,
    offcutAreaMm2After: after.offcutArea,
    offcutAreaDeltaMm2: after.offcutArea - before.offcutArea,
    utilMinAfter: after.utilMin,
    utilAvgAfter: after.utilAvg,
    utilMinBefore: before.utilMin,
    utilAvgBefore: before.utilAvg,
    affectedSheetsBefore: oldIndices.map((i) => i + 1),
    sheetsAfterCount: afterSheets.length,
    strategyId: run.strategyId,
    strategyLabel: run.strategyLabel,
    elapsedMs: run.elapsedMs,
    moves,
    repackedSheets: afterSheets,
    oldIndices,
    baseSignature,
    note
  }
}

// ---------- 空档诊断 ----------

function rectOfOffcut(o: OffcutInfo): Rect {
  return { x: o.x, y: o.y, w: o.wMm, h: o.hMm }
}

function diagnoseVoids(
  sheet: SheetResult,
  others: SheetResult[],
  kerf: number
): VoidInfo[] {
  const out: VoidInfo[] = []
  for (const o of sheet.offcuts) {
    const vr = rectOfOffcut(o)
    let best: { pl: Placement; from: number; waste: number } | null = null
    for (const other of others) {
      if (other.index === sheet.index) continue
      for (const pl of other.placements) {
        // 兼容判定：常规板件只在同板种板间挪；余料板件按厚度兼容
        if (!sheet.boardId.startsWith('offcut_')) {
          if (!other.boardId.startsWith('offcut_') && other.boardId !== sheet.boardId) continue
          if (other.boardId.startsWith('offcut_') && other.thicknessMm !== sheet.thicknessMm) continue
        }
        const probe: Part = {
          id: '',
          code: pl.code,
          name: pl.name,
          lenMm: pl.origLen,
          widMm: pl.origWid,
          qty: 1,
          grain: pl.grain,
          edgeBands: pl.edgeBands,
          cabinet: pl.cabinet,
          exposed: pl.exposed,
          boardId: ''
        }
        const fits = orientsOf(probe).some(
          (o2) => fitsClean(vr.w, o2.pw, kerf) && fitsClean(vr.h, o2.ph, kerf)
        )
        if (!fits) continue
        const waste = vr.w * vr.h - pl.lenMm * pl.widMm
        if (!best || waste < best.waste) best = { pl, from: other.index, waste }
      }
    }
    out.push({
      id: uid('void'),
      x: o.x,
      y: o.y,
      wMm: o.wMm,
      hMm: o.hMm,
      areaMm2: o.areaMm2,
      usable: o.usable,
      bestMover: best
        ? {
            instanceId: best.pl.instanceId,
            code: best.pl.code,
            name: best.pl.name,
            lenMm: best.pl.origLen,
            widMm: best.pl.origWid,
            fromSheet: best.from + 1,
            cabinet: best.pl.cabinet,
            wasteMm2: Math.max(0, best.waste)
          }
        : null,
      blockReason: best
        ? null
        : blockReasonFor(vr, sheet, others)
    })
  }
  return out
}

function blockReasonFor(
  vr: Rect,
  sheet: SheetResult,
  others: SheetResult[]
): string {
  const compat = others.filter(
    (o) =>
      o.index !== sheet.index &&
      (o.boardId === sheet.boardId ||
        (o.boardId.startsWith('offcut_') && o.thicknessMm === sheet.thicknessMm))
  )
  if (compat.length === 0 || compat.every((cs) => cs.placements.length === 0)) {
    return `没有同板种/同厚度的其它板可挪件（空档 ${Math.round(vr.w)}×${Math.round(vr.h)}mm）`
  }
  // 找一件最小的，说明是尺寸还是纹理挡住
  let smallest: Placement | null = null
  let grainBlocked = 0
  for (const cs of compat) {
    for (const pl of cs.placements) {
      if (!smallest || pl.origLen * pl.origWid < smallest.origLen * smallest.origWid) {
        smallest = pl
      }
      if (pl.grain !== 'none') grainBlocked++
    }
  }
  const sm = smallest!
  const minSide = Math.min(sm.origLen, sm.origWid)
  if (minSide > Math.max(vr.w, vr.h) + EPS || Math.max(sm.origLen, sm.origWid) > Math.max(vr.w, vr.h) + EPS) {
    return `空档 ${Math.round(vr.w)}×${Math.round(vr.h)}mm 装不下最小组兼容件 ${sm.code}（${sm.origLen}×${sm.origWid}mm）`
  }
  if (grainBlocked > 0 && vr.h < Math.min(sm.origLen, sm.origWid) + EPS) {
    return `纹理件朝向固定，空档 ${Math.round(vr.w)}×${Math.round(vr.h)}mm 净高/宽不够`
  }
  return `空档 ${Math.round(vr.w)}×${Math.round(vr.h)}mm：同板种各件按纹理朝向均放不下（0<余隙<锯路时下不了刀）`
}

// ---------- 主入口 ----------

export interface AnalyzeOptions {
  floorPct: number
}

export function analyzeLowSheets(job: Job, result: NestResult, opts: AnalyzeOptions): OptimizeReport {
  const t0 = performance.now()
  const floor = opts.floorPct / 100
  const stockBoards = job.boards
  const baseSignature = resultSignature(result)

  // 分组（同 boardId 的常规板为一组；余料板各自一组）
  const groups = new Map<string, SheetResult[]>()
  for (const s of result.sheets) {
    const k = sheetGroupKey(s)
    const arr = groups.get(k) ?? []
    arr.push(s)
    groups.set(k, arr)
  }

  // 每组重跑一次全部策略（路 B 与组内路 A 共用）
  const groupRuns = new Map<string, { runs: RepackRun[]; indices: number[] }>()
  for (const [key, sheets] of groups) {
    const indices = sheets.map((s) => s.index)
    const parts = sheets.flatMap((s) => syntheticParts(s))
    const boards = buildRepackBoards(sheets, stockBoards)
    const runs = repackAllStrategies(parts, boards, job.kerfMm, job.trimMm, false)
    groupRuns.set(key, { runs, indices })
  }

  const advices: SheetAdvice[] = []
  let bestChain: OptimizeReport['bestChain'] = null

  for (const s of result.sheets) {
    if (s.utilization >= floor) continue
    const key = sheetGroupKey(s)
    const group = groups.get(key)!
    const info = groupRuns.get(key)!
    const oldIndices = info.indices
    const singletonGroup = group.length === 1

    // —— 路 A：只重排这一张板（构造单板任务）——
    const local = trialLocal(s, job, baseSignature)

    // —— 路 B：整组重排 ——
    let chain: RouteTrial
    if (singletonGroup) {
      chain = infeasible(
        'chainSheets',
        s.boardId.startsWith('offcut_')
          ? '这是一块登记余料小板，自成一组，没有同板种的其它板可连锁挪动，凑不出省一张板需要的空档'
          : '该板种整批只有这一张板，没有同板种的其它板可连锁挪动，凑不出省一张板需要的空档',
        group,
        oldIndices,
        baseSignature
      )
    } else {
      const feasible = info.runs.filter((r) => r.result.sheets.length < group.length)
      if (feasible.length === 0) {
        const sameCount = info.runs
        const bestSame = pickChainSameCount(sameCount, group)
        chain = infeasible(
          'chainSheets',
          chainRejectReason(group, bestSame),
          group,
          oldIndices,
          baseSignature
        )
      } else {
        // 省板优先；省得一样多时走刀少优先、余料大优先
        feasible.sort(
          (a, b) =>
            a.result.sheets.length - b.result.sheets.length ||
            countSawOps(a.result.sheets) - countSawOps(b.result.sheets)
        )
        chain = makeTrial('chainSheets', feasible[0], group, oldIndices, baseSignature)
        chain.reason =
          chain.sawOpsDelta > 0
            ? `可省 ${-chain.boardsDelta} 张板，但重排后该组多 ${chain.sawOpsDelta} 次走刀（风险已计入）`
            : chain.sawOpsDelta < 0
              ? `可省 ${-chain.boardsDelta} 张板，且走刀还少 ${-chain.sawOpsDelta} 次`
              : `可省 ${-chain.boardsDelta} 张板，走刀次数不变`
        if (!bestChain || chain.boardsDelta < bestChain.trial.boardsDelta) {
          bestChain = { sheetIndex: s.index, trial: chain }
        }
      }
    }

    advices.push({
      sheetIndex: s.index,
      utilization: s.utilization,
      belowFloor: true,
      voids: diagnoseVoids(s, result.sheets, job.kerfMm),
      local,
      chain
    })
  }

  return {
    floorPct: opts.floorPct,
    generatedAt: Date.now(),
    elapsedMs: Math.round(performance.now() - t0),
    advices,
    belowCount: advices.length,
    sheetsCount: result.sheets.length,
    bestChain
  }
}

function pickChainSameCount(runs: RepackRun[], group: SheetResult[]): RepackRun | null {
  const same = runs.filter((r) => r.result.sheets.length === group.length)
  if (same.length === 0) return null
  same.sort((a, b) => countSawOps(a.result.sheets) - countSawOps(b.result.sheets))
  return same[0]
}

function chainRejectReason(group: SheetResult[], bestSame: RepackRun | null): string {
  const parts = group.reduce((a, g) => a + g.placements.length, 0)
  const tail =
    bestSame && countSawOps(bestSame.result.sheets) > countSawOps(group)
      ? '；即使只做同张数重排，刀路也会变多，不划算'
      : ''
  return `按内核同一条判定试遍 ${NEST_STRATEGIES.length} 种进件顺序，本组 ${group.length} 张板上的 ${parts} 件仍需 ${group.length} 张才能装下——各板空档被锯路/纹理朝向切碎，连锁挪动也凑不出一整张板的空档${tail}`
}

/** 路 A：仅重排本张板。单板任务，候选板只给这一块板（余料板给回它自己）。 */
function trialLocal(sheet: SheetResult, job: Job, baseSignature: string): RouteTrial {
  const oldIndices = [sheet.index]
  const parts = syntheticParts(sheet)
  const alone: Board[] = sheet.boardId.startsWith('offcut_')
    ? [
        {
          id: sheet.boardId,
          name: sheet.boardName,
          wMm: sheet.wMm,
          hMm: sheet.hMm,
          thicknessMm: sheet.thicknessMm,
          material: sheet.material,
          priceCents: 0,
          quantity: 1,
          kind: 'offcut'
        }
      ]
    : [
        {
          id: sheet.boardId,
          name: sheet.boardName,
          wMm: sheet.wMm,
          hMm: sheet.hMm,
          thicknessMm: sheet.thicknessMm,
          material: sheet.material,
          priceCents: sheet.priceCents,
          quantity: 0,
          kind: 'stock'
        }
      ]
  // 单板任务里件必须锁死这一种板（否则内核可能新开别的板）
  for (const p of parts) p.boardId = sheet.boardId.startsWith('offcut_') ? '' : sheet.boardId
  const runs = repackAllStrategies(parts, alone, job.kerfMm, job.trimMm, false)
  const oneSheet = runs.filter((r) => r.result.sheets.length === 1 && r.result.unplaced.length === 0)
  if (oneSheet.length === 0) {
    return infeasible(
      'swapLocal',
      '重排后出现排不下的件（不允许把件挤到别张板），同板对换不成立',
      [sheet],
      oldIndices,
      baseSignature
    )
  }
  // 目标：可用余料面积尽量大（碎空档并成整料），其次内部刀数少
  oneSheet.sort(
    (a, b) =>
      usableOffcutArea(b.result.sheets[0]) - usableOffcutArea(a.result.sheets[0]) ||
      internalCuts(a.result.sheets[0]) - internalCuts(b.result.sheets[0])
  )
  const trial = makeTrial('swapLocal', oneSheet[0], [sheet], oldIndices, baseSignature)
  const gainOff = trial.offcutAreaDeltaMm2
  const cutsDelta = trial.sawOpsDelta
  // 面积展示精度为 0.01m²（10000mm²）：增加量低于该值视为页面上看不出变化
  const VISIBLE_AREA_MM2 = 10000
  if (gainOff < VISIBLE_AREA_MM2 && cutsDelta >= 0) {
    trial.feasible = false
    trial.reason =
      '同板对换后碎空档合不出更大的可用余料（≥300×300mm 的余料面积增加不到 0.01m²），刀路也没减少：板数本来就不会少，这一动不划算，建议不动'
  } else {
    trial.feasible = true
    trial.reason =
      gainOff >= VISIBLE_AREA_MM2
        ? `本张板重排后可用余料面积增加 ${(gainOff / 1e6).toFixed(2)}m²（碎空档并成整料，留给下一批用），但板数不变，省不下整张板`
        : `本张板重排后内部刀少 ${-cutsDelta} 刀，板数不变`
  }
  return trial
}

// ---------- 计划与回写 ----------

function resultSignature(result: NestResult): string {
  const s = result.sheets
    .map(
      (sh) =>
        `${sh.boardId}:${sh.placements
          .map((p) => `${p.instanceId}@${Math.round(p.x)},${Math.round(p.y)}`)
          .join('|')}`
    )
    .join('||')
  return `${result.sheets.length}#${s}`
}

/** 从选中的试算生成可确认计划（纯数据，不动结果）。签名锁定在试算那一刻的结果版本。 */
export function buildPlan(
  result: NestResult,
  route: RouteId,
  trial: RouteTrial,
  floorPct: number
): OptimizePlan {
  void result
  return {
    id: uid('plan'),
    route,
    createdAt: Date.now(),
    floorPct,
    signature: trial.baseSignature,
    repackedSheets: trial.repackedSheets.map((s) => ({ ...s, steps: s.steps.map((st) => ({ ...st })) })),
    oldIndices: [...trial.oldIndices],
    beforeBoardCount: 0,
    afterBoardCount: 0
  }
}

/**
 * 纯函数拼装：用试算好的重排板替换旧组，重排全局板号/件号，
 * 再走 summarizeResult 同一条统计出口。不触碰入参。
 */
export function composeResult(job: Job, result: NestResult, plan: OptimizePlan): NestResult {
  const oldSet = new Set(plan.oldIndices)
  const kept = result.sheets.filter((s) => !oldSet.has(s.index))
  const repacked = plan.repackedSheets.map((s) => deepCloneSheet(s))
  void kept

  // 展示顺序：未动板按原顺序，重排组插到原组首板的位置
  const firstOld = Math.min(...plan.oldIndices)
  const ordered: SheetResult[] = []
  let inserted = false
  for (const s of result.sheets) {
    if (s.index === firstOld) {
      ordered.push(...repacked)
      inserted = true
    }
    if (!oldSet.has(s.index)) ordered.push(s)
  }
  if (!inserted) ordered.push(...repacked)

  // 全局重排板号、刀序、件序号（重排牵动的每张板都算新版）
  let seq = 0
  const newSheets = ordered.map((s, i) => {
    const steps = s.steps.map((st, k) => ({ ...st, boardIndex: i, order: k }))
    const placements = s.placements.map((p) => {
      seq++
      // 合成件的 instanceId 形如 __rep_<oldGlobalIndex>_<原 instanceId>，还原为原实例号
      const m = p.instanceId.match(/^__rep_\d+_(.+)$/)
      return { ...p, instanceId: m ? m[1] : p.instanceId, boardIndex: i, seq }
    })
    return { ...s, index: i, steps, placements }
  })

  // 汇总所需板清单：库存板照用；保留旧结果里出现过的余料小板定义
  const boards: Board[] = job.boards.map((b) => ({ ...b }))
  const stockIds = new Set(boards.map((b) => b.id))
  for (const s of result.sheets) {
    if (s.boardId.startsWith('offcut_') && !stockIds.has(s.boardId)) {
      boards.push({
        id: s.boardId,
        name: s.boardName,
        wMm: s.wMm,
        hMm: s.hMm,
        thicknessMm: s.thicknessMm,
        material: s.material,
        priceCents: 0,
        quantity: 1,
        kind: 'offcut'
      })
      stockIds.add(s.boardId)
    }
  }

  const composed = summarizeResult({
    sheets: newSheets,
    boards,
    unplacedList: result.unplaced.map((u) => ({ ...u })),
    baselineBoards: result.baselineBoards,
    keepBaseline: true,
    elapsedMs: 0,
    generatedAt: Date.now(),
    optimized: true
  })
  return composed
}

function deepCloneSheet(s: SheetResult): SheetResult {
  return {
    ...s,
    placements: s.placements.map((p) => ({ ...p, edgeBands: [...p.edgeBands] })),
    steps: s.steps.map((st) => ({ ...st, span: [st.span[0], st.span[1]] as [number, number] })),
    offcuts: s.offcuts.map((o) => ({ ...o }))
  }
}

// ---------- 合法性复核（确认回写前，必须与内核同标准）----------

export interface ValidationIssue {
  sheetIndex: number
  error: string
}

/** 逐板：边界/修边、净距/锯路、重叠、guillotine 贯通、逐刀模拟还原、利用率复算。 */
export function validateResult(job: Job, result: NestResult): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const kerf = job.kerfMm
  const trim = job.trimMm
  // 件数守恒
  const expectParts = job.parts.reduce((a, p) => a + p.qty, 0)
  const placed = result.sheets.reduce((a, s) => a + s.placements.length, 0) + result.unplaced.reduce((a, u) => a + u.qty, 0)
  if (placed !== expectParts) {
    issues.push({ sheetIndex: -1, error: `件数守恒失败：清单 ${expectParts} 件，就位+未排下 ${placed} 件` })
  }
  for (const sheet of result.sheets) {
    const ps = sheet.placements
    // 修边区
    for (const p of ps) {
      if (p.x < trim - 0.06 || p.y < trim - 0.06)
        issues.push({ sheetIndex: sheet.index, error: `零件 ${p.code} 越过修边区（左下）` })
      if (p.x + p.lenMm > sheet.wMm - trim + 0.06)
        issues.push({ sheetIndex: sheet.index, error: `零件 ${p.code} 越过修边区（右）` })
      if (p.y + p.widMm > sheet.hMm - trim + 0.06)
        issues.push({ sheetIndex: sheet.index, error: `零件 ${p.code} 越过修边区（上）` })
    }
    // 重叠/净距
    for (let i = 0; i < ps.length; i++) {
      for (let j = i + 1; j < ps.length; j++) {
        const a = ps[i]
        const b = ps[j]
        const ox = Math.min(a.x + a.lenMm, b.x + b.lenMm) - Math.max(a.x, b.x)
        const oy = Math.min(a.y + a.widMm, b.y + b.widMm) - Math.max(a.y, b.y)
        if (ox > 0.06 && oy > 0.06)
          issues.push({ sheetIndex: sheet.index, error: `零件 ${a.code} 与 ${b.code} 重叠` })
        if (ox > 0.06) {
          const gap = Math.abs(a.y + a.widMm - b.y) < Math.abs(a.y - (b.y + b.widMm))
            ? b.y - (a.y + a.widMm)
            : a.y - (b.y + b.widMm)
          if (gap > 0.06 && gap < kerf - 0.6)
            issues.push({ sheetIndex: sheet.index, error: `${a.code}/${b.code} 净距 ${gap.toFixed(2)} < 锯路 ${kerf}` })
        }
        if (oy > 0.06) {
          const gap = Math.abs(a.x + a.lenMm - b.x) < Math.abs(a.x - (b.x + b.lenMm))
            ? b.x - (a.x + a.lenMm)
            : a.x - (b.x + b.lenMm)
          if (gap > 0.06 && gap < kerf - 0.6)
            issues.push({ sheetIndex: sheet.index, error: `${a.code}/${b.code} 净距 ${gap.toFixed(2)} < 锯路 ${kerf}` })
        }
      }
    }
    // guillotine 合法性（与手工微调同一条判定）
    const v = guillotineViolation(
      ps.map((p) => ({ id: p.instanceId, x: p.x, y: p.y, w: p.lenMm, h: p.widMm })),
      { x: trim, y: trim, w: sheet.wMm - 2 * trim, h: sheet.hMm - 2 * trim },
      kerf
    )
    if (v) issues.push({ sheetIndex: sheet.index, error: v })
    // 逐刀模拟，核到每一块件
    const sim = simulate(sheet.wMm, sheet.hMm, kerf, sheet.steps, ps)
    if (!sim.ok) sim.errors.forEach((e) => issues.push({ sheetIndex: sheet.index, error: e }))
    // 利用率/净面积复算
    const net = ps.reduce((a, p) => a + p.origLen * p.origWid, 0)
    if (Math.abs(net - sheet.usedAreaMm2) > 1)
      issues.push({ sheetIndex: sheet.index, error: 'usedArea 与零件净面积不一致' })
    if (Math.abs(net / sheet.boardAreaMm2 - sheet.utilization) > 1e-9)
      issues.push({ sheetIndex: sheet.index, error: '利用率复算不一致' })
  }
  return issues
}

// ---------- 取数一致性对账（结果页/刀路/统计/打印/存档）----------

export interface AuditItem {
  surface: string
  ok: boolean
  detail: string
}

/**
 * 五个取数面都应只认 job.result 这一份：
 * 1 排样结果页（板数/件数/利用率）；2 裁切步骤页（刀序/走刀次数）；
 * 3 材料统计（按板用料余料、板种汇总、成本）；
 * 4 打印下料单与标签（板数/件数）；5 本机存档（持久化的那一版）。
 * 返回不一致项；存档对比由 store 传入持久化版本。
 */
export function auditResultConsistency(
  result: NestResult,
  stored: NestResult | null
): AuditItem[] {
  const items: AuditItem[] = []
  const sheets = result.sheets
  const boardsUsed = sheets.length
  const partCount = sheets.reduce((a, s) => a + s.placements.length, 0)
  const sawOps = countSawOps(sheets)

  // 1 结果页 KPI（boardsUsed）
  items.push({
    surface: '排样结果页（板数/件数/利用率）',
    ok: result.boardsUsed === boardsUsed,
    detail: `板数 ${result.boardsUsed}/${boardsUsed}，件数 ${partCount}`
  })
  // 2 裁切步骤页（走刀次数取 countSawOps(sheets)）
  const stepsTotal = sheets.reduce((a, s) => a + s.steps.length, 0)
  items.push({
    surface: '裁切步骤页（刀序/走刀次数）',
    ok: stepsTotal >= boardsUsed,
    detail: `逐板刀序共 ${stepsTotal} 刀，车间走刀（修边叠切计）${sawOps} 次`
  })
  // 3 材料统计按板汇总 = 逐板加总
  const byTypeSum = Object.values(result.boardsByType).reduce((a, n) => a + n, 0)
  const costSum = sheets.reduce((a, s) => a + s.priceCents, 0)
  const offcutSum = sheets.reduce(
    (a, s) => a + s.offcuts.filter((o) => o.usable).reduce((x, o) => x + o.areaMm2, 0),
    0
  )
  items.push({
    surface: '材料统计（按板用料/余料、板种、成本）',
    ok: byTypeSum === boardsUsed && costSum === result.totalCostCents,
    detail: `按板种张数加总 ${byTypeSum}/${boardsUsed}，成本加总 ${costSum}/${result.totalCostCents} 分，可用余料 ${(offcutSum / 1e6).toFixed(2)}m²`
  })
  // 4 打印单据与标签（遍历同一 sheets/placements）
  items.push({
    surface: '单据与标签打印（板数/件数）',
    ok: byTypeSum === boardsUsed,
    detail: `下料单 ${boardsUsed} 张、标签 ${partCount} 张（逐板遍历来的同源数）`
  })
  // 5 本机存档
  const storedSame = stored ? resultSignature(stored) === resultSignature(result) : false
  items.push({
    surface: '本机存档（持久化的那一版）',
    ok: !!stored && storedSame,
    detail: stored
      ? storedSame
        ? '存档与当前结果逐板逐件一致'
        : '存档仍是旧版：板号/坐标对不上（persist 未写成或读了缓存）'
      : '尚未持久化'
  })
  return items
}

/** 计划是否仍对应当前结果（防重复确认把同一件挪第二遍）。 */
export function planStillCurrent(result: NestResult, plan: OptimizePlan): boolean {
  return resultSignature(result) === plan.signature
}

/** 当前结果的版本签名（存档核对用）。 */
export function currentResultSignature(result: NestResult): string {
  return resultSignature(result)
}
