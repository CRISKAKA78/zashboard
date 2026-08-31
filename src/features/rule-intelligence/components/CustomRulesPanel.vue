<template>
  <section class="base-container p-3">
    <div class="flex flex-wrap items-start justify-between gap-2">
      <div class="min-w-0">
        <div class="flex items-center gap-2">
          <AdjustmentsHorizontalIcon class="text-base-content/60 h-4 w-4 shrink-0" />
          <h2 class="text-sm font-medium">{{ $t('customRules') }}</h2>
          <span
            v-if="state"
            class="badge badge-ghost badge-sm"
          >
            Pre {{ draft.pre.length }} / Post {{ draft.post.length }}
          </span>
          <span
            v-if="dirty"
            class="badge badge-warning badge-sm"
          >
            {{ $t('unsavedChanges') }}
          </span>
        </div>
        <p class="text-base-content/55 mt-1 text-xs">
          {{ $t('customRulesDescription') }}
        </p>
      </div>
      <button
        type="button"
        class="btn btn-ghost btn-xs"
        @click="toggleExpanded"
      >
        {{ expanded ? $t('collapse') : $t('manageCustomRules') }}
        <ChevronDownIcon
          class="h-3.5 w-3.5 transition-transform"
          :class="expanded ? 'rotate-180' : ''"
        />
      </button>
    </div>

    <div
      v-if="expanded"
      class="mt-3 space-y-3"
    >
      <div
        v-if="loading"
        class="text-base-content/60 flex items-center gap-2 py-3 text-xs"
      >
        <span class="loading loading-spinner loading-xs" />
        {{ $t('loading') }}
      </div>

      <div
        v-else-if="errorMessage && !state"
        class="alert alert-warning py-2 text-xs"
      >
        <ExclamationTriangleIcon class="h-4 w-4 shrink-0" />
        <span class="min-w-0 flex-1 break-words">{{ errorMessage }}</span>
        <button
          type="button"
          class="btn btn-ghost btn-xs"
          @click="load"
        >
          {{ $t('retry') }}
        </button>
      </div>

      <template v-else-if="state">
        <div class="grid grid-cols-1 gap-3 md:grid-cols-2">
          <section
            v-for="section in sections"
            :key="section.key"
            class="border-base-content/10 rounded-box min-w-0 border p-2"
          >
            <div class="flex items-center justify-between gap-2">
              <div class="min-w-0">
                <h3 class="text-xs font-semibold">{{ section.label }}</h3>
                <p class="text-base-content/50 mt-0.5 text-[0.7rem]">
                  {{ section.description }}
                </p>
              </div>
              <button
                type="button"
                class="btn btn-primary btn-xs"
                @click="beginAdd(section.key)"
              >
                <PlusIcon class="h-3.5 w-3.5" />
                {{ $t('addRule') }}
              </button>
            </div>

            <Draggable
              v-model="draft[section.key]"
              class="mt-2 min-h-10 space-y-1.5"
              item-key="id"
              handle=".custom-rule-drag-handle"
              :animation="150"
              @change="markDirty"
            >
              <template #item="{ element, index }: { element: CustomRule; index: number }">
                <div class="bg-base-200/55 rounded-box flex min-w-0 items-center gap-1.5 p-2">
                  <button
                    type="button"
                    class="custom-rule-drag-handle btn btn-circle btn-ghost btn-xs cursor-grab"
                    :title="$t('dragToReorder')"
                  >
                    <Bars3Icon class="h-3.5 w-3.5" />
                  </button>
                  <div class="min-w-0 flex-1">
                    <div class="flex min-w-0 flex-wrap items-center gap-1">
                      <span class="badge badge-outline badge-sm">{{ element.type }}</span>
                      <span class="truncate text-xs font-medium">{{ element.value || '—' }}</span>
                      <ArrowRightIcon class="text-base-content/35 h-3 w-3 shrink-0" />
                      <span class="truncate text-xs">{{ element.target }}</span>
                    </div>
                    <p class="text-base-content/45 mt-0.5 truncate font-mono text-[0.65rem]">
                      {{ element.raw || rulePreview(element) }}
                    </p>
                  </div>
                  <div class="flex shrink-0 items-center">
                    <button
                      type="button"
                      class="btn btn-circle btn-ghost btn-xs"
                      :disabled="index === 0"
                      :title="$t('moveUp')"
                      @click="move(section.key, index, -1)"
                    >
                      <ChevronUpIcon class="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      class="btn btn-circle btn-ghost btn-xs"
                      :disabled="index === draft[section.key].length - 1"
                      :title="$t('moveDown')"
                      @click="move(section.key, index, 1)"
                    >
                      <ChevronDownIcon class="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      class="btn btn-circle btn-ghost btn-xs"
                      :title="$t('editCustomRule')"
                      @click="beginEdit(section.key, index)"
                    >
                      <PencilSquareIcon class="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      class="btn btn-circle btn-ghost btn-xs text-error"
                      :title="$t('delete')"
                      @click="remove(section.key, index)"
                    >
                      <TrashIcon class="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              </template>
            </Draggable>

            <p
              v-if="!draft[section.key].length"
              class="text-base-content/40 py-3 text-center text-xs"
            >
              {{ $t('noCustomRules') }}
            </p>
          </section>
        </div>

        <section
          v-if="editor && editing"
          class="border-primary/25 bg-primary/5 rounded-box border p-3"
        >
          <div class="flex flex-wrap items-center justify-between gap-2">
            <h3 class="text-xs font-semibold">
              {{ editing.index === null ? $t('addRule') : $t('editCustomRule') }} ·
              {{ editing.section === 'pre' ? $t('preCustomRules') : $t('postCustomRules') }}
            </h3>
            <label class="label cursor-pointer gap-2 py-0 text-xs">
              <span>{{ $t('advancedRawMode') }}</span>
              <input
                type="checkbox"
                class="toggle toggle-xs"
                :checked="editor.mode === 'raw'"
                @change="toggleEditorMode(($event.target as HTMLInputElement).checked)"
              />
            </label>
          </div>

          <textarea
            v-if="editor.mode === 'raw'"
            v-model="editor.raw"
            class="textarea textarea-bordered mt-2 min-h-20 w-full font-mono text-xs"
            :placeholder="$t('rawRulePlaceholder')"
          />
          <div
            v-else
            class="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4"
          >
            <label class="form-control">
              <span class="label py-1 text-xs">{{ $t('ruleType') }}</span>
              <select
                v-model="editor.type"
                class="select select-bordered select-sm w-full"
              >
                <option
                  v-for="type in CUSTOM_RULE_TYPES"
                  :key="type"
                  :value="type"
                  :disabled="type === 'MATCH' && editing.section === 'pre'"
                >
                  {{ type }}
                </option>
              </select>
            </label>
            <label
              v-if="editor.type !== 'MATCH'"
              class="form-control lg:col-span-1"
            >
              <span class="label py-1 text-xs">{{ $t('ruleValue') }}</span>
              <input
                v-model="editor.value"
                class="input input-bordered input-sm w-full"
                :placeholder="$t('ruleValuePlaceholder')"
              />
            </label>
            <label class="form-control">
              <span class="label py-1 text-xs">{{ $t('ruleTarget') }}</span>
              <input
                v-model="editor.target"
                class="input input-bordered input-sm w-full"
                list="custom-rule-targets"
                :placeholder="$t('ruleTarget')"
              />
              <datalist id="custom-rule-targets">
                <option
                  v-for="target in targets"
                  :key="target"
                  :value="target"
                />
              </datalist>
            </label>
            <label class="form-control">
              <span class="label py-1 text-xs">{{ $t('additionalParams') }}</span>
              <input
                v-model="editorParams"
                class="input input-bordered input-sm w-full"
                placeholder="no-resolve, src"
              />
            </label>
          </div>

          <div class="mt-3 flex justify-end gap-2">
            <button
              type="button"
              class="btn btn-ghost btn-xs"
              @click="cancelEdit"
            >
              {{ $t('cancel') }}
            </button>
            <button
              type="button"
              class="btn btn-primary btn-xs"
              @click="acceptEdit"
            >
              {{ $t('confirm') }}
            </button>
          </div>
        </section>

        <div
          v-if="errorMessage"
          class="alert alert-warning py-2 text-xs"
        >
          <ExclamationTriangleIcon class="h-4 w-4 shrink-0" />
          <span class="break-words">{{ errorMessage }}</span>
        </div>
        <div
          v-else-if="statusMessage"
          class="alert alert-success py-2 text-xs"
        >
          <CheckCircleIcon class="h-4 w-4 shrink-0" />
          <span>{{ statusMessage }}</span>
        </div>

        <div class="flex flex-wrap items-center justify-between gap-2">
          <div class="text-base-content/45 min-w-0 text-[0.65rem]">
            <p class="truncate">{{ $t('sourceConfig') }}: {{ state.sourceConfigPath }}</p>
            <p class="truncate">{{ $t('managedConfig') }}: {{ state.runtimeConfigPath }}</p>
          </div>
          <div class="flex flex-wrap justify-end gap-2">
            <button
              v-if="state.backups.length"
              type="button"
              class="btn btn-ghost btn-xs"
              :disabled="busy"
              @click="restoreLatest"
            >
              <ArrowUturnLeftIcon class="h-3.5 w-3.5" />
              {{ $t('restoreLatestBackup') }}
            </button>
            <button
              type="button"
              class="btn btn-outline btn-xs"
              :disabled="busy"
              @click="validate"
            >
              <CheckBadgeIcon class="h-3.5 w-3.5" />
              {{ $t('validateConfig') }}
            </button>
            <button
              type="button"
              class="btn btn-primary btn-xs"
              :disabled="busy || !dirty"
              @click="save"
            >
              <span
                v-if="busy"
                class="loading loading-spinner loading-xs"
              />
              <ArrowPathIcon
                v-else
                class="h-3.5 w-3.5"
              />
              {{ $t('saveValidateReload') }}
            </button>
          </div>
        </div>
      </template>
    </div>
  </section>
