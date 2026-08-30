import type { Rule } from '@/types'
import { normalizeRuleType } from './ruleType.ts'
import type { RuleFallback, RuleFallbackType } from './types'

const FALLBACK_TYPES = new Set<RuleFallbackType>(['MATCH', 'FINAL'])

export const isRuleEffectivelyDisabled = (rule: Rule) =>
  rule.disabled === true || rule.extra?.disabled === true

/** Return the first enabled terminal rule because Mihomo evaluates rules in order. */
export const findRuleFallback = (rules: readonly Rule[]): RuleFallback | null => {
  for (const [index, rule] of rules.entries()) {
    const type = normalizeRuleType(rule.type)

    if (!FALLBACK_TYPES.has(type as RuleFallbackType) || isRuleEffectivelyDisabled(rule)) {
      continue
    }

    return {
      rule,
      type: type as RuleFallbackType,
      position: index + 1,
    }
  }

  return null
}
