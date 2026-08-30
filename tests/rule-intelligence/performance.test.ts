import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { it } from 'node:test'
import { resolveRulePenetration } from '../../src/features/rule-intelligence/rulePenetration.ts'
import { searchRuleIntelligence } from '../../src/features/rule-intelligence/ruleQuery.ts'
import type { Rule } from '../../src/types/index.d.ts'

const rule = (index: number): Rule => ({
  type: 'DOMAIN',
  payload: index === 9_999 ? 'target.example' : `host-${index}.example`,
  proxy: 'DIRECT',
  size: 0,
  uuid: String(index),
  index: index + 1,
})

it('searches and penetrates 10,000 direct rules within the interactive budget', (t) => {
  const rules = Array.from({ length: 10_000 }, (_, index) => rule(index))
  rules.push({ ...rule(10_000), type: 'MATCH', payload: '', index: 10_001 })

  const searchStarted = performance.now()
  const search = searchRuleIntelligence('target.example', rules)
  const searchMs = performance.now() - searchStarted

  const penetrationStarted = performance.now()
  const penetration = resolveRulePenetration('target.example', rules)
  const penetrationMs = performance.now() - penetrationStarted

  assert.equal(search.directMatches.length, 1)
  assert.equal(penetration.status, 'resolved')
  assert.ok(searchMs < 2_000, `search took ${searchMs.toFixed(2)} ms`)
  assert.ok(penetrationMs < 2_000, `penetration took ${penetrationMs.toFixed(2)} ms`)
  t.diagnostic(
    `10k rules: search=${searchMs.toFixed(2)}ms, penetration=${penetrationMs.toFixed(2)}ms`,
  )
})
