<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute } from 'vue-router'
import {
  getJob,
  runNest,
  applyAdjustment,
  registerOffcuts,
  useStore,
  effectiveBoardsFor,
  saveJob,
  applyRemixLocal,
  applyRemixChain,
  auditConsistency,
  type ConsistencyReport
} from '../lib/store'
import { toast } from '../lib/ui'
import { printJob } from '../lib/print'
import { money } from '../lib/format'
import {
  DEFAULT_UTIL_FLOOR_PCT,
  fmtM2,
  fmtUtil,
  overallUtilization,
  sawOps,
  utilFloorPct
} from '../lib/metrics'
import { analyzeRemix, inputSignature } from '../lib/remix'
import type { RemixReport, RemixSheetAdvice } from '../types'
import SheetDiagram from '../components/SheetDiagram.vue'
import { cabinetFill, cabinetStroke } from '../lib/colors'

const route = useRoute()
const job = computed(() => getJob(route.params.id as string))
const result = computed(() => job.value?.result)

const activeSheet = ref(0)
const sheet = computed(() => result.value?.sheets[activeSheet.value])
const adjustMode = ref(false)
const selectedId = ref<string | null>(null)

const floorPct = ref(DEFAULT_UTIL_FLOOR_PCT)
const showAdvice = ref(false)
const report = ref<RemixReport | null>(null)
const audit = ref<ConsistencyReport | null>(null)
const applyingLocal = ref<string | null>(null)
const applyingChain = ref(false)

function syncFloor(): void {
  if (job.value) floorPct.value = utilFloorPct(job.value)
}
syncFloor()
function saveFloor(): void {
  if (!job.value) return
  const v = Math.round(floorPct.value * 2) / 2
  floorPct.value = v < 1 ? 1 : v > 99 ? 99 : v
  job.value.utilFloorPct = floorPct.value
  report.value = null
  saveJob(job.value) // 仅下限设置落盘，结果 rev 不变
}

function buildReport(): void {
  if (!job.value || !result.value) return
  if (result.value.sheets.length === 0) {
    report.value = null
    return
  }
  report.value = analyzeRemix(
    job.value,
    result.value,
    floorPct.value,
    effectiveBoardsFor(job.value)
  )
}
function toggleAdvice(): void {
  showAdvice.value = !showAdvice.value
  if (showAdvice.value) buildReport()
}

/** 建议是否过期（重排/微调/调板后 rev 或输入变化）。 */
const reportStale = computed(
  () =>
    !!report.value &&
    !!result.value &&
    (report.value.baseRev !== (result.value.rev ?? 0) ||
      report.value.floorPct !== floorPct.value)
)

const lowSet = computed(() => new Set(report.value?.lowSheets ?? []))
const sheetAdvice = computed<RemixSheetAdvice | null>(
  () => report.value?.sheets.find((a) => a.sheetIndex === activeSheet.value) ?? null
)

function confirmLocal(instanceId: string): void {
  if (!job.value) return
  if (applyingLocal.value || applyingChain.value) return
  applyingLocal.value = instanceId
  try {
    const out = applyRemixLocal(job.value, activeSheet.value, instanceId)
    if (!out.ok) {
      toast(out.error ?? '确认失败，结果未动', 'bad', 4000)
      return
    }
    audit.value = auditConsistency(job.value)
    report.value = null
    showAdvice.value = false
    selectedId.value = instanceId
    toast(
      `已按路线一挪动并通过同一套内核校验（rev ${out.rev}），刀路/走刀/余料/利用率已刷新`,
      'good',
      3600
    )
  } finally {
    applyingLocal.value = null
  }
}
function confirmChain(): void {
  if (!job.value) return
  if (applyingLocal.value || applyingChain.value) return
  applyingChain.value = true
  try {
    const out = applyRemixChain(job.value, activeSheet.value)
    if (!out.ok) {
      toast(out.error ?? '确认失败，结果未动', 'bad', 4000)
      return
    }
    audit.value = auditConsistency(job.value)
    report.value = null
    showAdvice.value = false
    activeSheet.value = Math.min(activeSheet.value, (job.value.result?.sheets.length ?? 1) - 1)
    toast(
      `已按路线二连锁重排并通过同一套内核校验（rev ${out.rev}），受牵动板标签/下料单请作废重打`,
      'good',
      4200
    )
  } finally {
    applyingChain.value = false
  }
}

