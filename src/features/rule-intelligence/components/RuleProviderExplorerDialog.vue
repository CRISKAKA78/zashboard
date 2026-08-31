<template>
  <DialogWrapper
    v-model="isOpen"
    :title="dialogTitle"
    no-padding
    box-class="h-[min(90dvh,56rem)]! w-[min(96vw,90rem)]! max-w-[96vw]! max-md:h-dvh! max-md:w-screen! max-md:max-h-dvh! max-md:min-h-dvh! max-md:max-w-none! max-md:rounded-none!"
    content-class="flex flex-1 flex-col overflow-hidden!"
  >
    <template #title-right>
      <button
        type="button"
        class="btn btn-circle btn-ghost btn-xs absolute top-2 right-10"
        :class="loading ? 'animate-spin' : ''"
        :aria-label="$t('refreshProviderRules')"
        :title="$t('refreshProviderRules')"
        :disabled="loading || mutating"
        @click="loadPage"
      >
        <ArrowPathIcon class="h-4 w-4" />
      </button>
    </template>

    <div class="border-base-content/10 shrink-0 space-y-3 border-b p-3 sm:p-4">
      <div class="flex flex-wrap items-start justify-between gap-2">
        <div
          class="text-base-content/55 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs"
        >
          <span
            >{{ $t('behavior') }}: {{ providerInfo?.behavior || provider?.behavior || '-' }}</span
          >
          <span>{{ $t('format') }}: {{ providerInfo?.format || provider?.format || '-' }}</span>
          <span v-if="providerInfo?.size !== null && providerInfo?.size !== undefined">
            {{ formatBytes(providerInfo.size) }}
          </span>
          <span v-if="providerInfo?.mtime">
            {{ $t('updated') }}: {{ formatMtime(providerInfo.mtime) }}
          </span>
          <span v-if="pageResult">{{ $t('cache') }}: {{ pageResult.cache }}</span>
          <span
            v-if="providerInfo"
            class="badge badge-sm"
            :class="editable ? 'badge-success' : 'badge-ghost'"
          >
            {{ editable ? $t('localProviderEditable') : $t('providerReadOnly') }}
          </span>
        </div>
        <button
          v-if="editable"
          type="button"
          class="btn btn-primary btn-xs"
          :disabled="mutating"
          @click="beginAdd"
        >
          <PlusIcon class="h-3.5 w-3.5" />
          {{ $t('addRule') }}
        </button>
      </div>

      <div class="overflow-x-auto pb-0.5">
        <SegmentedControl
          :model-value="family"
          :options="familyOptions"
          @update:model-value="setFamily"
        />
      </div>

      <label class="input input-bordered flex w-full items-center gap-2">
        <MagnifyingGlassIcon class="h-4 w-4 shrink-0 opacity-45" />
        <input
          v-model="searchText"
          type="search"
          class="grow"
          :placeholder="$t('searchProviderRulesPlaceholder')"
          maxlength="512"
        />
      </label>
      <p class="text-base-content/45 text-xs">{{ $t('providerRuleContentSearchNotice') }}</p>

      <div
        v-if="editor"
        class="border-primary/25 bg-primary/5 rounded-box space-y-2 border p-3"
      >
        <div class="flex flex-wrap items-center justify-between gap-2">
          <p class="text-xs font-semibold">
            {{
              editor.operation === 'add' ? $t('addLocalProviderRule') : $t('editLocalProviderRule')
            }}
          </p>
          <button
            type="button"
            class="btn btn-circle btn-ghost btn-xs"
            :aria-label="$t('cancel')"
            :title="$t('cancel')"
            :disabled="mutating"
            @click="cancelEdit"
          >
            <XMarkIcon class="h-4 w-4" />
          </button>
        </div>
        <input
          v-model="editor.raw"
          type="text"
          class="input input-bordered input-sm w-full font-mono"
          :placeholder="$t('localProviderRulePlaceholder')"
          maxlength="4096"
          :disabled="mutating"
          @keyup.enter="saveEditor"
        />
        <div class="flex justify-end gap-2">
          <button
            type="button"
            class="btn btn-ghost btn-xs"
            :disabled="mutating"
            @click="cancelEdit"
          >
            {{ $t('cancel') }}
          </button>
          <button
            type="button"
            class="btn btn-primary btn-xs"
            :disabled="mutating || !editor.raw.trim()"
            @click="saveEditor"
          >
            <span
              v-if="mutating"
              class="loading loading-spinner loading-xs"
            />
            {{ $t('save') }}
          </button>
        </div>
      </div>

      <div
        v-if="operationError"
        class="alert alert-error py-2 text-xs"
      >
        <ExclamationTriangleIcon class="h-4 w-4 shrink-0" />
        <span class="min-w-0 break-words">{{ operationError }}</span>
      </div>
    </div>

    <div class="relative min-h-0 flex-1 overflow-auto">
      <div
        v-if="loading && !pageResult"
        class="flex h-full min-h-52 items-center justify-center"
      >
        <span class="loading loading-spinner loading-md" />
      </div>

      <div
        v-else-if="errorMessage"
        class="flex h-full min-h-52 flex-col items-center justify-center gap-3 px-6 text-center"
      >
        <ExclamationTriangleIcon class="text-warning h-10 w-10" />
        <p class="max-w-2xl text-sm">{{ errorMessage }}</p>
        <button
          type="button"
          class="btn btn-sm"
          @click="loadPage"
        >
          {{ $t('retry') }}
        </button>
      </div>

      <div
        v-else-if="pageResult && pageResult.items.length === 0"
        class="text-base-content/50 flex h-full min-h-52 items-center justify-center px-6 text-center"
      >
        {{ $t('noProviderRulesFound') }}
      </div>

      <table
        v-else-if="pageResult"
        class="table-sm table w-full min-w-[62rem]"
        :class="loading ? 'opacity-60' : ''"
      >
        <thead class="bg-base-100 sticky top-0 z-10">
          <tr class="border-base-content/10 border-b">
            <th class="text-base-content/45 w-14">#</th>
            <th
              v-for="column in sortableColumns"
              :key="column.key"
              :aria-sort="ariaSort(column.key)"
              :class="column.class"
            >
              <button
                type="button"
                class="flex w-full items-center gap-1 text-left whitespace-nowrap"
                @click="changeSort(column.key)"
              >
                {{ $t(column.label) }}
                <ArrowUpCircleIcon
                  v-if="sortKey === column.key && sortDirection === 'asc'"
                  class="h-4 w-4"
                />
                <ArrowDownCircleIcon
                  v-else-if="sortKey === column.key && sortDirection === 'desc'"
                  class="h-4 w-4"
                />
                <ArrowsUpDownIcon
                  v-else
                  class="h-3.5 w-3.5 opacity-30"
                />
              </button>
            </th>
            <th
              v-if="editable"
              class="w-24 text-right"
            >
              {{ $t('actions') }}
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="item in pageResult.items"
            :key="`${item.index}-${item.raw}`"
            class="hover:bg-base-200/55 border-base-content/5 border-b"
          >
            <td class="text-base-content/40 tabular-nums">{{ item.index }}</td>
            <td class="w-44 whitespace-nowrap">
              <span class="badge badge-ghost badge-sm">{{ item.type }}</span>
            </td>
            <td class="max-w-xl min-w-80">
              <span
                class="block truncate"
                :title="item.value"
              >
                {{ item.value }}
              </span>
            </td>
            <td class="text-base-content/65 max-w-sm min-w-48">
              <span
                class="block truncate"
                :title="item.params.join(', ')"
              >
                {{ item.params.join(', ') || '-' }}
              </span>
            </td>
            <td class="max-w-2xl min-w-96">
              <div class="flex items-center gap-2">
                <code
                  class="block min-w-0 flex-1 truncate text-xs"
                  :title="item.raw"
                  >{{ item.raw }}</code
                >
                <button
                  type="button"
                  class="btn btn-circle btn-ghost btn-xs shrink-0"
                  :aria-label="$t('copyRawRule')"
                  :title="$t('copyRawRule')"
                  @click="copyRaw(item.raw)"
                >
                  <ClipboardDocumentIcon class="h-3.5 w-3.5" />
                </button>
              </div>
            </td>
            <td
              v-if="editable"
              class="w-24 text-right whitespace-nowrap"
            >
              <button
                type="button"
                class="btn btn-circle btn-ghost btn-xs"
                :aria-label="$t('editLocalProviderRule')"
                :title="$t('editLocalProviderRule')"
                :disabled="mutating"
                @click="beginEdit(item)"
              >
                <PencilSquareIcon class="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                class="btn btn-circle btn-ghost btn-xs text-error"
                :aria-label="$t('delete')"
                :title="$t('delete')"
                :disabled="mutating"
                @click="removeRule(item)"
              >
                <TrashIcon class="h-3.5 w-3.5" />
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div
      v-if="pageResult"
      class="border-base-content/10 flex shrink-0 items-center justify-between gap-3 border-t px-3 py-2 sm:px-4"
    >
      <p class="text-base-content/55 min-w-0 truncate text-xs tabular-nums">
        {{
          $t('providerRulePageSummary', {
            start: rangeStart,
            end: rangeEnd,
            matched: pageResult.matched,
            total: pageResult.total,
          })
        }}
      </p>
      <div class="flex shrink-0 items-center gap-1">
        <button
          type="button"
          class="btn btn-circle btn-ghost btn-sm"
          :aria-label="$t('previousPage')"
          :disabled="loading || pageResult.page <= 1"
          @click="goToPage(pageResult.page - 1)"
        >
          <ChevronLeftIcon class="h-4 w-4" />
        </button>
        <span class="min-w-20 text-center text-xs tabular-nums">
          {{ pageResult.page }} / {{ pageCount }}
        </span>
        <button
          type="button"
          class="btn btn-circle btn-ghost btn-sm"
          :aria-label="$t('nextPage')"
          :disabled="loading || !pageResult.hasMore"
          @click="goToPage(pageResult.page + 1)"
        >
          <ChevronRightIcon class="h-4 w-4" />
        </button>
      </div>
    </div>
  </DialogWrapper>
