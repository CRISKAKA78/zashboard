export const CUSTOM_RULE_TYPES = [
  'DOMAIN',
  'DOMAIN-SUFFIX',
  'DOMAIN-KEYWORD',
  'IP-CIDR',
  'IP-CIDR6',
  'RULE-SET',
  'GEOIP',
  'MATCH',
] as const

export type CustomRuleType = (typeof CUSTOM_RULE_TYPES)[number]
export type CustomRuleMode = 'structured' | 'raw'

export type CustomRule = {
  id: string
  mode: CustomRuleMode
  type: CustomRuleType
  value: string
  target: string
  params: string[]
  raw: string
}

export type CustomRulesDraft = {
  pre: CustomRule[]
  post: CustomRule[]
}

export type CustomRulesBackup = {
  id: string
  createdAt: string
}

export type CustomRulesState = CustomRulesDraft & {
  version: string
  sourceConfigPath: string
  runtimeConfigPath: string
  backups: CustomRulesBackup[]
  backupId?: string
}

export type CustomRulesValidation = {
  valid: true
  preCount: number
  postCount: number
  runtimeConfigPath: string
}

export type CustomRulesSaveInput = CustomRulesDraft & {
  expectedVersion: string
}

export type CustomRulesRestoreInput = {
  expectedVersion: string
  backupId: string
}

export class CustomRulesApplyError extends Error {
  readonly code: 'CUSTOM_RULES_RELOAD_FAILED' | 'CUSTOM_RULES_ROLLBACK_FAILED'

  constructor(
    code: 'CUSTOM_RULES_RELOAD_FAILED' | 'CUSTOM_RULES_ROLLBACK_FAILED',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'CustomRulesApplyError'
    this.code = code
  }
}

export const createCustomRule = (target = 'DIRECT'): CustomRule => ({
  id: uuidv4(),
  mode: 'structured',
  type: 'DOMAIN',
  value: '',
  target,
  params: [],
  raw: '',
})

export type CustomRulesUpdateDependencies = {
  reload: (runtimeConfigPath: string) => Promise<unknown>
  rollback: (input: CustomRulesRestoreInput) => Promise<unknown>
  refresh: () => Promise<unknown>
}

/** Commit Helper-managed files, reload through the existing Mihomo client, and roll back on failure. */
export const applyCustomRulesUpdate = async (
  persist: () => Promise<CustomRulesState>,
  dependencies: CustomRulesUpdateDependencies,
) => {
  const saved = await persist()

  try {
    await dependencies.reload(saved.runtimeConfigPath)
  } catch (error) {
    if (!saved.backupId) {
      throw new CustomRulesApplyError(
        'CUSTOM_RULES_ROLLBACK_FAILED',
        'Mihomo reload failed and no rollback backup was returned.',
        { cause: error },
      )
    }

    try {
      await dependencies.rollback({
        expectedVersion: saved.version,
        backupId: saved.backupId,
      })
    } catch (rollbackError) {
      throw new CustomRulesApplyError(
        'CUSTOM_RULES_ROLLBACK_FAILED',
        'Mihomo reload failed and the managed files could not be rolled back.',
        { cause: rollbackError },
      )
    }

    try {
      // A failed HTTP response can be ambiguous: Mihomo may already have applied the candidate.
      // Reload the restored runtime file so both disk and process state are known to be old.
      await dependencies.reload(saved.runtimeConfigPath)
    } catch (recoveryError) {
      throw new CustomRulesApplyError(
        'CUSTOM_RULES_ROLLBACK_FAILED',
        'Managed files were restored, but Mihomo could not reload the previous configuration.',
        { cause: recoveryError },
      )
    }

    throw new CustomRulesApplyError(
      'CUSTOM_RULES_RELOAD_FAILED',
      'Mihomo rejected the reload. Managed files were restored to the previous version.',
      { cause: error },
    )
  }

  await dependencies.refresh()
  return saved
}
import { v4 as uuidv4 } from 'uuid'
