import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import {
  access,
  chmod,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { LocalHelperError } from './errors.mjs'

const execFileAsync = promisify(execFile)
const TEMP_PREFIX = 'zashboard-rule-intelligence-'
const SUPPORTED_MRS_BEHAVIORS = new Set(['domain', 'ipcidr'])

const ensureMihomoExecutable = async (binaryPath) => {
  let resolvedPath

  try {
    resolvedPath = await realpath(binaryPath)
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new LocalHelperError(
        'MIHOMO_BINARY_NOT_FOUND',
        'Configured Mihomo binary does not exist.',
        503,
        { cause: error },
      )
    }
    if (error?.code === 'EACCES' || error?.code === 'EPERM') {
      throw new LocalHelperError(
        'MIHOMO_BINARY_NOT_EXECUTABLE',
        'Configured Mihomo binary cannot be accessed.',
        503,
        { cause: error },
      )
    }
    throw error
  }

  let binaryStat
  try {
    binaryStat = await stat(resolvedPath)
  } catch (error) {
    if (error?.code === 'EACCES' || error?.code === 'EPERM') {
      throw new LocalHelperError(
        'MIHOMO_BINARY_NOT_EXECUTABLE',
        'Configured Mihomo binary cannot be accessed.',
        503,
        { cause: error },
      )
    }
    throw error
  }
  if (!binaryStat.isFile()) {
    throw new LocalHelperError(
      'MIHOMO_BINARY_NOT_FILE',
      'Configured Mihomo binary is not a file.',
      503,
    )
  }

  try {
    await access(resolvedPath, constants.X_OK)
  } catch (error) {
    throw new LocalHelperError(
      'MIHOMO_BINARY_NOT_EXECUTABLE',
      'Configured Mihomo binary is not executable.',
      503,
      { cause: error },
    )
  }

  return resolvedPath
}

const readMrsSource = async (sourcePath, maxBytes) => {
  let handle

  try {
    handle = await open(sourcePath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
    const sourceStat = await handle.stat()

    if (!sourceStat.isFile()) {
      throw new LocalHelperError(
        'PROVIDER_PATH_NOT_FILE',
        'MRS Rule Provider path does not point to a regular file.',
        422,
      )
    }
    if (sourceStat.size === 0) {
      throw new LocalHelperError('MRS_SOURCE_EMPTY', 'MRS Rule Provider file is empty.', 422)
    }
    if (sourceStat.size > maxBytes) {
      throw new LocalHelperError(
        'RULE_PROVIDER_TOO_LARGE',
        'MRS Rule Provider exceeds the configured read limit.',
        413,
      )
    }

    return {
      content: await handle.readFile(),
      stat: sourceStat,
    }
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new LocalHelperError(
        'RULE_PROVIDER_FILE_NOT_FOUND',
        'MRS Rule Provider file no longer exists.',
        404,
        { cause: error },
      )
    }
    if (error?.code === 'EACCES' || error?.code === 'EPERM') {
      throw new LocalHelperError(
        'RULE_PROVIDER_FILE_NOT_READABLE',
        'MRS Rule Provider file is not readable.',
        403,
        { cause: error },
      )
    }
    throw error
  } finally {
    await handle?.close()
  }
}

const conversionFailure = (error) => {
  if (error instanceof LocalHelperError) return error

  if (error?.killed || error?.code === 'ETIMEDOUT' || error?.signal === 'SIGTERM') {
    return new LocalHelperError(
      'MRS_CONVERSION_TIMEOUT',
      'Mihomo convert-ruleset timed out.',
      504,
      { cause: error },
    )
  }
  if (
    error?.code === 'ENOSPC' ||
    `${error?.stderr || ''} ${error?.message || ''}`.toLowerCase().includes('no space left')
  ) {
    return new LocalHelperError(
      'MRS_TEMP_NO_SPACE',
      'There is not enough temporary disk space to convert the MRS Rule Provider.',
      507,
      { cause: error },
    )
  }
  if (error?.code === 'EACCES' || error?.code === 'EPERM') {
    return new LocalHelperError(
      'MIHOMO_BINARY_NOT_EXECUTABLE',
      'Configured Mihomo binary cannot be executed.',
      503,
      { cause: error },
    )
  }

  const exitCode = error?.code ?? 'unknown'
  const detail = `${error?.stderr || error?.message || ''}`.trim().slice(0, 500)
  return new LocalHelperError(
    'MRS_CONVERSION_FAILED',
    `Mihomo convert-ruleset returned exit code ${exitCode}${detail ? `: ${detail}` : '.'}`,
    422,
    { cause: error },
  )
}

