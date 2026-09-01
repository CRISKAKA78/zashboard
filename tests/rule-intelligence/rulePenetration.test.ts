import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { resolveProxyChain } from '../../src/features/rule-intelligence/proxyChain.ts'
import { resolveRulePenetration } from '../../src/features/rule-intelligence/rulePenetration.ts'
import type {
  ProviderRuleSet,
  ProxyChainMap,
  RuleEntry,
} from '../../src/features/rule-intelligence/types.ts'
import type { Rule } from '../../src/types/index.d.ts'

const rule = (overrides: Partial<Rule> = {}): Rule => ({
  type: 'DOMAIN',
  payload: 'example.com',
  proxy: 'DIRECT',
  size: 0,
  uuid: '',
  index: Number.NaN,
  ...overrides,
})

const entry = (type: string, value: string): RuleEntry => ({
  source: 'fixture',
  type,
  value,
  raw: `${type},${value}`,
})

const provider = (name: string, entries: RuleEntry[]): ProviderRuleSet => ({
  name,
  behavior: 'domain',
  format: 'mrs',
  entries,
})

const chainMap = (links: Record<string, string>): ProxyChainMap =>
  Object.fromEntries(
    Object.entries(links).map(([name, now]) => [
      name,
      { name, now, ...(now ? { all: [now] } : {}) },
    ]),
  )

const chainResolver = (links: Record<string, string>) => {
  const map = chainMap(links)
  const groups = new Set(Object.entries(links).flatMap(([name, now]) => (now ? [name] : [])))
  return (target: string) => resolveProxyChain(target, map, groups)
}

