<template>
  <section class="base-container p-3">
    <div class="flex flex-wrap items-start justify-between gap-2">
      <div class="min-w-0">
        <div class="flex items-center gap-2">
          <ShieldCheckIcon class="text-base-content/60 h-4 w-4 shrink-0" />
          <h2 class="text-sm font-medium">{{ $t('rulePenetration') }}</h2>
          <span class="badge badge-ghost badge-sm">Text / YAML / MRS</span>
        </div>
        <p class="text-base-content/55 mt-1 text-xs">
          {{ $t('rulePenetrationDescription') }}
        </p>
      </div>
      <span
        v-if="debouncedQuery"
        class="badge badge-outline badge-sm"
      >
        {{ queryKindLabel }}
      </span>
    </div>

    <TextInput
      v-model="queryInput"
      class="mt-3 w-full"
      :placeholder="$t('queryRulePlaceholder')"
      :clearable="true"
      autocomplete="off"
    />

    <p
      v-if="penetration.status === 'keyword'"
      class="text-warning mt-2 text-xs"
    >
      {{ $t('keywordSearchNotice') }}
    </p>

    <div
      v-if="providerState === 'loading'"
      class="text-base-content/60 mt-3 flex items-center gap-2 text-xs"
    >
      <span class="loading loading-spinner loading-xs" />
      {{ $t('providerRulesLoading') }}
    </div>
    <div
      v-else-if="providerState === 'offline' || providerState === 'error'"
      class="alert alert-warning mt-3 py-2 text-xs"
    >
      <ExclamationTriangleIcon class="h-4 w-4 shrink-0" />
      <span class="min-w-0 flex-1">
        {{
          providerState === 'offline'
            ? $t('localHelperPenetrationUnavailable')
            : providerError || $t('providerRulesError')
        }}
      </span>
      <button
        type="button"
        class="btn btn-ghost btn-xs"
        @click="retryProviderLoad"
      >
        {{ $t('retry') }}
      </button>
    </div>
    <div
      v-else-if="providerErrors.length"
      class="alert alert-warning mt-3 items-start py-2 text-xs"
    >
      <ExclamationTriangleIcon class="h-4 w-4 shrink-0" />
      <div class="min-w-0">
        <p>{{ $t('providerRulesPartial', { count: providerErrors.length }) }}</p>
        <ul class="mt-1 space-y-0.5">
          <li
            v-for="error in providerErrors.slice(0, 3)"
            :key="`${error.provider}-${error.code}`"
            class="break-words"
          >
            <span class="font-medium">{{ error.provider }}:</span>
            {{ error.message }}
          </li>
        </ul>
      </div>
    </div>

    <div
      v-if="debouncedQuery"
      class="mt-3 max-h-[32rem] space-y-3 overflow-y-auto pr-1"
    >
      <template v-if="penetration.status === 'keyword'">
        <section>
          <h3 class="text-base-content/65 mb-1.5 text-xs font-medium">
            {{ $t('ruleSearchResults') }} · {{ penetration.search.matches.length }}
          </h3>
          <div
            v-if="penetration.search.matches.length"
            class="space-y-1.5"
          >
            <RuleMatchSummary
              v-for="(match, index) in penetration.search.matches"
              :key="`search-${match.source}-${match.rulePosition}-${match.entry?.line}-${index}`"
              :match="match"
            />
          </div>
          <p
            v-else-if="providerState !== 'loading'"
            class="text-base-content/55 py-3 text-center text-xs"
          >
            {{ $t('noRuleMatches') }}
          </p>
        </section>
      </template>

      <template v-else>
        <div
          v-if="penetration.status === 'indeterminate'"
          class="alert alert-warning items-start py-2 text-xs"
        >
          <ExclamationTriangleIcon class="h-4 w-4 shrink-0" />
          <div class="min-w-0">
            <p class="font-medium">
              {{
                penetration.blocker?.source === 'provider'
                  ? $t('rulePenetrationIndeterminate', {
                      provider: penetration.blocker.providerName,
                      index: penetration.blocker.ruleIndex,
                    })
                  : $t('rulePenetrationContextIndeterminate', {
                      type: penetration.blocker?.ruleType,
                      index: penetration.blocker?.ruleIndex,
                    })
              }}
            </p>
            <p class="text-base-content/60 mt-1 break-words">
              {{ penetration.blocker?.message }}
            </p>
          </div>
        </div>

        <section v-else-if="penetration.status === 'resolved' || penetration.status === 'fallback'">
          <h3 class="text-success mb-1.5 text-xs font-semibold">
            {{ $t('actualRuleMatch') }}
          </h3>
          <div class="border-success/25 bg-success/5 rounded-box border p-3 text-xs">
            <div class="flex min-w-0 flex-col items-start gap-1.5">
              <span class="badge badge-neutral badge-sm max-w-full break-all">
                {{ penetration.search.query.normalized }}
              </span>
              <ArrowDownIcon class="text-base-content/35 ml-2 h-3.5 w-3.5" />

              <template v-if="penetration.effectiveMatch?.source === 'provider'">
                <div class="flex min-w-0 flex-wrap items-center gap-1.5">
                  <span class="text-base-content/50">{{ $t('ruleSource') }}</span>
                  <span class="badge badge-info badge-sm break-all">
                    {{ penetration.effectiveMatch.providerName }}
                  </span>
                </div>
                <ArrowDownIcon class="text-base-content/35 ml-2 h-3.5 w-3.5" />
                <div class="flex min-w-0 flex-wrap items-center gap-1.5">
                  <span class="badge badge-outline badge-sm">
                    {{ penetration.effectiveMatch.entry?.type }}
                  </span>
                  <span class="font-medium break-all">
                    {{ penetration.effectiveMatch.entry?.value }}
                  </span>
                </div>
                <ArrowDownIcon class="text-base-content/35 ml-2 h-3.5 w-3.5" />
                <div class="flex min-w-0 flex-wrap items-center gap-1.5">
                  <span class="text-base-content/45 tabular-nums">
                    #{{ penetration.effectiveRuleIndex }}
                  </span>
                  <span class="badge badge-ghost badge-sm break-all">
                    RULE-SET,{{ penetration.effectiveMatch.providerName }}
                  </span>
                  <ArrowRightIcon class="text-base-content/35 h-3.5 w-3.5" />
                  <span class="font-medium break-all">{{ penetration.target }}</span>
                </div>
              </template>

              <template v-else-if="penetration.effectiveMatch">
                <div class="flex min-w-0 flex-wrap items-center gap-1.5">
                  <span class="text-base-content/45 tabular-nums">
                    #{{ penetration.effectiveRuleIndex }}
                  </span>
                  <span class="badge badge-outline badge-sm">
                    {{ penetration.effectiveMatch.entry?.type }}
                  </span>
                  <span class="font-medium break-all">
                    {{ penetration.effectiveMatch.entry?.value }}
                  </span>
                </div>
                <ArrowDownIcon class="text-base-content/35 ml-2 h-3.5 w-3.5" />
                <span class="font-medium break-all">{{ penetration.target }}</span>
              </template>

              <template v-else-if="penetration.effectiveFallback">
                <span class="text-base-content/60">{{ $t('noSpecificRuleMatched') }}</span>
                <ArrowDownIcon class="text-base-content/35 ml-2 h-3.5 w-3.5" />
                <div class="flex min-w-0 flex-wrap items-center gap-1.5">
                  <span class="text-base-content/45 tabular-nums">
                    #{{ penetration.effectiveRuleIndex }}
                  </span>
                  <span class="badge badge-warning badge-sm">
                    {{ penetration.effectiveFallback.type }}
                  </span>
                  <ArrowRightIcon class="text-base-content/35 h-3.5 w-3.5" />
                  <span class="font-medium break-all">{{ penetration.target }}</span>
                </div>
              </template>
            </div>

            <div
              v-if="penetration.target && penetration.route"
              class="border-base-content/10 mt-3 border-t pt-2"
            >
              <div class="text-base-content/55 mb-1 text-[0.7rem] font-medium uppercase">
                {{ $t('ruleRoute') }}
              </div>
              <ProxyChainPath
                :proxy="penetration.target"
                :show-now-node="true"
                :interactive="false"
              />
              <div class="mt-1.5 flex min-w-0 flex-wrap items-center gap-1.5">
                <span class="text-base-content/50">{{ $t('finalOutbound') }}:</span>
                <span class="badge badge-success badge-sm break-all">
                  {{ penetration.route.finalOutbound }}
                </span>
                <span
                  v-if="penetration.route.status === 'cycle'"
                  class="badge badge-warning badge-sm"
                >
                  {{ $t('proxyChainCycleDetected') }}
                </span>
                <span
                  v-else-if="penetration.route.status === 'missing'"
                  class="badge badge-warning badge-sm"
                >
                  {{ $t('proxyChainTargetMissing') }}
                </span>
              </div>
            </div>
          </div>
        </section>

        <p
          v-else-if="penetration.status === 'no-match' && providerState !== 'loading'"
          class="text-base-content/55 py-3 text-center text-xs"
        >
          {{ $t('noEffectiveRuleMatch') }}
        </p>

        <section v-if="penetration.otherMatches.length">
          <h3 class="text-base-content/65 mb-1.5 text-xs font-medium">
            {{ $t('otherPossibleMatches') }} · {{ penetration.otherMatches.length }}
          </h3>
          <div class="space-y-1.5">
            <RuleMatchSummary
              v-for="(match, index) in penetration.otherMatches"
              :key="`other-${match.source}-${match.rulePosition}-${match.entry?.line}-${index}`"
              :match="match"
            />
          </div>
        </section>
      </template>

      <p
        v-if="penetration.search.truncated"
        class="text-warning text-xs"
      >
        {{ $t('ruleResultsTruncated') }}
      </p>
    </div>
  </section>
