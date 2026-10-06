// 核心排样：guillotine（直线贯通可锯）递归二分 2D 装箱
// - 纹理 length/width 硬约束：只允许指定朝向，rotated 恒为 false，放不下就报原因
// - 锯路 kerf：零件与零件、零件与余料之间留锯缝；修边 trim 为四周先切掉的边
// - 利用率分母为整板面积，分子为零件净面积（不含锯路）
import type {
  Board,
  Job,
  NestResult,
  OffcutInfo,
  Part,
  Placement,
  SheetResult,
  UnplacedInfo
} from '../types'
import { EPS, type Rect } from './geometry'
import { buildSteps, simulate } from './cuts'
import type { DSeg } from './cuts'

export interface Inst {
  part: Part
  k: number // 第 k 件（qty 展开）
  key: string
  cabinet: string
}

interface FRect extends Rect {
  id: number
  parentRec: number | null // 由哪次放置产生（切割依赖）
  entrySeg: 'A' | 'B' | null // 进入该空档前必须完成的刀：首刀/次刀
}

interface Rec {
  id: number
  frId: number
  instKey: string
  x: number
  y: number
  pw: number
  ph: number
  dir: 'v' | 'h'
  segA?: DSeg
  segB?: DSeg
}

interface SheetState {
  board: Board
  index: number
  usable: Rect
  free: FRect[]
  recs: Rec[]
  placements: Placement[]
}

function boardMatches(b: Board, p: Part): boolean {
  return partMatchesBoard(p, b, boardDefs)
}

/** 件能否排上某板：未指定板种=任何板可；指定板种只认本板种，或同厚度余料小板。 */
export function partMatchesBoard(p: Part, b: Board, boardById: Map<string, Board>): boolean {
  if (!p.boardId) return true
  if (b.id === p.boardId) return true
  if (b.kind === 'offcut') {
    const target = boardById.get(p.boardId)
    return !!target && target.thicknessMm === b.thicknessMm
  }
  return false
}

const boardDefs = new Map<string, Board>()

/** 统一为横向板（长边沿 x）。余料上台可以转，所以归一化安全。 */
export function normalizeBoard(b: Board): Board {
  if (b.wMm >= b.hMm) return b
  return { ...b, wMm: b.hMm, hMm: b.wMm }
}

/** 展开零件实例（id#k）。排样与调板试算共用同一套展开，保证守恒口径一致。 */
export function expandInstances(job: Job): Inst[] {
  const insts: Inst[] = []
  for (const p of job.parts) {
    for (let k = 1; k <= Math.max(0, p.qty); k++) {
      insts.push({ part: p, k, key: `${p.id}#${k}`, cabinet: p.cabinet || '未分组' })
    }
  }
  return insts
}

/** 排样排序：按柜体批次分组时柜体优先；随后大边降序、面积降序（启发式，非判定）。 */
function canonicalOrder(job: Job, insts: Inst[]): Inst[] {
  return [...insts].sort((a, b) => {
    if (job.batchByCabinet && a.cabinet !== b.cabinet) return a.cabinet < b.cabinet ? -1 : 1
    const am = Math.max(a.part.lenMm, a.part.widMm)
    const bm = Math.max(b.part.lenMm, b.part.widMm)
    if (bm !== am) return bm - am
    return b.part.lenMm * b.part.widMm - a.part.lenMm * a.part.widMm
  })
}

