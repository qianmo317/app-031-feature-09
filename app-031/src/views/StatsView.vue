<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { getJob } from '../lib/store'
import boardsData from '../data/boards.json'
import { money } from '../lib/format'
import {
  boardMaterialRows,
  fmtM2,
  fmtUtil,
  overallUtilization,
  sawOps,
  totalPartCount,
  usableOffcutAreaMm2
} from '../lib/metrics'

const route = useRoute()
const job = computed(() => getJob(route.params.id as string))
const result = computed(() => job.value?.result)

const totalPieces = computed(() => (result.value ? totalPartCount(result.value) : 0))
const totalEdgeM = computed(
  () => (result.value?.edgeBandM.exposed ?? 0) + (result.value?.edgeBandM.normal ?? 0)
)
const hardware = computed(() => {
  const h = boardsData.hardware
  const n = totalPieces.value
  return [
    { name: h.connectorName, value: n * h.connectorPerPart, unit: '套' },
    { name: h.dowelName, value: n * h.dowelPerPart, unit: '个' },
    { name: h.screwName, value: n * h.screwPerPart, unit: '颗' },
    {
      name: h.glueName,
      value: Number(((totalEdgeM.value * h.glueGramPerEdgeMeter) / 1000).toFixed(2)),
      unit: 'kg'
    }
  ]
})

const rows = computed(() => (result.value ? boardMaterialRows(result.value) : []))
const usableOffcuts = computed(() => ({
  list: rows.value.flatMap((r) =>
    (result.value?.sheets[r.index]?.offcuts ?? [])
      .filter((o) => o.usable)
      .map((o) => ({ ...o, sheet: r.index + 1 }))
  ),
  area: result.value ? usableOffcutAreaMm2(result.value) : 0
}))

const overallUtil = computed(() => (result.value ? overallUtilization(result.value) : 0))
const sawCount = computed(() => (result.value ? sawOps(result.value) : 0))
const utilMinMax = computed(() => {
  const us = result.value?.sheets.map((s) => s.utilization) ?? []
  if (us.length === 0) return { min: 0, max: 0 }
  return { min: Math.min(...us), max: Math.max(...us) }
})
</script>