</template>

<script setup lang="ts">
import { getProxyChainAnalysis } from '@/assembly/proxies'
import { rules } from '@/assembly/rules'
import ProxyChainPath from '@/components/common/ProxyChainPath.vue'
import TextInput from '@/components/common/TextInput.vue'
import { LocalHelperRequestError } from '@/features/rule-intelligence/helperApi'
import {
  clearLocalProviderRuleCache,
  loadLocalProviderRuleSets,
  type ProviderLoadError,
} from '@/features/rule-intelligence/providerCache'
import { resolveRulePenetration } from '@/features/rule-intelligence/rulePenetration'
import type { ProviderRuleSet, RuleProviderAvailability } from '@/features/rule-intelligence/types'
import {
  ArrowDownIcon,
  ArrowRightIcon,
  ExclamationTriangleIcon,
  ShieldCheckIcon,
} from '@heroicons/vue/24/outline'
import { watchDebounced } from '@vueuse/core'
import { computed, onBeforeUnmount, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import RuleMatchSummary from './RuleMatchSummary.vue'

type ProviderState = 'idle' | 'loading' | 'ready' | 'offline' | 'error'

const { t } = useI18n()
const queryInput = ref('')
const debouncedQuery = ref('')
const providerState = ref<ProviderState>('idle')
const providerRuleSets = ref<ProviderRuleSet[]>([])
const providerErrors = ref<ProviderLoadError[]>([])
const providerError = ref('')
let providerRequest: AbortController | null = null

const providerAvailability = computed<RuleProviderAvailability>(() => {
  if (providerState.value === 'ready') return 'ready'
  if (providerState.value === 'offline') return 'offline'
  if (providerState.value === 'error') return 'error'
  return 'loading'
})
const penetration = computed(() =>
  resolveRulePenetration(debouncedQuery.value, rules.value, providerRuleSets.value, {
    providerAvailability: providerAvailability.value,
    providerIssues: providerErrors.value,
    resolveProxyChain: getProxyChainAnalysis,
  }),
)
const queryKindLabel = computed(() =>
  t(
    {
      domain: 'queryKindDomain',
      ip: 'queryKindIp',
      keyword: 'queryKindKeyword',
    }[penetration.value.search.query.kind],
  ),
)

const loadProviders = async (force = false) => {
  if (providerState.value === 'loading' || (!force && providerState.value === 'ready')) return

  providerRequest?.abort()
  providerRequest = new AbortController()
  providerState.value = 'loading'
  providerError.value = ''
  if (force) clearLocalProviderRuleCache()

  try {
    const loaded = await loadLocalProviderRuleSets(providerRequest.signal)
    providerRuleSets.value = loaded.providers
    providerErrors.value = loaded.errors
    providerState.value = 'ready'
  } catch (error) {
    providerRuleSets.value = []
    providerErrors.value = []
    if (
      error instanceof LocalHelperRequestError &&
      (['HELPER_OFFLINE', 'HELPER_TIMEOUT', 'HELPER_INVALID_RESPONSE'].includes(error.code) ||
        error.status === 404)
    ) {
      providerState.value = 'offline'
    } else {
      providerState.value = 'error'
      providerError.value = error instanceof Error ? error.message : t('providerRulesError')
    }
  }
}

const retryProviderLoad = () => loadProviders(true)

watchDebounced(
  queryInput,
  (value) => {
    debouncedQuery.value = value.trim()
    if (debouncedQuery.value && providerState.value === 'idle') void loadProviders()
  },
  { debounce: 350 },
)

onBeforeUnmount(() => providerRequest?.abort())
</script>
