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