export function nestJob(job: Job): NestResult {
  const t0 = performance.now()
  boardDefs.clear()
  const boards = job.boards.map(normalizeBoard)
  boards.forEach((b) => boardDefs.set(b.id, b))
  const kerf = job.kerfMm
  const trim = job.trimMm

  // 各板种实际开板数（用于库存补采提示）
  const openedCount = new Map<string, number>()

  // 零件实例展开 + 排序（同一份展开/排序口径，连锁试算也走这里）
  const insts = expandInstances(job)
  const sorted = canonicalOrder(job, insts)

  const sheets: SheetState[] = []
  let frSeq = 0
  const openSheet = (b: Board): SheetState => {
    const usable: Rect = {
      x: trim,
      y: trim,
      w: Math.max(1, b.wMm - 2 * trim),
      h: Math.max(1, b.hMm - 2 * trim)
    }
    const s: SheetState = {
      board: b,
      index: sheets.length,
      usable,
      free: [
        {
          id: frSeq++,
          x: usable.x,
          y: usable.y,
          w: usable.w,
          h: usable.h,
          parentRec: null,
          entrySeg: null
        }
      ],
      recs: [],
      placements: []
    }
    sheets.push(s)
    return s
  }

  const canOpen = (b: Board): boolean => {
    // 余料板只有一块，用完即止；常规板库存是采购参考，可超开（稍后提示补采）
    if (b.kind === 'offcut') {
      const used = openedCount.get(b.id) ?? 0
      return used < 1
    }
    return true
  }

  const pickNewBoard = (p: Part, pw: number, ph: number): Board | null => {
    const viable = boards.filter(
      (b) =>
        canOpen(b) &&
        boardMatches(b, p) &&
        fitsClean(b.wMm - 2 * trim, pw) &&
        fitsClean(b.hMm - 2 * trim, ph)
    )
    // 余料小板优先，其次选面积最小的（省大板）
    viable.sort((a, b) => {
      if ((a.kind === 'offcut') !== (b.kind === 'offcut')) return a.kind === 'offcut' ? -1 : 1
      return a.wMm * a.hMm - b.wMm * b.hMm
    })
    return viable[0] ?? null
  }

  interface Orient {
    pw: number
    ph: number
    rotated: boolean
  }
  // 只允许严丝合缝（0）或余隙 ≥ 锯路；0<余隙<锯路 时下不了刀，禁止放入
  const fitsClean = (avail: number, size: number): boolean => {
    const gap = avail - size
    return gap >= -EPS && (gap <= EPS || gap >= kerf - EPS)
  }
  const orientsOf = (p: Part): Orient[] => {
    if (p.grain === 'length') return [{ pw: p.lenMm, ph: p.widMm, rotated: false }]
    if (p.grain === 'width') return [{ pw: p.widMm, ph: p.lenMm, rotated: false }]
    if (p.lenMm === p.widMm) return [{ pw: p.lenMm, ph: p.widMm, rotated: false }]
    return [
      { pw: p.lenMm, ph: p.widMm, rotated: false },
      { pw: p.widMm, ph: p.lenMm, rotated: true }
    ]
  }

  const unplaced = new Map<string, { part: Part; qty: number }>()
  const markUnplaced = (p: Part): void => {
    const cur = unplaced.get(p.id)
    if (cur) cur.qty++
    else unplaced.set(p.id, { part: p, qty: 1 })
  }

  let seq = 0
  for (const inst of sorted) {
    const p = inst.part
    let best:
      | { sheet: SheetState | null; fr: FRect | null; nb: Board | null; o: Orient; tier: number; waste: number }
      | null = null
    for (const o of orientsOf(p)) {
      // tier 0：已打开的、板种匹配的板里最贴合的空档
      for (const s of sheets) {
        if (!boardMatches(s.board, p)) continue
        for (const fr of s.free) {
          if (fitsClean(fr.w, o.pw) && fitsClean(fr.h, o.ph)) {
            const waste = fr.w * fr.h - o.pw * o.ph
            if (!best || waste < best.waste) {
              best = { sheet: s, fr, nb: null, o, tier: 0, waste }
            }
          }
        }
      }
      // tier 1：新开余料小板 / tier 2：新开常规板
      const nb = pickNewBoard(p, o.pw, o.ph)
      if (nb) {
        const tier = nb.kind === 'offcut' ? 1 : 2
        const waste = (nb.wMm - 2 * trim) * (nb.hMm - 2 * trim) - o.pw * o.ph
        if (!best || tier < best.tier || (tier === best.tier && waste < best.waste)) {
          best = { sheet: null, fr: null, nb, o, tier, waste }
        }
      }
    }
    if (!best) {
      markUnplaced(p)
      continue
    }
    let s: SheetState
    let fr: FRect
    if (best.sheet && best.fr) {
      s = best.sheet
      fr = best.fr
    } else {
      // 正式新板（库存扣减）
      const nb = best.nb ?? pickNewBoard(p, best.o.pw, best.o.ph)
      if (!nb) {
        markUnplaced(p)
        continue
      }
      s = openSheet(nb)
      openedCount.set(nb.id, (openedCount.get(nb.id) ?? 0) + 1)
      fr = s.free[0]
    }
    const o = best.o
    // 占用该空档并按 guillotine 递归二分拆出余隙（拆分实现全应用唯一，见 splitFreeRect）
    s.free = s.free.filter((f) => f.id !== fr.id)
    const parentDeps = segDepsOf(fr, s)
    const split = splitFreeRect(fr, o.pw, o.ph, kerf, parentDeps)
    const rec: Rec = {
      id: s.recs.length,
      frId: fr.id,
      instKey: inst.key,
      x: split.x,
      y: split.y,
      pw: split.pw,
      ph: split.ph,
      dir: split.dir,
      segA: split.segA,
      segB: split.segB
    }
    const addFree = (r: Rect, parentRec: number, entrySeg: 'A' | 'B'): void => {
      if (r.w >= 1 && r.h >= 1) s.free.push({ ...r, id: frSeq++, parentRec, entrySeg })
    }
    for (const f of split.frees) addFree(f.r, rec.id, f.entrySeg)
    s.recs.push(rec)
    seq++
    s.placements.push({
      partId: p.id,
      instanceId: inst.key,
      boardIndex: s.index,
      x: fr.x,
      y: fr.y,
      lenMm: o.pw,
      widMm: o.ph,
      origLen: p.lenMm,
      origWid: p.widMm,
      rotated: o.rotated,
      seq,
      code: p.code,
      name: p.name,
      cabinet: inst.cabinet,
      exposed: p.exposed,
      grain: p.grain,
      edgeBands: p.edgeBands
    })
  }

  // 组装 SheetResult
  const results: SheetResult[] = sheets.map((s) => buildSheet(s, kerf, trim))

  const unplacedList: UnplacedInfo[] = [...unplaced.values()].map((u) => ({
    partId: u.part.id,
    code: u.part.code,
    name: u.part.name,
    qty: u.qty,
    reason:
      u.part.grain === 'none'
        ? '板材尺寸或库存不足，无法排下'
        : u.part.grain === 'length'
          ? '因纹理要求为竖纹（不可旋转），现有板材排不下'
          : '因纹理要求为横纹（不可旋转），现有板材排不下'
  }))

  return finalizeNestResult(
    job,
    results,
    unplacedList,
    openedCount,
    Math.round(performance.now() - t0),
    Date.now()
  )
}

