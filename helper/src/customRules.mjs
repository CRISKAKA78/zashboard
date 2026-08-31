import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { access, chmod, lstat, mkdir, open, readdir, readFile, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { readMihomoConfig } from './configDiscovery.mjs'
import {
  buildManagedConfig,
  normalizeCustomRules,
  parseCustomRuleFile,
  parseFakeIpFilterFile,
  serializeCustomRuleFile,
  serializeFakeIpFilterFile,
  serializeManagedConfig,
} from './customRuleModel.mjs'
import { LocalHelperError } from './errors.mjs'
import {
  replaceCandidate,
  temporaryPath,
  withWriteLock,
  writeSourceAtomic,
  writeTemporary,
} from './managedFiles.mjs'

const execFileAsync = promisify(execFile)
const MAX_MANAGED_FILE_BYTES = 4 * 1024 * 1024

const pathsFor = (settings) => {
  const customRulesDir = resolve(
    settings.customRulesDir || join(dirname(settings.configPath), 'custom'),
  )
  return {
    customRulesDir,
    prePath: join(customRulesDir, 'pre-rules.yaml'),
    postPath: join(customRulesDir, 'post-rules.yaml'),
    fakeIpFilterPath: join(customRulesDir, 'fake-ip-filter.yaml'),
    runtimePath: resolve(settings.runtimeConfigPath || join(customRulesDir, 'runtime-config.yaml')),
    backupsDir: join(customRulesDir, 'backups'),
  }
}

const ensureStorageDirectory = async (path) => {
  await mkdir(path, { recursive: true, mode: 0o700 })
  const info = await lstat(path)
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new LocalHelperError(
      'CUSTOM_RULES_DIRECTORY_INVALID',
      'Custom rules storage path is not a directory.',
      500,
    )
  }
  await chmod(path, 0o700).catch(() => {})
}

const readOptionalFile = async (path) => {
  let handle
  try {
    const pathInfo = await lstat(path)
    if (pathInfo.isSymbolicLink()) {
      throw new LocalHelperError(
        'CUSTOM_RULES_SYMLINK_REJECTED',
        `Managed custom rules file cannot be a symbolic link: ${path}`,
        403,
      )
    }
    handle = await open(
      path,
      constants.O_RDONLY | (typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0),
    )
    const info = await handle.stat()
    if (!info.isFile()) {
      throw new LocalHelperError(
        'CUSTOM_RULES_FILE_INVALID',
        `Managed custom rules path is not a regular file: ${path}`,
        422,
      )
    }
    if (info.size > MAX_MANAGED_FILE_BYTES) {
      throw new LocalHelperError(
        'CUSTOM_RULES_FILE_TOO_LARGE',
        `Managed custom rules file exceeds ${MAX_MANAGED_FILE_BYTES} bytes.`,
        413,
      )
    }
    return await handle.readFile('utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    if (error?.code === 'ELOOP') {
      throw new LocalHelperError(
        'CUSTOM_RULES_SYMLINK_REJECTED',
        `Managed custom rules file cannot be a symbolic link: ${path}`,
        403,
        { cause: error },
      )
    }
    throw error
  } finally {
    await handle?.close().catch(() => {})
  }
}

const versionFor = ({ baseSource, preSource, postSource, fakeIpFilterSource, runtimeSource }) =>
  createHash('sha256')
    .update(baseSource)
    .update('\0PRE\0')
    .update(preSource ?? '<missing>')
    .update('\0POST\0')
    .update(postSource ?? '<missing>')
    .update('\0FAKE-IP-FILTER\0')
    .update(fakeIpFilterSource ?? '<missing>')
    .update('\0RUNTIME\0')
    .update(runtimeSource ?? '<missing>')
    .digest('hex')

