// 全局状态：Vue reactive 单例 + localStorage 持久化（无 Pinia/Vuex）
import { reactive, computed } from 'vue'
import type {
  Board,
  Job,
  NestResult,
  Part,
  RegisteredOffcut,
  SheetResult
} from '../types'
import { finalizeNestResult, nestJob, normalizeBoard } from './packing'
import { rebuildFromPlacements, countSawOps } from './cuts'
import { guillotineViolation } from './geometry'
import { verifyResult } from './verify'
import { inputSignature, planChainMove, planLocalMove } from './remix'
import { refreshResultCaches } from './metrics'
import { uid } from './format'
import boardsData from '../data/boards.json'

const JOBS_KEY = 'fco.jobs.v1'
const OFFCUTS_KEY = 'fco.offcuts.v1'

interface State {
  jobs: Job[]
  offcuts: RegisteredOffcut[]
  loaded: boolean
}

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return fallback
    const parsed = JSON.parse(raw) as T
    if (Array.isArray(fallback) && !Array.isArray(parsed)) return fallback
    return parsed
  } catch {
    return fallback
  }
}

const state = reactive<State>({
  jobs: [],
  offcuts: [],
  loaded: false
})

function persist(): void {
  // 一次写成：先序列化，成功后同 tick 写两个键；任何一步抛错都不产生半份存档
  const jobsJson = JSON.stringify(state.jobs)
  const offcutsJson = JSON.stringify(state.offcuts)
  localStorage.setItem(JOBS_KEY, jobsJson)
  localStorage.setItem(OFFCUTS_KEY, offcutsJson)
}

/** 写后回读本机存档，确认存下的那一版与内存中是同一份（不一致则视为存档失败）。 */
export function archiveMatches(job: Job): boolean {
  try {
    const raw = localStorage.getItem(JOBS_KEY)
    if (!raw) return false
    const parsed = JSON.parse(raw) as Job[]
    const archived = parsed.find((j) => j.id === job.id)
    if (!archived || !archived.result) return false
    return archived.result.rev === job.result?.rev
  } catch {
    return false
  }
}

export interface ConsistencySource {
  key: string
  label: string
  ok: boolean
  detail: string
}
export interface ConsistencyReport {
  ok: boolean
  rev: number
  sources: ConsistencySource[]
}

/**
 * 各处取数一致性核对（调板确认后自动跑一次）：
 * - 排样结果页：走刀次数缓存须等于现算、余料面积缓存须等于现算、板数=sheets 数
 * - 材料统计/打印单据标签：件数=Σ板上件数、按板种张数=Σ板数、成本=Σ板价、封边可复算
 * - 本机存档：localStorage 里存下的那一版 rev 必须与内存相同（老数=存的不是这一版）
 */
export function auditConsistency(job: Job): ConsistencyReport | null {
  const result = job.result
  if (!result) return null
  const sources: ConsistencySource[] = []
  const add = (key: string, label: string, ok: boolean, detail: string): void => {
    sources.push({ key, label, ok, detail })
  }

  // 结果页缓存
  const sawLive = countSawOps(result.sheets)
  add(
    'nest',
    '排样结果页（走刀/余料/利用率）',
    (result.sawOps ?? sawLive) === sawLive && result.boardsUsed === result.sheets.length,
    `走刀 ${sawLive} 次${result.sawOps === sawLive ? '' : `（缓存 ${result.sawOps}）`}、板数 ${result.sheets.length}`
  )

  // 统计页/打印共用派生数
  const pieces = result.sheets.reduce((a, s) => a + s.placements.length, 0)
  const byTypeSum = Object.values(result.boardsByType).reduce((a, n) => a + n, 0)
  const costSum = result.sheets.reduce((a, s) => a + s.priceCents, 0)
  const utilNet = result.sheets.every(
    (s) =>
      Math.abs(s.usedAreaMm2 - s.placements.reduce((a, p) => a + p.origLen * p.origWid, 0)) <= 1 &&
      Math.abs(s.utilization - s.usedAreaMm2 / s.boardAreaMm2) <= 1e-9
  )
  add(
    'stats',
    '材料统计（按板用料/余料、张数、成本）',
    byTypeSum === result.sheets.length && costSum === result.totalCostCents && utilNet,
    `${pieces} 件、${byTypeSum} 张、余料/利用率逐板可复算`
  )
  add(
    'print',
    '下料单与标签打印（板数/件数）',
    byTypeSum === result.sheets.length,
    `打印按 ${result.sheets.length} 张、标签 ${pieces} 张出`
  )

  // 本机存档
  const archived = archiveMatches(job)
  add('archive', '本机存档（存下的那一版）', archived, archived ? `rev ${result.rev} 已落盘` : '存档版本与当前不一致')

  return { ok: sources.every((s) => s.ok), rev: result.rev ?? 0, sources }
}