/**
 * guillotine 余隙递归二分（全应用唯一实现：主排样与连锁试排都走这里）。
 * 把零件 (pw×ph) 放进空档 fr 的左下角，产出首刀/次刀与剩余空档。
 * v：先竖切贯通全高（segA），再在含件左条内横切（segB）；h 对称。
 * 判定口径与原排样一致：0<余隙<锯路 时不下刀（上层用 fitsClean 拦）。
 */
export interface FreeSplitResult {
  x: number
  y: number
  pw: number
  ph: number
  dir: 'v' | 'h'
  segA?: DSeg
  segB?: DSeg
  frees: { r: Rect; entrySeg: 'A' | 'B' }[]
}

export function splitFreeRect(
  fr: FRect,
  pw: number,
  ph: number,
  kerf: number,
  parentDeps: DSeg[]
): FreeSplitResult {
  const gx = fr.w - pw // 右侧余隙（≈0 或 ≥kerf）
  const gy = fr.h - ph // 上方余隙（≈0 或 ≥kerf）
  const cutX = gx >= kerf - EPS
  const cutY = gy >= kerf - EPS
  const dir: 'v' | 'h' = fr.w >= fr.h ? 'v' : 'h'
  const frees: { r: Rect; entrySeg: 'A' | 'B' }[] = []
  let segA: DSeg | undefined
  let segB: DSeg | undefined
  if (dir === 'v') {
    if (cutX)
      segA = { axis: 'v', at: fr.x + pw + kerf / 2, lo: fr.y, hi: fr.y + fr.h, deps: parentDeps }
    if (cutY)
      segB = {
        axis: 'h',
        at: fr.y + ph + kerf / 2,
        lo: fr.x,
        hi: cutX ? fr.x + pw : fr.x + fr.w,
        deps: segA ? [segA] : parentDeps
      }
    // 左条上方空档需要 segB；右侧整条空档只需要 segA
    if (cutY)
      frees.push({
        r: { x: fr.x, y: fr.y + ph + kerf, w: cutX ? pw : fr.w, h: gy - kerf },
        entrySeg: 'B'
      })
    if (cutX) frees.push({ r: { x: fr.x + pw + kerf, y: fr.y, w: gx - kerf, h: fr.h }, entrySeg: 'A' })
  } else {
    if (cutY)
      segA = { axis: 'h', at: fr.y + ph + kerf / 2, lo: fr.x, hi: fr.x + fr.w, deps: parentDeps }
    if (cutX)
      segB = {
        axis: 'v',
        at: fr.x + pw + kerf / 2,
        lo: fr.y,
        hi: cutY ? fr.y + ph : fr.y + fr.h,
        deps: segA ? [segA] : parentDeps
      }
    // 上方整条空档只需要 segA；下条右侧空档需要 segB
    if (cutY) frees.push({ r: { x: fr.x, y: fr.y + ph + kerf, w: fr.w, h: gy - kerf }, entrySeg: 'A' })
    if (cutX)
      frees.push({
        r: { x: fr.x + pw + kerf, y: fr.y, w: gx - kerf, h: cutY ? ph : fr.h },
        entrySeg: 'B'
      })
  }
  return { x: fr.x, y: fr.y, pw, ph, dir, segA, segB, frees }
}