</template>

<script setup lang="ts">
import { updateConfigsAPI } from '@/assembly/config'
import { fetchProxies, proxyMap } from '@/assembly/proxies'
import { fetchRules } from '@/assembly/rules'
import {
  applyCustomRulesUpdate,
  cloneCustomRule,
  cloneCustomRulesDraft,
  createCustomRule,
  CUSTOM_RULE_TYPES,
  type CustomRule,
  type CustomRulesDraft,
  type CustomRulesState,
} from '@/features/rule-intelligence/customRules'
import {
  fetchLocalCustomRules,
  restoreLocalCustomRules,
  rollbackLocalCustomRules,
  saveLocalCustomRules,
  validateLocalCustomRules,
} from '@/features/rule-intelligence/helperApi'
import { clearLocalProviderRuleCache } from '@/features/rule-intelligence/providerCache'
import {
  AdjustmentsHorizontalIcon,
  ArrowPathIcon,
  ArrowRightIcon,
  ArrowUturnLeftIcon,
  Bars3Icon,
  CheckBadgeIcon,
  CheckCircleIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  ExclamationTriangleIcon,
  PencilSquareIcon,
  PlusIcon,
  TrashIcon,
} from '@heroicons/vue/24/outline'
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import Draggable from 'vuedraggable'

