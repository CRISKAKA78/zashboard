<template>
  <div class="bg-base-200/55 rounded-box p-2 text-xs">
    <div class="flex min-w-0 flex-wrap items-center gap-1.5">
      <span
        v-if="match.ruleIndex !== null"
        class="text-base-content/45 tabular-nums"
      >
        #{{ match.ruleIndex }}
      </span>
      <span class="badge badge-ghost badge-sm">
        {{ match.source === 'provider' ? match.providerName : $t('directRuleSource') }}
      </span>
      <span
        v-if="match.entry"
        class="badge badge-outline badge-sm"
      >
        {{ match.entry.type }}
      </span>
      <span
        v-if="match.matchMode === 'provider-name'"
        class="badge badge-info badge-sm"
      >
        {{ $t('providerNameMatch') }}
      </span>
    </div>

    <div
      v-if="match.entry"
      class="mt-1 break-all"
    >
      {{ match.entry.value }}
      <span
        v-if="match.entry.line"
        class="text-base-content/40 ml-1"
      >
        L{{ match.entry.line }}
      </span>
    </div>

    <div
      v-if="match.target"
      class="text-base-content/55 mt-1 flex min-w-0 flex-wrap items-center gap-1"
    >
      <span v-if="match.source === 'provider'">RULE-SET,{{ match.providerName }}</span>
      <span v-else>{{ $t('ruleTarget') }}</span>
      <ArrowRightIcon class="h-3 w-3 shrink-0" />
      <span class="text-base-content font-medium break-all">{{ match.target }}</span>
    </div>
    <p
      v-else-if="match.source === 'provider'"
      class="text-base-content/45 mt-1"
    >
      {{ $t('providerNotReferenced') }}
    </p>
  </div>
</template>

<script setup lang="ts">
import type { RuleIntelligenceMatch } from '@/features/rule-intelligence/types'
import { ArrowRightIcon } from '@heroicons/vue/24/outline'

defineProps<{
  match: RuleIntelligenceMatch
}>()
</script>
