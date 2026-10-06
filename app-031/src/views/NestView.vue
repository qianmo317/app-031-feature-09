<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute } from 'vue-router'
import {
  getJob,
  runNest,
  applyAdjustment,
  registerOffcuts,
  useStore,
  applyOptimization
} from '../lib/store'
import { toast } from '../lib/ui'
import { printJob } from '../lib/print'
import { pct, money, DEFAULT_LOW_UTIL_FLOOR_PCT } from '../lib/format'
import {
  analyzeLowSheets,
  auditResultConsistency,
  type OptimizeReport,
  type RouteId,
  type RouteTrial,
  type SheetAdvice,
  type AuditItem
} from '../lib/optimize'
import SheetDiagram from '../components/SheetDiagram.vue'
import { cabinetFill, cabinetStroke } from '../lib/colors'

const route = useRoute()
const job = computed(() => getJob(route.params.id as string))
const result = computed(() => job.value?.result)

const activeSheet = ref(0)
const sheet = computed(() => result.value?.sheets[activeSheet.value])
const adjustMode = ref(false)
const selectedId = ref<string | null>(null)

// —— 省板建议 ——
const floorPct = ref(DEFAULT_LOW_UTIL_FLOOR_PCT)
const advice = ref<OptimizeReport | null>(null)
const analyzing = ref(false)
const applyingRoute = ref<RouteId | null>(null)
const auditItems = ref<AuditItem[] | null>(null)

const adviceBySheet = computed(() => {
  const m = new Map<number, SheetAdvice>()
  advice.value?.advices.forEach((a) => m.set(a.sheetIndex, a))
  return m
})
const activeAdvice = computed(() =>
  sheet.value ? adviceBySheet.value.get(sheet.value.index) ?? null : null
)

function runAdvice(): void {
  if (!job.value?.result) return
  analyzing.value = true
  auditItems.value = null
  // 让按钮状态先画出来再做重计算（板多时多路搜索会卡一下 UI）
  setTimeout(() => {
    try {
      advice.value = analyzeLowSheets(job.value!, job.value!.result!, {
        floorPct: floorPct.value
      })
      auditItems.value = auditResultConsistency(job.value!.result!, readStoredResult(job.value!.id))
      const n = advice.value.belowCount
      toast(
        n === 0
          ? `按 ${floorPct.value}% 下限检查：没有偏低的板`
          : `挑出 ${n} 张低于 ${floorPct.value}% 的板，已给出两条挪件路的试算`,
        n === 0 ? 'info' : 'good'
      )
    } finally {
      analyzing.value = false
    }
  }, 20)
}

function clearAdvice(): void {
  advice.value = null
  auditItems.value = null
}

/** 从本机存档里读同一项目的结果（不经过内存态），用于核对五处取数是否同源。 */
function readStoredResult(jobId: string) {
  try {
    const raw = localStorage.getItem('fco.jobs.v1')
    if (!raw) return null
    const arr = JSON.parse(raw) as { id: string; result?: import('../types').NestResult }[]
    const j = arr.find((x) => x.id === jobId)
    return j?.result ?? null
  } catch {
    return null
  }
}

function jumpSheet(i: number): void {
  activeSheet.value = i
}

function deltaBoardsText(t: RouteTrial): string {
  if (t.boardsDelta === 0) return '板数不变'
  return t.boardsDelta < 0 ? `少 ${-t.boardsDelta} 张` : `多 ${t.boardsDelta} 张`
}
function deltaCutsText(t: RouteTrial): string {
  if (t.sawOpsDelta === 0) return '走刀次数不变'
  return t.sawOpsDelta < 0 ? `少走 ${-t.sawOpsDelta} 刀` : `多走 ${t.sawOpsDelta} 刀`
}

