// 低利用率板诊断与调板试算（只出建议，不碰结果；确认后由 store 同口径执行）。
// 路线一·板上对换（小动）：别板上一件挪入本板现存空块，其他件坐标一律不动、
//   已排好的其它板不重排；逐块空块给出可挪件或“挪不进来”的原因；试算数全部内核重算。
// 路线二·跨板连锁（大动）：同板种成组，用同一排样判定试排 n-1 张；牵动板全部重排，
//   已发到车间的标签/下料单作废，走刀可能变多；试算划不来时写明原因。
import type {
  Board,
  Job,
  NestResult,
  Placement,
  RemixCandPart,
  RemixChainAdvice,
  RemixLocalAdvice,
  RemixReport,
  RemixSheetAdvice,
  RemixTrial,
  RemixVoid,
  SheetResult
} from '../types'
import {
  expandInstances,
  packFixedBoards,
  partMatchesBoard,
  type Inst
} from './packing'
import { countSawOps, rebuildFromPlacements } from './cuts'
import { guillotineViolation, type Rect } from './geometry'
import { verifyResult } from './verify'
import { EPS } from './geometry'

const USABLE_MIN = 300 - EPS // 与 buildSheet 的可用余料判定一致
const SCREEN_TOL = 1.2 // 整 mm 取整外的筛选容差；贯通/净距最终由内核判定兜底

/** 结果输入签名：板材/零件/锯路/修边/余料/分组任一变动即变（旧结果/旧建议自动过期）。 */
export function inputSignature(
  job: Job,
  boards: Pick<Board, 'id' | 'wMm' | 'hMm' | 'thicknessMm' | 'kind' | 'offcutId'>[]
): string {
  const b = boards
    .map((x) => [x.id, x.wMm, x.hMm, x.thicknessMm, x.kind ?? 'stock', x.offcutId ?? ''].join('|'))
    .sort()
  const p = job.parts
    .map((x) =>
      [
        x.id,
        x.lenMm,
        x.widMm,
        x.qty,
        x.grain,
        x.edgeBands.join(''),
        x.exposed ? 1 : 0,
        x.boardId ?? '',
        x.cabinet
      ].join('|')
    )
    .sort()
  const raw = JSON.stringify({
    b,
    p,
    k: job.kerfMm,
    t: job.trimMm,
    oc: [...job.useOffcutIds].sort(),
    g: job.batchByCabinet ? 1 : 0
  })
  let h = 5381
  for (let i = 0; i < raw.length; i++) h = ((h << 5) + h + raw.charCodeAt(i)) | 0
  return `sig${(h >>> 0).toString(36)}`
}

function voidsOf(sheet: SheetResult): RemixVoid[] {
  return sheet.offcuts.map((o, i) => ({
    index: i,
    xMm: o.x,
    yMm: o.y,
    wMm: o.wMm,
    hMm: o.hMm,
    areaMm2: o.areaMm2,
    usable: o.usable
  }))
}

/** 纹理/旋转允许的就位尺寸（与排样内核 orientsOf 同口径）。 */
function orientsOf(
  cand: Placement
): { pw: number; ph: number; rotated: boolean }[] {
  if (cand.grain === 'length') return [{ pw: cand.origLen, ph: cand.origWid, rotated: false }]
  if (cand.grain === 'width') return [{ pw: cand.origWid, ph: cand.origLen, rotated: false }]
  if (cand.origLen === cand.origWid)
    return [{ pw: cand.origLen, ph: cand.origWid, rotated: false }]
  return [
    { pw: cand.origLen, ph: cand.origWid, rotated: false },
    { pw: cand.origWid, ph: cand.origLen, rotated: true }
  ]
}

function leftoversToOffcuts(leftovers: Rect[]): SheetResult['offcuts'] {
  return leftovers
    .filter((r) => r.w >= 2 && r.h >= 2)
    .map((r) => ({
      x: Math.round(r.x),
      y: Math.round(r.y),
      wMm: Math.round(r.w),
      hMm: Math.round(r.h),
      areaMm2: Math.round(r.w * r.h),
      usable: r.w >= USABLE_MIN && r.h >= USABLE_MIN
    }))
    .sort((a, b) => b.areaMm2 - a.areaMm2)
}