type SectionKey = 'pre' | 'post'
type EditingLocation = { section: SectionKey; index: number | null }

const { t } = useI18n()
const expanded = ref(false)
const loading = ref(false)
const busy = ref(false)
const dirty = ref(false)
const state = ref<CustomRulesState | null>(null)
const draft = ref<CustomRulesDraft>({ pre: [], post: [], fakeIpFilter: [] })
const editing = ref<EditingLocation | null>(null)
const editor = ref<CustomRule | null>(null)
const editorParams = ref('')
const errorMessage = ref('')
const statusMessage = ref('')

const sections = computed(() => [
  {
    key: 'pre' as const,
    label: t('preCustomRules'),
    description: t('preCustomRulesDescription'),
  },
  {
    key: 'post' as const,
    label: t('postCustomRules'),
    description: t('postCustomRulesDescription'),
  },
])
const targets = computed(() =>
  [...new Set(['DIRECT', 'REJECT', 'REJECT-DROP', 'PASS', ...Object.keys(proxyMap.value)])].sort(
    (left, right) => left.localeCompare(right),
  ),
)

const displayError = (error: unknown) =>
  error instanceof Error ? error.message : t('customRulesOperationFailed')
const rulePreview = (rule: CustomRule) =>
  [rule.type, ...(rule.type === 'MATCH' ? [] : [rule.value]), rule.target, ...rule.params].join(',')

const load = async () => {
  loading.value = true
  errorMessage.value = ''
  statusMessage.value = ''
  try {
    const loaded = await fetchLocalCustomRules()
    state.value = loaded
    draft.value = cloneCustomRulesDraft(loaded)
    dirty.value = false
    cancelEdit()
  } catch (error) {
    state.value = null
    errorMessage.value = displayError(error)
  } finally {
    loading.value = false
  }
}