</template>

<script setup lang="ts">
import DialogWrapper from '@/components/common/DialogWrapper.vue'
import SegmentedControl from '@/components/common/SegmentedControl.vue'
import {
  fetchLocalRuleProviderRulePage,
  LocalHelperRequestError,
  mutateLocalRuleProvider,
  rollbackLocalRuleProvider,
  type LocalProviderRulePageResponse,
  type LocalProviderRuleItem,
  type RuleProviderFamily,
  type RuleProviderSortDirection,
  type RuleProviderSortKey,
} from '@/features/rule-intelligence/helperApi'
import {
  applyLocalProviderUpdate,
  LocalProviderApplyError,
} from '@/features/rule-intelligence/localProviderRules'
import { clearLocalProviderRuleCache } from '@/features/rule-intelligence/providerCache'
import {
  nextRuleProviderSort,
  RULE_PROVIDER_EXPLORER_PAGE_SIZE,
} from '@/features/rule-intelligence/ruleProviderExplorer'
import { showNotification } from '@/helper/notification'
import { fetchRules, updateRuleProviderAPI } from '@/assembly/rules'
import type { RuleProvider } from '@/types'
import {
  ArrowDownCircleIcon,
  ArrowPathIcon,
  ArrowsUpDownIcon,
  ArrowUpCircleIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ClipboardDocumentIcon,
  ExclamationTriangleIcon,
  MagnifyingGlassIcon,
  PencilSquareIcon,
  PlusIcon,
  TrashIcon,
  XMarkIcon,
} from '@heroicons/vue/24/outline'
import { watchDebounced } from '@vueuse/core'
import dayjs from 'dayjs'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