function ocArea(sheets: SheetResult[]): number {
  return sheets.reduce(
    (a, s) => a + s.offcuts.filter((o) => o.usable).reduce((x, o) => x + o.areaMm2, 0),
    0
  )
}

function utilOfSheets(sheets: SheetResult[]): number {
  const used = sheets.reduce((a, s) => a + s.usedAreaMm2, 0)
  const area = sheets.reduce((a, s) => a + s.boardAreaMm2, 0)
  return area > 0 ? used / area : 0
}

export interface LocalTrialResult {
  trial: RemixTrial
  target: SheetResult
  donor: SheetResult | null // null = 施主板取空，整板移除（省一张）
  donorEmptied: boolean
  orientIndex: number
}

/** 路线一：把 cand 从 donor 挪到 target 板第 voidIdx 个空块，内核重算两张板。 */
function localTrial(
  job: Job,
  result: NestResult,
  targetIdx: number,
  donorIdx: number,
  cand: Placement,
  voidIdx: number
): LocalTrialResult | { error: string } {
  const kerf = job.kerfMm
  const trim = job.trimMm
  const target = result.sheets[targetIdx]
  const donor = result.sheets[donorIdx]
  const vInfo = target.offcuts[voidIdx]

  const ors = orientsOf(cand)
  const oi = ors.findIndex(
    (o) => o.pw <= vInfo.wMm + SCREEN_TOL && o.ph <= vInfo.hMm + SCREEN_TOL
  )
  if (oi < 0)
    return {
      error: `就位尺寸大于空块（${ors
        .map((o) => `${o.pw}×${o.ph}`)
        .join(' 或 ')} 放不进 ${vInfo.wMm}×${vInfo.hMm}mm）`
    }
  const o = ors[oi]

  // 空块坐标是整 mm 取整的，贴哪个角放要让锯缝净距合法：
  // 依次试左下/右下/左上/右上四个锚点，由 guillotine 内核裁决（只认真贯通）。
  const anchors: { x: number; y: number }[] = [
    { x: vInfo.x, y: vInfo.y },
    { x: vInfo.x + vInfo.wMm - o.pw, y: vInfo.y },
    { x: vInfo.x, y: vInfo.y + vInfo.hMm - o.ph },
    { x: vInfo.x + vInfo.wMm - o.pw, y: vInfo.y + vInfo.hMm - o.ph }
  ]

  const bounds: Rect = { x: trim, y: trim, w: target.wMm - 2 * trim, h: target.hMm - 2 * trim }
  const basePlacements = target.placements
    .filter((p) => p.instanceId !== cand.instanceId)
    .map((p) => ({ ...p }))

  let legalAnchor: { x: number; y: number } | null = null
  let rebuiltTarget: ReturnType<typeof rebuildFromPlacements> = null
  for (const a of anchors) {
    const candidate: Placement = {
      ...cand,
      boardIndex: target.index,
      x: Math.round(a.x),
      y: Math.round(a.y),
      lenMm: o.pw,
      widMm: o.ph,
      rotated: o.rotated,
      adjusted: true
    }
    const tryList = [...basePlacements, candidate]
    const viol = guillotineViolation(
      tryList.map((p) => ({ id: p.instanceId, x: p.x, y: p.y, w: p.lenMm, h: p.widMm })),
      bounds,
      kerf
    )
    if (viol) continue
    const rb = rebuildFromPlacements(target.wMm, target.hMm, kerf, trim, target.index, tryList)
    if (rb) {
      legalAnchor = { x: candidate.x, y: candidate.y }
      rebuiltTarget = rb
      break
    }
  }
  if (!legalAnchor || !rebuiltTarget)
    return { error: '四个角都试过：放进去会切断锯路或变成非贯通（塞缝）排法' }

  const newTargetPlacements: Placement[] = [
    ...basePlacements,
    {
      ...cand,
      boardIndex: target.index,
      x: legalAnchor.x,
      y: legalAnchor.y,
      lenMm: o.pw,
      widMm: o.ph,
      rotated: o.rotated,
      adjusted: true
    }
  ]

  const donorPlacements = donor.placements
    .filter((p) => p.instanceId !== cand.instanceId)
    .map((p) => ({ ...p }))
  let newDonor: SheetResult | null = null
  if (donorPlacements.length > 0) {
    const rebuiltDonor = rebuildFromPlacements(
      donor.wMm,
      donor.hMm,
      kerf,
      trim,
      donor.index,
      donorPlacements
    )
    if (!rebuiltDonor) return { error: '取走件后原板刀路无法重建' }
    const usedArea = donorPlacements.reduce((a, p) => a + p.origLen * p.origWid, 0)
    newDonor = {
      ...donor,
      placements: donorPlacements.map((p) => ({ ...p, adjusted: true })),
      steps: rebuiltDonor.steps,
      offcuts: leftoversToOffcuts(rebuiltDonor.leftovers),
      usedAreaMm2: usedArea,
      utilization: donor.boardAreaMm2 > 0 ? usedArea / donor.boardAreaMm2 : 0,
      adjusted: true
    }
  }

  const ntUsed = newTargetPlacements.reduce((a, p) => a + p.origLen * p.origWid, 0)
  const newTargetSheet: SheetResult = {
    ...target,
    placements: newTargetPlacements.map((p) => ({ ...p, adjusted: true })),
    steps: rebuiltTarget!.steps,
    offcuts: leftoversToOffcuts(rebuiltTarget!.leftovers),
    usedAreaMm2: ntUsed,
    utilization: target.boardAreaMm2 > 0 ? ntUsed / target.boardAreaMm2 : 0,
    adjusted: true
  }

  const donorEmptied = donorPlacements.length === 0
  const touched = donorEmptied ? [targetIdx] : [targetIdx, donorIdx]
  const boardsBefore = result.sheets.length
  const boardsAfter = boardsBefore - (donorEmptied ? 1 : 0)

  const afterSheets: SheetResult[] = []
  result.sheets.forEach((s, i) => {
    if (i === targetIdx) afterSheets.push(newTargetSheet)
    else if (i === donorIdx) {
      if (newDonor) afterSheets.push(newDonor)
    } else afterSheets.push(s)
  })
  const sawBefore = countSawOps(result.sheets)
  const sawAfter = countSawOps(afterSheets)
  const oldTouched = [targetIdx, donorIdx].map((i) => result.sheets[i])
  const newTouched = donorEmptied ? [newTargetSheet] : [newTargetSheet, newDonor!]

  const trial: RemixTrial = {
    feasible: true,
    reason: '',
    boardsBefore,
    boardsAfter,
    boardsSaved: boardsBefore - boardsAfter,
    sawOpsBefore: sawBefore,
    sawOpsAfter: sawAfter,
    sawOpsDelta: sawAfter - sawBefore,
    offcutAreaBeforeMm2: ocArea(result.sheets),
    offcutAreaAfterMm2: ocArea(afterSheets),
    offcutAreaDeltaMm2: ocArea(afterSheets) - ocArea(result.sheets),
    utilizationBefore: utilOfSheets(oldTouched),
    utilizationAfter: utilOfSheets(newTouched),
    sheetsTouched: touched,
    voidedDocs: donorEmptied
      ? [`第 ${donorIdx + 1} 张板标签（该板不再开）`, `第 ${targetIdx + 1} 张板标签/下料单`]
      : [`第 ${targetIdx + 1}、${donorIdx + 1} 张板的标签与下料单`]
  }
  return { trial, target: newTargetSheet, donor: newDonor, donorEmptied, orientIndex: oi }
}