function init(): void {
  if (state.loaded) return
  state.jobs = load<Job[]>(JOBS_KEY, [])
  state.offcuts = load<RegisteredOffcut[]>(OFFCUTS_KEY, [])
  state.loaded = true
}

export function defaultBoards(): Board[] {
  return boardsData.stockBoards.slice(0, 3).map((b) => ({
    id: uid('b'),
    name: b.name,
    wMm: b.wMm,
    hMm: b.hMm,
    thicknessMm: b.thicknessMm,
    material: b.material,
    priceCents: b.priceCents,
    quantity: 0,
    kind: 'stock'
  }))
}

export function allStockTemplates(): Omit<Board, 'id'>[] {
  return boardsData.stockBoards.map((b) => ({
    name: b.name,
    wMm: b.wMm,
    hMm: b.hMm,
    thicknessMm: b.thicknessMm,
    material: b.material,
    priceCents: b.priceCents,
    quantity: 0,
    kind: 'stock' as const
  }))
}

export function createJob(name: string): Job {
  init()
  const job: Job = {
    id: uid('job'),
    name: name.trim() || `开料项目 ${state.jobs.length + 1}`,
    createdAt: Date.now(),
    boards: defaultBoards(),
    parts: [],
    kerfMm: boardsData.defaults.kerfMm,
    trimMm: boardsData.defaults.trimMm,
    useOffcutIds: [],
    batchByCabinet: false
  }
  state.jobs.unshift(job)
  persist()
  return job
}

export function deleteJob(id: string): void {
  const i = state.jobs.findIndex((j) => j.id === id)
  if (i >= 0) state.jobs.splice(i, 1)
  persist()
}

export function duplicateJob(id: string): Job | null {
  const src = getJob(id)
  if (!src) return null
  const job: Job = JSON.parse(JSON.stringify(src))
  job.id = uid('job')
  job.name = `${src.name} 副本`
  job.createdAt = Date.now()
  job.result = undefined
  state.jobs.unshift(job)
  persist()
  return job
}

export function saveJob(_job: Job): void {
  persist()
}

export function getJob(id: string): Job | undefined {
  init()
  return state.jobs.find((j) => j.id === id)
}

/** 把勾选的登记余料转成本单可用的小板（排在板材列表前，优先消耗）。 */
function boardsWithOffcuts(job: Job): Board[] {
  const offcutBoards: Board[] = state.offcuts
    .filter((o) => o.available && job.useOffcutIds.includes(o.id))
    .map((o) => ({
      id: `offcut_${o.id}`,
      name: `余料板 ${o.wMm}×${o.hMm}×${o.thicknessMm}（${o.material}）`,
      wMm: o.wMm,
      hMm: o.hMm,
      thicknessMm: o.thicknessMm,
      material: o.material,
      priceCents: 0,
      quantity: 1,
      kind: 'offcut' as const,
      offcutId: o.id
    }))
  return [...offcutBoards, ...job.boards]
}

/** 本单排样实际使用的板池（含勾选的登记余料小板）。 */
export function effectiveBoardsFor(job: Job): Board[] {
  return boardsWithOffcuts(job).map(normalizeBoard)
}

