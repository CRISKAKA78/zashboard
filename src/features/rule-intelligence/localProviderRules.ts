import type { LocalProviderRuleMutationResponse, LocalProviderRuleRestoreInput } from './helperApi'

export type LocalProviderApplyStage =
  'reload-no-backup' | 'rollback' | 'rollback-reload' | 'reload-restored'

export class LocalProviderApplyError extends Error {
  readonly stage: LocalProviderApplyStage

  constructor(stage: LocalProviderApplyStage, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'LocalProviderApplyError'
    this.stage = stage
  }
}

export type LocalProviderUpdateDependencies = {
  reload: (name: string) => Promise<unknown>
  rollback: (
    name: string,
    input: LocalProviderRuleRestoreInput,
  ) => Promise<LocalProviderRuleMutationResponse>
  refresh: () => Promise<unknown>
}

export const applyLocalProviderUpdate = async (
  name: string,
  persist: () => Promise<LocalProviderRuleMutationResponse>,
  dependencies: LocalProviderUpdateDependencies,
) => {
  const saved = await persist()
  try {
    await dependencies.reload(name)
  } catch (reloadError) {
    if (!saved.backupId) {
      throw new LocalProviderApplyError(
        'reload-no-backup',
        'Mihomo rejected the local Rule Provider reload and no rollback backup was returned.',
        { cause: reloadError },
      )
    }

    try {
      await dependencies.rollback(name, {
        expectedVersion: saved.version,
        backupId: saved.backupId,
      })
    } catch (rollbackError) {
      throw new LocalProviderApplyError(
        'rollback',
        'Mihomo rejected the local Rule Provider reload and the previous file could not be restored.',
        { cause: rollbackError },
      )
    }

    try {
      await dependencies.reload(name)
    } catch (rollbackReloadError) {
      throw new LocalProviderApplyError(
        'rollback-reload',
        'The previous local Rule Provider file was restored, but Mihomo could not reload it.',
        { cause: rollbackReloadError },
      )
    }

    throw new LocalProviderApplyError(
      'reload-restored',
      'Mihomo rejected the local Rule Provider reload. The previous file was restored.',
      { cause: reloadError },
    )
  }

  await dependencies.refresh()
  return saved
}
