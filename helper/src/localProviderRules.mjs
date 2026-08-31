import { createHash, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, readdir, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { isSeq, parseDocument, stringify } from 'yaml'
import { getRuleProviderInfo, readMihomoConfig } from './configDiscovery.mjs'
import { validateMihomoConfig } from './customRules.mjs'
import { LocalHelperError } from './errors.mjs'
import {
  replaceCandidate,
  temporaryPath,
  withWriteLock,
  writeSourceAtomic,
  writeTemporary,
} from './managedFiles.mjs'
import {
  clearProviderRulesCache,
  getRuleProviderVersion,
  isEditableRuleProvider,
  parseRuleProviderSource,
  readProviderSource,
  resolveProviderFormat,
} from './providerRules.mjs'

const MAX_RULE_LENGTH = 4096
const BACKUP_ID_PATTERN = /^\d+-[a-f\d]{16}$/u

const providerBackupKey = (provider) =>
  createHash('sha256').update(provider.name).update('\0').update(provider.path).digest('hex')

const backupRootFor = (settings, provider) =>
  join(
    resolve(settings.customRulesDir || join(dirname(settings.configPath), 'custom')),
    'provider-backups',
    providerBackupKey(provider),
  )

const ensureStorageDirectory = async (path) => {
  await mkdir(path, { recursive: true, mode: 0o700 })
  const info = await lstat(path)
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new LocalHelperError(
      'RULE_PROVIDER_BACKUP_DIRECTORY_INVALID',
      'Local Rule Provider backup storage is not a directory.',
      500,
    )
  }
  await chmod(path, 0o700).catch(() => {})
}

const mapWriteError = (error) => {
  if (error instanceof LocalHelperError) return error
  const messages = {
    ENOSPC: 'Insufficient disk space while writing the local Rule Provider.',
    EACCES: 'Permission denied while writing the local Rule Provider.',
    EPERM: 'Permission denied while writing the local Rule Provider.',
    EROFS: 'Local Rule Provider storage is read-only.',
  }
  return new LocalHelperError(
    'RULE_PROVIDER_WRITE_FAILED',
    messages[error?.code] || 'Unable to safely write the local Rule Provider.',
    500,
    { cause: error },
  )
}

const requireExpectedVersion = (input, actual) => {
  if (typeof input?.expectedVersion !== 'string' || input.expectedVersion !== actual) {
    throw new LocalHelperError(
      'RULE_PROVIDER_VERSION_CONFLICT',
      'The local Rule Provider changed. Refresh before saving again.',
      409,
    )
  }
}

const loadState = async (settings, name) => {
  const provider = await getRuleProviderInfo(settings, name)
  const format = resolveProviderFormat(provider)
  const normalizedProvider = {
    ...provider,
    format,
    editable: isEditableRuleProvider(provider, format),
  }

  if (!normalizedProvider.editable) {
    throw new LocalHelperError(
      'RULE_PROVIDER_READ_ONLY',
      'Only local file-based text or YAML Rule Providers can be edited.',
      409,
    )
  }

  const { source, stat } = await readProviderSource(normalizedProvider, settings.maxProviderBytes)
  const entries = parseRuleProviderSource(source, normalizedProvider)

  return {
    provider: normalizedProvider,
    source,
    stat,
    entries,
    version: getRuleProviderVersion(normalizedProvider, source),
  }
}

const normalizeRawRule = (input) => {
  if (typeof input !== 'string') {
    throw new LocalHelperError(
      'RULE_PROVIDER_RULE_INVALID',
      'A local Rule Provider rule must be a string.',
      400,
    )
  }

  const raw = input.trim()
  if (
    !raw ||
    raw.length > MAX_RULE_LENGTH ||
    raw.includes('\0') ||
    raw.includes('\n') ||
    raw.includes('\r') ||
    raw.startsWith('#') ||
    raw.startsWith('//')
  ) {
    throw new LocalHelperError(
      'RULE_PROVIDER_RULE_INVALID',
      `A local Rule Provider rule must be one non-comment line of at most ${MAX_RULE_LENGTH} characters.`,
      400,
    )
  }
  return raw
}

const normalizeMutation = (input, entryCount) => {
  const operation = input?.operation
  if (!['add', 'update', 'delete'].includes(operation)) {
    throw new LocalHelperError(
      'RULE_PROVIDER_OPERATION_INVALID',
      'Local Rule Provider operation must be add, update, or delete.',
      400,
    )
  }

  if (operation === 'add') {
    return { operation, raw: normalizeRawRule(input.raw) }
  }

  const index = Number(input?.index)
  if (!Number.isSafeInteger(index) || index < 1 || index > entryCount) {
    throw new LocalHelperError(
      'RULE_PROVIDER_INDEX_INVALID',
      `Local Rule Provider index must be between 1 and ${entryCount}.`,
      400,
    )
  }

  return {
    operation,
    index,
    ...(operation === 'update' ? { raw: normalizeRawRule(input.raw) } : {}),
  }
}