const overallUtil = computed(() => (result.value ? overallUtilization(result.value) : 0))
const sawCount = computed(() => (result.value ? sawOps(result.value) : 0))
/** 当前输入与存下的结果对不上（改了板材/零件/锯路/修边后没重排）。 */
const resultStaleInput = computed(() => {
  if (!job.value || !result.value || !result.value.inputSig) return false
  return inputSignature(job.value, effectiveBoardsFor(job.value)) !== result.value.inputSig
})
const cabinets = computed(() => {
  const set = new Set<string>()
  result.value?.sheets.forEach((s) => s.placements.forEach((p) => set.add(p.cabinet)))
  return [...set].sort()
})

// 已登记余料：以 (项目, 板, 尺寸) 判重
const { state } = useStore()
function registered(si: number, o: { x: number; y: number; wMm: number; hMm: number }): boolean {
  const j = job.value
  if (!j) return false
  return state.offcuts.some(
    (x) => x.jobId === j.id && x.sheetIndex === si && x.wMm === o.wMm && x.hMm === o.hMm
  )
}

function registerSheet(si: number): void {
  if (!job.value?.result) return
  const s = job.value.result.sheets[si]
  const picks = s.offcuts
    .filter((o) => o.usable && !registered(si, o))
    .map((o) => ({ sheetIndex: si, x: o.x, y: o.y, wMm: o.wMm, hMm: o.hMm }))
  if (picks.length === 0) {
    toast('该板没有新的可用余料（≥300×300mm）可登记')
    return
  }
  const n = registerOffcuts(job.value, picks)
  toast(`已登记 ${n} 块余料，可在下次开料优先使用`, 'good')
}
function registerAll(): void {
  if (!job.value?.result) return
  let n = 0
  job.value.result.sheets.forEach((s, si) => {
    const picks = s.offcuts
      .filter((o) => o.usable && !registered(si, o))
      .map((o) => ({ sheetIndex: si, x: o.x, y: o.y, wMm: o.wMm, hMm: o.hMm }))
    n += registerOffcuts(job.value!, picks)
  })
  toast(n > 0 ? `已登记全部 ${n} 块余料` : '所有余料均已登记', n > 0 ? 'good' : 'info')
}

function rerun(): void {
  if (!job.value) return
  runNest(job.value)
  activeSheet.value = 0
  report.value = null
  audit.value = auditConsistency(job.value)
  toast('已重新排样', 'good')
}

function onDrop(payload: { instanceId: string; xMm: number; yMm: number }): void {
  if (!job.value?.result || !sheet.value) return
  const si = sheet.value.index
  const placements = sheet.value.placements.map((p) => ({ ...p }))
  const moved = placements.find((p) => p.instanceId === payload.instanceId)
  if (!moved) return
  const EPS = 0.1
  const TOL = 0.5
  const target = sheet.value.placements.find(
    (p) =>
      p.instanceId !== payload.instanceId &&
      payload.xMm >= p.x - TOL &&
      payload.yMm >= p.y - TOL &&
      payload.xMm <= p.x + p.lenMm + TOL &&
      payload.yMm <= p.y + p.widMm + TOL
  )
  if (target) {
    const other = placements.find((p) => p.instanceId === target.instanceId)!
    const fitAB = moved.lenMm <= target.lenMm + EPS && moved.widMm <= target.widMm + EPS
    const fitBA = other.lenMm <= moved.lenMm + EPS && other.widMm <= moved.widMm + EPS
    if (!fitAB || !fitBA) {
      adjustFail('两件槽位尺寸不兼容，交换后非贯通')
      return
    }
    const ax = moved.x
    const ay = moved.y
    moved.x = other.x
    moved.y = other.y
    other.x = ax
    other.y = ay
  } else {
    const oc = sheet.value.offcuts.find(
      (o) =>
        payload.xMm >= o.x - TOL &&
        payload.yMm >= o.y - TOL &&
        payload.xMm <= o.x + o.wMm + TOL &&
        payload.yMm <= o.y + o.hMm + TOL &&
        o.wMm + EPS >= moved.lenMm &&
        o.hMm + EPS >= moved.widMm
    )
    if (!oc) {
      adjustFail('落点必须在虚线余料矩形内，或拖到另一零件上交换')
      return
    }
    moved.x = oc.x
    moved.y = oc.y
  }
  const t0 = performance.now()
  const err = applyAdjustment(job.value, si, placements)
  const ms = performance.now() - t0
  if (err) adjustFail(`${err}（校验耗时 ${ms.toFixed(1)}ms，已撤销）`)
  else {
    report.value = null
    audit.value = auditConsistency(job.value!)
    toast(`微调生效，已重算刀路（增量校验 ${ms.toFixed(1)}ms）`, 'good')
    selectedId.value = moved.instanceId
  }
}
function adjustFail(msg: string): void {
  toast(msg, 'bad', 3800)
}

