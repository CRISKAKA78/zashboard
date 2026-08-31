<template>
  <div>
    <button
      class="btn btn-sm"
      :aria-label="$t('editFakeIPFilter')"
      :disabled="isLoading || isSaving"
      @click="openDialog"
    >
      <PencilSquareIcon class="h-4 w-4" />
      <span
        v-if="filterCount !== null"
        class="badge badge-ghost badge-sm"
      >
        {{ filterCount }}
      </span>
    </button>

    <DialogWrapper
      v-model="dialogVisible"
      :title="$t('fakeIPFilter')"
    >
      <div class="flex flex-col gap-3 p-2 text-sm">
        <p class="text-base-content/65">{{ $t('fakeIPFilterDescription') }}</p>
        <div
          v-if="isLoading"
          class="text-base-content/60 flex items-center gap-2 text-xs"
        >
          <span class="loading loading-spinner loading-xs" />
          {{ $t('loading') }}
        </div>
        <textarea
          v-model="filterText"
          class="textarea textarea-bordered min-h-48 w-full font-mono text-xs"
          :placeholder="$t('fakeIPFilterPlaceholder')"
          :disabled="isLoading"
          spellcheck="false"
        ></textarea>
        <p
          v-if="errorMessage"
          class="text-error text-xs break-words"
        >
          {{ errorMessage }}
        </p>
        <button
          class="btn btn-primary btn-sm"
          :disabled="isLoading || isSaving || !state"
          @click="save"
        >
          <span
            v-if="isSaving"
            class="loading loading-spinner h-4 w-4"
          ></span>
          {{ $t('save') }}
        </button>
      </div>
    </DialogWrapper>
  </div>
</template>

<script setup lang="ts">
import { can } from '@/assembly/backend'
import { updateConfigsAPI } from '@/assembly/config'
import { fetchProxies } from '@/assembly/proxies'
import { fetchRules } from '@/assembly/rules'
import DialogWrapper from '@/components/common/DialogWrapper.vue'
import {
  applyCustomRulesUpdate,
  cloneCustomRulesDraft,
  type CustomRulesState,
} from '@/features/rule-intelligence/customRules'
import {
  fetchLocalCustomRules,
  rollbackLocalCustomRules,
  saveLocalCustomRules,
} from '@/features/rule-intelligence/helperApi'
import { clearLocalProviderRuleCache } from '@/features/rule-intelligence/providerCache'
import { notifyRequestError } from '@/helper/requestError'
import { PencilSquareIcon } from '@heroicons/vue/24/outline'
import { onMounted, ref } from 'vue'

const dialogVisible = ref(false)
const filterText = ref('')
const filterCount = ref<number | null>(null)
const state = ref<CustomRulesState | null>(null)
const isLoading = ref(false)
const isSaving = ref(false)
const errorMessage = ref('')

const displayError = (error: unknown) => (error instanceof Error ? error.message : String(error))

const load = async (updateEditor: boolean) => {
  if (isLoading.value) return
  isLoading.value = true
  errorMessage.value = ''
  try {
    const loaded = await fetchLocalCustomRules()
    state.value = loaded
    filterCount.value = loaded.fakeIpFilter.length
    if (updateEditor) filterText.value = loaded.fakeIpFilter.join('\n')
  } catch (error) {
    state.value = null
    filterCount.value = null
    errorMessage.value = displayError(error)
    if (updateEditor) notifyRequestError(error)
  } finally {
    isLoading.value = false
  }
}

const openDialog = () => {
  dialogVisible.value = true
  void load(true)
}

const refreshRuleIntelligence = async () => {
  clearLocalProviderRuleCache()
  await Promise.allSettled([fetchRules(), fetchProxies()])
}

const save = async () => {
  const current = state.value
  if (isSaving.value || !current || !can('configPatch')) return
  const filters = [
    ...new Set(
      filterText.value
        .split(/\r?\n/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ]

  isSaving.value = true
  errorMessage.value = ''
  try {
    const draft = cloneCustomRulesDraft(current)
    draft.fakeIpFilter = filters
    const saved = await applyCustomRulesUpdate(
      () =>
        saveLocalCustomRules({
          expectedVersion: current.version,
          ...draft,
        }),
      {
        reload: (runtimeConfigPath) =>
          updateConfigsAPI({ path: runtimeConfigPath, payload: '' }, true),
        rollback: rollbackLocalCustomRules,
        refresh: refreshRuleIntelligence,
      },
    )
    state.value = saved
    filterCount.value = saved.fakeIpFilter.length
    dialogVisible.value = false
  } catch (error) {
    errorMessage.value = displayError(error)
    notifyRequestError(error)
  } finally {
    isSaving.value = false
  }
}

onMounted(() => void load(false))
</script>
