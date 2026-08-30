import type { RuleProviderSortDirection, RuleProviderSortKey } from './helperApi'

export const RULE_PROVIDER_EXPLORER_PAGE_SIZE = 100

export type RuleProviderSortState = {
  key: RuleProviderSortKey | null
  direction: RuleProviderSortDirection
}

export const nextRuleProviderSort = (
  current: RuleProviderSortState,
  clickedKey: RuleProviderSortKey,
): RuleProviderSortState => {
  if (current.key !== clickedKey || current.direction === 'default') {
    return { key: clickedKey, direction: 'asc' }
  }
  if (current.direction === 'asc') {
    return { key: clickedKey, direction: 'desc' }
  }
  return { key: null, direction: 'default' }
}
