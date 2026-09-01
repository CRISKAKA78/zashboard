import type { Rule } from '@/types'
import { findRuleFallback, isRuleEffectivelyDisabled } from './ruleFallback.ts'
import {
  entryFromDirectRule,
  evaluateRuleEntryTraffic,
  getDisplayRuleIndex,
  normalizeRuleType,
  searchRuleIntelligence,
} from './ruleQuery.ts'
import type {
  ProviderRuleSet,
  ProxyChainAnalysis,
  RuleIntelligenceMatch,
  RulePenetrationBlocker,
  RulePenetrationResult,
  RuleProviderAvailability,
  RuleProviderIssue,
} from './types.ts'

const TERMINAL_OUTBOUNDS = new Set(['DIRECT', 'REJECT', 'REJECT-DROP', 'PASS'])

export type RulePenetrationOptions = {
  providerAvailability?: RuleProviderAvailability
  providerIssues?: readonly RuleProviderIssue[]
  resolveProxyChain?: (target: string) => ProxyChainAnalysis
}

export const isTerminalOutbound = (target: string) =>
  TERMINAL_OUTBOUNDS.has(target.trim().toUpperCase())

const unresolvedRoute = (target: string): ProxyChainAnalysis => ({
  path: [target],
  finalOutbound: target,
  status: 'missing',
  missingAt: target,
})

const resolveTargetRoute = (
  target: string,
  resolver?: (target: string) => ProxyChainAnalysis,
): ProxyChainAnalysis => {
  const route = resolver?.(target) ?? unresolvedRoute(target)

  if (isTerminalOutbound(target) && route.status === 'missing' && route.missingAt === target) {
    return {
      path: route.path.length ? route.path : [target],
      finalOutbound: target,
      status: 'resolved',
    }
  }

  return route
}

const providerBlocker = (
  rule: Rule,
  position: number,
  availability: RuleProviderAvailability,
  issues: ReadonlyMap<string, RuleProviderIssue>,
): RulePenetrationBlocker => {
  const issue = issues.get(rule.payload)
  const availabilityIssue = {
    loading: {
      code: 'PROVIDER_RULES_LOADING',
      message: 'Rule Provider rules are still loading.',
    },
    offline: {
      code: 'HELPER_OFFLINE',
      message: 'Local Helper is unavailable, so this Rule Provider cannot be evaluated.',
    },
    error: {
      code: 'PROVIDER_RULES_UNAVAILABLE',
      message: 'Rule Provider rules are unavailable.',
    },
    ready: {
      code: 'PROVIDER_MISSING',
      message: 'The referenced Rule Provider is missing.',
    },
  }[availability]

  return {
    source: 'provider',
    providerName: rule.payload,
    ruleType: 'RULE-SET',
    ruleValue: rule.payload,
    ruleIndex: getDisplayRuleIndex(rule, position - 1),
    rulePosition: position,
    target: rule.proxy,
    code: issue?.code || availabilityIssue.code,
    message: issue?.message || availabilityIssue.message,
  }
}

const evaluationBlocker = (
  rule: Rule,
  position: number,
  source: RulePenetrationBlocker['source'],
  providerName: string | null,
  type: string,
  value: string,
): RulePenetrationBlocker => ({
  source,
  providerName,
  ruleType: type,
  ruleValue: value,
  ruleIndex: getDisplayRuleIndex(rule, position - 1),
  rulePosition: position,
  target: rule.proxy,
  code: 'RULE_CONTEXT_REQUIRED',
  message:
    'This rule needs DNS, geodata, source, process, port, ingress, or nested-rule context that a host-only query does not provide.',
})

const providerMatch = (
  rule: Rule,
  position: number,
  entry: ProviderRuleSet['entries'][number],
): RuleIntelligenceMatch => ({
  source: 'provider',
  matchMode: 'traffic',
  entry,
  providerName: rule.payload,
  ruleIndex: getDisplayRuleIndex(rule, position - 1),
  rulePosition: position,
  target: rule.proxy,
})

const directMatch = (rule: Rule, position: number): RuleIntelligenceMatch => ({
  source: 'direct',
  matchMode: 'traffic',
  entry: entryFromDirectRule(rule),
  providerName: null,
  ruleIndex: getDisplayRuleIndex(rule, position - 1),
  rulePosition: position,
  target: rule.proxy,
})

const providerRuleHasNoResolve = (rule: Rule, provider: ProviderRuleSet) => {
  const references = (provider.ruleReferences || []).filter(
    (reference) => reference.target === rule.proxy,
  )

  return references.length > 0 && references.every((reference) => reference.noResolve)
}

