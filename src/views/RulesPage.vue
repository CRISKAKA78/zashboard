<template>
  <div
    :class="
      isRuleTable
        ? 'relative flex size-full flex-col overflow-hidden'
        : 'relative size-full overflow-x-hidden'
    "
    :style="isRuleTable ? padding : undefined"
  >
    <template v-if="isRuleTable">
      <RulesCtrl />
      <RuleFallbackCard
        v-if="rulesTabShow === RULE_TAB_TYPE.RULES"
        class="mx-3 mt-3 shrink-0"
      />
      <RulePenetrationPanel
        v-if="rulesTabShow === RULE_TAB_TYPE.RULES"
        class="mx-3 mt-3 shrink-0"
      />
      <CustomRulesPanel
        v-if="rulesTabShow === RULE_TAB_TYPE.RULES"
        class="mx-3 mt-3 shrink-0"
      />
      <RulesTable @open-provider="openProviderExplorer" />
    </template>
    <template v-else-if="!isVirtualScroller">
      <RulesCtrl />
      <div
        class="p-3"
        :style="padding"
      >
        <RuleFallbackCard
          v-if="rulesTabShow === RULE_TAB_TYPE.RULES"
          class="mb-2"
        />
        <RulePenetrationPanel
          v-if="rulesTabShow === RULE_TAB_TYPE.RULES"
          class="mb-2"
        />
        <CustomRulesPanel
          v-if="rulesTabShow === RULE_TAB_TYPE.RULES"
          class="mb-2"
        />
        <template v-if="rulesTabShow === RULE_TAB_TYPE.PROVIDER">
          <div class="flex flex-col gap-2">
            <div
              v-for="(ruleProvider, index) in renderRulesProvider"
              :key="ruleProvider.name"
              class="base-container"
            >
              <RuleProvider
                :ruleProvider="ruleProvider"
                :index="index + 1"
                @open="openProviderExplorer"
              />
            </div>
          </div>
        </template>
        <template v-else>
          <div class="flex flex-col gap-2">
            <div
              v-for="rule in renderRules"
              :key="rule.payload"
              class="base-container"
            >
              <RuleCard
                :rule="rule"
                :index="rules.indexOf(rule) + 1"
              />
            </div>
          </div>
        </template>
      </div>
    </template>
    <VirtualScroller
      v-else
      :data="renderRules"
      :size="44"
    >
      <template v-slot:before>
        <RulesCtrl />
        <div
          v-if="rulesTabShow === RULE_TAB_TYPE.RULES"
          class="px-3 pt-3"
        >
          <RuleFallbackCard />
          <RulePenetrationPanel class="mt-2" />
          <CustomRulesPanel class="mt-2" />
        </div>
      </template>
      <template v-slot="{ item: rule }: { item: Rule }">
        <RuleCard
          :key="rule.payload"
          :rule="rule"
          :index="rules.indexOf(rule) + 1"
        />
      </template>
    </VirtualScroller>
    <RuleProviderExplorerDialog
      v-model="providerExplorerVisible"
      :provider="selectedProvider"
    />
  </div>
</template>

<script setup lang="ts">
import VirtualScroller from '@/components/common/VirtualScroller.vue'
import RuleFallbackCard from '@/features/rule-intelligence/components/RuleFallbackCard.vue'
import RulePenetrationPanel from '@/features/rule-intelligence/components/RulePenetrationPanel.vue'
import CustomRulesPanel from '@/features/rule-intelligence/components/CustomRulesPanel.vue'
import RuleProviderExplorerDialog from '@/features/rule-intelligence/components/RuleProviderExplorerDialog.vue'
import RulesCtrl from '@/components/controls/RulesCtrl'
import RuleCard from '@/components/rules/RuleCard.vue'
import RuleProvider from '@/components/rules/RuleProvider.vue'
import RulesTable from '@/components/rules/RulesTable.vue'
import { usePaddingForViews } from '@/composables/paddingViews'
import { LIST_DISPLAY_STYLE, RULE_TAB_TYPE } from '@/constant'
import { fetchRules, renderRules, renderRulesProvider, rules, rulesTabShow } from '@/assembly/rules'
import { ruleDisplayStyle } from '@/store/settings'
import type { Rule, RuleProvider as RuleProviderType } from '@/types'
import { computed, provide, ref } from 'vue'

fetchRules()

const expandedRule = ref<string | null>(null)
provide('expandedRule', expandedRule)

const selectedProvider = ref<RuleProviderType | null>(null)
const providerExplorerVisible = ref(false)
const openProviderExplorer = (provider: RuleProviderType) => {
  selectedProvider.value = provider
  providerExplorerVisible.value = true
}

const isRuleTable = computed(() => ruleDisplayStyle.value === LIST_DISPLAY_STYLE.TABLE)
const cardPadding = usePaddingForViews({
  offsetTop: 12,
  offsetBottom: 8,
})
const tablePadding = usePaddingForViews({
  offsetTop: 0,
  offsetBottom: 0,
})
const padding = computed(() =>
  isRuleTable.value ? tablePadding.padding.value : cardPadding.padding.value,
)
const isVirtualScroller = computed(() => {
  return rulesTabShow.value === RULE_TAB_TYPE.RULES && renderRules.value.length > 200
})
</script>