function confirmTrial(routeId: RouteId, t: RouteTrial): void {
  if (!job.value?.result || !advice.value) return
  const isChain = routeId === 'chainSheets'
  const warn = isChain
    ? `确认按「跨板连锁」重排？\n\n` +
      `· 重排后板数 ${t.oldIndices.length} → ${t.sheetsAfterCount} 张（${deltaBoardsText(t)}），${deltaCutsText(t)}；\n` +
      `· 牵动第 ${t.affectedSheetsBefore.join('、')} 张板，每张都要重排；\n` +
      `· 重排以前已发到车间的标签与下料单全部作废，需要重新打印；\n` +
      `· 试算只给了建议，确认后才真正改结果，出错会整体回退。`
    : `确认按「同板对换」重排这一张板？\n\n` +
      `· 只动这一张，其它板一张不碰，板数不变；\n` +
      `· 重排后这张板已打印的标签/下料单作废，需要重新打印；\n` +
      `· 出错会整体回退，不动其它板。`
  if (!window.confirm(warn)) return
  applyingRoute.value = routeId
  setTimeout(() => {
    try {
      const res = applyOptimization(job.value!, routeId, t, floorPct.value)
      if (!res.ok) {
        toast(res.error ?? '重排失败，未改动', 'bad', 4200)
        return
      }
      const newCount = res.newResult!.sheets.length
      const oldCount = result.value!.sheets.length
      advice.value = analyzeLowSheets(job.value!, res.newResult!, { floorPct: floorPct.value })
      auditItems.value = auditResultConsistency(res.newResult!, readStoredResult(job.value!.id))
      if (activeSheet.value >= newCount) activeSheet.value = newCount - 1
      toast(
        isChain
          ? `已重排：${oldCount} → ${newCount} 张板；刀路按贯通顺序重给，走刀/余料/利用率与各处单据已一起刷新`
          : '已按同板对换重排；其它板未动，刀路与余料已重算',
        'good',
        3600
      )
    } finally {
      applyingRoute.value = null
    }
  }, 20)
}

