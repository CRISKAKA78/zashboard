import type { Rule } from '@/types'
import { isIpInCidr, parseIpAddress } from './ip.ts'
import { isRuleEffectivelyDisabled } from './ruleFallback.ts'
import { normalizeRuleType } from './ruleType.ts'
import type {
  ProviderRuleSet,
  RuleEntry,
  RuleIntelligenceMatch,
  RuleIntelligenceResult,
  RuleQuery,
} from './types.ts'

const DOMAIN_TYPES = new Set(['DOMAIN', 'DOMAIN-SUFFIX', 'DOMAIN-KEYWORD'])
const IP_TYPES = new Set(['IP-CIDR', 'IP-CIDR6'])
const MAX_RESULTS = 200

export { normalizeRuleType }
const normalizeDomain = (value: string) => value.trim().toLowerCase().replace(/\.$/u, '')

const isDomain = (value: string) => {
  const normalized = normalizeDomain(value)
  if (!normalized.includes('.') || normalized.length > 253) return false

  return normalized
    .split('.')
    .every(
      (label) =>
        label.length > 0 && label.length <= 63 && /^[\da-z](?:[\da-z-]*[\da-z])?$/iu.test(label),
    )
}

export const classifyRuleQuery = (input: string): RuleQuery => {
  const raw = input.trim()

  if (parseIpAddress(raw)) {
    return { raw, normalized: raw.toLowerCase(), kind: 'ip' }
  }
  if (isDomain(raw)) {
    return { raw, normalized: normalizeDomain(raw), kind: 'domain' }
  }

  return { raw, normalized: raw.toLowerCase(), kind: 'keyword' }
}

export const doesRuleEntryMatchTraffic = (entry: RuleEntry, query: RuleQuery) => {
  const type = normalizeRuleType(entry.type)

  if (query.kind === 'domain' && DOMAIN_TYPES.has(type)) {
    const value = normalizeDomain(entry.value).replace(/^(?:\+\.|\*\.|\.)/u, '')
    if (!value) return false

    if (type === 'DOMAIN') return query.normalized === value
    if (type === 'DOMAIN-SUFFIX') {
      return query.normalized === value || query.normalized.endsWith(`.${value}`)
    }
    return query.normalized.includes(value)
  }

  if (query.kind === 'ip' && IP_TYPES.has(type)) {
    return isIpInCidr(query.normalized, entry.value.trim())
  }

  return false
}

const entryFromDirectRule = (rule: Rule): RuleEntry => ({
  source: 'direct',
  type: normalizeRuleType(rule.type),
  value: rule.payload,
  raw: `${rule.type},${rule.payload},${rule.proxy}`,
})

export const getDisplayRuleIndex = (rule: Rule, position: number) =>
  Number.isFinite(rule.index) ? rule.index : position + 1

const matchesEntry = (entry: RuleEntry, query: RuleQuery) =>
  query.kind === 'keyword'
    ? entry.raw.toLowerCase().includes(query.normalized)
    : doesRuleEntryMatchTraffic(entry, query)

const toPublicMatch = (match: RuleIntelligenceMatch): RuleIntelligenceMatch => ({
  source: match.source,
  matchMode: match.matchMode,
  entry: match.entry,
  providerName: match.providerName,
  ruleIndex: match.ruleIndex,
  rulePosition: match.rulePosition,
  target: match.target,
})

export const searchRuleIntelligence = (
  queryInput: string,
  directRules: readonly Rule[],
  providers: readonly ProviderRuleSet[] = [],
): RuleIntelligenceResult => {
  const query = classifyRuleQuery(queryInput)
  if (!query.raw) {
    return { query, matches: [], directMatches: [], providerMatches: [], truncated: false }
  }

  const directMatches: Array<RuleIntelligenceMatch & { order: number }> = []
  const providerReferences = new Map<string, { rule: Rule; order: number }>()

  directRules.forEach((rule, order) => {
    if (isRuleEffectivelyDisabled(rule)) return

    if (normalizeRuleType(rule.type) === 'RULE-SET') {
      if (!providerReferences.has(rule.payload)) {
        providerReferences.set(rule.payload, { rule, order })
      }
      return
    }

    const entry = entryFromDirectRule(rule)
    if (!matchesEntry(entry, query)) return

    directMatches.push({
      source: 'direct',
      matchMode: query.kind === 'keyword' ? 'content' : 'traffic',
      entry,
      providerName: null,
      ruleIndex: getDisplayRuleIndex(rule, order),
      rulePosition: order + 1,
      target: rule.proxy,
      order,
    })
  })

  const providerMatches: Array<RuleIntelligenceMatch & { order: number; entryOrder: number }> = []
  for (const provider of providers) {
    const reference = providerReferences.get(provider.name)
    const matchingEntries = provider.entries.filter((entry) => matchesEntry(entry, query))

    matchingEntries.forEach((entry, entryOrder) => {
      providerMatches.push({
        source: 'provider',
        matchMode: query.kind === 'keyword' ? 'content' : 'traffic',
        entry,
        providerName: provider.name,
        ruleIndex: reference ? getDisplayRuleIndex(reference.rule, reference.order) : null,
        rulePosition: reference ? reference.order + 1 : null,
        target: reference?.rule.proxy ?? null,
        order: reference?.order ?? Number.POSITIVE_INFINITY,
        entryOrder,
      })
    })

    if (
      query.kind === 'keyword' &&
      matchingEntries.length === 0 &&
      provider.name.toLowerCase().includes(query.normalized)
    ) {
      providerMatches.push({
        source: 'provider',
        matchMode: 'provider-name',
        entry: null,
        providerName: provider.name,
        ruleIndex: reference ? getDisplayRuleIndex(reference.rule, reference.order) : null,
        rulePosition: reference ? reference.order + 1 : null,
        target: reference?.rule.proxy ?? null,
        order: reference?.order ?? Number.POSITIVE_INFINITY,
        entryOrder: -1,
      })
    }
  }

  const byRuleOrder = (left: { order: number }, right: { order: number }) =>
    left.order - right.order
  const getEntryOrder = (match: { order: number }) =>
    'entryOrder' in match && typeof match.entryOrder === 'number' ? match.entryOrder : -1
  directMatches.sort(byRuleOrder)
  providerMatches.sort(
    (left, right) => byRuleOrder(left, right) || left.entryOrder - right.entryOrder,
  )

  const orderedMatches = [...directMatches, ...providerMatches].sort(
    (left, right) => byRuleOrder(left, right) || getEntryOrder(left) - getEntryOrder(right),
  )
  const visibleMatches = orderedMatches.slice(0, MAX_RESULTS).map(toPublicMatch)

  return {
    query,
    matches: visibleMatches,
    directMatches: visibleMatches.filter((match) => match.source === 'direct'),
    providerMatches: visibleMatches.filter((match) => match.source === 'provider'),
    truncated: orderedMatches.length > MAX_RESULTS,
  }
}