/** 沿父放置的切割线建立依赖：进入空档前要求对应首刀/次刀已完成。 */
function segDepsOf(fr: FRect, s: SheetState): DSeg[] {
  if (fr.parentRec === null || !fr.entrySeg) return []
  const rec = s.recs.find((r) => r.id === fr.parentRec)
  if (!rec) return []
  const seg = fr.entrySeg === 'A' ? rec.segA ?? rec.segB : rec.segB ?? rec.segA
  return seg ? [seg] : []
}

function buildSheet(s: SheetState, kerf: number, trim: number): SheetResult {
  const raw: DSeg[] = []
  for (const r of s.recs) {
    if (r.segA) raw.push(r.segA)
    if (r.segB) raw.push(r.segB)
  }
  const b = s.board
  const steps = buildSteps(b.wMm, b.hMm, kerf, trim, s.index, raw)
  const boardArea = b.wMm * b.hMm
  const usedArea = s.placements.reduce((a, p) => a + p.origLen * p.origWid, 0)

  // 剩余空档全部留档；两边 ≥300mm 才标记为可用余料，按面积降序
  const offcuts: OffcutInfo[] = s.free
    .filter((f) => f.w >= 2 && f.h >= 2)
    .map((f) => ({
      x: Math.round(f.x),
      y: Math.round(f.y),
      wMm: Math.round(f.w),
      hMm: Math.round(f.h),
      areaMm2: Math.round(f.w * f.h),
      usable: f.w >= 300 - EPS && f.h >= 300 - EPS
    }))
    .sort((a, c) => c.areaMm2 - a.areaMm2)

  const sheet: SheetResult = {
    index: s.index,
    boardId: b.id,
    boardName: b.name,
    material: b.material,
    thicknessMm: b.thicknessMm,
    wMm: b.wMm,
    hMm: b.hMm,
    priceCents: b.kind === 'offcut' ? 0 : b.priceCents,
    placements: s.placements,
    steps,
    usedAreaMm2: usedArea,
    boardAreaMm2: boardArea,
    utilization: usedArea / boardArea,
    offcuts
  }
  const sim = simulate(b.wMm, b.hMm, kerf, steps, s.placements)
  if (!sim.ok) {
    console.error(`[排样] 第 ${s.index + 1} 张板切割模拟失败`, sim.errors)
  }
  return sheet
}