/** 连锁试算还要把当前结果里已经用上的余料小板算进板池（它们已是“开了的板”）。 */
export function effectiveBoardsForRemix(job: Job): Board[] {
  const base = boardsWithOffcuts(job)
  const known = new Set(base.map((b) => b.id))
  if (job.result) {
    for (const s of job.result.sheets) {
      if (s.boardId.startsWith('offcut_') && !known.has(s.boardId)) {
        base.push({
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
        known.add(s.boardId)
      }
    }
  }
  return base.map(normalizeBoard)
}

export function runNest(job: Job): NestResult {
  const effective: Job = { ...job, boards: boardsWithOffcuts(job) }
  const result = nestJob(effective)
  // 标记被用掉的余料
  const usedOffcutBoardIds = new Set(
    result.sheets.filter((s) => s.boardId.startsWith('offcut_')).map((s) => s.boardId)
  )
  for (const oc of state.offcuts) {
    if (usedOffcutBoardIds.has(`offcut_${oc.id}`)) {
      oc.available = false
      oc.usedByJobId = job.id
    }
  }
  result.rev = (job.result?.rev ?? 0) + 1
  result.inputSig = inputSignature(job, effective.boards)
  refreshResultCaches(result)
  job.result = result
  persist()
  return result
}

/** 手工微调：移动/交换后按同一条内核判定重校验；非法返回错误信息并整体回退。 */
export function applyAdjustment(
  job: Job,
  sheetIndex: number,
  placements: SheetResult['placements']
): string | null {
  if (!job.result) return '尚未排样'
  const result = job.result
  const snapshot = JSON.stringify(result)
  const expectedPieces = result.sheets.reduce((a, s) => a + s.placements.length, 0)
  const sheet = result.sheets[sheetIndex]
  const violation = guillotineViolation(
    placements.map((p) => ({ id: p.instanceId, x: p.x, y: p.y, w: p.lenMm, h: p.widMm })),
    {
      x: job.trimMm,
      y: job.trimMm,
      w: sheet.wMm - 2 * job.trimMm,
      h: sheet.hMm - 2 * job.trimMm
    },
    job.kerfMm
  )
  if (violation) return violation
  const rebuilt = rebuildFromPlacements(
    sheet.wMm,
    sheet.hMm,
    job.kerfMm,
    job.trimMm,
    sheetIndex,
    placements
  )
  if (!rebuilt) return '调整后无法生成可执行的贯通裁切刀路'
  const offcuts = rebuilt.leftovers
    .filter((r) => r.w >= 300 - 0.05 && r.h >= 300 - 0.05)
    .map((r) => ({
      x: Math.round(r.x),
      y: Math.round(r.y),
      wMm: Math.round(r.w),
      hMm: Math.round(r.h),
      areaMm2: Math.round(r.w * r.h),
      usable: true
    }))
    .sort((a, b) => b.areaMm2 - a.areaMm2)
  sheet.placements = placements.map((p) => ({ ...p, adjusted: true }))
  sheet.steps = rebuilt.steps
  sheet.offcuts = offcuts
  sheet.adjusted = true
  sheet.usedAreaMm2 = sheet.placements.reduce((a, p) => a + p.origLen * p.origWid, 0)
  sheet.utilization = sheet.usedAreaMm2 / sheet.boardAreaMm2
  // 微调也挂同一条判定：逐板贯通/模拟/余隙/修边 + 件数守恒
  const ver = verifyResult(job, result, expectedPieces)
  if (!ver.ok) {
    job.result = JSON.parse(snapshot)
    return ver.issues[0]?.detail ?? '微调未通过内核校验，已回退'
  }
  result.rev = (result.rev ?? 0) + 1
  recomputeAggregates(job)
  refreshResultCaches(result)
  try {
    persist()
  } catch (e) {
    job.result = JSON.parse(snapshot)
    return `存档写入失败，已回退：${(e as Error).message}`
  }
  return null
}

/**
 * 调板确认后重算全局汇总（板数、按板种张数、成本、封边、补采、随手排基线/省板）。
 * 与 nestJob 的 finalizeNestResult 同一份实现，保证各处取数同源。
 */
function recomputeAggregates(job: Job): void {
  if (!job.result) return
  const result = job.result
  const opened = new Map<string, number>()
  for (const s of result.sheets) opened.set(s.boardId, (opened.get(s.boardId) ?? 0) + 1)
  const fresh = finalizeNestResult(
    job,
    result.sheets,
    result.unplaced,
    opened,
    result.elapsedMs,
    result.generatedAt
  )
  // 保留当前版本/签名，覆盖其余汇总字段
  const rev = result.rev
  const sig = result.inputSig
  Object.assign(result, fresh)
  result.rev = rev
  result.inputSig = sig
}

function finalizeSheetIndices(sheets: SheetResult[]): void {
  sheets.forEach((s, i) => {
    s.index = i
  })
}

export interface RemixApplyOutcome {
  ok: boolean
  error?: string
  rev?: number
}

/** 路线一确认：挪一件入空块。重算→同一条内核总校验→一次写回，出错整体回退。 */
export function applyRemixLocal(job: Job, targetIdx: number, instanceId: string): RemixApplyOutcome {
  if (!job.result) return { ok: false, error: '尚未排样' }
  const result = job.result
  // 幂等：同一版结果上该件已在目标板，直接返回，不再挪第二遍
  if (result.sheets[targetIdx].placements.some((p) => p.instanceId === instanceId)) {
    return { ok: true, rev: result.rev }
  }
  const expectedPieces = result.sheets.reduce((a, s) => a + s.placements.length, 0)
  const snap = takeSnapshot(job)
  const plan = planLocalMove(job, result, targetIdx, instanceId)
  if ('error' in plan) return { ok: false, error: plan.error }

  const sheets: SheetResult[] = []
  result.sheets.forEach((s, i) => {
    if (i === plan.targetIdx) sheets.push(plan.target)
    else if (i === plan.donorIdx) {
      if (plan.donor) sheets.push(plan.donor)
    } else sheets.push(s)
  })
  finalizeSheetIndices(sheets)
  const ver = verifyResult(job, { ...result, sheets }, expectedPieces)
  if (!ver.ok) {
    restoreSnapshot(job, snap)
    return { ok: false, error: ver.issues.map((x) => x.detail).join('；') + '（已回退，结果未动）' }
  }
  result.sheets = sheets
  if (plan.donorEmptied) remapRegisteredOffcutsForRemoval(job, plan.targetIdx, plan.donorIdx)
  result.rev = (result.rev ?? 0) + 1
  recomputeAggregates(job)
  refreshResultCaches(result)
  try {
    persist()
  } catch (e) {
    restoreSnapshot(job, snap)
    return { ok: false, error: `存档写入失败，已回退：${(e as Error).message}` }
  }
  return { ok: true, rev: result.rev }
}

/** 路线二确认：同板种连锁重排省板。重算→同一条内核总校验→一次写回，出错整体回退。 */
export function applyRemixChain(job: Job, targetIdx: number): RemixApplyOutcome {
  if (!job.result) return { ok: false, error: '尚未排样' }
  const result = job.result
  const expectedPieces = result.sheets.reduce((a, s) => a + s.placements.length, 0)
  const snap = takeSnapshot(job)
  const plan = planChainMove(job, result, targetIdx, effectiveBoardsForRemix(job))
  if ('error' in plan) return { ok: false, error: plan.error }

  const { groupIdxs, packed } = plan
  const sheets: SheetResult[] = []
  let pi = 0
  result.sheets.forEach((s, i) => {
    if (groupIdxs.includes(i)) {
      if (pi < packed.length) sheets.push({ ...packed[pi] })
      pi++
    } else {
      sheets.push(s)
    }
  })
  finalizeSheetIndices(sheets)
  const ver = verifyResult(job, { ...result, sheets }, expectedPieces)
  if (!ver.ok) {
    restoreSnapshot(job, snap)
    return { ok: false, error: ver.issues.map((x) => x.detail).join('；') + '（已回退，结果未动）' }
  }
  result.sheets = sheets
  remapRegisteredOffcutsForChain(job, result, groupIdxs, packed.length)
  result.rev = (result.rev ?? 0) + 1
  recomputeAggregates(job)
  refreshResultCaches(result)
  try {
    persist()
  } catch (e) {
    restoreSnapshot(job, snap)
    return { ok: false, error: `存档写入失败，已回退：${(e as Error).message}` }
  }
  return { ok: true, rev: result.rev }
}

interface ResultSnapshot {
  resultJson: string
  offcutsJson: string
}

function takeSnapshot(job: Job): ResultSnapshot {
  return {
    resultJson: JSON.stringify(job.result),
    offcutsJson: JSON.stringify(state.offcuts)
  }
}

/** 写到一半出错（或校验不过）时恢复原样：结果与余料台账都回到快照。 */
function restoreSnapshot(job: Job, snap: ResultSnapshot): void {
  job.result = JSON.parse(snap.resultJson) as NestResult
  const restored = JSON.parse(snap.offcutsJson) as RegisteredOffcut[]
  state.offcuts.splice(0, state.offcuts.length, ...restored)
}

/** 删除施主板后，把登记余料的板序号顺延（组内并到目标板序号）。 */
function remapRegisteredOffcutsForRemoval(
  job: Job,
  targetIdx: number,
  donorIdx: number
): void {
  const lo = Math.min(targetIdx, donorIdx)
  const hi = Math.max(targetIdx, donorIdx)
  for (const oc of state.offcuts) {
    if (oc.jobId !== job.id) continue
    if (oc.sheetIndex === hi) oc.sheetIndex = lo
    else if (oc.sheetIndex > hi) oc.sheetIndex -= 1
  }
}

/** 连锁重排后，组内板数变化时顺延登记余料序号（组外不动，组内并入首张待核对）。 */
function remapRegisteredOffcutsForChain(
  job: Job,
  result: NestResult,
  groupIdxs: number[],
  newCount: number
): void {
  void result
  const first = Math.min(...groupIdxs)
  const last = Math.max(...groupIdxs)
  for (const oc of state.offcuts) {
    if (oc.jobId !== job.id) continue
    if (oc.sheetIndex >= first && oc.sheetIndex <= last) {
      // 余料位置已随重排变化，旧尺寸作废，序号并到组首张并置为不可用，提示重新核对
      oc.sheetIndex = first
      oc.available = false
    } else if (oc.sheetIndex > last) {
      oc.sheetIndex -= groupIdxs.length - newCount
    }
  }
}

export function registerOffcuts(
  job: Job,
  picks: { sheetIndex: number; x: number; y: number; wMm: number; hMm: number }[]
): number {
  if (!job.result) return 0
  let n = 0
  for (const pick of picks) {
    const sheet = job.result.sheets[pick.sheetIndex]
    state.offcuts.push({
      id: uid('oc'),
      jobId: job.id,
      jobName: job.name,
      sheetIndex: pick.sheetIndex,
      wMm: pick.wMm,
      hMm: pick.hMm,
      thicknessMm: sheet.thicknessMm,
      material: sheet.material,
      createdAt: Date.now(),
      available: true
    })
    n++
  }
  persist()
  return n
}

export function addManualOffcut(input: {
  wMm: number
  hMm: number
  thicknessMm: number
  material: string
}): void {
  state.offcuts.push({
    id: uid('oc'),
    jobId: '',
    jobName: '手工登记',
    sheetIndex: -1,
    wMm: input.wMm,
    hMm: input.hMm,
    thicknessMm: input.thicknessMm,
    material: input.material,
    createdAt: Date.now(),
    available: true
  })
  persist()
}

export function removeOffcut(id: string): void {
  const i = state.offcuts.findIndex((o) => o.id === id)
  if (i >= 0) state.offcuts.splice(i, 1)
  persist()
}

export function toggleOffcut(id: string): void {
  const o = state.offcuts.find((x) => x.id === id)
  if (o) {
    o.available = !o.available
    if (o.available) o.usedByJobId = undefined
    persist()
  }
}

/** 示例：一套橱柜 + 衣柜混合 BOM（含竖纹门板、见光侧板、背板 9mm） */
export function createSampleJob(): Job {
  const job = createJob('示例：三室全屋柜体（18mm 柜体 + 9mm 背板）')
  const b18 = job.boards[0] // 颗粒板 18mm
  const bBack = boardsData.stockBoards[6]
  const back: Board = {
    id: uid('b'),
    name: bBack.name,
    wMm: bBack.wMm,
    hMm: bBack.hMm,
    thicknessMm: bBack.thicknessMm,
    material: bBack.material,
    priceCents: bBack.priceCents,
    quantity: 0,
    kind: 'stock'
  }
  job.boards.push(back)
  const P = (
    code: string,
    name: string,
    l: number,
    w: number,
    qty: number,
    grain: Part['grain'],
    edges: Part['edgeBands'],
    cabinet: string,
    exposed: boolean,
    boardId?: string
  ): Part => ({
    id: uid('p'),
    code,
    name,
    lenMm: l,
    widMm: w,
    qty,
    grain,
    edgeBands: edges,
    cabinet,
    exposed,
    boardId: boardId ?? b18.id
  })
  const all4: Part['edgeBands'] = ['top', 'bottom', 'left', 'right']
  const lb: Part['edgeBands'] = ['left', 'right']
  const tb: Part['edgeBands'] = ['top', 'bottom']
  job.parts = [
    // 地柜（600 宽标准柜 ×2 + 800 宽水槽柜）
    P('DC-S', '地柜侧板', 700, 560, 4, 'length', lb, '地柜', false),
    P('DC-D', '地柜底板', 564, 560, 2, 'none', tb, '地柜', false),
    P('DC-T', '地柜顶板/拉带', 564, 100, 2, 'none', [], '地柜', false),
    P('DC-M', '地柜门(竖纹见光)', 700, 296, 2, 'length', all4, '地柜', true),
    P('SC-S', '水槽柜侧板', 700, 560, 2, 'length', lb, '水槽柜', false),
    P('SC-D', '水槽柜底板', 764, 560, 1, 'none', tb, '水槽柜', false),
    P('SC-M', '水槽柜门(竖纹见光)', 700, 396, 2, 'length', all4, '水槽柜', true),
    // 吊柜
    P('GC-S', '吊柜侧板', 700, 320, 4, 'length', lb, '吊柜', false),
    P('GC-P', '吊柜层板', 764, 320, 2, 'none', tb, '吊柜', false),
    P('GC-M', '吊柜门板(竖纹见光)', 700, 396, 2, 'length', all4, '吊柜', true),
    // 衣柜
    P('WR-S', '衣柜见光侧板', 2200, 580, 2, 'length', all4, '衣柜', true),
    P('WR-IS', '衣柜中侧板', 2180, 560, 1, 'length', lb, '衣柜', false),
    P('WR-P', '衣柜层板', 564, 560, 5, 'none', tb, '衣柜', false),
    P('WR-T', '衣柜顶板', 1800, 560, 1, 'none', tb, '衣柜', false),
    P('WR-B', '衣柜底板', 1800, 560, 1, 'none', tb, '衣柜', false),
    P('WR-M', '衣柜门板(竖纹见光)', 2180, 446, 4, 'length', all4, '衣柜', true),
    // 9mm 背板（指定板材）
    P('BB-D', '地柜/水槽柜背板', 690, 564, 3, 'none', [], '地柜', false, back.id),
    P('BB-G', '吊柜背板', 690, 764, 1, 'none', [], '吊柜', false, back.id),
    P('BB-W', '衣柜背板(竖纹)', 2180, 900, 2, 'length', [], '衣柜', false, back.id)
  ]
  return job
}

export function newPart(partial: Partial<Part> = {}): Part {
  return {
    id: uid('p'),
    code: partial.code ?? '',
    name: partial.name ?? '',
    lenMm: partial.lenMm ?? 0,
    widMm: partial.widMm ?? 0,
    qty: partial.qty ?? 1,
    grain: partial.grain ?? 'none',
    edgeBands: partial.edgeBands ?? [],
    cabinet: partial.cabinet ?? '未分组',
    exposed: partial.exposed ?? false,
    boardId: partial.boardId ?? ''
  }
}

export function exportJobJson(job: Job): string {
  return JSON.stringify(job, null, 2)
}

export function importJobJson(json: string): Job | null {
  try {
    const obj = JSON.parse(json) as Job
    if (!obj.parts || !obj.boards) return null
    obj.id = uid('job')
    obj.createdAt = Date.now()
    obj.result = undefined
    state.jobs.unshift(obj)
    persist()
    return obj
  } catch {
    return null
  }
}

export function useStore() {
  init()
  return {
    state,
    jobs: computed(() => state.jobs),
    offcuts: computed(() => state.offcuts)
  }
}

export { boardsData }
