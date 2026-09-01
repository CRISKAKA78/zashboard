import type { Rule } from '@/types'

export type ProxyChainStatus = 'resolved' | 'cycle' | 'missing'

export type ProxyChainNode = {
  name: string
  now?: string
  all?: string[]
}

export type ProxyChainMap = Readonly<Record<string, ProxyChainNode | undefined>>

export type ProxyChainAnalysis = {
  path: string[]
  finalOutbound: string
  status: ProxyChainStatus
  cycleAt?: string
  missingAt?: string
}

export type RuleFallbackType = 'MATCH' | 'FINAL'

export type RuleFallback = {
  rule: Rule
  type: RuleFallbackType
  position: number
}

export type RuleEntry = {
  source: string
  type: string
  value: string
  raw: string
  line?: number
  behavior?: string
  format?: string
}

export type RuleQueryKind = 'domain' | 'ip' | 'keyword'

export type RuleQuery = {
  raw: string
  normalized: string
  kind: RuleQueryKind
}

export type RuleTrafficEvaluation = 'match' | 'miss' | 'indeterminate'

export type ProviderRuleSet = {
  name: string
  behavior: string | null
  format: string | null
  entries: RuleEntry[]
  ruleReferences?: Array<{
    target: string
    noResolve: boolean
  }>
}

export type RuleIntelligenceMatch = {
  source: 'direct' | 'provider'
  matchMode: 'traffic' | 'content' | 'provider-name'
  entry: RuleEntry | null
  providerName: string | null
  ruleIndex: number | null
  rulePosition: number | null
  target: string | null
}

export type RuleIntelligenceResult = {
  query: RuleQuery
  matches: RuleIntelligenceMatch[]
  directMatches: RuleIntelligenceMatch[]
  providerMatches: RuleIntelligenceMatch[]
  truncated: boolean
}

export type RuleProviderAvailability = 'ready' | 'loading' | 'offline' | 'error'

export type RuleProviderIssue = {
  provider: string
  code?: string
  message: string
}

export type RulePenetrationStatus =
  'empty' | 'keyword' | 'resolved' | 'fallback' | 'indeterminate' | 'no-match'

export type RulePenetrationBlocker = {
  source: 'direct' | 'provider'
  providerName: string | null
  ruleType: string
  ruleValue: string
  ruleIndex: number
  rulePosition: number
  target: string
  code: string
  message: string
}

export type RulePenetrationResult = {
  status: RulePenetrationStatus
  search: RuleIntelligenceResult
  effectiveMatch: RuleIntelligenceMatch | null
  effectiveFallback: RuleFallback | null
  effectiveRuleIndex: number | null
  otherMatches: RuleIntelligenceMatch[]
  target: string | null
  route: ProxyChainAnalysis | null
  blocker: RulePenetrationBlocker | null
}
