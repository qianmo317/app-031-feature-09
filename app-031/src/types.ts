// 数据模型（对应规格书 §7，进阶功能所需字段为可选扩展）

export type GrainDemand = 'length' | 'width' | 'none' // 竖纹 / 横纹 / 无要求
export type EdgeSide = 'top' | 'bottom' | 'left' | 'right'

export interface Board {
  id: string
  name: string
  wMm: number
  hMm: number
  thicknessMm: number
  material: string
  priceCents: number
  quantity: number // 库存张数，0 = 不限
  kind?: 'stock' | 'offcut' // stock 常规板材 / offcut 登记余料转来的小板
  offcutId?: string
}

export interface Part {
  id: string
  code: string
  name: string
  lenMm: number
  widMm: number
  qty: number
  grain: GrainDemand
  edgeBands: EdgeSide[]
  cabinet: string // 所在柜体/房间，便于分拣
  exposed: boolean // 是否见光
  boardId?: string // 指定板材类型，空 = 自动
}

export interface Placement {
  partId: string
  instanceId: string
  boardIndex: number
  x: number
  y: number
  lenMm: number // 实际占 x 方向的尺寸（纹理=横纹时为零件 wid，rotated 仍为 false）
  widMm: number // 实际占 y 方向的尺寸
  origLen: number // 清单录入尺寸（标签用）
  origWid: number
  rotated: boolean
  seq: number
  // 冗余展示字段
  code: string
  name: string
  cabinet: string
  exposed: boolean
  grain: GrainDemand
  edgeBands: EdgeSide[]
  adjusted?: boolean // 手工微调产生
}

export interface CutStep {
  boardIndex: number
  axis: 'v' | 'h'
  at: number // 切割线坐标（mm，板左下角原点）
  span: [number, number] // 贯通区间起止
  order: number
  kind: 'trim' | 'cut'
  label: string
}

export interface OffcutInfo {
  x: number
  y: number
  wMm: number
  hMm: number
  areaMm2: number
  usable: boolean // 两边 ≥300mm 才登记为可用余料，其余仅作碎料留档
}

export interface SheetResult {
  index: number
  boardId: string
  boardName: string
  material: string
  thicknessMm: number
  wMm: number
  hMm: number
  priceCents: number
  placements: Placement[]
  steps: CutStep[]
  usedAreaMm2: number
  boardAreaMm2: number
  utilization: number
  offcuts: OffcutInfo[]
  adjusted?: boolean
}

export interface UnplacedInfo {
  partId: string
  code: string
  name: string
  qty: number
  reason: string
}

export interface NestResult {
  sheets: SheetResult[]
  boardsUsed: number
  boardsByType: Record<string, number>
  edgeBandM: { exposed: number; normal: number }
  unplaced: UnplacedInfo[]
  baselineBoards: number // 随手排（朴素顺板）需要的张数
  savedBoards: number
  savedCents: number
  totalCostCents: number
  stockShortage: { boardId: string; boardName: string; need: number; have: number }[]
  elapsedMs: number
  generatedAt: number
  // —— 调板/取数一致性扩展（旧本机存档可能缺字段，缺则视为待重新排样）——
  rev?: number // 结果版本号：重排/微调/调板确认各 +1，防试算过期与重复确认
  inputSig?: string // 生成该结果时的输入签名（板材/零件/锯路/修边/余料/分组）
  sawOps?: number // 车间实际走刀次数（修边同规格叠切计 1 次），与 countSawOps 同源
  usableOffcutAreaMm2?: number // 全部板上可用余料（≥300×300）面积合计，mm²
}

export interface Job {
  id: string
  name: string
  createdAt: number
  boards: Board[]
  parts: Part[]
  kerfMm: number
  trimMm: number
  useOffcutIds: string[] // 参与本单排样的登记余料
  batchByCabinet: boolean // 按柜体批次分组开料
  result?: NestResult
  utilFloorPct?: number // 利用率下限（百分数，如 75 = 75.0%）；缺省 75
  caps?: Record<string, number> // 连锁试算专用：板种开板硬上限（不参与普通排样）
}

export interface RegisteredOffcut {
  id: string
  jobId: string
  jobName: string
  sheetIndex: number
  wMm: number
  hMm: number
  thicknessMm: number
  material: string
  createdAt: number
  available: boolean
  usedByJobId?: string
}

// —— 低利用率板诊断与调板试算（只出建议，确认才动结果）——

/** 板上空出来的一块（来自排样内核回收的空档，整 mm 展示）。 */
export interface RemixVoid {
  index: number
  xMm: number
  yMm: number
  wMm: number
  hMm: number
  areaMm2: number
  usable: boolean // 两边 ≥300mm
}

/** 别的板上、理论上可挪进某空块的一件（路线一候选）。 */
export interface RemixCandPart {
  instanceId: string
  code: string
  name: string
  cabinet: string
  fromSheet: number
  lenMm: number // 就位尺寸
  widMm: number
  grain: GrainDemand
  rotated: boolean // 挪入时是否需要旋转（纹理件恒 false）
  fitVoid: number // 放得进的空块序号；-1 = 哪块都放不进
  reason: string // 放不进时的原因
}

/** 一份试算：改前/改后的板数、走刀次数、余料与利用率。所有数字均来自内核重算。 */
export interface RemixTrial {
  feasible: boolean
  reason: string // 不可行/不划算的原因；可行时为空
  boardsBefore: number
  boardsAfter: number
  boardsSaved: number
  sawOpsBefore: number
  sawOpsAfter: number
  sawOpsDelta: number
  offcutAreaBeforeMm2: number
  offcutAreaAfterMm2: number
  offcutAreaDeltaMm2: number
  utilizationBefore: number
  utilizationAfter: number // 受牵动板的合计利用率
  sheetsTouched: number[] // 受牵动板（当前板序）
  voidedDocs: string[] // 需作废重打的单据
}

/** 路线一（板上对换·小动）的建议。 */
export interface RemixLocalAdvice {
  movableIn: RemixCandPart[]
  noneFitReason: string // 全部挪不进来时的原因
  best: (RemixTrial & { instanceId: string }) | null
  notes: string[] // 让/要付出的东西
}

/** 路线二（跨板连锁·大动）的建议。 */
export interface RemixChainAdvice {
  feasible: boolean
  reason: string // 不划算/不可行原因
  trial: RemixTrial | null
  notes: string[] // 让/要付出的东西
}

/** 单张低利用率板的诊断。 */
export interface RemixSheetAdvice {
  sheetIndex: number
  boardName: string
  utilization: number
  voids: RemixVoid[]
  local: RemixLocalAdvice
  chain: RemixChainAdvice
}

export interface RemixReport {
  floorPct: number // 本次诊断采用的下限（百分数）
  inputSig: string // 诊断基于的输入签名；签名或 rev 变了报告即过期
  baseRev: number
  totalSheets: number
  lowSheets: number[]
  sheets: RemixSheetAdvice[]
  elapsedMs: number
}

