import { realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { LocalHelperError } from './errors.mjs'

const isInsideRoot = (root, target) => {
  const relativePath = relative(root, target)

  return (
    relativePath === '' ||
    (relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
  )
}

const findNearestExistingAncestor = async (target) => {
  let current = target

  while (true) {
    try {
      return {
        path: current,
        realPath: await realpath(current),
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw error
      }

      const parent = dirname(current)
      if (parent === current) {
        throw error
      }
      current = parent
    }
  }
}

const resolveRulesRoot = async (rulesDir) => {
  let root

  try {
    root = await realpath(rulesDir)
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new LocalHelperError(
        'RULES_DIR_NOT_FOUND',
        `Configured rules directory does not exist: ${rulesDir}`,
        422,
        { cause: error },
      )
    }
    throw error
  }

  const rootStat = await stat(root)
  if (!rootStat.isDirectory()) {
    throw new LocalHelperError(
      'RULES_DIR_NOT_DIRECTORY',
      `Configured rules directory is not a directory: ${rulesDir}`,
      422,
    )
  }

  return root
}

export const resolveAllowedProviderPath = async ({ configuredPath, configPath, rulesDir }) => {
  if (typeof configuredPath !== 'string' || !configuredPath || configuredPath.includes('\0')) {
    throw new LocalHelperError(
      'INVALID_PROVIDER_PATH',
      'Rule Provider path must be a non-empty string.',
      422,
    )
  }

  const rulesRoot = await resolveRulesRoot(rulesDir)
  const candidate = isAbsolute(configuredPath)
    ? resolve(configuredPath)
    : resolve(dirname(configPath), configuredPath)
  const ancestor = await findNearestExistingAncestor(candidate)
  const resolvedCandidate = resolve(ancestor.realPath, relative(ancestor.path, candidate))

  if (!isInsideRoot(rulesRoot, resolvedCandidate)) {
    throw new LocalHelperError(
      'PROVIDER_PATH_OUTSIDE_RULES_DIR',
      'Rule Provider path is outside MIHOMO_RULES_DIR.',
      403,
    )
  }

  try {
    const candidateRealPath = await realpath(candidate)

    if (!isInsideRoot(rulesRoot, candidateRealPath)) {
      throw new LocalHelperError(
        'PROVIDER_PATH_OUTSIDE_RULES_DIR',
        'Rule Provider path resolves outside MIHOMO_RULES_DIR.',
        403,
      )
    }

    const candidateStat = await stat(candidateRealPath)
    if (!candidateStat.isFile()) {
      throw new LocalHelperError(
        'PROVIDER_PATH_NOT_FILE',
        'Rule Provider path does not point to a regular file.',
        422,
      )
    }

    return {
      path: candidateRealPath,
      exists: true,
      stat: candidateStat,
    }
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return {
        path: resolvedCandidate,
        exists: false,
        stat: null,
      }
    }
    throw error
  }
}