interface ChainGroup {
  boardId: string
  board: Board
  idxs: number[]
  insts: Inst[]
}

function buildChainGroups(
  job: Job,
  result: NestResult,
  effectiveBoards: Board[]
): ChainGroup[] {
  const boardById = new Map(effectiveBoards.map((b) => [b.id, b]))
  const groups = new Map<string, ChainGroup>()
  result.sheets.forEach((s) => {
    const def = boardById.get(s.boardId)
    if (!def || def.kind === 'offcut') return // 登记余料小板只有一块，不存在省一张
    let g = groups.get(s.boardId)
    if (!g) {
      g = { boardId: s.boardId, board: def, idxs: [], insts: [] }
      groups.set(s.boardId, g)
    }
    g.idxs.push(s.index)
  })
  const instByKey = new Map<string, Inst>()
  for (const inst of expandInstances(job)) instByKey.set(inst.key, inst)
  for (const g of groups.values()) {
    for (const idx of g.idxs)
      for (const p of result.sheets[idx].placements) {
        const inst = instByKey.get(p.instanceId)
        if (inst) g.insts.push(inst)
      }
  }
  return [...groups.values()].filter((g) => g.idxs.length >= 2)
}

function chainTrial(
  job: Job,
  result: NestResult,
  g: ChainGroup
): RemixChainAdvice {
  const n = g.idxs.length
  const notes = [
    `第 ${g.idxs.map((i) => i + 1).join('、')} 张板全部重新排样，未牵动的板一张不碰。`,
    '重排前发到车间的标签、下料单与排样图全部作废，确认后按新刀路重新打印。',
    '存在挪完反而多切几刀的风险，走刀次数以试算为准（可能增加）。'
  ]
  const t0 = performance.now()
  const packed = packFixedBoards(g.board, g.insts, job.kerfMm, job.trimMm, n - 1)
  const elapsedMs = Math.round(performance.now() - t0)
  if (!packed) {
    return {
      feasible: false,
      reason: `同一套贯通/余隙/修边判定下换序试排 ${elapsedMs}ms，这 ${g.insts.length} 件仍压不进 ${n - 1} 张：至少要开 ${n} 张，省不出一整张，连锁不划算。`,
      trial: null,
      notes
    }
  }
  // 逐板模拟 + 件数守恒（组内件数必须一件不少）
  const probe: NestResult = {
    ...result,
    sheets: packed.map((s, i) => ({ ...s, index: g.idxs[0] + i }))
  }
  const ver = verifyResult(job, probe, g.insts.length)
  if (!ver.ok) {
    return {
      feasible: false,
      reason: `试排张数达标但内核校验未过：${ver.issues[0]?.detail ?? '未知'}，不予建议。`,
      trial: null,
      notes
    }
  }
  const replaced: SheetResult[] = []
  let pi = 0
  result.sheets.forEach((s, i) => {
    if (g.idxs.includes(i)) {
      if (pi < packed.length) replaced.push({ ...packed[pi], index: i })
      pi++
    } else replaced.push(s)
  })
  const sawBefore = countSawOps(result.sheets)
  const sawAfter = countSawOps(replaced)
  const trial: RemixTrial = {
    feasible: true,
    reason: '',
    boardsBefore: result.sheets.length,
    boardsAfter: result.sheets.length - (n - packed.length),
    boardsSaved: n - packed.length,
    sawOpsBefore: sawBefore,
    sawOpsAfter: sawAfter,
    sawOpsDelta: sawAfter - sawBefore,
    offcutAreaBeforeMm2: ocArea(result.sheets),
    offcutAreaAfterMm2: ocArea(replaced),
    offcutAreaDeltaMm2: ocArea(replaced) - ocArea(result.sheets),
    utilizationBefore: utilOfSheets(g.idxs.map((i) => result.sheets[i])),
    utilizationAfter: utilOfSheets(packed),
    sheetsTouched: g.idxs,
    voidedDocs: [
      `第 ${g.idxs.map((i) => i + 1).join('、')} 张板的标签、下料单与排样图全部作废重打`
    ]
  }
  return { feasible: true, reason: '', trial, notes }
}