const toggleExpanded = () => {
  expanded.value = !expanded.value
  if (expanded.value && !state.value && !loading.value) void load()
}
const markDirty = () => {
  dirty.value = true
  statusMessage.value = ''
}
const beginAdd = (section: SectionKey) => {
  const rule = createCustomRule(
    targets.value.includes('DIRECT') ? 'DIRECT' : targets.value[0] || 'DIRECT',
  )
  editing.value = { section, index: null }
  editor.value = rule
  editorParams.value = ''
}
const beginEdit = (section: SectionKey, index: number) => {
  const rule = draft.value[section][index]
  editing.value = { section, index }
  editor.value = cloneCustomRule(rule)
  editorParams.value = rule.params.join(', ')
}
const cancelEdit = () => {
  editing.value = null
  editor.value = null
  editorParams.value = ''
}
const toggleEditorMode = (raw: boolean) => {
  if (!editor.value) return
  editor.value.mode = raw ? 'raw' : 'structured'
  if (raw && !editor.value.raw) editor.value.raw = rulePreview(editor.value)
}
const acceptEdit = () => {
  if (!editor.value || !editing.value) return
  const next = cloneCustomRule(editor.value)
  next.params = editorParams.value
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
  if (next.mode === 'structured') next.raw = rulePreview(next)
  const list = draft.value[editing.value.section]
  if (editing.value.index === null) list.push(next)
  else list.splice(editing.value.index, 1, next)
  markDirty()
  cancelEdit()
}
const remove = (section: SectionKey, index: number) => {
  if (!confirm(t('deleteCustomRuleConfirm'))) return
  draft.value[section].splice(index, 1)
  markDirty()
  if (editing.value?.section === section && editing.value.index === index) cancelEdit()
}
const move = (section: SectionKey, index: number, direction: -1 | 1) => {
  const target = index + direction
  if (target < 0 || target >= draft.value[section].length) return
  const [rule] = draft.value[section].splice(index, 1)
  draft.value[section].splice(target, 0, rule)
  markDirty()
}

const refreshRuleIntelligence = async () => {
  clearLocalProviderRuleCache()
  await Promise.allSettled([fetchRules(), fetchProxies()])
}
const updateDependencies = {
  reload: (runtimeConfigPath: string) =>
    updateConfigsAPI({ path: runtimeConfigPath, payload: '' }, true),
  rollback: rollbackLocalCustomRules,
  refresh: refreshRuleIntelligence,
}

const validate = async () => {
  busy.value = true
  errorMessage.value = ''
  statusMessage.value = ''
  try {
    await validateLocalCustomRules(cloneCustomRulesDraft(draft.value))
    statusMessage.value = t('customRulesValidationPassed')
  } catch (error) {
    errorMessage.value = displayError(error)
  } finally {
    busy.value = false
  }
}
const save = async () => {
  if (!state.value) return
  busy.value = true
  errorMessage.value = ''
  statusMessage.value = ''
  try {
    const expectedVersion = state.value.version
    const saved = await applyCustomRulesUpdate(
      () =>
        saveLocalCustomRules({
          expectedVersion,
          ...cloneCustomRulesDraft(draft.value),
        }),
      updateDependencies,
    )
    state.value = saved
    draft.value = cloneCustomRulesDraft(saved)
    dirty.value = false
    statusMessage.value = t('customRulesSavedReloaded')
  } catch (error) {
    const message = displayError(error)
    await load()
    errorMessage.value = message
  } finally {
    busy.value = false
  }
}
const restoreLatest = async () => {
  const current = state.value
  const latest = current?.backups[0]
  if (!current || !latest || !confirm(t('restoreCustomRulesConfirm'))) return
  busy.value = true
  errorMessage.value = ''
  statusMessage.value = ''
  try {
    const restored = await applyCustomRulesUpdate(
      () =>
        restoreLocalCustomRules({
          expectedVersion: current.version,
          backupId: latest.id,
        }),
      updateDependencies,
    )
    state.value = restored
    draft.value = cloneCustomRulesDraft(restored)
    dirty.value = false
    statusMessage.value = t('customRulesBackupRestored')
  } catch (error) {
    const message = displayError(error)
    await load()
    errorMessage.value = message
  } finally {
    busy.value = false
  }
}
</script>
