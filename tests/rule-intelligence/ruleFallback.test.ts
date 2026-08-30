import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  findRuleFallback,
  isRuleEffectivelyDisabled,
} from '../../src/features/rule-intelligence/ruleFallback.ts'
import type { Rule } from '../../src/types/index.d.ts'

const rule = (overrides: Partial<Rule>): Rule => ({
  type: 'Domain',
  payload: 'example.com',
  proxy: 'Proxy',
  size: 1,
  uuid: '',
  index: 0,
  ...overrides,
})

describe('findRuleFallback', () => {
  it('finds MATCH → Proxy', () => {
    const fallback = findRuleFallback([rule({ type: 'MATCH', payload: '', proxy: 'Proxy' })])

    assert.equal(fallback?.type, 'MATCH')
    assert.equal(fallback?.position, 1)
    assert.equal(fallback?.rule.proxy, 'Proxy')
  })

  it('finds FINAL → DIRECT', () => {
    const fallback = findRuleFallback([rule({ type: 'Final', payload: '', proxy: 'DIRECT' })])

    assert.equal(fallback?.type, 'FINAL')
    assert.equal(fallback?.position, 1)
    assert.equal(fallback?.rule.proxy, 'DIRECT')
  })

  it('does not recognize a disabled MATCH', () => {
    const fallback = findRuleFallback([rule({ type: 'Match', payload: '', disabled: true })])

    assert.equal(fallback, null)
  })

  it('respects extra.disabled', () => {
    const disabledRule = rule({
      type: 'Match',
      payload: '',
      extra: {
        disabled: true,
        hitAt: '',
        hitCount: 0,
        missAt: '',
        missCount: 0,
      },
    })

    assert.equal(isRuleEffectivelyDisabled(disabledRule), true)
    assert.equal(findRuleFallback([disabledRule]), null)
  })

  it('chooses the first effective fallback in rule order', () => {
    const fallback = findRuleFallback([
      rule({ type: 'DomainSuffix' }),
      rule({ type: 'MATCH', payload: '', disabled: true }),
      rule({ type: 'FINAL', payload: '', proxy: 'DIRECT' }),
      rule({ type: 'MATCH', payload: '', proxy: 'Proxy' }),
    ])

    assert.equal(fallback?.type, 'FINAL')
    assert.equal(fallback?.position, 3)
    assert.equal(fallback?.rule.proxy, 'DIRECT')
  })
})