const withoutEffectiveMatch = (
  matches: readonly RuleIntelligenceMatch[],
  effective: RuleIntelligenceMatch,
) =>
  matches.filter(
    (candidate) =>
      candidate.source !== effective.source ||
      candidate.rulePosition !== effective.rulePosition ||
      candidate.providerName !== effective.providerName ||
      candidate.entry?.raw !== effective.entry?.raw,
  )

const baseResult = (
  search: ReturnType<typeof searchRuleIntelligence>,
): Omit<RulePenetrationResult, 'status'> => ({
  search,
  effectiveMatch: null,
  effectiveFallback: null,
  effectiveRuleIndex: null,
  otherMatches: search.matches,
  target: null,
  route: null,
  blocker: null,
})

/**
 * Resolve the first rule Mihomo can actually apply for a domain or IP.
 * Unknown providers are hard ordering barriers: a later known match must not be
 * presented as effective when an earlier RULE-SET could still win.
 */
export const resolveRulePenetration = (
  queryInput: string,
  rules: readonly Rule[],
  providers: readonly ProviderRuleSet[] = [],
  options: RulePenetrationOptions = {},
): RulePenetrationResult => {
  const search = searchRuleIntelligence(queryInput, rules, providers)
  const base = baseResult(search)

  if (!search.query.raw) return { ...base, status: 'empty' }
  if (search.query.kind === 'keyword') return { ...base, status: 'keyword' }

  const availability = options.providerAvailability ?? 'ready'
  const availableProviders = new Set(providers.map((provider) => provider.name))
  const providersByName = new Map(providers.map((provider) => [provider.name, provider]))
  const issues = new Map((options.providerIssues ?? []).map((issue) => [issue.provider, issue]))
  const fallback = findRuleFallback(rules)

  for (const [offset, rule] of rules.entries()) {
    if (isRuleEffectivelyDisabled(rule)) continue

    const position = offset + 1
    if (fallback?.position === position) {
      return {
        ...base,
        status: 'fallback',
        effectiveFallback: fallback,
        effectiveRuleIndex: getDisplayRuleIndex(rule, offset),
        target: rule.proxy,
        route: resolveTargetRoute(rule.proxy, options.resolveProxyChain),
      }
    }

    if (normalizeRuleType(rule.type) === 'RULE-SET') {
      if (!availableProviders.has(rule.payload)) {
        return {
          ...base,
          status: 'indeterminate',
          blocker: providerBlocker(rule, position, availability, issues),
        }
      }

      const provider = providersByName.get(rule.payload)!
      const noResolve = providerRuleHasNoResolve(rule, provider)
      let entryMatch: ProviderRuleSet['entries'][number] | null = null
      let indeterminateEntry: ProviderRuleSet['entries'][number] | null = null
      for (const entry of provider.entries) {
        const evaluation = evaluateRuleEntryTraffic(entry, search.query, { noResolve })
        if (evaluation === 'match') {
          entryMatch = entry
          break
        }
        if (evaluation === 'indeterminate' && !indeterminateEntry) indeterminateEntry = entry
      }

      if (!entryMatch) {
        if (indeterminateEntry) {
          return {
            ...base,
            status: 'indeterminate',
            blocker: evaluationBlocker(
              rule,
              position,
              'provider',
              rule.payload,
              normalizeRuleType(indeterminateEntry.type),
              indeterminateEntry.value,
            ),
          }
        }
        continue
      }

      const match = providerMatch(rule, position, entryMatch)

      return {
        ...base,
        status: 'resolved',
        effectiveMatch: match,
        effectiveRuleIndex: match.ruleIndex,
        otherMatches: withoutEffectiveMatch(search.matches, match),
        target: match.target,
        route: match.target ? resolveTargetRoute(match.target, options.resolveProxyChain) : null,
      }
    }

    const evaluation = evaluateRuleEntryTraffic(entryFromDirectRule(rule), search.query)
    if (evaluation === 'indeterminate') {
      return {
        ...base,
        status: 'indeterminate',
        blocker: evaluationBlocker(
          rule,
          position,
          'direct',
          null,
          normalizeRuleType(rule.type),
          rule.payload,
        ),
      }
    }
    if (evaluation === 'miss') continue

    const match = directMatch(rule, position)

    return {
      ...base,
      status: 'resolved',
      effectiveMatch: match,
      effectiveRuleIndex: match.ruleIndex,
      otherMatches: withoutEffectiveMatch(search.matches, match),
      target: match.target,
      route: match.target ? resolveTargetRoute(match.target, options.resolveProxyChain) : null,
    }
  }

  return { ...base, status: 'no-match' }
}