const selected = computed(() =>
  sheet.value?.placements.find((p) => p.instanceId === selectedId.value) ?? null
)

function printNest(): void {
  if (job.value) printJob(job.value.id, ['nest'])
}
</script>

<template>
  <div v-if="job && result">
    <!-- 总览条 -->
    <section class="panel kpi-bar">
      <div><b>{{ result.boardsUsed }}</b><span>板材（张）</span></div>
      <div><b>{{ fmtUtil(overallUtil) }}</b><span>综合利用率</span></div>
      <div><b>{{ sawCount }}</b><span>走刀次数</span></div>
      <div><b>{{ (result.edgeBandM.exposed + result.edgeBandM.normal).toFixed(2) }}m</b><span>封边总长</span></div>
      <div class="hl"><b>省 {{ result.savedBoards }} 张</b><span>约 {{ money(result.savedCents) }}</span></div>
      <div class="spacer" />
      <button class="sm" @click="rerun">重新排样</button>
      <button class="sm" @click="registerAll">登记全部余料</button>
      <button class="sm primary" @click="printNest">打印排样图</button>
      <router-link class="sm btn-like" :to="`/cut/${job.id}`">看裁切步骤 →</router-link>
    </section>

    <!-- 利用率下限与调板建议 -->
    <section v-if="result.sheets.length > 0" class="panel floor-bar no-print">
      <div class="row" style="gap: 8px">
        <b>利用率下限</b>
        <input
          v-model.number="floorPct"
          type="number"
          min="1"
          max="99"
          step="0.5"
          style="width: 70px"
          @change="saveFloor"
        />
        <span>%</span>
        <span class="muted small">低于此值的板会被挑出来诊断并给挪件试算</span>
        <div class="spacer" />
        <button class="sm" :class="{ primary: showAdvice }" @click="toggleAdvice">
          {{ showAdvice ? '收起调板建议' : '挑出低利用率板并试算' }}
        </button>
      </div>
      <p class="small muted" style="margin: 6px 0 0">
        口径：面积按 mm² 计算再换算 m²（保留 {{ 2 }} 位小数，1m²=1,000,000mm²）；
        利用率保留 1 位小数；余料尺寸整 mm、两边 ≥300mm 才记可用；走刀次数为整数（同规格修边叠切计 1 次）。
        试算只出建议不动结果，点确认才重排。
      </p>
    </section>

    <section v-if="showAdvice" class="panel advice-panel no-print">
      <template v-if="!report">
        <p class="muted small">正在按同一套排样内核试算…</p>
      </template>
      <template v-else>
        <div class="row" style="gap: 10px">
          <b>诊断结果（下限 {{ report.floorPct }}%）</b>
          <span v-if="report.lowSheets.length === 0" class="tag good">
            全部 {{ report.totalSheets }} 张板都不低于下限，没有需要调的板
          </span>
          <span v-else class="tag bad">{{ report.lowSheets.length }} 张低于下限</span>
          <span v-if="reportStale" class="tag warn">结果已变动，建议过期，请重新试算</span>
          <div class="spacer" />
          <button class="sm" @click="buildReport">重新试算</button>
        </div>

        <div v-if="report.lowSheets.length > 0" class="advice-sheet-list">
          <div class="row" style="gap: 6px; margin: 8px 0 4px">
            <button
              v-for="a in report.sheets"
              :key="a.sheetIndex"
              class="sm jump"
              :class="{ active: a.sheetIndex === activeSheet }"
              @click="activeSheet = a.sheetIndex"
            >
              第 {{ a.sheetIndex + 1 }} 张 {{ fmtUtil(a.utilization) }}
            </button>
          </div>

          <article v-if="sheetAdvice" class="advice-card">
            <h4>
              第 {{ sheetAdvice.sheetIndex + 1 }} 张 · {{ sheetAdvice.boardName }} ·
              利用率 {{ fmtUtil(sheetAdvice.utilization) }}（低于 {{ report.floorPct }}%）
            </h4>

            <!-- 空出来的是哪几块 -->
            <div class="void-block">
              <b class="small">本板空块（{{ sheetAdvice.voids.length }}）：</b>
              <div v-if="sheetAdvice.voids.length === 0" class="small muted">无登记空块。</div>
              <ul class="void-list">
                <li v-for="v in sheetAdvice.voids" :key="v.index" class="small">
                  块{{ v.index + 1 }}：{{ v.wMm }}×{{ v.hMm }}mm（{{ fmtM2(v.areaMm2) }}m²）
                  位于 ({{ v.xMm }}, {{ v.yMm }})
                  <span :class="v.usable ? 'tag good' : 'tag'">{{ v.usable ? '可用余料' : '碎料' }}</span>
                </li>
              </ul>
            </div>

            <!-- 路线一 -->
            <div class="route route-a">
              <div class="row">
                <b>路线一 · 板上对换（小动）</b>
                <div class="spacer" />
                <button
                  v-if="sheetAdvice.local.best && !reportStale"
                  class="sm primary"
                  :disabled="applyingLocal !== null || applyingChain"
                  @click="confirmLocal(sheetAdvice.local.best!.instanceId)"
                >
                  {{ applyingLocal === sheetAdvice.local.best.instanceId ? '执行中…' : '按最优一件确认挪动' }}
                </button>
              </div>
              <ul class="notes small">
                <li v-for="(n, i) in sheetAdvice.local.notes" :key="i">{{ n }}</li>
              </ul>

              <div v-if="sheetAdvice.local.noneFitReason" class="small muted">
                {{ sheetAdvice.local.noneFitReason }}
              </div>
              <details v-else class="cand-details">
                <summary class="small">别板上的件能否挪进来（{{ sheetAdvice.local.movableIn.length }} 件明细）</summary>
                <table class="cand-grid">
                  <thead>
                    <tr><th>件</th><th>来自</th><th>就位(mm)</th><th>判定</th></tr>
                  </thead>
                  <tbody>
                    <tr v-for="c in sheetAdvice.local.movableIn" :key="c.instanceId">
                      <td>{{ c.code }}（{{ c.name }}）</td>
                      <td>第 {{ c.fromSheet + 1 }} 张</td>
                      <td>{{ c.lenMm }}×{{ c.widMm }}{{ c.rotated ? '（需旋转90°）' : '' }}</td>
                      <td v-if="c.fitVoid >= 0" class="ok">
                        可挪入块{{ c.fitVoid + 1 }}
                        <button
                          class="sm"
                          :disabled="applyingLocal !== null || applyingChain || !!reportStale"
                          @click="confirmLocal(c.instanceId)"
                        >确认挪这件</button>
                      </td>
                      <td v-else class="bad">{{ c.reason }}</td>
                    </tr>
                  </tbody>
                </table>
              </details>

              <div v-if="sheetAdvice.local.best" class="trial-box">
                <b class="small">试算（挪「{{ sheetAdvice.local.best.instanceId.split('#')[0] }}」）：</b>
                <table class="trial-grid">
                  <tbody>
                    <tr><th>板数</th><td>{{ sheetAdvice.local.best.boardsBefore }} → {{ sheetAdvice.local.best.boardsAfter }} 张（省 {{ sheetAdvice.local.best.boardsSaved }}）</td></tr>
                    <tr><th>走刀次数</th><td>{{ sheetAdvice.local.best.sawOpsBefore }} → {{ sheetAdvice.local.best.sawOpsAfter }}（{{ sheetAdvice.local.best.sawOpsDelta >= 0 ? '+' : '' }}{{ sheetAdvice.local.best.sawOpsDelta }}）</td></tr>
                    <tr><th>可用余料</th><td>{{ fmtM2(sheetAdvice.local.best.offcutAreaBeforeMm2) }} → {{ fmtM2(sheetAdvice.local.best.offcutAreaAfterMm2) }}m²</td></tr>
                    <tr><th>牵动板利用率</th><td>{{ fmtUtil(sheetAdvice.local.best.utilizationBefore) }} → {{ fmtUtil(sheetAdvice.local.best.utilizationAfter) }}</td></tr>
                    <tr><th>作废单据</th><td>{{ sheetAdvice.local.best.voidedDocs.join('；') }}</td></tr>
                  </tbody>
                </table>
              </div>
            </div>

            <!-- 路线二 -->
            <div class="route route-b">
              <div class="row">
                <b>路线二 · 跨板连锁省板（大动）</b>
                <div class="spacer" />
                <button
                  v-if="sheetAdvice.chain.feasible && sheetAdvice.chain.trial && !reportStale"
                  class="sm primary danger"
                  :disabled="applyingLocal !== null || applyingChain"
                  @click="confirmChain"
                >
                  {{ applyingChain ? '重排校验中…' : '确认连锁重排（省一张）' }}
                </button>
              </div>
              <ul v-if="sheetAdvice.chain.notes.length" class="notes small">
                <li v-for="(n, i) in sheetAdvice.chain.notes" :key="i">{{ n }}</li>
              </ul>
              <div v-if="!sheetAdvice.chain.feasible" class="small bad">{{ sheetAdvice.chain.reason }}</div>
              <div v-else-if="sheetAdvice.chain.trial" class="trial-box">
                <b class="small">试算：</b>
                <table class="trial-grid">
                  <tbody>
                    <tr><th>板数</th><td>{{ sheetAdvice.chain.trial.boardsBefore }} → {{ sheetAdvice.chain.trial.boardsAfter }} 张（省 {{ sheetAdvice.chain.trial.boardsSaved }}）</td></tr>
                    <tr><th>走刀次数</th><td>{{ sheetAdvice.chain.trial.sawOpsBefore }} → {{ sheetAdvice.chain.trial.sawOpsAfter }}（{{ sheetAdvice.chain.trial.sawOpsDelta >= 0 ? '+' : '' }}{{ sheetAdvice.chain.trial.sawOpsDelta }}）{{ sheetAdvice.chain.trial.sawOpsDelta > 0 ? '，反而多切，代价已计入' : '' }}</td></tr>
                    <tr><th>可用余料</th><td>{{ fmtM2(sheetAdvice.chain.trial.offcutAreaBeforeMm2) }} → {{ fmtM2(sheetAdvice.chain.trial.offcutAreaAfterMm2) }}m²</td></tr>
                    <tr><th>组内利用率</th><td>{{ fmtUtil(sheetAdvice.chain.trial.utilizationBefore) }} → {{ fmtUtil(sheetAdvice.chain.trial.utilizationAfter) }}</td></tr>
                    <tr><th>牵动板</th><td>第 {{ sheetAdvice.chain.trial.sheetsTouched.map((i) => i + 1).join('、') }} 张全部重排</td></tr>
                    <tr><th>作废单据</th><td>{{ sheetAdvice.chain.trial.voidedDocs.join('；') }}</td></tr>
                  </tbody>
                </table>
              </div>
            </div>
          </article>
        </div>
      </template>
    </section>

    <!-- 确认后取数一致性核对 -->
    <section v-if="audit" class="panel audit-panel no-print">
      <div class="row">
        <b>取数核对（rev {{ audit.rev }}）</b>
        <span :class="audit.ok ? 'tag good' : 'tag bad'">
          {{ audit.ok ? '结果页 / 材料统计 / 打印单据标签 / 本机存档四处一致' : '存在老数，见下' }}
        </span>
      </div>
      <table class="audit-grid">
        <tbody>
          <tr v-for="src in audit.sources" :key="src.key">
            <td>{{ src.ok ? '✅' : '❌' }}</td>
            <td><b>{{ src.label }}</b></td>
            <td class="small muted">{{ src.detail }}</td>
          </tr>
        </tbody>
      </table>
    </section>

    <div v-if="result.unplaced.length > 0" class="alert bad">
      <b>{{ result.unplaced.reduce((a, u) => a + u.qty, 0) }} 件未排下：</b>
      <span v-for="u in result.unplaced" :key="u.partId" class="alert-item">
        {{ u.code }}（{{ u.name }}）×{{ u.qty }}：{{ u.reason }}
      </span>
    </div>
    <div v-for="sh in result.stockShortage" :key="sh.boardId" class="alert warn">
      库存不足：{{ sh.boardName }} 需要 {{ sh.need }} 张，库存仅 {{ sh.have }} 张，请补采 {{ sh.need - sh.have }} 张。
    </div>
    <div v-if="resultStaleInput" class="alert warn">
      零件/板材/锯路/修边在排样后被改过，当前图、统计与打印拿的是上一版结果（rev {{ result.rev ?? 0 }}），
      数字对不上当前清单。请点「重新排样」后再看建议、下料单与标签。
    </div>

    <div class="layout">
      <!-- 左：板标签 -->
      <aside class="sheet-tabs no-print">
        <button
          v-for="s in result.sheets"
          :key="s.index"
          class="sheet-tab"
          :class="{ active: s.index === activeSheet, low: report && lowSet.has(s.index) }"
          @click="activeSheet = s.index"
        >
          <b>第 {{ s.index + 1 }} 张<span v-if="report && lowSet.has(s.index)" class="low-flag">低</span></b>
          <span>{{ s.boardName.length > 14 ? s.material + ' ' + s.thicknessMm + 'mm' : s.boardName }}</span>
          <span class="ut">{{ fmtUtil(s.utilization) }}</span>
        </button>
      </aside>

      <!-- 中：图 -->
      <section class="panel canvas-panel">
        <div class="row" style="margin-bottom: 8px">
          <b>第 {{ activeSheet + 1 }} 张 / 共 {{ result.sheets.length }} 张</b>
          <span class="tag">{{ sheet?.boardName }}</span>
          <span class="tag good">利用率 {{ fmtUtil(sheet?.utilization ?? 0) }}</span>
          <span v-if="sheet?.adjusted" class="tag warn">已手工微调</span>
          <div class="spacer" />
          <label class="row small" style="gap:4px">
            <input type="checkbox" v-model="adjustMode" />
            手工微调（拖动/交换）
          </label>
        </div>

        <div class="svg-wrap" :class="{ adjusting: adjustMode }">
          <SheetDiagram
            v-if="sheet"
            :sheet="sheet"
            :draggable="adjustMode"
            :selected-id="selectedId"
            @drop="onDrop"
            @select="(id) => (selectedId = id)"
          />
        </div>
        <p v-if="adjustMode" class="small muted">
          拖动零件到虚线余料矩形内可移位；拖到另一零件上可交换（要求互相放得下）。
          每次松手都会重新做 guillotine 合法性校验，非贯通排法会被拒绝并撤销。
        </p>

        <div class="row wrap" style="margin-top: 10px">
          <span class="small muted">同色 = 同柜体：</span>
          <span v-for="c in cabinets" :key="c" class="legend">
            <i :style="{ background: cabinetFill(c), borderColor: cabinetStroke(c) }"></i>{{ c }}
          </span>
        </div>
      </section>

      <!-- 右：零件/余料明细 -->
      <aside class="side panel no-print">
        <h4>本板零件（{{ sheet?.placements.length }}）</h4>
        <div class="mini-list">
          <div
            v-for="p in sheet?.placements ?? []"
            :key="p.instanceId"
            class="mini-row"
            :class="{ sel: selectedId === p.instanceId }"
            @click="selectedId = p.instanceId"
          >
            <b>{{ p.seq }}. {{ p.code }}</b>
            <span>{{ p.origLen }}×{{ p.origWid }} · {{ p.cabinet }}</span>
          </div>
        </div>
        <h4 style="margin-top: 12px">可用余料</h4>
        <p v-if="(sheet?.offcuts.filter((o) => o.usable).length ?? 0) === 0" class="small muted">
          本板没有 ≥300×300mm 的余料
        </p>
        <div
          v-for="(o, i) in sheet?.offcuts.filter((x) => x.usable) ?? []"
          :key="i"
          class="oc-row"
        >
          <span>{{ o.wMm }}×{{ o.hMm }}mm · {{ (o.areaMm2 / 1e6).toFixed(2) }}m²</span>
          <span v-if="registered(sheet!.index, o)" class="tag good">已登记</span>
        </div>
        <button class="sm" style="margin-top: 8px" @click="registerSheet(sheet!.index)">
          登记本板余料
        </button>

        <div v-if="selected" class="sel-detail">
          <h4>选中：{{ selected.code }}</h4>
          <p class="small">
            {{ selected.name }}<br />
            尺寸 {{ selected.origLen }}×{{ selected.origWid }}mm
            （就位 {{ Math.round(selected.lenMm) }}×{{ Math.round(selected.widMm) }}）<br />
            位置 ({{ Math.round(selected.x) }}, {{ Math.round(selected.y) }})<br />
            {{ selected.cabinet }} · {{ selected.grain === 'length' ? '竖纹' : selected.grain === 'width' ? '横纹' : '纹理无要求' }}
            · 封边 {{ selected.edgeBands.length }} 边{{ selected.exposed ? ' · 见光' : '' }}
          </p>
        </div>
      </aside>
    </div>
  </div>
  <div v-else class="panel empty">
    <p>该项目还没有排样结果。</p>
    <router-link :to="`/parts/${route.params.id}`"><button class="primary">去录入零件并排样</button></router-link>
  </div>
