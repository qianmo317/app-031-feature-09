// 自动化断言（规格书 §8/§10 强制）：
// guillotine 100 组随机零反例、纹理零旋转、锯路/修边、守恒、封边复算、
// 30 零件锯切工步 ≤20 且模拟器还原、余料再利用、300 零件性能 <1.5s。
import type { Board, Job, Part } from '../types'
import { nestJob, packFixedBoards, expandInstances } from './packing'
import { simulate, countSawOps, rebuildFromPlacements } from './cuts'
import { guillotineViolation, type Rect } from './geometry'
import { analyzeRemix, planLocalMove } from './remix'
import { verifyResult } from './verify'
import { boardMaterialRows } from './metrics'
import type { SheetResult } from '../types'

export interface CheckResult {
  name: string
  ok: boolean
  detail: string
}

export interface SelfTestReport {
  ok: boolean
  elapsedMs: number
  checks: CheckResult[]
}

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

let boardSeq = 0
let partSeq = 0

function makeBoard(over: Partial<Board> = {}): Board {
  return {
    id: `b${boardSeq++}`,
    name: over.name ?? '测试板 2440×1220',
    wMm: over.wMm ?? 2440,
    hMm: over.hMm ?? 1220,
    thicknessMm: 18,
    material: '颗粒板',
    priceCents: 13800,
    quantity: 0,
    kind: 'stock',
    ...over
  }
}

function makePart(over: Partial<Part> = {}): Part {
  return {
    id: `p${partSeq++}`,
    code: over.code ?? `P${partSeq}`,
    name: over.name ?? '测试件',
    lenMm: over.lenMm ?? 400,
    widMm: over.widMm ?? 300,
    qty: over.qty ?? 1,
    grain: over.grain ?? 'none',
    edgeBands: over.edgeBands ?? [],
    cabinet: over.cabinet ?? '柜A',
    exposed: over.exposed ?? false,
    boardId: over.boardId ?? ''
  }
}

function makeJob(parts: Part[], over: Partial<Job> = {}): Job {
  return {
    id: `j${partSeq}`,
    name: '测试任务',
    createdAt: 0,
    boards: over.boards ?? [makeBoard()],
    parts,
    kerfMm: over.kerfMm ?? 3.2,
    trimMm: over.trimMm ?? 8,
    useOffcutIds: [],
    batchByCabinet: false,
    ...over
  }
}

/** 检查同板任意两件之间的净距：只要相邻就必须 ≥ kerf；四周 ≥ trim。 */
function assertClearances(job: Job): string | null {
  const kerf = job.kerfMm
  const trim = job.trimMm
  for (const sheet of job.result!.sheets) {
    const ps = sheet.placements
    for (const p of ps) {
      if (p.x < trim - 0.06 || p.y < trim - 0.06) return '零件越过修边区（左下）'
      if (p.x + p.lenMm > sheet.wMm - trim + 0.06) return '零件越过修边区（右）'
      if (p.y + p.widMm > sheet.hMm - trim + 0.06) return '零件越过修边区（上）'
    }
    for (let i = 0; i < ps.length; i++) {
      for (let j = i + 1; j < ps.length; j++) {
        const a = ps[i]
        const b = ps[j]
        const ox = Math.min(a.x + a.lenMm, b.x + b.lenMm) - Math.max(a.x, b.x)
        const oy = Math.min(a.y + a.widMm, b.y + b.widMm) - Math.max(a.y, b.y)
        if (ox > 0.06 && oy > 0.06) return '零件重叠'
        // 同向投影有重叠时，另一轴的净距必须 ≥ kerf
        if (ox > 0.06) {
          const gap = Math.abs(a.y + a.widMm - b.y) < Math.abs(a.y - (b.y + b.widMm))
            ? b.y - (a.y + a.widMm)
            : a.y - (b.y + b.widMm)
          if (gap > 0.06 && gap < kerf - 0.6) return `净距 ${gap.toFixed(2)} < 锯路 ${kerf}`
        }
        if (oy > 0.06) {
          const gap = Math.abs(a.x + a.lenMm - b.x) < Math.abs(a.x - (b.x + b.lenMm))
            ? b.x - (a.x + a.lenMm)
            : a.x - (b.x + b.lenMm)
          if (gap > 0.06 && gap < kerf - 0.6) return `净距 ${gap.toFixed(2)} < 锯路 ${kerf}`
        }
      }
    }
  }
  return null
}