const mutateTextSource = (state, mutation) => {
  const eol = state.source.includes('\r\n') ? '\r\n' : '\n'
  const lines = state.source.split(/\r?\n/u)

  if (mutation.operation === 'add') {
    const insertionIndex = state.source.endsWith('\n') ? lines.length - 1 : lines.length
    lines.splice(insertionIndex, 0, mutation.raw)
  } else {
    const line = state.entries[mutation.index - 1].line
    if (!Number.isSafeInteger(line) || line < 1 || line > lines.length) {
      throw new LocalHelperError(
        'RULE_PROVIDER_SOURCE_CHANGED',
        'The local Rule Provider source no longer matches its parsed entries.',
        409,
      )
    }
    if (mutation.operation === 'update') lines[line - 1] = mutation.raw
    else lines.splice(line - 1, 1)
  }

  return lines.join(eol)
}

const mutateYamlSource = (state, mutation) => {
  const document = parseDocument(state.source, {
    prettyErrors: true,
    uniqueKeys: true,
  })
  if (document.errors.length > 0) {
    throw new LocalHelperError(
      'RULE_PROVIDER_YAML_INVALID',
      `Rule Provider "${state.provider.name}" YAML is invalid: ${document.errors[0].message}`,
      422,
    )
  }

  const payload = document.get('payload', true)
  if (!isSeq(payload)) {
    throw new LocalHelperError(
      'RULE_PROVIDER_PAYLOAD_INVALID',
      `Rule Provider "${state.provider.name}" must contain a YAML payload sequence.`,
      422,
    )
  }

  if (mutation.operation === 'add') payload.add(mutation.raw)
  else if (mutation.operation === 'update') payload.set(mutation.index - 1, mutation.raw)
  else payload.delete(mutation.index - 1)

  return document.toString({ lineWidth: 0 })
}

const mutateSource = (state, input, maximumBytes) => {
  const mutation = normalizeMutation(input, state.entries.length)
  const source =
    state.provider.format === 'yaml'
      ? mutateYamlSource(state, mutation)
      : mutateTextSource(state, mutation)
  const bytes = Buffer.byteLength(source)
  if (bytes > maximumBytes) {
    throw new LocalHelperError(
      'RULE_PROVIDER_TOO_LARGE',
      `Rule Provider "${state.provider.name}" exceeds the configured write limit.`,
      413,
    )
  }

  const entries = parseRuleProviderSource(source, state.provider)
  const expectedCount =
    state.entries.length +
    (mutation.operation === 'add' ? 1 : mutation.operation === 'delete' ? -1 : 0)
  if (entries.length !== expectedCount) {
    throw new LocalHelperError(
      'RULE_PROVIDER_RULE_INVALID',
      'The edited rule did not produce exactly one valid Rule Provider entry.',
      422,
    )
  }
  return source
}

const createValidationConfig = async (settings, state, candidatePath) => {
  const config = structuredClone(await readMihomoConfig(settings.configPath))
  const definition = config['rule-providers']?.[state.provider.name]
  if (!definition || typeof definition !== 'object' || Array.isArray(definition)) {
    throw new LocalHelperError(
      'RULE_PROVIDER_NOT_FOUND',
      `Rule Provider "${state.provider.name}" was not found in the active configuration.`,
      404,
    )
  }
  definition.path = candidatePath
  definition.format = state.provider.format
  return stringify(config, { lineWidth: 0 })
}

const prepareCandidate = async (settings, state, source, dependencies = {}) => {
  const storageDir = resolve(
    settings.customRulesDir || join(dirname(settings.configPath), 'custom'),
  )
  await ensureStorageDirectory(storageDir)
  const temporary = {
    provider: temporaryPath(dirname(state.provider.path), 'provider-rules'),
    config: temporaryPath(storageDir, 'provider-validation'),
  }

  try {
    const writer = dependencies.writeTemporary ?? writeTemporary
    await writer(temporary.provider, source, state.stat.mode & 0o777)
    await writer(
      temporary.config,
      await createValidationConfig(settings, state, temporary.provider),
    )
    await (dependencies.validateConfig ?? validateMihomoConfig)(settings, temporary.config)
    return temporary
  } catch (error) {
    await Promise.all(
      Object.values(temporary).map((path) => rm(path, { force: true }).catch(() => {})),
    )
    throw error
  }
}

const cleanupCandidate = (temporary) =>
  Promise.all(Object.values(temporary).map((path) => rm(path, { force: true }).catch(() => {})))

