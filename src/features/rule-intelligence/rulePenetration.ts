import type { Rule } from '@/types'
import { findRuleFallback, isRuleEffectivelyDisabled } from './ruleFallback.ts'
import { getDisplayRuleIndex, normalizeRuleType, searchRuleIntelligence } from './ruleQuery.ts'
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

const matchesAtPosition = (
  matches: readonly RuleIntelligenceMatch[],
  position: number,
  source: RuleIntelligenceMatch['source'],
) =>
  matches.find(
    (match) =>
      match.matchMode === 'traffic' && match.rulePosition === position && match.source === source,
  )

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
    providerName: rule.payload,
    ruleIndex: getDisplayRuleIndex(rule, position - 1),
    rulePosition: position,
    target: rule.proxy,
    code: issue?.code || availabilityIssue.code,
    message: issue?.message || availabilityIssue.message,
  }
}

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

      const match = matchesAtPosition(search.matches, position, 'provider')
      if (!match) continue

      return {
        ...base,
        status: 'resolved',
        effectiveMatch: match,
        effectiveRuleIndex: match.ruleIndex,
        otherMatches: search.matches.filter((candidate) => candidate !== match),
        target: match.target,
        route: match.target ? resolveTargetRoute(match.target, options.resolveProxyChain) : null,
      }
    }

    const match = matchesAtPosition(search.matches, position, 'direct')
    if (!match) continue

    return {
      ...base,
      status: 'resolved',
      effectiveMatch: match,
      effectiveRuleIndex: match.ruleIndex,
      otherMatches: search.matches.filter((candidate) => candidate !== match),
      target: match.target,
      route: match.target ? resolveTargetRoute(match.target, options.resolveProxyChain) : null,
    }
  }

  return { ...base, status: 'no-match' }
}