const loadState = async (settings) => {
  const paths = pathsFor(settings)
  await ensureStorageDirectory(paths.customRulesDir)
  const [baseConfig, baseSource, preSource, postSource, fakeIpFilterSource, runtimeSource] =
    await Promise.all([
      readMihomoConfig(settings.configPath),
      readFile(settings.configPath, 'utf8'),
      readOptionalFile(paths.prePath),
      readOptionalFile(paths.postPath),
      readOptionalFile(paths.fakeIpFilterPath),
      readOptionalFile(paths.runtimePath),
    ])
  const customRules = normalizeCustomRules(
    {
      pre: parseCustomRuleFile(preSource, 'Pre'),
      post: parseCustomRuleFile(postSource, 'Post'),
      fakeIpFilter: parseFakeIpFilterFile(fakeIpFilterSource),
    },
    baseConfig,
  )

  return {
    paths,
    baseConfig,
    baseSource,
    preSource,
    postSource,
    fakeIpFilterSource,
    runtimeSource,
    customRules,
    version: versionFor({
      baseSource,
      preSource,
      postSource,
      fakeIpFilterSource,
      runtimeSource,
    }),
  }
}

const mapWriteError = (error) => {
  if (error instanceof LocalHelperError) return error
  const messages = {
    ENOSPC: 'Insufficient disk space while writing custom rules.',
    EACCES: 'Permission denied while writing custom rules.',
    EPERM: 'Permission denied while writing custom rules.',
    EROFS: 'Custom rules storage is read-only.',
  }
  return new LocalHelperError(
    'CUSTOM_RULES_WRITE_FAILED',
    messages[error?.code] || 'Unable to safely write custom rules.',
    500,
    { cause: error },
  )
}

export const validateMihomoConfig = async (settings, configPath, execute = execFileAsync) => {
  try {
    await access(settings.binaryPath, constants.X_OK)
  } catch (error) {
    throw new LocalHelperError(
      error?.code === 'ENOENT' ? 'MIHOMO_BINARY_NOT_FOUND' : 'MIHOMO_BINARY_NOT_EXECUTABLE',
      error?.code === 'ENOENT'
        ? 'Configured Mihomo binary does not exist.'
        : 'Configured Mihomo binary is not executable.',
      422,
      { cause: error },
    )
  }

  try {
    await execute(
      settings.binaryPath,
      ['-t', '-d', dirname(settings.configPath), '-f', configPath],
      {
        encoding: 'utf8',
        timeout: settings.configValidationTimeout ?? 20_000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      },
    )
  } catch (error) {
    const output = `${error?.stderr || ''}\n${error?.stdout || ''}`.trim().slice(0, 1000)
    if (error?.killed || error?.signal === 'SIGTERM' || error?.code === 'ETIMEDOUT') {
      throw new LocalHelperError(
        'MIHOMO_VALIDATION_TIMEOUT',
        'Mihomo configuration validation timed out.',
        422,
        { cause: error },
      )
    }
    throw new LocalHelperError(
      'MIHOMO_VALIDATION_FAILED',
      output
        ? `Mihomo configuration validation failed: ${output}`
        : 'Mihomo configuration validation failed.',
      422,
      { cause: error },
    )
  }
}

const prepareCandidate = async (settings, state, input, dependencies = {}) => {
  const customRules = normalizeCustomRules(
    {
      ...input,
      fakeIpFilter: input?.fakeIpFilter ?? state.customRules.fakeIpFilter,
    },
    state.baseConfig,
  )
  const managedConfig = buildManagedConfig(state.baseConfig, customRules)
  const sources = {
    pre: serializeCustomRuleFile(customRules.pre),
    post: serializeCustomRuleFile(customRules.post),
    fakeIpFilter: serializeFakeIpFilterFile(customRules.fakeIpFilter),
    runtime: serializeManagedConfig(managedConfig),
  }
  const temporary = {
    pre: temporaryPath(state.paths.customRulesDir, 'pre-rules'),
    post: temporaryPath(state.paths.customRulesDir, 'post-rules'),
    fakeIpFilter: temporaryPath(state.paths.customRulesDir, 'fake-ip-filter'),
    runtime: temporaryPath(state.paths.customRulesDir, 'runtime-config'),
  }

  try {
    const writer = dependencies.writeTemporary ?? writeTemporary
    await writer(temporary.pre, sources.pre)
    await writer(temporary.post, sources.post)
    await writer(temporary.fakeIpFilter, sources.fakeIpFilter)
    await writer(temporary.runtime, sources.runtime)
    await (dependencies.validateConfig ?? validateMihomoConfig)(settings, temporary.runtime)
    return { customRules, managedConfig, sources, temporary }
  } catch (error) {
    await Promise.all(
      Object.values(temporary).map((path) => rm(path, { force: true }).catch(() => {})),
    )
    throw error
  }
}

