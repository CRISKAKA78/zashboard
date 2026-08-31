import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { reactive } from 'vue'
import {
  applyCustomRulesUpdate,
  cloneCustomRule,
  cloneCustomRulesDraft,
  CustomRulesApplyError,
  type CustomRulesDraft,
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
  fakeIpFilter: [],
})

describe('custom rules transport cloning', () => {
  it('normalizes Vue reactive drafts into structured-clone-safe plain data', () => {
    const reactiveDraft = reactive<CustomRulesDraft>({
      pre: [
        {
          id: 'rule-1',
          mode: 'structured',
          type: 'DOMAIN-WILDCARD',
          value: '*.criskaka.com',
          target: 'DIRECT',
          params: ['no-resolve'],
          raw: 'DOMAIN-WILDCARD,*.criskaka.com,DIRECT,no-resolve',
        },
      ],
      post: [],
      fakeIpFilter: ['*.criskaka.com'],
    })

    assert.throws(() => structuredClone(reactiveDraft.pre), /could not be cloned/i)

    const clone = cloneCustomRulesDraft(reactiveDraft)
    assert.doesNotThrow(() => structuredClone(clone))
    assert.deepEqual(clone, {
      pre: [
        {
          id: 'rule-1',
          mode: 'structured',
          type: 'DOMAIN-WILDCARD',
          value: '*.criskaka.com',
          target: 'DIRECT',
          params: ['no-resolve'],
          raw: 'DOMAIN-WILDCARD,*.criskaka.com,DIRECT,no-resolve',
        },
      ],
      post: [],
      fakeIpFilter: ['*.criskaka.com'],
    })
    assert.notEqual(clone.pre[0], reactiveDraft.pre[0])
    assert.notEqual(clone.pre[0].params, reactiveDraft.pre[0].params)
  })

  it('clones a reactive rule edited in the Custom Rules panel', () => {
    const rule = reactive({
      id: 'rule-2',
      mode: 'structured' as const,
      type: 'DOMAIN' as const,
      value: 'example.com',
      target: 'DIRECT',
      params: [],
      raw: 'DOMAIN,example.com,DIRECT',
    })

    const clone = cloneCustomRule(rule)
    assert.doesNotThrow(() => structuredClone(clone))
    assert.deepEqual(clone, { ...rule, params: [] })
  })
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