describe('resolveRulePenetration', () => {
  it('resolves Direct Rule → DIRECT', () => {
    const result = resolveRulePenetration('example.com', [rule()])

    assert.equal(result.status, 'resolved')
    assert.equal(result.effectiveMatch?.source, 'direct')
    assert.equal(result.effectiveRuleIndex, 1)
    assert.equal(result.target, 'DIRECT')
    assert.deepEqual(result.route, {
      path: ['DIRECT'],
      finalOutbound: 'DIRECT',
      status: 'resolved',
    })
  })

  it('resolves Direct Rule → Proxy Group', () => {
    const result = resolveRulePenetration('example.com', [rule({ proxy: 'Proxy' })], [], {
      resolveProxyChain: chainResolver({ Proxy: 'Node', Node: '' }),
    })

    assert.deepEqual(result.route?.path, ['Proxy', 'Node'])
    assert.equal(result.route?.finalOutbound, 'Node')
  })

  it('resolves RuleSet → Group → Node', () => {
    const result = resolveRulePenetration(
      'chatgpt.com',
      [rule({ type: 'RuleSet', payload: 'OpenAI', proxy: 'AI' })],
      [provider('OpenAI', [entry('DOMAIN-SUFFIX', 'chatgpt.com')])],
      { resolveProxyChain: chainResolver({ AI: 'US-03', 'US-03': '' }) },
    )

    assert.equal(result.status, 'resolved')
    assert.equal(result.effectiveMatch?.providerName, 'OpenAI')
    assert.equal(result.effectiveMatch?.entry?.type, 'DOMAIN-SUFFIX')
    assert.deepEqual(result.route?.path, ['AI', 'US-03'])
  })

  it('resolves a Controller RuleSet through DOMAIN-WILDCARD', () => {
    const result = resolveRulePenetration(
      'ag.hga030.com',
      [rule({ type: 'RuleSet', payload: 'Custom Proxy', proxy: '自定义代理' })],
      [provider('Custom Proxy', [entry('DOMAIN-WILDCARD', 'ag.hga*.com')])],
    )

    assert.equal(result.status, 'resolved')
    assert.equal(result.effectiveMatch?.entry?.type, 'DOMAIN-WILDCARD')
    assert.equal(result.target, '自定义代理')
  })

  it('resolves DOMAIN-REGEX and IP-SUFFIX provider rules', () => {
    const domain = resolveRulePenetration(
      'api.example.com',
      [rule({ type: 'RULE-SET', payload: 'Regex', proxy: 'Proxy' })],
      [provider('Regex', [entry('DOMAIN-REGEX', '^api\\.example\\.com$')])],
    )
    const ip = resolveRulePenetration(
      '1.8.8.8',
      [rule({ type: 'RULE-SET', payload: 'Suffix', proxy: 'Proxy' })],
      [provider('Suffix', [entry('IP-SUFFIX', '8.8.8.8/24')])],
    )

    assert.equal(domain.status, 'resolved')
    assert.equal(ip.status, 'resolved')
  })

  it('resolves RuleSet → Group → Group → Node', () => {
    const result = resolveRulePenetration(
      'chatgpt.com',
      [rule({ type: 'RULE-SET', payload: 'OpenAI', proxy: 'AI' })],
      [provider('OpenAI', [entry('DOMAIN', 'chatgpt.com')])],
      {
        resolveProxyChain: chainResolver({
          AI: 'Overseas',
          Overseas: 'US-Auto',
          'US-Auto': 'US-03',
          'US-03': '',
        }),
      },
    )

    assert.deepEqual(result.route?.path, ['AI', 'Overseas', 'US-Auto', 'US-03'])
    assert.equal(result.route?.finalOutbound, 'US-03')
  })

  it('uses MATCH when no specific rule matches', () => {
    const result = resolveRulePenetration('unknown.xyz', [
      rule({ payload: 'example.com' }),
      rule({ type: 'MATCH', payload: '', proxy: 'Proxy' }),
    ])

    assert.equal(result.status, 'fallback')
    assert.equal(result.effectiveFallback?.type, 'MATCH')
    assert.equal(result.effectiveRuleIndex, 2)
    assert.equal(result.target, 'Proxy')
  })

  it('selects the first /rules match and retains later theoretical matches', () => {
    const result = resolveRulePenetration(
      'chatgpt.com',
      [
        rule({ type: 'DOMAIN', payload: 'chatgpt.com', proxy: 'DIRECT' }),
        rule({ type: 'RULE-SET', payload: 'OpenAI', proxy: 'AI' }),
        rule({ type: 'RULE-SET', payload: 'Global', proxy: 'Proxy' }),
      ],
      [
        provider('OpenAI', [entry('DOMAIN-SUFFIX', 'chatgpt.com')]),
        provider('Global', [entry('DOMAIN-KEYWORD', 'chatgpt')]),
      ],
    )

    assert.equal(result.effectiveMatch?.source, 'direct')
    assert.equal(result.effectiveRuleIndex, 1)
    assert.deepEqual(
      result.otherMatches.map((match) => match.rulePosition),
      [2, 3],
    )
  })

  for (const outbound of ['REJECT', 'REJECT-DROP', 'PASS']) {
    it(`treats ${outbound} as a terminal outbound`, () => {
      const result = resolveRulePenetration('example.com', [rule({ proxy: outbound })])

      assert.equal(result.route?.status, 'resolved')
      assert.equal(result.route?.finalOutbound, outbound)
    })
  }

  it('reports a circular Proxy Group without looping', () => {
    const result = resolveRulePenetration('example.com', [rule({ proxy: 'A' })], [], {
      resolveProxyChain: chainResolver({ A: 'B', B: 'A' }),
    })

    assert.equal(result.route?.status, 'cycle')
    assert.deepEqual(result.route?.path, ['A', 'B', 'A'])
  })

  it('does not guess past a missing Provider', () => {
    const result = resolveRulePenetration('example.com', [
      rule({ type: 'RULE-SET', payload: 'Missing', proxy: 'Proxy' }),
      rule({ type: 'DOMAIN', payload: 'example.com', proxy: 'DIRECT' }),
    ])

    assert.equal(result.status, 'indeterminate')
    assert.equal(result.effectiveMatch, null)
    assert.equal(result.blocker?.providerName, 'Missing')
    assert.equal(result.blocker?.code, 'PROVIDER_MISSING')
  })

  it('surfaces a Provider parse failure as an ordering blocker', () => {
    const result = resolveRulePenetration(
      'example.com',
      [
        rule({ type: 'RULE-SET', payload: 'Broken', proxy: 'Proxy' }),
        rule({ type: 'MATCH', payload: '', proxy: 'DIRECT' }),
      ],
      [],
      {
        providerIssues: [
          { provider: 'Broken', code: 'MRS_CONVERSION_FAILED', message: 'Damaged MRS.' },
        ],
      },
    )

    assert.equal(result.status, 'indeterminate')
    assert.equal(result.blocker?.code, 'MRS_CONVERSION_FAILED')
    assert.equal(result.blocker?.message, 'Damaged MRS.')
  })

  it('degrades conservatively when Local Helper is offline', () => {
    const result = resolveRulePenetration(
      'example.com',
      [
        rule({ type: 'RULE-SET', payload: 'OpenAI', proxy: 'AI' }),
        rule({ type: 'DOMAIN', payload: 'example.com', proxy: 'DIRECT' }),
      ],
      [],
      { providerAvailability: 'offline' },
    )

    assert.equal(result.status, 'indeterminate')
    assert.equal(result.blocker?.code, 'HELPER_OFFLINE')
  })

  it('does not guess past a direct rule that requires unavailable context', () => {
    const result = resolveRulePenetration('example.com', [
      rule({ type: 'GEOSITE', payload: 'google', proxy: 'Proxy' }),
      rule({ type: 'DOMAIN', payload: 'example.com', proxy: 'DIRECT' }),
    ])

    assert.equal(result.status, 'indeterminate')
    assert.equal(result.blocker?.source, 'direct')
    assert.equal(result.blocker?.ruleType, 'GEOSITE')
    assert.equal(result.blocker?.code, 'RULE_CONTEXT_REQUIRED')
  })

  it('does not guess past an indeterminate entry in an otherwise available Provider', () => {
    const result = resolveRulePenetration(
      'example.com',
      [
        rule({ type: 'RULE-SET', payload: 'Geo', proxy: 'Proxy' }),
        rule({ type: 'DOMAIN', payload: 'example.com', proxy: 'DIRECT' }),
      ],
      [provider('Geo', [entry('GEOSITE', 'google')])],
    )

    assert.equal(result.status, 'indeterminate')
    assert.equal(result.blocker?.source, 'provider')
    assert.equal(result.blocker?.ruleType, 'GEOSITE')
  })

  it('still resolves a known Provider match when another entry is indeterminate', () => {
    const result = resolveRulePenetration(
      'example.com',
      [rule({ type: 'RULE-SET', payload: 'Mixed', proxy: 'Proxy' })],
      [provider('Mixed', [entry('GEOSITE', 'google'), entry('DOMAIN', 'example.com')])],
    )

    assert.equal(result.status, 'resolved')
    assert.equal(result.effectiveMatch?.entry?.type, 'DOMAIN')
  })

  it('skips a no-resolve IP Provider and reaches a later domain Provider', () => {
    const telegramIp = provider('Telegram / IP', [entry('IP-CIDR', '149.154.160.0/20')])
    telegramIp.behavior = 'ipcidr'
    telegramIp.ruleReferences = [{ target: 'Telegram', noResolve: true }]

    const result = resolveRulePenetration(
      'accounts.binance.com',
      [
        rule({
          type: 'RULE-SET',
          payload: 'Telegram / IP',
          proxy: 'Telegram',
          index: 18,
        }),
        rule({
          type: 'RULE-SET',
          payload: 'Binance / Domain',
          proxy: 'Crypto',
          index: 55,
        }),
      ],
      [telegramIp, provider('Binance / Domain', [entry('DOMAIN-SUFFIX', 'binance.com')])],
    )

    assert.equal(result.status, 'resolved')
    assert.equal(result.effectiveRuleIndex, 55)
    assert.equal(result.effectiveMatch?.providerName, 'Binance / Domain')
    assert.equal(result.target, 'Crypto')
  })

  it('keeps an IP Provider indeterminate when its RULE-SET may resolve DNS', () => {
    const telegramIp = provider('Telegram / IP', [entry('IP-CIDR', '149.154.160.0/20')])
    telegramIp.behavior = 'ipcidr'
    telegramIp.ruleReferences = [{ target: 'Telegram', noResolve: false }]

    const result = resolveRulePenetration(
      'accounts.binance.com',
      [
        rule({ type: 'RULE-SET', payload: 'Telegram / IP', proxy: 'Telegram' }),
        rule({ type: 'DOMAIN-SUFFIX', payload: 'binance.com', proxy: 'Crypto' }),
      ],
      [telegramIp],
    )

    assert.equal(result.status, 'indeterminate')
    assert.equal(result.blocker?.ruleType, 'IP-CIDR')
  })

  it('does not label keyword content search as an effective match', () => {
    const result = resolveRulePenetration('openai', [
      rule({ type: 'DOMAIN-SUFFIX', payload: 'openai.com', proxy: 'AI' }),
    ])

    assert.equal(result.status, 'keyword')
    assert.equal(result.search.matches.length, 1)
    assert.equal(result.effectiveMatch, null)
    assert.equal(result.route, null)
  })
})
