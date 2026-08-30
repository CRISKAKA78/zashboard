import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { describe, it } from 'node:test'
import {
  createRuleProviderPage,
  getRuleEntryFamily,
  getRuleEntryParams,
  hasRuleProviderExplorerQuery,
} from '../src/providerExplorer.mjs'

const entry = (index, type = 'DOMAIN') => ({
  source: 'Test',
  type,
  value: `value-${String(index).padStart(6, '0')}.example`,
  raw: `${type},value-${String(index).padStart(6, '0')}.example${index % 2 ? ',no-resolve' : ''}`,
  line: index + 1,
  behavior: 'classical',
  format: 'text',
})

const result = (entries) => ({
  provider: { name: 'Test', behavior: 'classical', format: 'text' },
  entries,
  cache: 'hit',
})

describe('Rule Provider Explorer projection', () => {
  it('uses the documented domain/IP families and keeps params separate from raw', () => {
    for (const type of ['DOMAIN', 'DOMAIN-SUFFIX', 'DOMAIN-KEYWORD']) {
      assert.equal(getRuleEntryFamily(entry(1, type)), 'domain')
    }
    for (const type of ['IP-CIDR', 'IP-CIDR6', 'SRC-IP', 'SRC-IP-CIDR', 'SRC-IP-CIDR6', 'GEOIP']) {
      assert.equal(getRuleEntryFamily(entry(1, type)), 'ip')
    }
    assert.equal(getRuleEntryFamily(entry(1, 'PROCESS-NAME')), 'other')
    assert.deepEqual(getRuleEntryParams(entry(1, 'IP-CIDR')), ['no-resolve'])
    assert.deepEqual(
      getRuleEntryParams({ ...entry(1), type: 'DOMAIN-SUFFIX', raw: '+.example.com' }),
      [],
    )
  })

  it('paginates 250 entries as 100, 100, and 50 while preserving source order', () => {
    const entries = Array.from({ length: 250 }, (_, index) => entry(index))
    const pages = [1, 2, 3].map((page) =>
      createRuleProviderPage(result(entries), { page, pageSize: 100 }),
    )

    assert.deepEqual(
      pages.map((page) => page.items.length),
      [100, 100, 50],
    )
    assert.deepEqual(
      pages.map((page) => page.items[0].index),
      [1, 101, 201],
    )
    assert.deepEqual(
      pages.map((page) => page.hasMore),
      [true, true, false],
    )
  })

  it('filters content fields, reports global family counts, and sorts stably', () => {
    const entries = [
      { ...entry(0, 'DOMAIN-SUFFIX'), value: 'z.example', raw: 'DOMAIN-SUFFIX,z.example' },
      { ...entry(1, 'IP-CIDR'), value: '8.8.8.0/24', raw: 'IP-CIDR,8.8.8.0/24,no-resolve' },
      { ...entry(2, 'DOMAIN'), value: 'a.example', raw: 'DOMAIN,a.example,tagged' },
      { ...entry(3, 'PROCESS-NAME'), value: 'Browser', raw: 'PROCESS-NAME,Browser' },
    ]
    const filtered = createRuleProviderPage(result(entries), {
      family: 'domain',
      search: 'tagged',
    })
    const sorted = createRuleProviderPage(result(entries), {
      sortKey: 'content',
      sortDirection: 'asc',
    })

    assert.deepEqual(filtered.counts, { all: 4, domain: 2, ip: 1, other: 1 })
    assert.equal(filtered.matched, 1)
    assert.equal(filtered.items[0].value, 'a.example')
    for (const [search, expected] of [
      ['process-name', 'Browser'],
      ['8.8.8.0/24', '8.8.8.0/24'],
      ['no-resolve', '8.8.8.0/24'],
      ['domain-suffix,z.example', 'z.example'],
    ]) {
      const searched = createRuleProviderPage(result(entries), { search })
      assert.equal(searched.items[0].value, expected)
    }
    assert.deepEqual(
      sorted.items.map((item) => item.value),
      ['8.8.8.0/24', 'a.example', 'Browser', 'z.example'],
    )
  })

  it('projects 100,000 entries without returning the entire dataset', () => {
    const entries = Array.from({ length: 100_000 }, (_, index) => entry(index))
    const startedAt = performance.now()
    const page = createRuleProviderPage(result(entries), { page: 500, pageSize: 100 })
    const elapsed = performance.now() - startedAt

    assert.equal(page.total, 100_000)
    assert.equal(page.items.length, 100)
    assert.equal(page.items[0].index, 49_901)
    assert.ok(elapsed < 2_000, `100k projection took ${elapsed.toFixed(0)}ms`)
  })

  it('rejects invalid paging and sorting values', () => {
    assert.throws(
      () => createRuleProviderPage(result([]), { pageSize: 501 }),
      (error) => error.code === 'RULE_PROVIDER_QUERY_INVALID' && error.status === 400,
    )
    assert.throws(
      () => createRuleProviderPage(result([]), { sortDirection: 'asc' }),
      (error) => error.code === 'RULE_PROVIDER_QUERY_INVALID',
    )
  })

  it('only switches the compatible endpoint to Explorer shape for recognized query keys', () => {
    assert.equal(hasRuleProviderExplorerQuery(new URLSearchParams('cacheBust=1')), false)
    assert.equal(hasRuleProviderExplorerQuery(new URLSearchParams('page=1')), true)
  })
})
