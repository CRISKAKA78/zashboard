import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  nextRuleProviderSort,
  RULE_PROVIDER_EXPLORER_PAGE_SIZE,
} from '../../src/features/rule-intelligence/ruleProviderExplorer.ts'

describe('Rule Provider Explorer UI state', () => {
  it('uses the bounded 100-row Explorer page', () => {
    assert.equal(RULE_PROVIDER_EXPLORER_PAGE_SIZE, 100)
  })

  it('cycles each sortable column through ascending, descending, and source order', () => {
    const ascending = nextRuleProviderSort({ key: null, direction: 'default' }, 'content')
    const descending = nextRuleProviderSort(ascending, 'content')
    const sourceOrder = nextRuleProviderSort(descending, 'content')
    const anotherColumn = nextRuleProviderSort(descending, 'type')

    assert.deepEqual(ascending, { key: 'content', direction: 'asc' })
    assert.deepEqual(descending, { key: 'content', direction: 'desc' })
    assert.deepEqual(sourceOrder, { key: null, direction: 'default' })
    assert.deepEqual(anotherColumn, { key: 'type', direction: 'asc' })
  })
})
