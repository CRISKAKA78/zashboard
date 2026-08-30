import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { extname } from 'node:path'
import { isSeq, LineCounter, parseDocument } from 'yaml'
import { getRuleProviderInfo } from './configDiscovery.mjs'
import { LocalHelperError } from './errors.mjs'
import { convertMrsToText } from './mrsConversion.mjs'

const parsedProviderCache = new Map()
const inflightMrsConversions = new Map()

const normalizeRuleType = (type) => type.trim().replaceAll('_', '-').toUpperCase()

const parseClassicalRule = (raw, context) => {
  const [type = '', value = ''] = raw.split(',', 3)
  const normalizedType = normalizeRuleType(type)

  if (!normalizedType || !value.trim()) {
    throw new LocalHelperError(
      'RULE_PROVIDER_ENTRY_INVALID',
      `Invalid classical rule in Rule Provider "${context.source}" at line ${context.line}.`,
      422,
    )
  }

  return {
    source: context.source,
    type: normalizedType,
    value: value.trim(),
    raw,
    line: context.line,
    behavior: context.behavior,
    format: context.format,
  }
}

const parseDomainRule = (raw, context) => {
  if (raw.includes(',')) {
    return parseClassicalRule(raw, context)
  }

  const suffixPrefixes = ['+.', '*.', '.']
  const prefix = suffixPrefixes.find((item) => raw.startsWith(item))

  const type = prefix ? 'DOMAIN-SUFFIX' : 'DOMAIN'
  const value = prefix ? raw.slice(prefix.length) : raw

  return {
    source: context.source,
    type,
    value,
    raw: context.format === 'mrs' ? `${type},${value}` : raw,
    line: context.line,
    behavior: context.behavior,
    format: context.format,
  }
}

const parseIpCidrRule = (raw, context) => {
  if (raw.includes(',')) {
    return parseClassicalRule(raw, context)
  }

  const type = raw.includes(':') ? 'IP-CIDR6' : 'IP-CIDR'

  return {
    source: context.source,
    type,
    value: raw,
    raw: context.format === 'mrs' ? `${type},${raw}` : raw,
    line: context.line,
    behavior: context.behavior,
    format: context.format,
  }
}

const normalizeEntry = (value, context) => {
  const raw = value.trim()

  if (!raw || raw.startsWith('#') || raw.startsWith('//')) {
    return null
  }

  switch (context.behavior) {
    case 'domain':
      return parseDomainRule(raw, context)
    case 'ipcidr':
      return parseIpCidrRule(raw, context)
    default:
      return parseClassicalRule(raw, context)
  }
}

const parseTextProvider = (source, provider, options = {}) =>
  source
    .split(/\r?\n/u)
    .map((value, index) =>
      normalizeEntry(value, {
        source: provider.name,
        line: options.includeLines === false ? undefined : index + 1,
        behavior: provider.behavior?.toLowerCase() || 'classical',
        format: options.format || 'text',
      }),
    )
    .filter(Boolean)

const parseYamlProvider = (source, provider) => {
  const lineCounter = new LineCounter()
  const document = parseDocument(source, {
    lineCounter,
    prettyErrors: true,
    uniqueKeys: true,
  })

  if (document.errors.length > 0) {
    throw new LocalHelperError(
      'RULE_PROVIDER_YAML_INVALID',
      `Rule Provider "${provider.name}" YAML is invalid: ${document.errors[0].message}`,
      422,
    )
  }

  const payload = document.get('payload', true)
  if (!isSeq(payload)) {
    throw new LocalHelperError(
      'RULE_PROVIDER_PAYLOAD_INVALID',
      `Rule Provider "${provider.name}" must contain a YAML payload sequence.`,
      422,
    )
  }

  return payload.items
    .map((item, index) => {
      if (typeof item?.value !== 'string') {
        throw new LocalHelperError(
          'RULE_PROVIDER_ENTRY_INVALID',
          `Rule Provider "${provider.name}" payload item ${index + 1} must be a string.`,
          422,
        )
      }

      const offset = item.range?.[0]
      return normalizeEntry(item.value, {
        source: provider.name,
        line: offset === undefined ? index + 1 : lineCounter.linePos(offset).line,
        behavior: provider.behavior?.toLowerCase() || 'classical',
        format: 'yaml',
      })
    })
    .filter(Boolean)
}