/** 生成整份低利用率诊断。一张板都没排下时返回空诊断，页面不出任何行。 */
export function analyzeRemix(
  job: Job,
  result: NestResult,
  floorPct: number,
  effectiveBoards: Board[]
): RemixReport {
  const t0 = performance.now()
  const sig = inputSignature(job, effectiveBoards)
  const sheets: RemixSheetAdvice[] = []
  const lowSheets: number[] = []
  const totalSheets = result.sheets.length

  if (totalSheets > 0) {
    const groups = buildChainGroups(job, result, effectiveBoards)
    const boardById = new Map(effectiveBoards.map((b) => [b.id, b]))
    const instByKey = new Map(expandInstances(job).map((i) => [i.key, i]))

    result.sheets.forEach((sheet, si) => {
      if (sheet.utilization * 100 + 1e-9 >= floorPct) return
      lowSheets.push(si)
      const voids = voidsOf(sheet)
      const targetDef = boardById.get(sheet.boardId)
      const movableIn: RemixCandPart[] = []
      let boardFail = 0
      let hardFail = 0
      let fitOk = 0

      result.sheets.forEach((donor, di) => {
        if (di === si) return
        for (const cand of donor.placements) {
          const inst = instByKey.get(cand.instanceId)
          // 板种/厚度兼容（与排样内核 partMatchesBoard 同一条规则）
          const compatible =
            !!targetDef && !!inst && partMatchesBoard(inst.part, targetDef, boardById)
          if (!compatible) {
            boardFail++
            movableIn.push({
              instanceId: cand.instanceId,
              code: cand.code,
              name: cand.name,
              cabinet: cand.cabinet,
              fromSheet: di,
              lenMm: cand.lenMm,
              widMm: cand.widMm,
              grain: cand.grain,
              rotated: false,
              fitVoid: -1,
              reason: '板种/厚度不同，不能挪到这张板'
            })
            continue
          }
          const ors = orientsOf(cand)
          const vi = voids.findIndex(
            (v) =>
              ors.some((o) => o.pw <= v.wMm + SCREEN_TOL && o.ph <= v.hMm + SCREEN_TOL)
          )
          if (vi < 0) {
            hardFail++
            movableIn.push({
              instanceId: cand.instanceId,
              code: cand.code,
              name: cand.name,
              cabinet: cand.cabinet,
              fromSheet: di,
              lenMm: cand.lenMm,
              widMm: cand.widMm,
              grain: cand.grain,
              rotated: false,
              fitVoid: -1,
              reason: `哪块空块都放不下（${ors
                .map((o) => `${o.pw}×${o.ph}`)
                .join(' 或 ')}mm 大于全部空块）`
            })
            continue
          }
          // 尺寸初筛过了，交给内核做贯通/模拟试算（真做得到才算数）
          const tr = localTrial(job, result, si, di, cand, vi)
          if ('error' in tr) {
            hardFail++
            movableIn.push({
              instanceId: cand.instanceId,
              code: cand.code,
              name: cand.name,
              cabinet: cand.cabinet,
              fromSheet: di,
              lenMm: cand.lenMm,
              widMm: cand.widMm,
              grain: cand.grain,
              rotated: false,
              fitVoid: -1,
              reason: tr.error
            })
            continue
          }
          fitOk++
          movableIn.push({
            instanceId: cand.instanceId,
            code: cand.code,
            name: cand.name,
            cabinet: cand.cabinet,
            fromSheet: di,
            lenMm: cand.lenMm,
            widMm: cand.widMm,
            grain: cand.grain,
            rotated: tr.orientIndex === 1,
            fitVoid: vi,
            reason: ''
          })
        }
      })

      // 试算最优的一件：先比省板数，再比牵动板利用率，再比走刀增量
      let best: (RemixTrial & { instanceId: string }) | null = null
      for (const c of movableIn.filter((x) => x.fitVoid >= 0)) {
        const cand = result.sheets[c.fromSheet].placements.find(
          (p) => p.instanceId === c.instanceId
        )!
        const tr = localTrial(job, result, si, c.fromSheet, cand, c.fitVoid)
        if ('error' in tr) continue
        const cur = { ...tr.trial, instanceId: c.instanceId }
        const scoreOf = (t: typeof cur): number =>
          t.boardsSaved * 1e9 + t.utilizationAfter * 1e6 - t.sawOpsDelta * 1e3
        if (!best || scoreOf(cur) > scoreOf(best)) best = cur
      }

      const noneFitReason =
        result.sheets.length <= 1
          ? '只有这一张板，没有“别处的件”可挪。'
          : fitOk === 0
            ? `别板共 ${movableIn.length} 件：${boardFail} 件板种/厚度不兼容，${hardFail} 件尺寸或贯通放不下，没有挪得进来的。`
            : ''
      const local: RemixLocalAdvice = {
        movableIn,
        noneFitReason,
        best,
        notes: [
          '让：只动目标板空块与被挪的那一件，其他件坐标不动，已排好的其它板一张不碰。',
          '代价：通常省不下一整张板；牵动的两张板要重出标签/下料单，走刀次数以试算为准（可能略增）。'
        ]
      }
      const g = groups.find((gg) => gg.idxs.includes(si))
      const chain: RemixChainAdvice = g
        ? chainTrial(job, result, g)
        : {
            feasible: false,
            reason: '同板种只有这一张板，没有可连锁挪动的其它板。',
            trial: null,
            notes: []
          }
      sheets.push({
        sheetIndex: si,
        boardName: sheet.boardName,
        utilization: sheet.utilization,
        voids,
        local,
        chain
      })
    })
  }

  return {
    floorPct,
    inputSig: sig,
    baseRev: result.rev ?? 0,
    totalSheets,
    lowSheets,
    sheets,
    elapsedMs: Math.round(performance.now() - t0)
  }
}

