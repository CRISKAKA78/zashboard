import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { resolveProxyChain } from '../../src/features/rule-intelligence/proxyChain.ts'
import type { ProxyChainMap } from '../../src/features/rule-intelligence/types.ts'

const chainMap = (links: Record<string, string>): ProxyChainMap =>
  Object.fromEntries(
    Object.entries(links).map(([name, now]) => [
      name,
      { name, now, ...(now ? { all: [now] } : {}) },
    ]),
  )

describe('resolveProxyChain', () => {
  it('resolves Group → Node', () => {
    const result = resolveProxyChain('Group', chainMap({ Group: 'Node', Node: '' }))

    assert.deepEqual(result, {
      path: ['Group', 'Node'],
      finalOutbound: 'Node',
      status: 'resolved',
    })
  })

  it('resolves Group → Group → Node', () => {
    const result = resolveProxyChain(
      'AI',
      chainMap({ AI: 'Overseas', Overseas: 'US Auto', 'US Auto': 'US-03', 'US-03': '' }),
    )

    assert.deepEqual(result.path, ['AI', 'Overseas', 'US Auto', 'US-03'])
    assert.equal(result.finalOutbound, 'US-03')
    assert.equal(result.status, 'resolved')
  })

  for (const outbound of ['DIRECT', 'REJECT']) {
    it(`resolves Group → ${outbound}`, () => {
      const result = resolveProxyChain('Group', chainMap({ Group: outbound, [outbound]: '' }))

      assert.deepEqual(result.path, ['Group', outbound])
      assert.equal(result.finalOutbound, outbound)
      assert.equal(result.status, 'resolved')
    })
  }

  it('detects A → B → A without looping forever', () => {
    const result = resolveProxyChain('A', chainMap({ A: 'B', B: 'A' }))

    assert.deepEqual(result, {
      path: ['A', 'B', 'A'],
      finalOutbound: 'A',
      status: 'cycle',
      cycleAt: 'A',
    })
  })
})
