import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  applyCustomRulesUpdate,
  CustomRulesApplyError,
  type CustomRulesState,
} from '../../src/features/rule-intelligence/customRules.ts'

const savedState = (): CustomRulesState => ({
  version: 'new-version',
  sourceConfigPath: '/etc/mihomo/config.yaml',
  runtimeConfigPath: '/etc/mihomo/custom/runtime-config.yaml',
  backups: [],
  backupId: 'backup-1',
  pre: [],
  post: [],
})

describe('custom rules reload orchestration', () => {
  it('reloads through the existing client and refreshes Rule Intelligence', async () => {
    const calls: string[] = []
    const result = await applyCustomRulesUpdate(async () => savedState(), {
      reload: async (path) => calls.push(`reload:${path}`),
      rollback: async () => calls.push('rollback'),
      refresh: async () => calls.push('refresh'),
    })

    assert.equal(result.version, 'new-version')
    assert.deepEqual(calls, ['reload:/etc/mihomo/custom/runtime-config.yaml', 'refresh'])
  })

  it('rolls managed files back when Mihomo reload fails', async () => {
    const calls: unknown[] = []
    let reloadAttempts = 0

    await assert.rejects(
      () =>
        applyCustomRulesUpdate(async () => savedState(), {
          reload: async (path) => {
            reloadAttempts += 1
            calls.push(`reload:${path}`)
            if (reloadAttempts === 1) throw new Error('reload failed')
          },
          rollback: async (input) => calls.push(input),
          refresh: async () => calls.push('refresh'),
        }),
      (error) =>
        error instanceof CustomRulesApplyError && error.code === 'CUSTOM_RULES_RELOAD_FAILED',
    )
    assert.deepEqual(calls, [
      'reload:/etc/mihomo/custom/runtime-config.yaml',
      { expectedVersion: 'new-version', backupId: 'backup-1' },
      'reload:/etc/mihomo/custom/runtime-config.yaml',
    ])
  })

  it('reports a distinct error when rollback also fails', async () => {
    await assert.rejects(
      () =>
        applyCustomRulesUpdate(async () => savedState(), {
          reload: async () => {
            throw new Error('reload failed')
          },
          rollback: async () => {
            throw new Error('rollback failed')
          },
          refresh: async () => {},
        }),
      (error) =>
        error instanceof CustomRulesApplyError && error.code === 'CUSTOM_RULES_ROLLBACK_FAILED',
    )
  })

  it('reports a distinct error when the restored configuration cannot be reloaded', async () => {
    let rollbackCalled = false
    await assert.rejects(
      () =>
        applyCustomRulesUpdate(async () => savedState(), {
          reload: async () => {
            throw new Error('reload failed')
          },
          rollback: async () => {
            rollbackCalled = true
          },
          refresh: async () => {},
        }),
      (error) =>
        error instanceof CustomRulesApplyError && error.code === 'CUSTOM_RULES_ROLLBACK_FAILED',
    )
    assert.equal(rollbackCalled, true)
  })
})