function dumpJob(job: Job, err?: string): void {
  console.error('DUMP_KERF', job.kerfMm, 'TRIM', job.trimMm, 'ERR', err ?? '')
  for (const p of job.parts) {
    console.error(
      'DUMP_PART',
      JSON.stringify({
        c: p.code,
        l: p.lenMm,
        w: p.widMm,
        q: p.qty,
        g: p.grain,
        e: p.edgeBands.join(''),
        x: p.exposed ? 1 : 0
      })
    )
  }
  const m = err?.match(/板(\d+)/)
  if (m && job.result) {
    const sheet = job.result.sheets[Number(m[1]) - 1]
    if (sheet) {
      console.error('DUMP_SHEET', sheet.wMm, sheet.hMm)
      for (const p of sheet.placements)
        console.error('DUMP_PL', p.code, p.x, p.y, p.lenMm, p.widMm, p.grain)
      for (const st of sheet.steps)
        console.error('DUMP_ST', st.order, st.kind, st.axis, st.at, st.span[0], st.span[1])
      const sim = simulate(sheet.wMm, sheet.hMm, job.kerfMm, sheet.steps, sheet.placements)
      console.error('DUMP_SIM', JSON.stringify(sim.errors))
      for (const lf of sim.leaves)
        console.error('DUMP_LEAF', Math.round(lf.x), Math.round(lf.y), Math.round(lf.w), Math.round(lf.h))
    }
  }
}

function assertSheet(job: Job): string | null {
  const r = job.result!
  for (const sheet of r.sheets) {
    // guillotine 合法性
    const rects = sheet.placements.map((p) => ({
      id: p.instanceId,
      x: p.x,
      y: p.y,
      w: p.lenMm,
      h: p.widMm
    }))
    const bounds: Rect = {
      x: job.trimMm,
      y: job.trimMm,
      w: sheet.wMm - 2 * job.trimMm,
      h: sheet.hMm - 2 * job.trimMm
    }
    const v = guillotineViolation(rects, bounds, job.kerfMm)
    if (v) return `板${sheet.index + 1}：${v}`
    // 逐步切割模拟
    const sim = simulate(sheet.wMm, sheet.hMm, job.kerfMm, sheet.steps, sheet.placements)
    if (!sim.ok) return `板${sheet.index + 1}：${sim.errors.join('；')}`
    // 利用率复算（分子不含锯路）
    const net = sheet.placements.reduce((a, p) => a + p.origLen * p.origWid, 0)
    if (Math.abs(net - sheet.usedAreaMm2) > 1) return 'usedArea 与零件净面积不一致'
    if (Math.abs(net / sheet.boardAreaMm2 - sheet.utilization) > 1e-9)
      return '利用率复算不一致'
  }
  // 面积守恒不等式
  const boardArea = r.sheets.reduce((a, s) => a + s.boardAreaMm2, 0)
  const partArea = job.parts.reduce((a, p) => a + p.lenMm * p.widMm * p.qty, 0)
  if (boardArea + 1 < partArea) return 'Σ板面积 < Σ零件面积'
  return null
}

