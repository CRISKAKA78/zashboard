import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { isIpInCidr } from '../../src/features/rule-intelligence/ip.ts'
import {
  classifyRuleQuery,
  doesRuleEntryMatchTraffic,
  searchRuleIntelligence,
} from '../../src/features/rule-intelligence/ruleQuery.ts'
import type { ProviderRuleSet, RuleEntry } from '../../src/features/rule-intelligence/types.ts'
import type { Rule } from '../../src/types/index.d.ts'

const entry = (type: string, value: string): RuleEntry => ({
  source: 'test',
  type,
  value,
  raw: `${type},${value}`,
})

const rule = (overrides: Partial<Rule> = {}): Rule => ({
  type: 'DOMAIN',
  payload: 'example.com',
  proxy: 'DIRECT',
  size: 0,
  uuid: '',
  index: 0,
  ...overrides,
})

describe('rule query matching', () => {
  it('distinguishes DOMAIN exact matching from subdomains', () => {
    const domainRule = entry('DOMAIN', 'google.com')

    assert.equal(doesRuleEntryMatchTraffic(domainRule, classifyRuleQuery('google.com')), true)
    assert.equal(doesRuleEntryMatchTraffic(domainRule, classifyRuleQuery('www.google.com')), false)
  })

  it('matches DOMAIN-SUFFIX on label boundaries', () => {
    const suffixRule = entry('DOMAIN-SUFFIX', 'google.com')

    for (const query of ['google.com', 'www.google.com', 'mail.google.com']) {
      assert.equal(doesRuleEntryMatchTraffic(suffixRule, classifyRuleQuery(query)), true)
    }
    assert.equal(doesRuleEntryMatchTraffic(suffixRule, classifyRuleQuery('notgoogle.com')), false)
  })

  it('matches DOMAIN-KEYWORD against a domain', () => {
    const keywordRule = entry('DOMAIN-KEYWORD', 'google')

    assert.equal(
      doesRuleEntryMatchTraffic(keywordRule, classifyRuleQuery('mail.google.example')),
      true,
    )
    assert.equal(doesRuleEntryMatchTraffic(keywordRule, classifyRuleQuery('example.com')), false)
  })

  it('performs real IPv4 CIDR containment', () => {
    assert.equal(isIpInCidr('8.8.8.8', '8.8.8.0/24'), true)
    assert.equal(isIpInCidr('8.8.9.8', '8.8.8.0/24'), false)
    assert.equal(isIpInCidr('8.8.8.8', '8.8.8.8/32'), true)
  })

  it('performs real IPv6 CIDR containment', () => {
    assert.equal(isIpInCidr('2001:db8::1234', '2001:db8::/32'), true)
    assert.equal(isIpInCidr('2001:db9::1', '2001:db8::/32'), false)
    assert.equal(isIpInCidr('::ffff:192.0.2.128', '::ffff:192.0.2.0/120'), true)
  })

  it('marks a keyword query as content search rather than a traffic match', () => {
    const result = searchRuleIntelligence('openai', [
      rule({ type: 'DomainSuffix', payload: 'openai.com', index: 3 }),
    ])

    assert.equal(result.query.kind, 'keyword')
    assert.equal(result.directMatches[0].matchMode, 'content')
  })

  it('keeps direct rules and providers aligned with real /rules order', () => {
    const providers: ProviderRuleSet[] = [
      {
        name: 'OpenAI',
        behavior: 'domain',
        format: 'yaml',
        entries: [entry('DOMAIN-SUFFIX', 'chatgpt.com')],
      },
    ]
    const result = searchRuleIntelligence(
      'chatgpt.com',
      [
        rule({ type: 'RuleSet', payload: 'OpenAI', proxy: 'AI', index: 10 }),
        rule({ type: 'DOMAIN', payload: 'chatgpt.com', proxy: 'DIRECT', index: 20 }),
      ],
      providers,
    )

    assert.equal(result.providerMatches[0].ruleIndex, 10)
    assert.equal(result.providerMatches[0].target, 'AI')
    assert.equal(result.directMatches[0].ruleIndex, 20)
    assert.equal(result.directMatches[0].target, 'DIRECT')
    assert.deepEqual(
      result.matches.map((match) => match.ruleIndex),
      [10, 20],
    )
  })
})
