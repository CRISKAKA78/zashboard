import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  applyLocalProviderUpdate,
  LocalProviderApplyError,
} from '../../src/features/rule-intelligence/localProviderRules.ts'

const saved = {
  provider: {
    name: 'Custom Proxy',
    type: 'file',
    behavior: 'classical',
    format: 'text',
    configuredPath: './rules/custom-proxy.list',
    path: '/rules/custom-proxy.list',
    pathAccess: 'allowed' as const,
    exists: true,
    size: 10,
    mtime: '2026-08-31T00:00:00.000Z',
    url: null,
    interval: null,
    editable: true,
    error: null,
  },
  entries: [],
  version: 'saved-version',
  backupId: 'backup-1',
}

describe('local Rule Provider update orchestration', () => {
  it('reloads the edited Provider and refreshes Rule Intelligence', async () => {
    const calls: string[] = []
    const result = await applyLocalProviderUpdate('Custom Proxy', async () => saved, {
      reload: async (name) => calls.push(`reload:${name}`),
      rollback: async () => {
        throw new Error('not expected')
      },
      refresh: async () => calls.push('refresh'),
    })

    assert.equal(result, saved)
    assert.deepEqual(calls, ['reload:Custom Proxy', 'refresh'])
  })

  it('restores the previous Provider when Mihomo reload fails', async () => {
    const calls: string[] = []
    let reloads = 0

    await assert.rejects(
      applyLocalProviderUpdate('Custom Proxy', async () => saved, {
        reload: async () => {
          reloads += 1
          calls.push(`reload:${reloads}`)
          if (reloads === 1) throw new Error('reload failed')
        },
        rollback: async (name, input) => {
          calls.push(`rollback:${name}:${input.expectedVersion}:${input.backupId}`)
          return {
            provider: saved.provider,
            entries: saved.entries,
            version: 'restored-version',
          }
        },
        refresh: async () => calls.push('refresh'),
      }),
      (error) => error instanceof LocalProviderApplyError && error.stage === 'reload-restored',
    )

    assert.deepEqual(calls, [
      'reload:1',
      'rollback:Custom Proxy:saved-version:backup-1',
      'reload:2',
    ])
  })

  it('does not roll back a valid Provider when only the Rule Intelligence refresh fails', async () => {
    let rollbackCalled = false

    await assert.rejects(
      applyLocalProviderUpdate('Custom Proxy', async () => saved, {
        reload: async () => {},
        rollback: async () => {
          rollbackCalled = true
          throw new Error('not expected')
        },
        refresh: async () => {
          throw new Error('refresh failed')
        },
      }),
      /refresh failed/u,
    )

    assert.equal(rollbackCalled, false)
  })

  it('reports a distinct rollback failure', async () => {
    await assert.rejects(
      applyLocalProviderUpdate('Custom Direct', async () => saved, {
        reload: async () => {
          throw new Error('reload failed')
        },
        rollback: async () => {
          throw new Error('rollback failed')
        },
        refresh: async () => {},
      }),
      (error) => error instanceof LocalProviderApplyError && error.stage === 'rollback',
    )
  })
})