<template>
  <div v-if="job && result">
    <!-- 师傅最关心的一句话 -->
    <section class="panel headline">
      <div class="hl-text">
        <h2>
          本方案用 <b>{{ result.boardsUsed }}</b> 张板，
          比随手排省 <b class="hl">{{ result.savedBoards }}</b> 张
          <span class="hl-money">约 {{ money(result.savedCents) }}</span>
        </h2>
        <p class="muted">
          朴素顺板需要 {{ result.baselineBoards }} 张（原清单顺序、不旋转、货架式摆法）；
          本方案综合利用率 {{ fmtUtil(overallUtil) }}，
          单板区间 {{ fmtUtil(utilMinMax.min) }} ~ {{ fmtUtil(utilMinMax.max) }}，
          车间走刀 {{ sawCount }} 次（同规格修边叠切计 1 次），共 {{ totalPieces }} 件。
        </p>
        <p class="small muted">
          口径：面积按 mm² 累计再换算 m²（保留 2 位小数）；利用率保留 1 位小数；
          利用率分子为零件净面积（不含锯路）；余料尺寸整 mm，两边 ≥300mm 记可用。
        </p>
      </div>
    </section>

    <div v-if="result.stockShortage.length > 0" class="alert">
      ⚠️ 需补采：
      <span v-for="s in result.stockShortage" :key="s.boardId">
        {{ s.boardName }} {{ s.need - s.have }} 张；
      </span>
    </div>

    <div class="stat-grid">
      <section class="panel">
        <h3>板材领料</h3>
        <table class="grid">
          <thead>
            <tr><th>板材</th><th>张数</th><th>单价</th><th>小计</th></tr>
          </thead>
          <tbody>
            <tr v-for="(n, name) in result.boardsByType" :key="name">
              <td>{{ name }}</td>
              <td>{{ n }}</td>
              <td>{{ money(result.sheets.find((x) => x.boardName === name)?.priceCents ?? 0) }}</td>
              <td>{{ money((result.sheets.find((x) => x.boardName === name)?.priceCents ?? 0) * Number(n)) }}</td>
            </tr>
          </tbody>
          <tfoot>
            <tr><td colspan="3"><b>板材成本合计</b></td><td><b>{{ money(result.totalCostCents) }}</b></td></tr>
          </tfoot>
        </table>
        <p class="small muted" style="margin-top: 8px">排样计算耗时 {{ result.elapsedMs }}ms。</p>
      </section>

      <section class="panel" style="grid-column: 1 / -1">
        <h3>按板汇总用料与余料（{{ rows.length }} 张 / {{ totalPieces }} 件）</h3>
        <table class="grid">
          <thead>
            <tr>
              <th>板</th><th>板材</th><th>规格(mm)</th><th>件数</th>
              <th>用料(m²)</th><th>浪费(m²)</th><th>可用余料(m²)</th>
              <th>利用率</th><th>走刀(次)</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in rows" :key="r.index">
              <td>第 {{ r.index + 1 }} 张</td>
              <td>{{ r.boardName }}</td>
              <td>{{ r.spec }}×{{ r.thicknessMm }}</td>
              <td>{{ r.pieces }}</td>
              <td>{{ fmtM2(r.usedAreaMm2) }}</td>
              <td>{{ fmtM2(r.wasteMm2) }}</td>
              <td>{{ fmtM2(r.offcutAreaMm2) }}</td>
              <td>{{ fmtUtil(r.utilization) }}</td>
              <td>{{ r.sawOps }}</td>
            </tr>
          </tbody>
          <tfoot>
            <tr>
              <td colspan="4"><b>合计 {{ rows.length }} 张 / {{ totalPieces }} 件</b></td>
              <td><b>{{ fmtM2(rows.reduce((a, r) => a + r.usedAreaMm2, 0)) }}</b></td>
              <td><b>{{ fmtM2(rows.reduce((a, r) => a + r.wasteMm2, 0)) }}</b></td>
              <td><b>{{ fmtM2(usableOffcuts.area) }}</b></td>
              <td><b>{{ fmtUtil(overallUtil) }}</b></td>
              <td><b>{{ sawCount }}</b></td>
            </tr>
          </tfoot>
        </table>
        <p class="small muted" style="margin-top: 6px">
          本表与排样结果页、下料单/标签打印、本机存档取同一批数（rev {{ result.rev ?? 0 }}）。
        </p>
      </section>

      <section class="panel">
        <h3>封边（按实际零件边长）</h3>
        <div class="edge-bars">
          <div class="edge-box">
            <b>{{ result.edgeBandM.exposed.toFixed(2) }} m</b>
            <span>见光边</span>
          </div>
          <div class="edge-box">
            <b>{{ result.edgeBandM.normal.toFixed(2) }} m</b>
            <span>非见光边</span>
          </div>
          <div class="edge-box total">
            <b>{{ totalEdgeM.toFixed(2) }} m</b>
            <span>合计</span>
          </div>
        </div>
        <p class="small muted">按零件开料后的实际净尺寸逐边累加（不含锯路）。</p>
      </section>

      <section class="panel">
        <h3>五金与胶量（按零件数估算）</h3>
        <table class="grid">
          <tbody>
            <tr v-for="(h, i) in hardware" :key="i">
              <td>{{ h.name }}</td>
              <td style="text-align: right; font-variant-numeric: tabular-nums">
                {{ h.value }} {{ h.unit }}
              </td>
            </tr>
          </tbody>
        </table>
        <p class="small muted">共 {{ totalPieces }} 件零件。</p>
      </section>

      <section class="panel">
        <h3>可再利用余料（≥300×300mm）</h3>
        <p>{{ usableOffcuts.list.length }} 块，合计 {{ fmtM2(usableOffcuts.area) }}m²</p>
        <table class="grid">
          <thead>
            <tr><th>所在板</th><th>尺寸(mm)</th><th>面积</th></tr>
          </thead>
          <tbody>
            <tr v-for="(o, i) in usableOffcuts.list.slice(0, 8)" :key="i">
              <td>第 {{ o.sheet }} 张</td>
              <td>{{ o.wMm }}×{{ o.hMm }}</td>
              <td>{{ fmtM2(o.areaMm2) }}m²</td>
            </tr>
          </tbody>
        </table>
        <router-link v-if="usableOffcuts.list.length > 0" :to="`/nest/${job.id}`" class="small">
          去排样页一键登记余料 →
        </router-link>
      </section>
    </div>
  </div>
  <div v-else class="panel empty">
    <p>该项目还没有排样结果。</p>
    <router-link :to="`/parts/${route.params.id}`"><button class="primary">去排样</button></router-link>
  </div>
</template>

<style scoped>
.headline {
  margin-bottom: 14px;
  background: linear-gradient(135deg, #fff7ed, #fff);
}
.hl-text h2 {
  font-size: 19px;
}
.hl {
  color: var(--c-primary);
  font-size: 26px;
}
.hl-money {
  color: var(--c-primary);
  font-size: 15px;
  font-weight: 600;
}
.alert {
  background: #fffbeb;
  border: 1px solid #f0d9b5;
  color: #92600a;
  border-radius: 8px;
  padding: 9px 14px;
  margin-bottom: 12px;
  font-size: 13px;
}
.stat-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: 12px;
}
.stat-grid h3 {
  font-size: 14px;
  margin-bottom: 10px;
}
.edge-bars {
  display: flex;
  gap: 8px;
}
.edge-box {
  flex: 1;
  background: #f4f7f3;
  border-radius: 8px;
  padding: 12px;
  text-align: center;
}
.edge-box b {
  display: block;
  font-size: 19px;
}
.edge-box span {
  font-size: 12px;
  color: var(--c-ink-2);
}
.edge-box.total {
  background: #1f2a26;
  color: #fff;
}
.edge-box.total span {
  color: #9fb0a7;
}
.empty {
  text-align: center;
  padding: 50px;
}
</style>