const cleanupTempDirectory = async (temporaryDirectory) => {
  if (!temporaryDirectory) return

  try {
    const [realTemporaryDirectory, realTempRoot] = await Promise.all([
      realpath(temporaryDirectory),
      realpath(tmpdir()),
    ])
    const safeTarget =
      dirname(realTemporaryDirectory) === realTempRoot &&
      basename(realTemporaryDirectory).startsWith(TEMP_PREFIX)

    if (!safeTarget) {
      console.error(`Refusing to clean unexpected temporary path: ${realTemporaryDirectory}`)
      return
    }

    await rm(realTemporaryDirectory, { recursive: true, force: true })
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      console.error('Unable to clean the MRS conversion temporary directory.', error)
    }
  }
}

export const convertMrsToText = async (
  { binaryPath, behavior, sourcePath, timeoutMs, maxBytes },
  dependencies = {},
) => {
  const normalizedBehavior = behavior?.toLowerCase()
  if (!SUPPORTED_MRS_BEHAVIORS.has(normalizedBehavior)) {
    throw new LocalHelperError(
      'MRS_BEHAVIOR_UNSUPPORTED',
      `MRS Rule Provider behavior "${behavior || 'unset'}" is not supported.`,
      415,
    )
  }

  const ensureExecutable = dependencies.ensureExecutable || ensureMihomoExecutable
  const execute = dependencies.execute || execFileAsync
  const source = await readMrsSource(sourcePath, maxBytes)
  const resolvedBinary = await ensureExecutable(binaryPath)
  let temporaryDirectory

  try {
    temporaryDirectory = await mkdtemp(join(tmpdir(), TEMP_PREFIX))
    await chmod(temporaryDirectory, 0o700)

    const nonce = randomBytes(16).toString('hex')
    const temporarySource = join(temporaryDirectory, `${nonce}.mrs`)
    const temporaryTarget = join(temporaryDirectory, `${randomBytes(16).toString('hex')}.txt`)
    await writeFile(temporarySource, source.content, { flag: 'wx', mode: 0o600 })

    try {
      await execute(
        resolvedBinary,
        ['convert-ruleset', normalizedBehavior, 'mrs', temporarySource, temporaryTarget],
        {
          encoding: 'utf8',
          timeout: timeoutMs,
          maxBuffer: 1024 * 1024,
          windowsHide: true,
        },
      )
    } catch (error) {
      throw conversionFailure(error)
    }

    let converted
    try {
      const outputStat = await stat(temporaryTarget)
      if (outputStat.size === 0) {
        throw new LocalHelperError(
          'MRS_CONVERSION_OUTPUT_EMPTY',
          'Mihomo convert-ruleset returned an empty rule set.',
          422,
        )
      }
      if (outputStat.size > maxBytes) {
        throw new LocalHelperError(
          'MRS_CONVERSION_OUTPUT_TOO_LARGE',
          'Converted MRS Rule Provider exceeds the configured read limit.',
          413,
        )
      }

      await chmod(temporaryTarget, 0o600)
      converted = await readFile(temporaryTarget, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw new LocalHelperError(
          'MRS_CONVERSION_OUTPUT_MISSING',
          'Mihomo convert-ruleset did not create an output file.',
          422,
          { cause: error },
        )
      }
      throw error
    }

    if (!converted.trim()) {
      throw new LocalHelperError(
        'MRS_CONVERSION_OUTPUT_EMPTY',
        'Mihomo convert-ruleset returned an empty rule set.',
        422,
      )
    }

    return { source: converted, stat: source.stat }
  } catch (error) {
    if (error instanceof LocalHelperError) throw error
    if (error?.code === 'ENOSPC') throw conversionFailure(error)

    throw new LocalHelperError(
      'MRS_TEMP_FAILED',
      `Unable to prepare MRS conversion temporary files: ${error.message}`,
      500,
      { cause: error },
    )
  } finally {
    await cleanupTempDirectory(temporaryDirectory)
  }
}
