<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { getJob } from '../lib/store'
import boardsData from '../data/boards.json'
import { pct, money } from '../lib/format'

const route = useRoute()
const job = computed(() => getJob(route.params.id as string))
const result = computed(() => job.value?.result)

const totalPieces = computed(
  () => result.value?.sheets.reduce((a, s) => a + s.placements.length, 0) ?? 0
)
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

const usableOffcuts = computed(() => {
  const all = result.value?.sheets.flatMap((s, si) =>
    s.offcuts.filter((o) => o.usable).map((o) => ({ ...o, sheet: si + 1 }))
  ) ?? []
  return { list: all, area: all.reduce((a, o) => a + o.areaMm2, 0) }
})

const overallUtil = computed(() => {
  if (!result.value || result.value.sheets.length === 0) return 0
  const used = result.value.sheets.reduce((a, s) => a + s.usedAreaMm2, 0)
  const total = result.value.sheets.reduce((a, s) => a + s.boardAreaMm2, 0)
  return total > 0 ? used / total : 0
})
const utilMinMax = computed(() => {
  const us = result.value?.sheets.map((s) => s.utilization) ?? []
  if (us.length === 0) return { min: 0, max: 0 }
  return { min: Math.min(...us), max: Math.max(...us) }
})

// 按板汇总用料与余料（与排样结果页/打印逐板同源）
const perSheetRows = computed(() => {
  return (result.value?.sheets ?? []).map((s) => {
    const usedM2 = s.usedAreaMm2 / 1e6
    const boardM2 = s.boardAreaMm2 / 1e6
    const usableOff = s.offcuts.filter((o) => o.usable)
    // 板上除零件净面积、≥300×300 可登记余料之外的部分（锯路/修边/碎料）
    const restMm2 = s.boardAreaMm2 - s.usedAreaMm2 - usableOff.reduce((a, o) => a + o.areaMm2, 0)
    return {
      index: s.index + 1,
      name: s.boardName,
      w: s.wMm,
      h: s.hMm,
      usedM2,
      boardM2,
      utilization: s.utilization,
      usableM2: usableOff.reduce((a, o) => a + o.areaMm2, 0) / 1e6,
      usableCount: usableOff.length,
      scrapM2: Math.max(0, restMm2) / 1e6
    }
  })
})
const totalUsableM2 = computed(() => perSheetRows.value.reduce((a, r) => a + r.usableM2, 0))
const totalScrapM2 = computed(() => perSheetRows.value.reduce((a, r) => a + r.scrapM2, 0))
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
          本方案综合利用率 {{ pct(overallUtil) }}，
          单板区间 {{ pct(utilMinMax.min) }} ~ {{ pct(utilMinMax.max) }}。
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
      <section class="panel" style="grid-column: 1 / -1">
        <h3>按板汇总用料与余料（与排样结果页、打印单据同源）</h3>
        <table class="grid">
          <thead>
            <tr>
              <th>板号</th><th>板材/规格(mm)</th><th>板面积</th><th>零件净用料</th>
              <th>利用率</th><th>可再用余料</th><th>锯路/修边/碎料</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in perSheetRows" :key="r.index">
              <td>第 {{ r.index }} 张</td>
              <td>{{ r.name }}<br /><span class="small muted">{{ r.w }}×{{ r.h }}</span></td>
              <td>{{ r.boardM2.toFixed(2) }}m²</td>
              <td>{{ r.usedM2.toFixed(2) }}m²</td>
              <td>{{ pct(r.utilization) }}</td>
              <td>{{ r.usableCount }} 块 / {{ r.usableM2.toFixed(2) }}m²</td>
              <td>{{ r.scrapM2.toFixed(2) }}m²</td>
            </tr>
          </tbody>
          <tfoot>
            <tr>
              <td colspan="3"><b>合计 {{ perSheetRows.length }} 张</b></td>
              <td><b>{{ perSheetRows.reduce((a, r) => a + r.usedM2, 0).toFixed(2) }}m²</b></td>
              <td>{{ pct(overallUtil) }}</td>
              <td><b>{{ totalUsableM2.toFixed(2) }}m²</b></td>
              <td>{{ totalScrapM2.toFixed(2) }}m²</td>
            </tr>
          </tfoot>
        </table>
        <p class="small muted" style="margin-top: 6px">
          面积按平方毫米累加后换算平方米，保留 2 位小数；利用率保留 1 位小数（分子=零件净面积，不含锯路）；
          尺寸/刀位按毫米整数展示（刀路坐标保留 1 位小数）；金额保留 2 位小数。
        </p>
      </section>

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
        <p>{{ usableOffcuts.list.length }} 块，合计 {{ (usableOffcuts.area / 1e6).toFixed(2) }}m²</p>
        <table class="grid">
          <thead>
            <tr><th>所在板</th><th>尺寸(mm)</th><th>面积</th></tr>
          </thead>
          <tbody>
            <tr v-for="(o, i) in usableOffcuts.list.slice(0, 8)" :key="i">
              <td>第 {{ o.sheet }} 张</td>
              <td>{{ o.wMm }}×{{ o.hMm }}</td>
              <td>{{ (o.areaMm2 / 1e6).toFixed(2) }}m²</td>
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
