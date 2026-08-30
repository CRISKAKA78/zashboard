import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { parseDocument } from 'yaml'
import { LocalHelperError } from './errors.mjs'
import { inspectMihomoBinary } from './mihomo.mjs'
import { resolveAllowedProviderPath } from './pathSecurity.mjs'

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

const errorInfo = (error) => ({
  code: error.code || 'UNKNOWN_ERROR',
  message: error.message,
})

const readConfigSource = async (configPath) => {
  try {
    return await readFile(configPath, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new LocalHelperError(
        'CONFIG_NOT_FOUND',
        `Mihomo configuration file does not exist: ${configPath}`,
        404,
        { cause: error },
      )
    }
    if (error?.code === 'EACCES' || error?.code === 'EPERM') {
      throw new LocalHelperError(
        'CONFIG_NOT_READABLE',
        `Mihomo configuration file is not readable: ${configPath}`,
        403,
        { cause: error },
      )
    }
    throw error
  }
}

export const readMihomoConfig = async (configPath) => {
  const source = await readConfigSource(configPath)
  const document = parseDocument(source, {
    merge: true,
    prettyErrors: true,
    uniqueKeys: true,
  })

  if (document.errors.length > 0) {
    throw new LocalHelperError(
      'CONFIG_YAML_INVALID',
      `Mihomo configuration YAML is invalid: ${document.errors[0].message}`,
      422,
    )
  }

  let config
  try {
    config = document.toJS({ maxAliasCount: 100 }) ?? {}
  } catch (error) {
    throw new LocalHelperError(
      'CONFIG_YAML_INVALID',
      `Mihomo configuration YAML cannot be safely expanded: ${error.message}`,
      422,
      { cause: error },
    )
  }
  if (!isRecord(config)) {
    throw new LocalHelperError(
      'CONFIG_ROOT_INVALID',
      'Mihomo configuration root must be a YAML mapping.',
      422,
    )
  }

  return config
}

export const getRuleProviderDefinitions = (config) => {
  const providers = config['rule-providers']

  if (providers === undefined || providers === null) {
    return []
  }
  if (!isRecord(providers)) {
    throw new LocalHelperError(
      'RULE_PROVIDERS_INVALID',
      'rule-providers must be a YAML mapping.',
      422,
    )
  }

  return Object.entries(providers).map(([name, provider]) => {
    if (!isRecord(provider)) {
      throw new LocalHelperError(
        'RULE_PROVIDER_INVALID',
        `Rule Provider "${name}" must be a YAML mapping.`,
        422,
      )
    }

    const intervalValue =
      typeof provider.interval === 'number' || typeof provider.interval === 'string'
        ? Number(provider.interval)
        : Number.NaN

    return {
      name,
      type: typeof provider.type === 'string' ? provider.type : null,
      behavior: typeof provider.behavior === 'string' ? provider.behavior : null,
      format: typeof provider.format === 'string' ? provider.format : null,
      configuredPath: typeof provider.path === 'string' ? provider.path : null,
      url: typeof provider.url === 'string' ? provider.url : null,
      interval: Number.isFinite(intervalValue) ? intervalValue : null,
    }
  })
}

const providerWithoutFile = (provider) => ({
  ...provider,
  path: null,
  pathAccess: 'not-configured',
  exists: false,
  size: null,
  mtime: null,
  error: null,
})

const getProviderFilePath = (provider, settings) => {
  if (provider.configuredPath) {
    return provider.configuredPath
  }

  if (provider.type === 'http' && provider.url) {
    const cacheFileName = createHash('md5').update(provider.url).digest('hex')
    return join(settings.rulesDir, cacheFileName)
  }

  return null
}

const inspectProviderFile = async (provider, settings, strict) => {
  const providerFilePath = getProviderFilePath(provider, settings)

  if (!providerFilePath) {
    return providerWithoutFile(provider)
  }

  try {
    const file = await resolveAllowedProviderPath({
      configuredPath: providerFilePath,
      configPath: settings.configPath,
      rulesDir: settings.rulesDir,
    })

    return {
      ...provider,
      path: file.path,
      pathAccess: 'allowed',
      exists: file.exists,
      size: file.stat?.size ?? null,
      mtime: file.stat?.mtime.toISOString() ?? null,
      error: null,
    }
  } catch (error) {
    if (strict || !(error instanceof LocalHelperError)) {
      throw error
    }

    return {
      ...provider,
      path: null,
      pathAccess: 'rejected',
      exists: false,
      size: null,
      mtime: null,
      error: errorInfo(error),
    }
  }
}

export const listRuleProviders = async (settings) => {
  const config = await readMihomoConfig(settings.configPath)
  const providers = getRuleProviderDefinitions(config)

  return Promise.all(providers.map((provider) => inspectProviderFile(provider, settings, false)))
}

export const getRuleProviderInfo = async (settings, name) => {
  const config = await readMihomoConfig(settings.configPath)
  const provider = getRuleProviderDefinitions(config).find((item) => item.name === name)

  if (!provider) {
    throw new LocalHelperError(
      'RULE_PROVIDER_NOT_FOUND',
      `Rule Provider "${name}" was not found in the active configuration.`,
      404,
    )
  }

  return inspectProviderFile(provider, settings, true)
}

const inspectRulesDirectory = async (rulesDir) => {
  try {
    const rulesStat = await stat(rulesDir)

    return {
      path: rulesDir,
      exists: true,
      directory: rulesStat.isDirectory(),
    }
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return {
        path: rulesDir,
        exists: false,
        directory: false,
      }
    }
    throw error
  }
}

const inspectConfig = async (configPath) => {
  let configStat

  try {
    configStat = await stat(configPath)
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return {
        path: configPath,
        exists: false,
        valid: false,
        size: null,
        mtime: null,
        ruleProviderCount: 0,
        error: errorInfo(
          new LocalHelperError(
            'CONFIG_NOT_FOUND',
            'Mihomo configuration file does not exist.',
            404,
          ),
        ),
      }
    }
    throw error
  }

  try {
    const config = await readMihomoConfig(configPath)

    return {
      path: configPath,
      exists: true,
      valid: true,
      size: configStat.size,
      mtime: configStat.mtime.toISOString(),
      ruleProviderCount: getRuleProviderDefinitions(config).length,
      error: null,
    }
  } catch (error) {
    if (!(error instanceof LocalHelperError)) {
      throw error
    }

    return {
      path: configPath,
      exists: true,
      valid: false,
      size: configStat.size,
      mtime: configStat.mtime.toISOString(),
      ruleProviderCount: 0,
      error: errorInfo(error),
    }
  }
}

export const getConfigInfo = async (settings) => {
  const [config, rulesDirectory, mihomo] = await Promise.all([
    inspectConfig(settings.configPath),
    inspectRulesDirectory(settings.rulesDir),
    inspectMihomoBinary(settings.binaryPath),
  ])

  return {
    config,
    rulesDirectory,
    mihomo,
  }
}