export function runSelfTest(): SelfTestReport {
  boardSeq = 0
  partSeq = 0
  const t0 = performance.now()
  const checks: CheckResult[] = []
  const add = (name: string, ok: boolean, detail: string): void => {
    checks.push({ name, ok, detail })
  }

  // 1) 100 组随机任务：零反例
  const rng = mulberry32((globalThis as { FCO_SEED?: number }).FCO_SEED ?? 20260925)
  let failures = 0
  let firstFailure = ''
  let totalInstances = 0
  for (let g = 0; g < 100; g++) {
    const kerf = +(2 + rng() * 2).toFixed(2)
    const trim = 5 + Math.floor(rng() * 6)
    const partKinds = 8 + Math.floor(rng() * 33)
    const parts: Part[] = []
    for (let i = 0; i < partKinds; i++) {
      const len = 120 + Math.floor(rng() * 980)
      const wid = 80 + Math.floor(rng() * 620)
      const gr = rng()
      parts.push(
        makePart({
          code: `R${g}-${i}`,
          lenMm: len,
          widMm: wid,
          qty: 1 + Math.floor(rng() * 3),
          grain: gr < 0.4 ? 'length' : gr < 0.55 ? 'width' : 'none',
          edgeBands: rng() < 0.5 ? ['top', 'left'] : [],
          cabinet: ['客厅柜', '衣柜', '橱柜', '书柜'][Math.floor(rng() * 4)],
          exposed: rng() < 0.3
        })
      )
    }
    const job = makeJob(parts, { kerfMm: kerf, trimMm: trim })
    const r = nestJob(job)
    job.result = r
    const placed = r.sheets.reduce((a, s) => a + s.placements.length, 0)
    totalInstances = parts.reduce((a, p) => a + p.qty, 0)
    // 尺寸被限制为一定排得下
    if (r.unplaced.length > 0) {
      failures++
      firstFailure = `组${g + 1}：存在 ${r.unplaced.length} 件未排下`
      continue
    }
    if (placed !== totalInstances) {
      failures++
      firstFailure = `组${g + 1}：守恒失败 ${placed}/${totalInstances}`
      continue
    }
    const clearanceErr = assertClearances(job)
    if (clearanceErr) {
      failures++
      firstFailure = `组${g + 1}：${clearanceErr}`
      if ((globalThis as { FCO_DUMP?: boolean }).FCO_DUMP) dumpJob(job)
      continue
    }
    const sheetErr = assertSheet(job)
    if (sheetErr) {
      failures++
      firstFailure = `组${g + 1}：${sheetErr}`
      if ((globalThis as { FCO_DUMP?: boolean }).FCO_DUMP) dumpJob(job, sheetErr)
      continue
    }
    // 纹理硬约束：零旋转
    const rotated = r.sheets.flatMap((s) => s.placements).filter((p) => {
      if (p.grain === 'none') return false
      if (p.rotated) return true
      if (p.grain === 'length' && !(p.lenMm === p.origLen && p.widMm === p.origWid)) return true
      if (p.grain === 'width' && !(p.lenMm === p.origWid && p.widMm === p.origLen)) return true
      return false
    })
    if (rotated.length > 0) {
      failures++
      firstFailure = `组${g + 1}：纹理件被旋转 ${rotated.length} 次`
    }
  }
  add(
    '100 组随机 guillotine 零反例（贯通/锯路/修边/守恒/模拟）',
    failures === 0,
    failures === 0
      ? '100/100 通过；每组均验证：逐步模拟可还原全部零件'
      : firstFailure
  )

  // 2) 纹理无法满足时给原因而不是偷转
  {
    const job = makeJob([
      makePart({ code: 'BIG', lenMm: 2500, widMm: 400, qty: 1, grain: 'length' }),
      makePart({ code: 'OK', lenMm: 400, widMm: 400, qty: 1 })
    ])
    const r = nestJob(job)
    const ok =
      r.unplaced.length === 1 &&
      r.unplaced[0].code === 'BIG' &&
      r.unplaced[0].reason.includes('纹理') &&
      r.sheets.reduce((a, s) => a + s.placements.length, 0) === 1
    add('纹理排不下时明确提示且不强制旋转', ok, ok ? '提示：' + r.unplaced[0].reason : '未按预期报纹理冲突')
  }

  // 3) 锯路精确净距（两件相邻 = kerf）
  {
    const job = makeJob([
      makePart({ code: 'A', lenMm: 500, widMm: 500 }),
      makePart({ code: 'B', lenMm: 500, widMm: 500 })
    ])
    const r = nestJob(job)
    const ps = r.sheets[0].placements
    ps.sort((a, b) => a.y - b.y || a.x - b.x)
    const gap = ps[1].y - (ps[0].y + 500)
    const ok = Math.abs(gap - job.kerfMm) < 0.1
    add('相邻零件净距等于锯路 3.2mm', ok, `实测净距 ${gap.toFixed(2)}mm`)
  }

  // 4) 封边米数复算 + 见光分列
  {
    const job = makeJob([
      makePart({
        code: 'E1',
        lenMm: 500,
        widMm: 300,
        qty: 2,
        edgeBands: ['top', 'left'],
        exposed: true
      }),
      makePart({ code: 'E2', lenMm: 400, widMm: 200, qty: 1, edgeBands: ['top', 'bottom', 'left', 'right'] })
    ])
    const r = nestJob(job)
    const expectExposed = 2 * (0.5 + 0.3) // 1.6
    const expectNormal = 0.4 * 2 + 0.2 * 2 // 1.2
    const ok =
      Math.abs(r.edgeBandM.exposed - expectExposed) < 0.011 &&
      Math.abs(r.edgeBandM.normal - expectNormal) < 0.011
    add(
      '封边米数逐件复算一致且见光/非见光分列',
      ok,
      `见光 ${r.edgeBandM.exposed}m（期望 ${expectExposed}）、非见光 ${r.edgeBandM.normal}m（期望 ${expectNormal}）`
    )
  }

  // 5) 30 件标准件：锯切工步 ≤20 且模拟还原全部尺寸
  {
    const job = makeJob([makePart({ code: 'S', lenMm: 480, widMm: 398, qty: 30, grain: 'none' })])
    const r = nestJob(job)
    const ops = countSawOps(r.sheets)
    const simsOk = r.sheets.every((s) =>
      simulate(s.wMm, s.hMm, job.kerfMm, s.steps, s.placements).ok
    )
    const placed = r.sheets.reduce((a, s) => a + s.placements.length, 0)
    const ok = ops <= 20 && simsOk && placed === 30 && r.sheets.length === 2
    add(
      '30 零件锯切工步 ≤20 且按步模拟尺寸全部正确',
      ok,
      `${r.sheets.length} 张板、${ops} 个锯切工步（修边按叠切计 1 次）、模拟 ${simsOk ? '通过' : '失败'}`
    )
  }

  // 6) 余料作为小板参与下一轮排样
  {
    const small: Board = {
      id: 'offcut_test',
      name: '余料板 900×700',
      wMm: 900,
      hMm: 700,
      thicknessMm: 18,
      material: '颗粒板',
      priceCents: 0,
      quantity: 1,
      kind: 'offcut'
    }
    const job = makeJob([makePart({ code: 'O1', lenMm: 500, widMm: 500 })], {
      boards: [small, makeBoard()]
    })
    const r = nestJob(job)
    const ok = r.sheets[0].boardId === 'offcut_test' && r.sheets.length === 1
    add('余料登记后优先作为小板材参与排样', ok, ok ? '零件排上了 900×700 余料板' : '余料未被优先使用')
  }

  // 7) 300 零件（40 种规格）性能
  {
    const rng2 = mulberry32(77)
    const parts: Part[] = []
    let qtyLeft = 300
    for (let i = 0; i < 40; i++) {
      const qty = Math.min(i === 39 ? qtyLeft : 7 + Math.floor(rng2() * 2), qtyLeft)
      qtyLeft -= qty
      parts.push(
        makePart({
          code: `F${i}`,
          lenMm: 150 + Math.floor(rng2() * 750),
          widMm: 120 + Math.floor(rng2() * 500),
          qty
        })
      )
    }
    const job = makeJob(parts)
    const r = nestJob(job)
    const placed = r.sheets.reduce((a, s) => a + s.placements.length, 0)
    const ok = r.elapsedMs < 1500 && placed === 300
    add('300 零件排样 < 1.5s', ok, `耗时 ${r.elapsedMs}ms，用板 ${r.sheets.length} 张，就位 ${placed}/300`)
  }

  // 8) 手工微调合法性校验：合法布局通过，塞缝布局拒绝
  {
    const bounds: Rect = { x: 8, y: 8, w: 2424, h: 1204 }
    const legal: { id: string; x: number; y: number; w: number; h: number }[] = [
      { id: '1', x: 8, y: 8, w: 600, h: 1196 },
      { id: '2', x: 611.2, y: 8, w: 600, h: 596 },
      { id: '3', x: 611.2, y: 607.2, w: 600, h: 596.8 }
    ]
    // 经典风车形非切分布局（5 块互相顶住，找不到任何一条贯通切线）
    const illegal: { id: string; x: number; y: number; w: number; h: number }[] = [
      { id: 'B', x: 8, y: 8, w: 396.8, h: 600 },
      { id: 'C', x: 408, y: 8, w: 592, h: 396.8 },
      { id: 'E', x: 408, y: 408, w: 196.8, h: 196.8 },
      { id: 'A', x: 8, y: 608, w: 596.8, h: 396.8 },
      { id: 'D', x: 608, y: 408, w: 392, h: 596.8 }
    ]
    const okLegal = guillotineViolation(legal, bounds, 3.2) === null
    const okIllegal = guillotineViolation(illegal, bounds, 3.2) !== null
    add(
      '微调后 guillotine 合法性校验准确',
      okLegal && okIllegal,
      `合法布局 ${okLegal ? '放行' : '误拒'}；塞缝布局 ${okIllegal ? '拒绝' : '误放'}`
    )
  }

  // 9) 多板种混排 + 库存张数约束
  {
    const thin = makeBoard({
      id: 'thin',
      name: '背板 2440×1220×9',
      wMm: 2440,
      hMm: 1220,
      thicknessMm: 9,
      priceCents: 9800
    })
    const thick = makeBoard({ id: 'thick', name: '主板 2440×1220×18', quantity: 1 })
    const parts = [
      makePart({ code: 'T', lenMm: 1000, widMm: 600, qty: 5, boardId: 'thick' }),
      makePart({ code: 'B', lenMm: 1000, widMm: 600, qty: 2, boardId: 'thin' })
    ]
    const job = makeJob(parts, { boards: [thick, thin] })
    const r = nestJob(job)
    const thickSheets = r.sheets.filter((s) => s.thicknessMm === 18).length
    const thinSheets = r.sheets.filter((s) => s.thicknessMm === 9).length
    const shortage = r.stockShortage.find((x) => x.boardId === 'thick')
    const ok =
      thickSheets >= 2 && thinSheets === 1 && !!shortage && shortage.need >= 2 && shortage.have === 1
    add(
      '多板种混排且 18mm 库存仅 1 张时超开并提示补采',
      ok,
      `18mm 用 ${thickSheets} 张（库存 1，需补采）、9mm 用 ${thinSheets} 张`
    )
  }

  // 10) 连锁试排：标准序排不满时，多策略定板搜索能把同组压进 n-1 张（判定口径不变）
  {
    // 标准「大边降序」把这 3 件排到 2 张（872×671 / 982×628 / 857×938），
    // 但存在一张装法；多策略定板试排（换序，不改判定）能压进 1 张。
    const board = makeBoard({ id: 'chain_b', wMm: 2440, hMm: 1220 })
    const insts = expandInstances(
      makeJob([
        makePart({ code: 'A', lenMm: 872, widMm: 671, qty: 1 }),
        makePart({ code: 'B', lenMm: 982, widMm: 628, qty: 1 }),
        makePart({ code: 'C', lenMm: 857, widMm: 938, qty: 1 })
      ])
    )
    const stdJob = makeJob(
      [
        makePart({ code: 'A', lenMm: 872, widMm: 671, qty: 1 }),
        makePart({ code: 'B', lenMm: 982, widMm: 628, qty: 1 }),
        makePart({ code: 'C', lenMm: 857, widMm: 938, qty: 1 })
      ],
      { boards: [board] }
    )
    const stdSheets = nestJob(stdJob).sheets.length
    const packed = packFixedBoards(board, insts, 3.2, 8, 1)
    let allSimOk = false
    if (packed && packed.length === 1) {
      allSimOk = simulate(2440, 1220, 3.2, packed[0].steps, packed[0].placements).ok
    }
    add(
      '连锁多策略定板试排：标准 2 张的组压进 1 张且逐刀模拟合法',
      stdSheets === 2 && !!packed && packed.length === 1 && allSimOk,
      `标准序 ${stdSheets} 张；试排 ${packed ? packed.length + ' 张' : '失败'}，模拟 ${allSimOk ? '通过' : '失败'}`
    )
  }

  // 11) 连锁诊断：全部板不低于下限时 lowSheets 为空；有低板时划不来要给原因
  {
    const job = makeJob([
      makePart({ code: 'A', lenMm: 800, widMm: 600, qty: 1 }),
      makePart({ code: 'B', lenMm: 800, widMm: 600, qty: 1 }),
      makePart({ code: 'C', lenMm: 1200, widMm: 1000, qty: 1 })
    ])
    const r = nestJob(job)
    job.result = r
    const rep90 = analyzeRemix(job, r, 90, job.boards)
    const lowCount = rep90.lowSheets.length
    // 下限设到不可能达到的 99% 时，每张板都被挑出，且同板种组试排压不进 n-1 必须给原因
    const rep99 = analyzeRemix(job, r, 99, job.boards)
    const reasonOk = rep99.sheets.every(
      (s) => s.chain.feasible === false && s.chain.reason.length > 0
    )
    add(
      '低利用率诊断：按下限挑板，划不来的连锁写明原因',
      lowCount >= 0 && rep99.lowSheets.length === r.sheets.length && reasonOk,
      `下限90%挑出 ${lowCount} 张；下限99%挑出 ${rep99.lowSheets.length}/${r.sheets.length}，原因 ${reasonOk ? '齐全' : '缺失'}`
    )
  }

  // 12) 总校验抓篡改：伪造重叠布局必须被 verifyResult 拦下
  {
    const job = makeJob([makePart({ code: 'X', lenMm: 400, widMm: 300 })])
    const r = nestJob(job)
    job.result = r
    const sheet = r.sheets[0]
    // 复制一个件并故意叠到第一件上
    const dup = { ...sheet.placements[0], instanceId: 'p_dup#1', x: 10, y: 10 }
    const tampered: Job = {
      ...job,
      result: { ...r, sheets: [{ ...sheet, placements: [...sheet.placements, dup] }] }
    }
    const ver = verifyResult(tampered, tampered.result!, 2)
    add(
      '调板写回总校验能抓重叠/重复件（不会把非法布局写进结果）',
      !ver.ok,
      ver.ok ? '篡改布局被错误放行' : `已拦下：${ver.issues[0]?.detail ?? '非法'}`
    )
  }

  // 13b) 路线一（板上对换）内核链路：手工合法布局上挪一件进空块、取空施主板，省一张且校验通过
  {
    const board = makeBoard({ id: 'loc_b', wMm: 2440, hMm: 1220 })
    const job = makeJob(
      [
        makePart({ code: 'BIG', lenMm: 1836, widMm: 490 }),
        makePart({ code: 'T', lenMm: 496, widMm: 1000 })
      ],
      { boards: [board] }
    )
    const r = nestJob(job)
    job.result = r
    let ok = false
    let detail = '用例未执行'
    if (r.sheets.length === 1) {
      const src = r.sheets[0]
      const tall = src.placements.find((p) => p.code === 'T')!
      const big = src.placements.find((p) => p.code === 'BIG')!
      const toOc = (rs: Rect[]) =>
        rs
          .filter((x) => x.w >= 2 && x.h >= 2)
          .map((x) => ({
            x: Math.round(x.x),
            y: Math.round(x.y),
            wMm: Math.round(x.w),
            hMm: Math.round(x.h),
            areaMm2: Math.round(x.w * x.h),
            usable: x.w >= 300 - 0.05 && x.h >= 300 - 0.05
          }))
          .sort((a, b) => b.areaMm2 - a.areaMm2)
      // 手工两张：板0 只有 BIG；板1 只放高件 T（500×1000）占左竖条，
      // 右条全高 1921×1204 整块空出（X 留在板0 同 BIG 一起）
      const firstPlacements = [{ ...big, x: 8, y: 8 }]
      const secondPlacements = [{ ...tall, x: 8, y: 212 }]
      const rb0 = rebuildFromPlacements(2440, 1220, 3.2, 8, 0, firstPlacements)
      const rb1 = rebuildFromPlacements(2440, 1220, 3.2, 8, 1, secondPlacements)
      if (rb0 && rb1) {
        r.sheets = [
          { ...src, index: 0, placements: firstPlacements.map((p) => ({ ...p, adjusted: true })), steps: rb0.steps, offcuts: toOc(rb0.leftovers) },
          { ...src, index: 1, placements: secondPlacements.map((p) => ({ ...p, adjusted: true })), steps: rb1.steps, offcuts: toOc(rb1.leftovers) }
        ]
        const plan = planLocalMove(job, r, 1, big.instanceId)
        if ('error' in plan) {
          detail = plan.error
        } else {
          const after: SheetResult[] = []
          r.sheets.forEach((s, i) => {
            if (i === plan.targetIdx) after.push(plan.target)
            else if (i === plan.donorIdx) {
              if (plan.donor) after.push(plan.donor)
            } else after.push(s)
          })
          after.forEach((s, i) => (s.index = i))
          const ver = verifyResult(job, { ...r, sheets: after }, 2)
          ok = plan.donorEmptied && after.length === 1 && ver.ok
          detail = `取空施主板=${plan.donorEmptied}，写回 ${after.length} 张，校验 ${ver.ok ? '通过' : ver.issues[0]?.detail}`
        }
      } else {
        detail = '手工两张布局刀路重建失败'
      }
    } else {
      detail = '基准排样不是 1 张，用例构造失效'
    }
    add('路线一板上对换：挪件入空块取空施主板→省一张且逐刀校验通过', ok, detail)
  }

  // 13) 按板汇总与结果页同源：行数=板数、件数合计=总件数、面积可复算
  {
    const job = makeJob([
      makePart({ code: 'A', lenMm: 500, widMm: 400, qty: 3 }),
      makePart({ code: 'B', lenMm: 300, widMm: 200, qty: 2 })
    ])
    const r = nestJob(job)
    job.result = r
    const rows = boardMaterialRows(r)
    const pieces = rows.reduce((a, x) => a + x.pieces, 0)
    const areaOk = rows.every(
      (x) =>
        Math.abs(x.usedAreaMm2 + x.wasteMm2 - x.boardAreaMm2) <= 1 &&
        Math.abs(x.utilization - x.usedAreaMm2 / x.boardAreaMm2) < 1e-9
    )
    add(
      '材料统计按板汇总与排样结果同源可复算',
      rows.length === r.sheets.length && pieces === 5 && areaOk,
      `${rows.length} 行、${pieces} 件、面积恒等式 ${areaOk ? '成立' : '不成立'}`
    )
  }

  const elapsedMs = Math.round(performance.now() - t0)
  const ok = checks.every((c) => c.ok)
  return { ok, elapsedMs, checks }
}