const cleanupCandidate = (candidate) =>
  Promise.all(
    Object.values(candidate.temporary).map((path) => rm(path, { force: true }).catch(() => {})),
  )

const backupId = () => `${Date.now()}-${randomBytes(8).toString('hex')}`

const createBackup = async (settings, state) => {
  const id = backupId()
  const directory = join(state.paths.backupsDir, id)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const pre = state.preSource ?? serializeCustomRuleFile([])
  const post = state.postSource ?? serializeCustomRuleFile([])
  const fakeIpFilter =
    state.fakeIpFilterSource ?? serializeFakeIpFilterFile(state.customRules.fakeIpFilter)
  await writeTemporary(join(directory, 'pre-rules.yaml'), pre)
  await writeTemporary(join(directory, 'post-rules.yaml'), post)
  await writeTemporary(join(directory, 'fake-ip-filter.yaml'), fakeIpFilter)
  await writeTemporary(
    join(directory, 'manifest.json'),
    `${JSON.stringify({ id, createdAt: new Date().toISOString() }, null, 2)}\n`,
  )
  await pruneBackups(settings, state.paths)
  return id
}

const listBackups = async (paths) => {
  let entries
  try {
    entries = await readdir(paths.backupsDir, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }

  const backups = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+-[a-f\d]{16}$/u.test(entry.name)) continue
    try {
      const manifestSource = await readOptionalFile(
        join(paths.backupsDir, entry.name, 'manifest.json'),
      )
      if (manifestSource === null) continue
      const manifest = JSON.parse(manifestSource)
      if (
        manifest.id !== entry.name ||
        typeof manifest.createdAt !== 'string' ||
        !Number.isFinite(Date.parse(manifest.createdAt))
      ) {
        continue
      }
      backups.push({ id: entry.name, createdAt: manifest.createdAt })
    } catch {
      // Ignore incomplete backup directories; they can never be selected by the API.
    }
  }
  return backups.sort((left, right) => right.createdAt.localeCompare(left.createdAt))
}

const pruneBackups = async (settings, paths) => {
  const backups = await listBackups(paths)
  const limit = settings.customRulesBackupLimit ?? 3
  await Promise.all(
    backups
      .slice(limit)
      .map((backup) => rm(join(paths.backupsDir, backup.id), { recursive: true, force: true })),
  )
}

const readBackupRules = async (paths, id, fallbackFakeIpFilter) => {
  if (typeof id !== 'string' || !/^\d+-[a-f\d]{16}$/u.test(id)) {
    throw new LocalHelperError('CUSTOM_RULES_BACKUP_INVALID', 'Backup id is invalid.', 400)
  }
  const directory = join(paths.backupsDir, id)
  try {
    const [preSource, postSource, fakeIpFilterSource] = await Promise.all([
      readOptionalFile(join(directory, 'pre-rules.yaml')),
      readOptionalFile(join(directory, 'post-rules.yaml')),
      readOptionalFile(join(directory, 'fake-ip-filter.yaml')),
    ])
    if (preSource === null || postSource === null) throw new Error('incomplete')
    return {
      pre: parseCustomRuleFile(preSource, 'Pre backup'),
      post: parseCustomRuleFile(postSource, 'Post backup'),
      fakeIpFilter:
        parseFakeIpFilterFile(fakeIpFilterSource) ?? structuredClone(fallbackFakeIpFilter),
    }
  } catch (error) {
    if (error instanceof LocalHelperError) throw error
    throw new LocalHelperError(
      'CUSTOM_RULES_BACKUP_NOT_FOUND',
      'Custom rules backup was not found or is incomplete.',
      404,
      { cause: error },
    )
  }
}