const resolveProviderFormat = (provider) => {
  const configuredFormat = provider.format?.toLowerCase()
  const extension = extname(provider.path || '').toLowerCase()

  if (configuredFormat === 'mrs' || extension === '.mrs') {
    return 'mrs'
  }

  if (configuredFormat === 'text' || ['.txt', '.list'].includes(extension)) {
    return 'text'
  }
  if (!configuredFormat || configuredFormat === 'yaml' || ['.yaml', '.yml'].includes(extension)) {
    return 'yaml'
  }

  throw new LocalHelperError(
    'RULE_PROVIDER_FORMAT_UNSUPPORTED',
    `Rule Provider "${provider.name}" format "${provider.format}" is not supported.`,
    415,
  )
}

const readProviderSource = async (provider, maxBytes) => {
  let handle

  try {
    handle = await open(provider.path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
    const fileStat = await handle.stat()

    if (!fileStat.isFile()) {
      throw new LocalHelperError(
        'PROVIDER_PATH_NOT_FILE',
        'Rule Provider path does not point to a regular file.',
        422,
      )
    }
    if (fileStat.size > maxBytes) {
      throw new LocalHelperError(
        'RULE_PROVIDER_TOO_LARGE',
        `Rule Provider "${provider.name}" exceeds the configured read limit.`,
        413,
      )
    }

    return {
      source: await handle.readFile({ encoding: 'utf8' }),
      stat: fileStat,
    }
  } finally {
    await handle?.close()
  }
}

const responseFromParsed = (provider, parsed, cache) => ({
  provider: {
    ...provider,
    size: parsed.stat.size,
    mtime: parsed.stat.mtime.toISOString(),
  },
  entries: parsed.entries,
  cache,
})

const parseMrsProvider = async (settings, provider, convertMrs) => {
  const converted = await convertMrs({
    binaryPath: settings.binaryPath,
    behavior: provider.behavior,
    sourcePath: provider.path,
    timeoutMs: settings.mrsConversionTimeout,
    maxBytes: settings.maxProviderBytes,
  })

  return {
    entries: parseTextProvider(converted.source, provider, {
      format: 'mrs',
      includeLines: false,
    }),
    stat: converted.stat,
  }
}

export const getRuleProviderRules = async (settings, name, dependencies = {}) => {
  const provider = await getRuleProviderInfo(settings, name)

  if (!provider.exists || !provider.path) {
    throw new LocalHelperError(
      'RULE_PROVIDER_FILE_NOT_FOUND',
      `Local file for Rule Provider "${name}" does not exist.`,
      404,
    )
  }

  const format = resolveProviderFormat(provider)
  const normalizedProvider = { ...provider, format }
  const cacheKey = JSON.stringify([
    provider.name,
    provider.path,
    provider.size,
    provider.mtime,
    provider.behavior,
    format,
  ])
  const cached = parsedProviderCache.get(provider.name)

  if (cached?.key === cacheKey) {
    return { provider: normalizedProvider, entries: cached.entries, cache: 'hit' }
  }

  if (format === 'mrs') {
    const existingConversion = inflightMrsConversions.get(cacheKey)
    if (existingConversion) {
      const parsed = await existingConversion
      return responseFromParsed(normalizedProvider, parsed, 'hit')
    }

    const conversion = parseMrsProvider(
      settings,
      normalizedProvider,
      dependencies.convertMrs || convertMrsToText,
    )
    inflightMrsConversions.set(cacheKey, conversion)

    try {
      const parsed = await conversion
      parsedProviderCache.set(provider.name, { key: cacheKey, entries: parsed.entries })
      return responseFromParsed(normalizedProvider, parsed, 'miss')
    } finally {
      if (inflightMrsConversions.get(cacheKey) === conversion) {
        inflightMrsConversions.delete(cacheKey)
      }
    }
  }

  const { source, stat } = await readProviderSource(provider, settings.maxProviderBytes)
  const entries =
    format === 'text'
      ? parseTextProvider(source, normalizedProvider)
      : parseYamlProvider(source, normalizedProvider)

  parsedProviderCache.set(provider.name, { key: cacheKey, entries })

  return {
    provider: {
      ...normalizedProvider,
      size: stat.size,
      mtime: stat.mtime.toISOString(),
    },
    entries,
    cache: 'miss',
  }
}

export const clearProviderRulesCache = () => parsedProviderCache.clear()