// —— 确认执行：试算过的两条路线在这里重算一遍要写回的板（store 负责校验/回退/写存档）——

export interface LocalApplyPlan {
  targetIdx: number
  donorIdx: number
  instanceId: string
  target: SheetResult
  donor: SheetResult | null
  donorEmptied: boolean
}

export function planLocalMove(
  job: Job,
  result: NestResult,
  targetIdx: number,
  instanceId: string
): LocalApplyPlan | { error: string } {
  const found = findLocalHit(job, result, targetIdx, instanceId)
  if (!found) return { error: '该件已无法挪入（建议可能已过期，请重新诊断）' }
  const tr = localTrial(job, result, targetIdx, found.di, found.cand, found.vi)
  if ('error' in tr) return { error: tr.error }
  return {
    targetIdx,
    donorIdx: found.di,
    instanceId,
    target: tr.target,
    donor: tr.donor,
    donorEmptied: tr.donorEmptied
  }
}

function findLocalHit(
  job: Job,
  result: NestResult,
  targetIdx: number,
  instanceId: string
): { di: number; cand: Placement; vi: number } | null {
  void job
  for (let di = 0; di < result.sheets.length; di++) {
    if (di === targetIdx) continue
    const cand = result.sheets[di].placements.find((p) => p.instanceId === instanceId)
    if (!cand) continue
    const ors = orientsOf(cand)
    const vi = result.sheets[targetIdx].offcuts.findIndex((v) =>
      ors.some((o) => o.pw <= v.wMm + SCREEN_TOL && o.ph <= v.hMm + SCREEN_TOL)
    )
    if (vi >= 0) return { di, cand, vi }
  }
  return null
}

export function planChainMove(
  job: Job,
  result: NestResult,
  targetIdx: number,
  effectiveBoards: Board[]
): { groupIdxs: number[]; packed: SheetResult[] } | { error: string } {
  const g = buildChainGroups(job, result, effectiveBoards).find((gg) =>
    gg.idxs.includes(targetIdx)
  )
  if (!g) return { error: '没有可连锁的同板种板组' }
  const packed = packFixedBoards(g.board, g.insts, job.kerfMm, job.trimMm, g.idxs.length - 1)
  if (!packed) return { error: '连锁试排已压不进 n-1 张（建议可能已过期）' }
  return { groupIdxs: g.idxs, packed }
}