const requireExpectedVersion = (input, actual) => {
  if (typeof input?.expectedVersion !== 'string' || input.expectedVersion !== actual) {
    throw new LocalHelperError(
      'CUSTOM_RULES_VERSION_CONFLICT',
      'Custom rules or source configuration changed. Refresh before saving again.',
      409,
    )
  }
}

const commitCandidate = async (state, candidate, dependencies = {}) => {
  const replace = dependencies.replaceCandidate ?? replaceCandidate
  try {
    await replace(candidate.temporary.pre, state.paths.prePath)
    await replace(candidate.temporary.post, state.paths.postPath)
    await replace(candidate.temporary.fakeIpFilter, state.paths.fakeIpFilterPath)
    await replace(candidate.temporary.runtime, state.paths.runtimePath)
  } catch (error) {
    try {
      await Promise.all([
        writeSourceAtomic(state.paths.prePath, state.preSource),
        writeSourceAtomic(state.paths.postPath, state.postSource),
        writeSourceAtomic(state.paths.fakeIpFilterPath, state.fakeIpFilterSource),
        writeSourceAtomic(state.paths.runtimePath, state.runtimeSource),
      ])
    } catch (rollbackError) {
      throw new LocalHelperError(
        'CUSTOM_RULES_ROLLBACK_FAILED',
        'A managed-file replacement failed and the previous files could not be fully restored.',
        500,
        { cause: rollbackError },
      )
    }
    throw mapWriteError(error)
  }
}

const publicState = async (settings, state, extra = {}) => ({
  version: state.version,
  pre: state.customRules.pre,
  post: state.customRules.post,
  fakeIpFilter: state.customRules.fakeIpFilter,
  sourceConfigPath: settings.configPath,
  runtimeConfigPath: state.paths.runtimePath,
  backups: await listBackups(state.paths),
  ...extra,
})

export const getCustomRules = async (settings) => publicState(settings, await loadState(settings))

export const validateCustomRules = async (settings, input, dependencies = {}) => {
  const state = await loadState(settings)
  const candidate = await prepareCandidate(settings, state, input, dependencies)
  await cleanupCandidate(candidate)
  return {
    valid: true,
    preCount: candidate.customRules.pre.length,
    postCount: candidate.customRules.post.length,
    fakeIpFilterCount: candidate.customRules.fakeIpFilter.length,
    runtimeConfigPath: state.paths.runtimePath,
  }
}

export const saveCustomRules = async (settings, input, dependencies = {}) => {
  const key = pathsFor(settings).customRulesDir
  return withWriteLock(key, async () => {
    const state = await loadState(settings)
    requireExpectedVersion(input, state.version)
    let candidate
    try {
      candidate = await prepareCandidate(settings, state, input, dependencies)
      const current = await loadState(settings)
      requireExpectedVersion(input, current.version)
      const id = await createBackup(settings, state)
      await commitCandidate(state, candidate, dependencies)
      const saved = await loadState(settings)
      return publicState(settings, saved, { backupId: id })
    } catch (error) {
      throw mapWriteError(error)
    } finally {
      if (candidate) await cleanupCandidate(candidate)
    }
  })
}

const restore = async (settings, input, dependencies, createCurrentBackup) => {
  const key = pathsFor(settings).customRulesDir
  return withWriteLock(key, async () => {
    const state = await loadState(settings)
    requireExpectedVersion(input, state.version)
    const rules = await readBackupRules(state.paths, input.backupId, state.customRules.fakeIpFilter)
    let candidate
    try {
      candidate = await prepareCandidate(settings, state, rules, dependencies)
      const current = await loadState(settings)
      requireExpectedVersion(input, current.version)
      const id = createCurrentBackup ? await createBackup(settings, state) : input.backupId
      await commitCandidate(state, candidate, dependencies)
      const restored = await loadState(settings)
      return publicState(settings, restored, { backupId: id })
    } catch (error) {
      throw mapWriteError(error)
    } finally {
      if (candidate) await cleanupCandidate(candidate)
    }
  })
}

export const restoreCustomRulesBackup = (settings, input, dependencies = {}) =>
  restore(settings, input, dependencies, true)

export const rollbackCustomRules = (settings, input, dependencies = {}) =>
  restore(settings, input, dependencies, false)