const overallUtil = computed(() => {
  if (!result.value || result.value.sheets.length === 0) return 0
  const used = result.value.sheets.reduce((a, s) => a + s.usedAreaMm2, 0)
  const total = result.value.sheets.reduce((a, s) => a + s.boardAreaMm2, 0)
  return total > 0 ? used / total : 0
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
  clearAdvice()
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
    toast(`微调生效，已重算刀路（增量校验 ${ms.toFixed(1)}ms）`, 'good')
    selectedId.value = moved.instanceId
    // 手工改动后旧试算计划已对不上，作废当前建议（防确认时把旧方案写回）
    clearAdvice()
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
      <div><b>{{ pct(overallUtil) }}</b><span>综合利用率</span></div>
      <div><b>{{ (result.edgeBandM.exposed + result.edgeBandM.normal).toFixed(1) }}m</b><span>封边总长</span></div>
      <div class="hl"><b>省 {{ result.savedBoards }} 张</b><span>约 {{ money(result.savedCents) }}</span></div>
      <div class="spacer" />
      <button class="sm" @click="rerun">重新排样</button>
      <button class="sm" @click="registerAll">登记全部余料</button>
      <button class="sm primary" @click="printNest">打印排样图</button>
      <router-link class="sm btn-like" :to="`/cut/${job.id}`">看裁切步骤 →</router-link>
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

    <!-- 省板建议：只出试算，确认才动结果；一张板都没排下时不出这些行 -->
    <section v-if="result.sheets.length > 0" class="panel advice-panel no-print">
      <div class="row wrap" style="gap: 10px; align-items: center">
        <h3 style="font-size: 14px; margin: 0">省板建议</h3>
        <label class="row small" style="gap: 5px">
          利用率下限
          <input
            v-model.number="floorPct"
            type="number"
            min="1"
            max="99"
            step="1"
            style="width: 64px"
            @change="clearAdvice"
          />
          %（低于该值的板挑出来）
        </label>
        <button class="sm primary" :disabled="analyzing" @click="runAdvice">
          {{ analyzing ? '试算中…' : advice ? '重新试算' : '挑出低利用板并试算' }}
        </button>
        <button v-if="advice" class="sm" @click="clearAdvice">收起建议</button>
        <span class="spacer" />
        <span v-if="advice" class="small muted">试算耗时 {{ advice.elapsedMs }}ms · 仅给建议，未改任何结果</span>
      </div>

      <div v-if="advice && advice.belowCount === 0" class="adv-ok">
        ✅ 共 {{ advice.sheetsCount }} 张板，没有利用率低于 {{ advice.floorPct }}% 的板，无需调板。
      </div>

      <div v-if="advice && advice.belowCount > 0" class="adv-summary">
        <p class="small" style="margin: 8px 0 6px">
          挑出 <b>{{ advice.belowCount }}</b> 张低于 {{ advice.floorPct }}% 的板（点板号跳到该板看空档与两条挪件路）：
        </p>
        <div class="chips">
          <button
            v-for="a in advice.advices"
            :key="a.sheetIndex"
            class="chip"
            :class="{ on: a.sheetIndex === activeSheet, saveable: a.chain.feasible }"
            @click="jumpSheet(a.sheetIndex)"
          >
            第 {{ a.sheetIndex + 1 }} 张 · {{ pct(a.utilization) }}
            <i v-if="a.chain.feasible">可省 {{ -a.chain.boardsDelta }} 张</i>
            <i v-else>省不下整板</i>
          </button>
        </div>
        <div class="route-legend small muted">
          两条路的取舍：<b>路 A 同板对换</b>——只动这一张、其它板不碰，但省不下整张板；
          <b>路 B 跨板连锁</b>——有机会真少开一张板，但牵动的每张板都要重排，
          重排前发去车间的标签/下料单作废，还要担多切几刀的风险。代价都写在下面各方案里。
        </div>
      </div>
    </section>

    <!-- 取数一致性对账 -->
    <section v-if="auditItems && result.sheets.length > 0" class="panel audit-panel no-print">
      <div class="row" style="gap:8px">
        <b class="small">五处取数核对</b>
        <span :class="['tag', auditItems.every((i) => i.ok) ? 'good' : 'bad']">
          {{ auditItems.every((i) => i.ok) ? '全部为同一版数' : '存在旧数' }}
        </span>
      </div>
      <table class="audit-grid">
        <tr v-for="(it, i) in auditItems" :key="i">
          <td>{{ it.ok ? '✅' : '❌' }}</td>
          <td class="small"><b>{{ it.surface }}</b></td>
          <td class="small muted">{{ it.detail }}</td>
        </tr>
      </table>
      <p v-if="!auditItems.every((i) => i.ok)" class="small bad-text">
        标 ❌ 的那一处仍拿老数，请以当前排样结果为准重新进入该页面/重新打印。
      </p>
    </section>

    <div class="layout">
      <!-- 左：板标签 -->
      <aside class="sheet-tabs no-print">
        <button
          v-for="s in result.sheets"
          :key="s.index"
          class="sheet-tab"
          :class="{
            active: s.index === activeSheet,
            low: adviceBySheet.has(s.index),
            saveable: adviceBySheet.get(s.index)?.chain.feasible
          }"
          @click="activeSheet = s.index"
        >
          <b>第 {{ s.index + 1 }} 张</b>
          <span>{{ s.boardName.length > 14 ? s.material + ' ' + s.thicknessMm + 'mm' : s.boardName }}</span>
          <span class="ut" :class="{ bad: adviceBySheet.has(s.index) }">{{ pct(s.utilization) }}</span>
          <span v-if="adviceBySheet.get(s.index)?.chain.feasible" class="ut-save">可省板</span>
          <span v-else-if="adviceBySheet.has(s.index)" class="ut-low">低于下限</span>
        </button>
      </aside>

      <!-- 中：图 -->
      <section class="panel canvas-panel">
        <div class="row" style="margin-bottom: 8px">
          <b>第 {{ activeSheet + 1 }} 张 / 共 {{ result.sheets.length }} 张</b>
          <span class="tag">{{ sheet?.boardName }}</span>
          <span class="tag good">利用率 {{ pct(sheet?.utilization ?? 0) }}</span>
          <span v-if="sheet?.adjusted" class="tag warn">已手工微调</span>
          <span v-if="result.optimized" class="tag good">已按省板建议重排</span>
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

        <!-- 本板省板诊断 -->
        <div v-if="activeAdvice" class="sheet-advice">
          <div class="adv-head row">
            <b>本板利用率 {{ pct(activeAdvice.utilization) }}，低于下限 {{ advice!.floorPct }}%</b>
            <span class="spacer" />
            <span class="small muted">空出来的料块（虚线框）：</span>
          </div>

          <table class="void-grid">
            <thead>
              <tr><th>空块位置/尺寸(mm)</th><th>面积</th><th>别处的件能否挪进来</th></tr>
            </thead>
            <tbody>
              <tr v-for="v in activeAdvice.voids" :key="v.id" :class="{ unusable: !v.usable }">
                <td>
                  ({{ v.x }}, {{ v.y }}) {{ v.wMm }}×{{ v.hMm }}
                  <span class="tag" :class="v.usable ? 'good' : ''">{{ v.usable ? '可用余料' : '碎料' }}</span>
                </td>
                <td>{{ (v.areaMm2 / 1e6).toFixed(2) }}m²</td>
                <td v-if="v.bestMover">
                  可挪 <b>{{ v.bestMover.code }}</b>（{{ v.bestMover.name }}，
                  {{ v.bestMover.lenMm }}×{{ v.bestMover.widMm }}mm，第 {{ v.bestMover.fromSheet }} 张板，
                  {{ v.bestMover.cabinet }}），塞入后剩余 {{ (v.bestMover.wasteMm2 / 1e6).toFixed(2) }}m²
                </td>
                <td v-else class="muted">{{ v.blockReason }}</td>
              </tr>
              <tr v-if="activeAdvice.voids.length === 0">
                <td colspan="3" class="muted">本板没有可登记的空档（全部切到边或只剩锯路零头）。</td>
              </tr>
            </tbody>
          </table>

          <div class="route-cards">
            <!-- 路 A -->
            <div class="route-card" :class="{ no: !activeAdvice.local.feasible }">
              <div class="rt-title">
                <b>路 A · 同板对换</b>
                <span class="small muted">只动本张板，其它板一张不碰</span>
              </div>
              <ul class="rt-facts small">
                <li>板数：{{ result.boardsUsed }} → {{ result.boardsUsed + activeAdvice.local.boardsDelta }} 张（{{ deltaBoardsText(activeAdvice.local) }}）</li>
                <li>走刀：{{ activeAdvice.local.sawOpsAfter - activeAdvice.local.sawOpsDelta }} → {{ activeAdvice.local.sawOpsAfter }} 次（{{ deltaCutsText(activeAdvice.local) }}）</li>
                <li>可用余料：{{ (activeAdvice.local.offcutAreaMm2After / 1e6).toFixed(2) }}m²（{{ activeAdvice.local.offcutAreaDeltaMm2 >= 0 ? '+' : '' }}{{ (activeAdvice.local.offcutAreaDeltaMm2 / 1e6).toFixed(2) }}m²）</li>
                <li>重排后本板利用率均值 {{ pct(activeAdvice.local.utilAvgAfter) }}，最低 {{ pct(activeAdvice.local.utilMinAfter) }}</li>
              </ul>
              <p class="rt-reason small">{{ activeAdvice.local.feasible ? activeAdvice.local.reason : activeAdvice.local.reason }}</p>
              <p class="rt-cost small muted">
                让出的东西：只重排第 {{ activeAdvice.local.affectedSheetsBefore.join('、') }} 张板，
                这一张已打印的标签/下料单作废要重打；其余板不受影响。
              </p>
              <button
                class="sm"
                :disabled="!activeAdvice.local.feasible || applyingRoute !== null"
                @click="confirmTrial('swapLocal', activeAdvice.local)"
              >
                {{ activeAdvice.local.feasible ? '确认按路 A 重排' : '试算不划算，不动' }}
              </button>
            </div>

            <!-- 路 B -->
            <div class="route-card chain" :class="{ no: !activeAdvice.chain.feasible }">
              <div class="rt-title">
                <b>路 B · 跨板连锁</b>
                <span class="small muted">牵动第 {{ activeAdvice.chain.affectedSheetsBefore.join('、') }} 张板</span>
              </div>
              <ul class="rt-facts small">
                <li>板数：组内 {{ activeAdvice.chain.oldIndices.length }} → {{ activeAdvice.chain.sheetsAfterCount }} 张（{{ deltaBoardsText(activeAdvice.chain) }}）</li>
                <li>走刀：{{ activeAdvice.chain.sawOpsAfter - activeAdvice.chain.sawOpsDelta }} → {{ activeAdvice.chain.sawOpsAfter }} 次（{{ deltaCutsText(activeAdvice.chain) }}）</li>
                <li>可用余料：{{ (activeAdvice.chain.offcutAreaMm2After / 1e6).toFixed(2) }}m²（{{ activeAdvice.chain.offcutAreaDeltaMm2 >= 0 ? '+' : '' }}{{ (activeAdvice.chain.offcutAreaDeltaMm2 / 1e6).toFixed(2) }}m²）</li>
                <li>搜索策略：{{ activeAdvice.chain.strategyLabel || '—' }}，试算 {{ activeAdvice.chain.elapsedMs }}ms</li>
              </ul>
              <p class="rt-reason small">
                {{ activeAdvice.chain.feasible ? activeAdvice.chain.reason : activeAdvice.chain.reason }}
              </p>
              <p class="rt-cost small muted">
                让出的东西：被牵动的 {{ activeAdvice.chain.affectedSheetsBefore.length }} 张板全部重排，
                重排前发去车间的标签与下料单作废；风险是可能多切几刀（上面已按逐刀模拟算出实际变化）。
              </p>
              <button
                class="sm primary"
                :disabled="!activeAdvice.chain.feasible || applyingRoute !== null"
                @click="confirmTrial('chainSheets', activeAdvice.chain)"
              >
                {{ applyingRoute === 'chainSheets' ? '重排回写中…' : activeAdvice.chain.feasible ? '确认按路 B 重排（省一张）' : '凑不出省一张的空档' }}
              </button>
            </div>
          </div>
          <p class="small muted" style="margin: 6px 0 0">
            所有试算的余隙、四周修边与贯通合法性都挂在排样内核同一条判定上；点确认后刀路按贯通切割顺序重新生成并逐刀核到每块件。
          </p>
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
/* 省板建议 */
.advice-panel {
  margin-bottom: 12px;
}
.adv-ok {
  margin-top: 10px;
  padding: 10px 12px;
  border-radius: 6px;
  background: #f4f7f3;
  font-size: 13px;
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 8px;
}
.chip {
  border: 1px solid var(--c-line);
  border-radius: 16px;
  padding: 4px 12px;
  font-size: 12px;
  background: #fff;
  cursor: pointer;
}
.chip.on {
  border-color: var(--c-primary);
  background: #fff7ed;
}
.chip.saveable {
  border-color: #15803d;
}
.chip i {
  font-style: normal;
  margin-left: 6px;
  color: var(--c-ink-2);
}
.chip.saveable i {
  color: #15803d;
  font-weight: 700;
}
.route-legend {
  border-top: 1px dashed var(--c-line-soft);
  padding-top: 8px;
  line-height: 1.6;
}
.audit-panel {
  margin-bottom: 12px;
}
.audit-grid {
  margin-top: 6px;
  display: table;
}
.audit-grid td {
  padding: 2px 10px 2px 0;
  vertical-align: top;
}
.bad-text {
  color: var(--c-bad);
  margin-top: 4px;
}
.sheet-tab.low .ut.bad {
  color: var(--c-bad);
}
.sheet-tab.saveable {
  border-color: #15803d;
}
.ut-low,
.ut-save {
  font-size: 10px;
  font-weight: 700;
}
.ut-low {
  color: var(--c-bad);
}
.ut-save {
  color: #15803d;
}
.sheet-advice {
  margin-top: 12px;
  border-top: 1px solid var(--c-line);
  padding-top: 10px;
}
.void-grid {
  width: 100%;
  border-collapse: collapse;
  margin: 8px 0;
  font-size: 12px;
}
.void-grid th,
.void-grid td {
  border: 1px solid var(--c-line-soft);
  padding: 4px 8px;
  text-align: left;
}
.void-grid th {
  background: #f7f8f6;
}
.void-grid tr.unusable {
  color: var(--c-ink-2);
}
.route-cards {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
  margin-top: 8px;
}
.route-card {
  border: 1px solid var(--c-line);
  border-radius: 8px;
  padding: 10px 12px;
  background: #fffdf8;
}
.route-card.chain {
  background: #f6faf4;
  border-color: #bfe3c3;
}
.route-card.no {
  background: #fafafa;
  opacity: 0.85;
}
.rt-title {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-bottom: 6px;
}
.rt-facts {
  margin: 0 0 6px;
  padding-left: 16px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.rt-reason {
  margin: 0 0 6px;
  color: #1f2a26;
  line-height: 1.5;
}
.route-card.no .rt-reason {
  color: var(--c-ink-2);
}
.rt-cost {
  margin: 0 0 8px;
  line-height: 1.5;
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
  .route-cards {
    grid-template-columns: 1fr;
  }
}
</style>