const isOpen = defineModel<boolean>({ default: false })
const props = defineProps<{ provider: RuleProvider | null }>()
const { t } = useI18n()

const family = ref<RuleProviderFamily>('all')
const searchText = ref('')
const debouncedSearch = ref('')
const sortKey = ref<RuleProviderSortKey | null>(null)
const sortDirection = ref<RuleProviderSortDirection>('default')
const requestedPage = ref(1)
const pageResult = ref<LocalProviderRulePageResponse | null>(null)
const loading = ref(false)
const mutating = ref(false)
const error = ref<LocalHelperRequestError | null>(null)
const operationError = ref('')
const editor = ref<{
  operation: 'add' | 'update'
  index?: number
  raw: string
} | null>(null)

let activeRequest: AbortController | null = null
let requestSequence = 0

const sortableColumns: Array<{
  key: RuleProviderSortKey
  label: string
  class: string
}> = [
  { key: 'type', label: 'type', class: 'w-44' },
  { key: 'content', label: 'content', class: 'min-w-80' },
  { key: 'params', label: 'additionalParams', class: 'min-w-48' },
  { key: 'raw', label: 'rawRule', class: 'min-w-96' },
]

const providerInfo = computed(() => pageResult.value?.provider)
const editable = computed(
  () => providerInfo.value?.editable === true && typeof pageResult.value?.version === 'string',
)
const dialogTitle = computed(() => {
  if (!props.provider) return ''
  const total = pageResult.value?.total ?? props.provider.ruleCount
  return `${props.provider.name} (${total})`
})
const familyOptions = computed(() => {
  const counts = pageResult.value?.counts
  return [
    { value: 'all', label: t('all'), count: counts?.all ?? props.provider?.ruleCount ?? 0 },
    { value: 'domain', label: t('domainRules'), count: counts?.domain ?? 0 },
    { value: 'ip', label: t('ipRules'), count: counts?.ip ?? 0 },
    { value: 'other', label: t('otherRules'), count: counts?.other ?? 0 },
  ]
})
const pageCount = computed(() =>
  Math.max(1, Math.ceil((pageResult.value?.matched ?? 0) / RULE_PROVIDER_EXPLORER_PAGE_SIZE)),
)
const rangeStart = computed(() =>
  pageResult.value?.matched ? (pageResult.value.page - 1) * pageResult.value.pageSize + 1 : 0,
)
const rangeEnd = computed(() =>
  pageResult.value ? rangeStart.value + pageResult.value.items.length - 1 : 0,
)
const errorMessage = computed(() => {
  if (!error.value) return ''
  if (['HELPER_OFFLINE', 'HELPER_TIMEOUT'].includes(error.value.code)) {
    return t('providerExplorerOffline')
  }
  if (error.value.code === 'RULE_PROVIDER_FORMAT_UNSUPPORTED') {
    return t('providerExplorerUnsupportedFormat')
  }
  return `${t('providerExplorerLoadFailed')} (${error.value.code})`
})

