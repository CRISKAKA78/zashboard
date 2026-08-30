<template>
  <div class="base-container p-3">
    <div class="flex flex-wrap items-center gap-2">
      <ShieldCheckIcon class="text-base-content/60 h-4 w-4 shrink-0" />
      <h2 class="text-sm font-medium">{{ $t('currentFallbackRule') }}</h2>
      <span
        v-if="fallback"
        class="badge badge-ghost badge-sm"
      >
        {{ fallback.type }}
      </span>
    </div>

    <div
      v-if="fallback"
      class="mt-2 flex min-w-0 flex-col gap-2"
    >
      <div class="flex min-w-0 flex-wrap items-center gap-2">
        <span class="text-base-content/45 text-xs tabular-nums">#{{ fallback.position }}</span>
        <span class="text-xs font-medium">{{ fallback.type }}</span>
        <ArrowRightIcon class="text-base-content/35 h-3.5 w-3.5 shrink-0" />
        <ProxyChainPath
          class="min-w-0"
          :proxy="fallback.rule.proxy"
          :show-now-node="true"
          :interactive="false"
        />
      </div>
      <div class="text-base-content/55 flex flex-wrap items-center gap-2 text-xs">
        <template v-if="proxyChain.status === 'cycle'">
          <span class="badge badge-warning badge-sm">
            {{ $t('proxyChainCycleDetected') }}
          </span>
        </template>
        <template v-else>
          <span>{{ $t('outbound') }}:</span>
          <span class="text-base-content font-medium break-all">
            {{ proxyChain.finalOutbound || fallback.rule.proxy }}
          </span>
        </template>
      </div>
    </div>
    <p
      v-else
      class="text-base-content/55 mt-2 text-xs"
    >
      {{ $t('noEffectiveFallbackRule') }}
    </p>
  </div>
</template>

<script setup lang="ts">
import { getProxyChainAnalysis } from '@/assembly/proxies'
import { rules } from '@/assembly/rules'
import ProxyChainPath from '@/components/common/ProxyChainPath.vue'
import { findRuleFallback } from '@/features/rule-intelligence/ruleFallback'
import { ArrowRightIcon, ShieldCheckIcon } from '@heroicons/vue/24/outline'
import { computed } from 'vue'

const fallback = computed(() => findRuleFallback(rules.value))
const proxyChain = computed(() => getProxyChainAnalysis(fallback.value?.rule.proxy || ''))
</script>