// —— 连锁挪件试算：同一套余隙/锯路/修边/贯通判定，把指定一组件排进上限张数的同规格板 ——

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface FixedPackStrategy {
  name: string
  order: (insts: Inst[]) => Inst[]
}

function shuffleInst(insts: Inst[], seed: number): Inst[] {
  const a = [...insts]
  const rng = mulberry32(seed)
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

/** 连锁试算的换序策略：只改尝试顺序，判定（fitsClean/余隙/贯通）一概不变。 */
export const FIXED_PACK_STRATEGIES: FixedPackStrategy[] = [
  {
    name: '大边降序（标准）',
    order: (is) =>
      [...is].sort(
        (a, b) =>
          Math.max(b.part.lenMm, b.part.widMm) - Math.max(a.part.lenMm, a.part.widMm) ||
          b.part.lenMm * b.part.widMm - a.part.lenMm * a.part.widMm
      )
  },
  {
    name: '面积降序',
    order: (is) => [...is].sort((a, b) => b.part.lenMm * b.part.widMm - a.part.lenMm * a.part.widMm)
  },
  {
    name: '长边降序',
    order: (is) =>
      [...is].sort((a, b) => b.part.lenMm - a.part.lenMm || b.part.widMm - a.part.widMm)
  },
  {
    name: '短边降序',
    order: (is) =>
      [...is].sort((a, b) => b.part.widMm - a.part.widMm || b.part.lenMm - a.part.lenMm)
  },
  { name: '定种洗牌 1', order: (is) => shuffleInst(is, 0x51a7) },
  { name: '定种洗牌 2', order: (is) => shuffleInst(is, 0xb00c) }
]

function orientOfPart(p: Part): { pw: number; ph: number; rotated: boolean }[] {
  if (p.grain === 'length') return [{ pw: p.lenMm, ph: p.widMm, rotated: false }]
  if (p.grain === 'width') return [{ pw: p.widMm, ph: p.lenMm, rotated: false }]
  if (p.lenMm === p.widMm) return [{ pw: p.lenMm, ph: p.widMm, rotated: false }]
  return [
    { pw: p.lenMm, ph: p.widMm, rotated: false },
    { pw: p.widMm, ph: p.lenMm, rotated: true }
  ]
}

function fitsGap(avail: number, size: number, kerf: number): boolean {
  const gap = avail - size
  return gap >= -EPS && (gap <= EPS || gap >= kerf - EPS)
}

/**
 * 把一组件排进同规格板，最多用 maxSheets 张；按给定策略逐一试。
 * 返回第一个不超上限的方案（张数相同时取走刀更少的）；全部超上限返回 null。
 * 余隙拆分、锯路、修边、贯通刀依赖与 nestJob 完全相同（splitFreeRect）。
 */
export function packFixedBoards(
  boardInput: Board,
  insts: Inst[],
  kerf: number,
  trim: number,
  maxSheets: number,
  strategies: FixedPackStrategy[] = FIXED_PACK_STRATEGIES
): SheetResult[] | null {
  const board = normalizeBoard(boardInput)
  for (const st of strategies) {
    const states = packOneOrder(board, st.order(insts), kerf, trim, maxSheets)
    if (states && states.length <= maxSheets) {
      return states.map((s) => buildSheet(s, kerf, trim))
    }
  }
  return null
}

function packOneOrder(
  b: Board,
  order: Inst[],
  kerf: number,
  trim: number,
  maxSheets: number
): SheetState[] | null {
  const states: SheetState[] = []
  let frSeqLocal = 0
  let seq = 0
  const open = (): SheetState => {
    const usable: Rect = {
      x: trim,
      y: trim,
      w: Math.max(1, b.wMm - 2 * trim),
      h: Math.max(1, b.hMm - 2 * trim)
    }
    const s: SheetState = {
      board: b,
      index: states.length,
      usable,
      free: [{ id: frSeqLocal++, x: usable.x, y: usable.y, w: usable.w, h: usable.h, parentRec: null, entrySeg: null }],
      recs: [],
      placements: []
    }
    states.push(s)
    return s
  }
  for (const inst of order) {
    const p = inst.part
    let chosen: { s: SheetState; fr: FRect; pw: number; ph: number; rotated: boolean; waste: number } | null = null
    for (const s of states) {
      for (const o of orientOfPart(p)) {
        for (const fr of s.free) {
          if (fitsGap(fr.w, o.pw, kerf) && fitsGap(fr.h, o.ph, kerf)) {
            const waste = fr.w * fr.h - o.pw * o.ph
            if (!chosen || waste < chosen.waste)
              chosen = { s, fr, pw: o.pw, ph: o.ph, rotated: o.rotated, waste }
          }
        }
      }
    }
    if (!chosen) {
      if (states.length >= maxSheets) return null
      const s = open()
      const fr = s.free[0]
      const o = orientOfPart(p).find((oo) => fitsGap(fr.w, oo.pw, kerf) && fitsGap(fr.h, oo.ph, kerf))
      if (!o) return null // 件本身比板大（分组时已排除，理论不到这）
      chosen = { s, fr, pw: o.pw, ph: o.ph, rotated: o.rotated, waste: 0 }
    }
    const { s, fr } = chosen
    s.free = s.free.filter((f) => f.id !== fr.id)
    const deps = segDepsOf(fr, s)
    const split = splitFreeRect(fr, chosen.pw, chosen.ph, kerf, deps)
    const rec: Rec = {
      id: s.recs.length,
      frId: fr.id,
      instKey: inst.key,
      x: split.x,
      y: split.y,
      pw: split.pw,
      ph: split.ph,
      dir: split.dir,
      segA: split.segA,
      segB: split.segB
    }
    for (const f of split.frees) {
      if (f.r.w >= 1 && f.r.h >= 1)
        s.free.push({ ...f.r, id: frSeqLocal++, parentRec: rec.id, entrySeg: f.entrySeg })
    }
    s.recs.push(rec)
    seq++
    s.placements.push({
      partId: p.id,
      instanceId: inst.key,
      boardIndex: s.index,
      x: fr.x,
      y: fr.y,
      lenMm: chosen.pw,
      widMm: chosen.ph,
      origLen: p.lenMm,
      origWid: p.widMm,
      rotated: chosen.rotated,
      seq,
      code: p.code,
      name: p.name,
      cabinet: inst.cabinet,
      exposed: p.exposed,
      grain: p.grain,
      edgeBands: p.edgeBands
    })
  }
  return states
}

/** 汇总统计（主排样与调板确认共用，保证各处取数同源）。 */
export function finalizeNestResult(
  job: Job,
  sheets: SheetResult[],
  unplacedList: UnplacedInfo[],
  openedCount: Map<string, number>,
  elapsedMs: number,
  generatedAt: number
): NestResult {
  const boardsByType: Record<string, number> = {}
  let totalCost = 0
  for (const s of sheets) {
    boardsByType[s.boardName] = (boardsByType[s.boardName] ?? 0) + 1
    totalCost += s.priceCents
  }
  let exposedM = 0
  let normalM = 0
  for (const s of sheets) {
    for (const pl of s.placements) {
      const m =
        (pl.origLen *
          ((pl.edgeBands.includes('top') ? 1 : 0) + (pl.edgeBands.includes('bottom') ? 1 : 0)) +
          pl.origWid *
            ((pl.edgeBands.includes('left') ? 1 : 0) + (pl.edgeBands.includes('right') ? 1 : 0))) /
        1000
      if (pl.exposed) exposedM += m
      else normalM += m
    }
  }
  const stockShortage = job.boards
    .filter((b) => b.kind !== 'offcut' && b.quantity > 0)
    .map((b) => ({
      boardId: b.id,
      boardName: b.name,
      need: openedCount.get(b.id) ?? 0,
      have: b.quantity
    }))
    .filter((x) => x.need > x.have)

  const stockUsed = sheets.filter((s) => s.priceCents > 0)
  const avgPrice =
    stockUsed.length > 0
      ? stockUsed.reduce((a, s) => a + s.priceCents, 0) / stockUsed.length
      : job.boards.reduce((a, b) => a + b.priceCents, 0) / Math.max(1, job.boards.length)

  const optimizedBoards = sheets.length
  const baselineBoards = shelfBaseline(job, job.boards.map(normalizeBoard), job.kerfMm, job.trimMm, optimizedBoards)
  const savedBoards = Math.max(0, baselineBoards - optimizedBoards)

  return {
    sheets,
    boardsUsed: optimizedBoards,
    boardsByType,
    edgeBandM: {
      exposed: Math.round(exposedM * 100) / 100,
      normal: Math.round(normalM * 100) / 100
    },
    unplaced: unplacedList,
    baselineBoards,
    savedBoards,
    savedCents: Math.round(savedBoards * avgPrice),
    totalCostCents: totalCost,
    stockShortage,
    elapsedMs,
    generatedAt
  }
}

/**
 * 「随手排」基线：保持清单原顺序、固定朝向（不旋转）、朴素顺板货架式摆放。
 * 用于展示「本方案比随手排省几张板」。库存耗尽时退化为与优化方案相同的张数。
 */
function shelfBaseline(
  job: Job,
  boards: Board[],
  kerf: number,
  trim: number,
  optimizedCount: number
): number {
  let count = 0
  // 用对象持有当前板状态，避免闭包对局部变量的窄化问题
  const cur: { value: { b: Board; x: number; y: number; shelfH: number } | null } = { value: null }
  const usable = (b: Board): [number, number] => [b.wMm - 2 * trim, b.hMm - 2 * trim]
  const newSheet = (b: Board): void => {
    count++
    cur.value = { b, x: 0, y: 0, shelfH: 0 }
  }
  // 随手排不用登记余料，只在常规板之间顺
  const canOpen = (b: Board): boolean => b.kind !== 'offcut'
  for (const part of job.parts) {
    for (let k = 0; k < part.qty; k++) {
      const pw = part.grain === 'width' ? part.widMm : part.lenMm
      const ph = part.grain === 'width' ? part.lenMm : part.widMm
      const tryCur = (): boolean => {
        const c = cur.value
        if (!c || !boardMatches(c.b, part)) return false
        const [uw, uh] = usable(c.b)
        if (c.x + pw <= uw + EPS && c.y + Math.max(c.shelfH, ph) <= uh + EPS) {
          if (c.x === 0 && c.shelfH === 0) c.shelfH = ph
          c.x += pw + kerf
          c.shelfH = Math.max(c.shelfH, ph)
          return true
        }
        // 当前层放不下，换行再试
        if (c.x > 0) {
          c.y += c.shelfH + kerf
          c.x = 0
          c.shelfH = 0
          if (pw <= uw + EPS && c.y + ph <= uh + EPS) {
            c.shelfH = ph
            c.x = pw + kerf
            return true
          }
        }
        return false
      }
      if (tryCur()) {
        // 已摆入当前板
      } else {
        const candidates = boards
          .filter(
            (b) =>
              canOpen(b) &&
              boardMatches(b, part) &&
              b.wMm - 2 * trim + EPS >= pw &&
              b.hMm - 2 * trim + EPS >= ph
          )
          .sort((a, b) => a.wMm * a.hMm - b.wMm * b.hMm)
        if (candidates.length === 0) return Math.max(optimizedCount, count)
        newSheet(candidates[0])
        cur.value!.x = pw + kerf
        cur.value!.shelfH = ph
      }
    }
  }
  return Math.max(count, optimizedCount)
}