const resetExplorer = () => {
  family.value = 'all'
  searchText.value = ''
  debouncedSearch.value = ''
  sortKey.value = null
  sortDirection.value = 'default'
  requestedPage.value = 1
  pageResult.value = null
  error.value = null
}

const loadPage = async () => {
  const name = props.provider?.name
  if (!isOpen.value || !name) return

  const sequence = ++requestSequence
  activeRequest?.abort()
  activeRequest = new AbortController()
  loading.value = true
  error.value = null

  try {
    const result = await fetchLocalRuleProviderRulePage(
      name,
      {
        page: requestedPage.value,
        pageSize: RULE_PROVIDER_EXPLORER_PAGE_SIZE,
        family: family.value,
        search: debouncedSearch.value,
        sortKey: sortKey.value,
        sortDirection: sortDirection.value,
      },
      activeRequest.signal,
    )
    if (sequence !== requestSequence) return

    pageResult.value = result
    requestedPage.value = result.page
  } catch (caught) {
    if (sequence !== requestSequence) return
    error.value =
      caught instanceof LocalHelperRequestError
        ? caught
        : new LocalHelperRequestError('HELPER_INVALID_RESPONSE', 'Invalid response.')
  } finally {
    if (sequence === requestSequence) loading.value = false
  }
}

const setFamily = (value: string) => {
  family.value = value as RuleProviderFamily
  requestedPage.value = 1
  void loadPage()
}

const changeSort = (key: RuleProviderSortKey) => {
  const next = nextRuleProviderSort({ key: sortKey.value, direction: sortDirection.value }, key)
  sortKey.value = next.key
  sortDirection.value = next.direction
  requestedPage.value = 1
  void loadPage()
}

const ariaSort = (key: RuleProviderSortKey) => {
  if (sortKey.value !== key || sortDirection.value === 'default') return 'none'
  return sortDirection.value === 'asc' ? 'ascending' : 'descending'
}

const goToPage = (page: number) => {
  requestedPage.value = page
  void loadPage()
}

