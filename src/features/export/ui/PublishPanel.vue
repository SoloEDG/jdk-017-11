<script setup lang="ts">
import { Share2, ArrowDownToLine, Gauge, RotateCcw } from "lucide-vue-next";
import type { StudioDocument } from "../../../shared/types";
import { usePublish } from "../model/usePublish";
import {
  publishFormats,
  rendererChoices,
  projectionSummary,
  formatBytes,
} from "../lib/publish";
const props = defineProps<{ doc: StudioDocument }>();
const {
  settings,
  busy,
  progress,
  message,
  result,
  estimateLabel,
  widthHint,
  largeWarning,
  sizes,
  publish,
  cancel,
  resetSettings,
} = usePublish(props.doc);
</script>
<template>
  <section class="panel publish-panel" id="publish-panel">
    <div class="section-label">
      <span>06 / 离线互动作品</span><Share2 :size="16" />
    </div>
    <h2>把可探索的星球发给别人</h2>
    <p class="muted">
      导出一个独立 HTML 单页：照片、初始取景和查看控件都打包在内，接收者断网也能拖动、缩放与切换投影。
    </p>

    <label class="field-label publish-gap" for="publish-title">作品标题</label>
    <input
      id="publish-title"
      class="text-field"
      type="text"
      maxlength="60"
      placeholder="我的星球"
      v-model="settings.title"
      :disabled="busy"
    />

    <label class="field-label" for="publish-size">照片清晰度</label>
    <select
      id="publish-size"
      aria-label="照片清晰度"
      v-model.number="settings.width"
      :disabled="busy"
    >
      <option v-for="s in sizes" :key="s.value" :value="s.value">
        {{ s.label }} · {{ s.hint }}
      </option>
    </select>

    <div class="format-row">
      <span>照片格式</span>
      <div class="segmented small">
        <button
          v-for="f in publishFormats"
          :key="f.value"
          type="button"
          :disabled="busy"
          :class="{ active: settings.format === f.value }"
          :title="f.hint"
          @click="settings.format = f.value"
        >
          {{ f.label }}
        </button>
      </div>
    </div>

    <label v-if="settings.format !== 'png'" class="control">
      照片质量 <output>{{ Math.round(settings.quality * 100) }}%</output>
      <input
        aria-label="照片质量"
        type="range"
        min="0.45"
        max="0.95"
        step="0.01"
        v-model.number="settings.quality"
        :disabled="busy"
      />
    </label>

    <label class="field-label" for="publish-renderer">默认查看引擎</label>
    <select
      id="publish-renderer"
      aria-label="默认查看引擎"
      v-model="settings.renderer"
      :disabled="busy"
    >
      <option v-for="r in rendererChoices" :key="r.value" :value="r.value">
        {{ r.label }} · {{ r.hint }}
      </option>
    </select>

    <div class="size-estimate" role="status" aria-live="polite">
      <div>
        <Gauge :size="14" /><span>预计文件体积</span>
        <strong>{{ estimateLabel }}</strong>
      </div>
      <p>
        {{ widthHint }}。体积包含内嵌照片与离线查看器；导出后会显示实际大小，可随时调低清晰度重试。
      </p>
      <p v-if="largeWarning" class="size-warning">{{ largeWarning }}</p>
    </div>

    <button
      class="primary export-button"
      :disabled="!doc.asset || busy"
      @click="publish"
    >
      <ArrowDownToLine :size="16" />{{
        busy ? `正在打包 ${Math.round(progress * 100)}%` : "导出离线互动作品"
      }}<span v-if="!busy">↗</span>
    </button>
    <button v-if="busy" class="text-button" @click="cancel">取消导出</button>
    <p v-if="message" role="status" class="mini">{{ message }}</p>
    <p v-if="result" class="export-foot">
      {{ result.filename }} · 照片 {{ formatBytes(result.imageBytes) }} / 共
      {{ formatBytes(result.bytes) }}
    </p>
    <p class="mini publish-summary">
      将写入的初始构图：{{ projectionSummary(doc.projection, doc.edge) }}
    </p>
    <button class="text-button" :disabled="busy" @click="resetSettings">
      <RotateCcw :size="13" /> 恢复发布设置默认值
    </button>
  </section>
</template>