</template>

<style scoped>
.kpi-bar {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-bottom: 12px;
  flex-wrap: wrap;
}
.kpi-bar > div {
  display: flex;
  flex-direction: column;
}
.kpi-bar b {
  font-size: 20px;
  font-variant-numeric: tabular-nums;
}
.kpi-bar span {
  font-size: 11px;
  color: var(--c-ink-2);
}
.kpi-bar .hl b {
  color: var(--c-primary);
}
.btn-like {
  border: 1px solid var(--c-line);
  border-radius: 6px;
  padding: 5px 10px;
  font-size: 12px;
  text-decoration: none;
}
.alert {
  border-radius: 8px;
  padding: 9px 14px;
  margin-bottom: 10px;
  font-size: 13px;
}
.alert.bad {
  background: var(--c-bad-bg);
  border: 1px solid #eecfcf;
  color: var(--c-bad);
}
.alert.warn {
  background: #fffbeb;
  border: 1px solid #f0d9b5;
  color: #92600a;
}
.alert-item {
  margin-right: 14px;
  white-space: nowrap;
}
.layout {
  display: grid;
  grid-template-columns: 132px 1fr 282px;
  gap: 12px;
  align-items: start;
}
.sheet-tabs {
  display: flex;
  flex-direction: column;
  gap: 8px;
  position: sticky;
  top: 70px;
}
.sheet-tab {
  text-align: left;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 10px;
}
.sheet-tab b {
  font-size: 13px;
}
.sheet-tab span {
  font-size: 11px;
  color: var(--c-ink-2);
}
.sheet-tab .ut {
  font-weight: 700;
  color: var(--c-accent);
}
.sheet-tab.active {
  border-color: var(--c-primary);
  background: #fff7ed;
}
.canvas-panel {
  min-width: 0;
}
.svg-wrap {
  border: 1px solid var(--c-line);
  border-radius: 6px;
  background: #fff;
  padding: 8px;
}
.svg-wrap.adjusting {
  border-color: var(--c-primary);
  border-style: dashed;
}
.legend {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
}
.legend i {
  display: inline-block;
  width: 13px;
  height: 13px;
  border: 1.5px solid;
  border-radius: 3px;
}
.side {
  max-height: calc(100vh - 90px);
  overflow: auto;
}
.side h4 {
  font-size: 13px;
}
.mini-list {
  max-height: 300px;
  overflow-y: auto;
  border: 1px solid var(--c-line-soft);
  border-radius: 6px;
}
.mini-row {
  padding: 4px 8px;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  border-bottom: 1px solid var(--c-line-soft);
}
.mini-row:last-child {
  border-bottom: none;
}
.mini-row span {
  font-size: 11px;
  color: var(--c-ink-2);
}
.mini-row.sel {
  background: #fff7ed;
}
.oc-row {
  display: flex;
  justify-content: space-between;
  font-size: 12px;
  padding: 4px 0;
  border-bottom: 1px dashed var(--c-line-soft);
}
.sel-detail {
  margin-top: 14px;
  border-top: 1px solid var(--c-line);
  padding-top: 8px;
}
.empty {
  text-align: center;
  padding: 50px;
}
.floor-bar {
  margin-bottom: 10px;
  padding: 10px 14px;
}
.advice-panel {
  margin-bottom: 12px;
  border-color: #f0d9b5;
}
.advice-sheet-list .jump.active {
  border-color: var(--c-primary);
  background: #fff7ed;
}
.advice-card {
  border: 1px solid var(--c-line);
  border-radius: 8px;
  padding: 10px 12px;
  margin-top: 8px;
}
.advice-card h4 {
  font-size: 13px;
  margin-bottom: 8px;
}
.void-block {
  margin-bottom: 8px;
}
.void-list {
  margin: 4px 0 0;
  padding-left: 18px;
}
.void-list li {
  margin: 2px 0;
}
.route {
  border-radius: 8px;
  padding: 8px 10px;
  margin-top: 8px;
}
.route-a {
  background: #f4f7f3;
  border: 1px solid #d7e0d8;
}
.route-b {
  background: #fff7ed;
  border: 1px solid #f0d9b5;
}
.notes {
  margin: 6px 0;
  padding-left: 18px;
}
.notes li {
  margin: 2px 0;
}
.cand-details {
  margin: 6px 0;
}
.cand-grid,
.trial-grid,
.audit-grid {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
  margin-top: 4px;
}
.cand-grid th,
.cand-grid td {
  border: 1px solid var(--c-line-soft);
  padding: 3px 6px;
  text-align: left;
}
.cand-grid td.ok {
  color: #15803d;
}
.cand-grid td.bad {
  color: #b91c1c;
}
.trial-grid th {
  width: 110px;
  text-align: left;
  vertical-align: top;
  color: var(--c-ink-2);
  font-weight: 600;
  padding: 2px 8px 2px 0;
}
.audit-grid td {
  padding: 3px 8px 3px 0;
}
.trial-box {
  margin-top: 6px;
  background: #fff;
  border: 1px dashed var(--c-line);
  border-radius: 6px;
  padding: 6px 8px;
}
.audit-panel {
  margin-bottom: 12px;
}
.sheet-tab.low {
  border-color: #e0a3a3;
  background: #fef2f2;
}
.low-flag {
  display: inline-block;
  margin-left: 5px;
  background: #dc2626;
  color: #fff;
  font-size: 10px;
  border-radius: 3px;
  padding: 0 4px;
  vertical-align: middle;
}
button.danger {
  border-color: #dc2626;
  color: #b91c1c;
}
@media (max-width: 1100px) {
  .layout {
    grid-template-columns: 1fr;
  }
  .sheet-tabs {
    flex-direction: row;
    overflow-x: auto;
    position: static;
  }
}
</style>