const formatMtime = (value: string) => dayjs(value).format('YYYY-MM-DD HH:mm:ss')
const formatBytes = (value: number) => {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`
  return `${(value / 1024 / 1024).toFixed(1)} MiB`
}

const copyRaw = async (raw: string) => {
  try {
    await navigator.clipboard.writeText(raw)
  } catch {
    const textArea = document.createElement('textarea')
    textArea.value = raw
    document.body.appendChild(textArea)
    textArea.select()
    document.execCommand('copy')
    textArea.remove()
  }
  showNotification({ content: 'copySuccess', type: 'alert-success', timeout: 2000 })
}

const beginAdd = () => {
  operationError.value = ''
  editor.value = { operation: 'add', raw: '' }
}

const beginEdit = (item: LocalProviderRuleItem) => {
  operationError.value = ''
  editor.value = { operation: 'update', index: item.index, raw: item.raw }
}

const cancelEdit = () => {
  editor.value = null
}

const displayMutationError = (caught: unknown) => {
  if (caught instanceof LocalProviderApplyError) {
    const key = {
      'reload-no-backup': 'localProviderReloadNoBackup',
      rollback: 'localProviderRollbackFailed',
      'rollback-reload': 'localProviderRollbackReloadFailed',
      'reload-restored': 'localProviderReloadRestored',
    }[caught.stage]
    return t(key)
  }
  if (caught instanceof LocalHelperRequestError) {
    if (caught.code === 'RULE_PROVIDER_VERSION_CONFLICT') {
      return t('localProviderVersionConflict')
    }
    if (caught.code === 'RULE_PROVIDER_READ_ONLY') return t('providerReadOnly')
    return `${t('localProviderOperationFailed')} (${caught.code})`
  }
  return t('localProviderOperationFailed')
}

const refreshAfterMutation = async () => {
  clearLocalProviderRuleCache()
  await fetchRules()
}

const runMutation = async (input: {
  operation: 'add' | 'update' | 'delete'
  index?: number
  raw?: string
}) => {
  const name = props.provider?.name
  const version = pageResult.value?.version
  if (!name || !editable.value || typeof version !== 'string') return

  mutating.value = true
  operationError.value = ''
  try {
    await applyLocalProviderUpdate(
      name,
      () => mutateLocalRuleProvider(name, { expectedVersion: version, ...input }),
      {
        reload: updateRuleProviderAPI,
        rollback: rollbackLocalRuleProvider,
        refresh: refreshAfterMutation,
      },
    )
    editor.value = null
    showNotification({
      content:
        input.operation === 'add'
          ? 'localProviderRuleAdded'
          : input.operation === 'update'
            ? 'localProviderRuleUpdated'
            : 'localProviderRuleDeleted',
      type: 'alert-success',
      timeout: 2500,
    })
    await loadPage()
  } catch (caught) {
    operationError.value = displayMutationError(caught)
    await loadPage()
  } finally {
    mutating.value = false
  }
}

const saveEditor = () => {
  const current = editor.value
  if (!current || !current.raw.trim() || mutating.value) return
  void runMutation({
    operation: current.operation,
    ...(current.index === undefined ? {} : { index: current.index }),
    raw: current.raw,
  })
}

const removeRule = (item: LocalProviderRuleItem) => {
  if (mutating.value || !confirm(t('deleteLocalProviderRuleConfirm'))) return
  void runMutation({ operation: 'delete', index: item.index })
}

watch([isOpen, () => props.provider?.name], ([open, name], [wasOpen, previousName]) => {
  if (!open) {
    requestSequence += 1
    activeRequest?.abort()
    activeRequest = null
    loading.value = false
    editor.value = null
    operationError.value = ''
    return
  }
  if (name && (!wasOpen || name !== previousName)) {
    resetExplorer()
    void loadPage()
  }
})

watchDebounced(
  searchText,
  (value) => {
    const normalized = value.trim()
    if (normalized === debouncedSearch.value) return
    debouncedSearch.value = normalized
    requestedPage.value = 1
    void loadPage()
  },
  { debounce: 350 },
)

onBeforeUnmount(() => {
  requestSequence += 1
  activeRequest?.abort()
})
</script>