const createBackup = async (settings, state) => {
  const id = `${Date.now()}-${randomBytes(8).toString('hex')}`
  const root = backupRootFor(settings, state.provider)
  const directory = join(root, id)
  await ensureStorageDirectory(dirname(dirname(root)))
  await ensureStorageDirectory(dirname(root))
  await ensureStorageDirectory(root)
  await ensureStorageDirectory(directory)
  await writeTemporary(join(directory, 'provider.rules'), state.source)
  await writeTemporary(
    join(directory, 'manifest.json'),
    `${JSON.stringify(
      {
        id,
        createdAt: new Date().toISOString(),
        provider: state.provider.name,
        path: state.provider.path,
      },
      null,
      2,
    )}\n`,
  )

  const entries = await readdir(root, { withFileTypes: true })
  const limit = settings.customRulesBackupLimit ?? 3
  const stale = entries
    .filter((entry) => entry.isDirectory() && BACKUP_ID_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => right.localeCompare(left))
    .slice(limit)
  await Promise.all(stale.map((entry) => rm(join(root, entry), { recursive: true, force: true })))
  return id
}

const readSafeBackupFile = async (path, maximum) => {
  let handle
  try {
    handle = await open(
      path,
      constants.O_RDONLY | (typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0),
    )
    const info = await handle.stat()
    if (!info.isFile() || info.size > maximum) throw new Error('invalid backup file')
    return await handle.readFile('utf8')
  } finally {
    await handle?.close().catch(() => {})
  }
}

const readBackup = async (settings, state, id) => {
  if (typeof id !== 'string' || !BACKUP_ID_PATTERN.test(id)) {
    throw new LocalHelperError(
      'RULE_PROVIDER_BACKUP_INVALID',
      'Local Rule Provider backup id is invalid.',
      400,
    )
  }

  const root = backupRootFor(settings, state.provider)
  await ensureStorageDirectory(dirname(dirname(root)))
  await ensureStorageDirectory(dirname(root))
  await ensureStorageDirectory(root)
  const directory = join(root, id)
  try {
    const directoryInfo = await lstat(directory)
    if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()) {
      throw new Error('backup directory is invalid')
    }
    const manifest = JSON.parse(
      await readSafeBackupFile(join(directory, 'manifest.json'), 64 * 1024),
    )
    if (
      manifest.id !== id ||
      manifest.provider !== state.provider.name ||
      manifest.path !== state.provider.path
    ) {
      throw new Error('backup does not match provider')
    }
    return await readSafeBackupFile(join(directory, 'provider.rules'), settings.maxProviderBytes)
  } catch (error) {
    throw new LocalHelperError(
      'RULE_PROVIDER_BACKUP_NOT_FOUND',
      'Local Rule Provider backup was not found or does not match this Provider.',
      404,
      { cause: error },
    )
  }
}

const commitCandidate = async (state, temporary, dependencies = {}) => {
  const replace = dependencies.replaceCandidate ?? replaceCandidate
  try {
    await replace(temporary.provider, state.provider.path, state.stat.mode & 0o777)
  } catch (error) {
    try {
      await writeSourceAtomic(state.provider.path, state.source, state.stat.mode & 0o777)
    } catch (rollbackError) {
      throw new LocalHelperError(
        'RULE_PROVIDER_ROLLBACK_FAILED',
        'The local Rule Provider replacement failed and the previous file could not be restored.',
        500,
        { cause: rollbackError },
      )
    }
    throw mapWriteError(error)
  }
}

const publicState = async (settings, name, extra = {}) => {
  clearProviderRulesCache()
  const state = await loadState(settings, name)
  return {
    provider: {
      ...state.provider,
      size: state.stat.size,
      mtime: state.stat.mtime.toISOString(),
    },
    entries: state.entries,
    version: state.version,
    ...extra,
  }
}

export const saveLocalRuleProvider = async (settings, name, input, dependencies = {}) => {
  return withWriteLock(resolve(settings.rulesDir), async () => {
    const state = await loadState(settings, name)
    requireExpectedVersion(input, state.version)
    const source = mutateSource(state, input, settings.maxProviderBytes)
    let temporary
    try {
      temporary = await prepareCandidate(settings, state, source, dependencies)
      const current = await loadState(settings, name)
      requireExpectedVersion(input, current.version)
      const backupId = await createBackup(settings, state)
      await commitCandidate(state, temporary, dependencies)
      return publicState(settings, name, { backupId })
    } catch (error) {
      throw mapWriteError(error)
    } finally {
      if (temporary) await cleanupCandidate(temporary)
    }
  })
}

export const rollbackLocalRuleProvider = async (settings, name, input, dependencies = {}) => {
  return withWriteLock(resolve(settings.rulesDir), async () => {
    const state = await loadState(settings, name)
    requireExpectedVersion(input, state.version)
    const source = await readBackup(settings, state, input?.backupId)
    parseRuleProviderSource(source, state.provider)
    let temporary
    try {
      temporary = await prepareCandidate(settings, state, source, dependencies)
      const current = await loadState(settings, name)
      requireExpectedVersion(input, current.version)
      await commitCandidate(state, temporary, dependencies)
      return publicState(settings, name)
    } catch (error) {
      throw mapWriteError(error)
    } finally {
      if (temporary) await cleanupCandidate(temporary)
    }
  })
}
