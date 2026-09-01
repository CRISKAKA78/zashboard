import {
  fetchLocalRuleProviderRules,
  fetchLocalRuleProviders,
  LocalHelperRequestError,
  type LocalHelperErrorInfo,
  type LocalRuleProviderInfo,
} from './helperApi'
import type { ProviderRuleSet } from './types'

type CachedProvider = {
  signature: string
  rules: ProviderRuleSet
}

export type ProviderLoadError = LocalHelperErrorInfo & {
  provider: string
}

export type ProviderLoadResult = {
  providers: ProviderRuleSet[]
  errors: ProviderLoadError[]
}

const providerCache = new Map<string, CachedProvider>()
const MAX_CONCURRENT_READS = 4

const metadataSignature = (provider: LocalRuleProviderInfo) =>
  [
    provider.path,
    provider.size,
    provider.mtime,
    provider.behavior,
    provider.format,
    JSON.stringify(provider.ruleReferences || []),
  ].join('|')

const loadOneProvider = async (
  provider: LocalRuleProviderInfo,
  signal?: AbortSignal,
): Promise<{ rules?: ProviderRuleSet; error?: ProviderLoadError }> => {
  const signature = metadataSignature(provider)
  const cached = providerCache.get(provider.name)

  if (cached?.signature === signature) {
    return { rules: cached.rules }
  }

  try {
    const response = await fetchLocalRuleProviderRules(provider.name, signal)
    const rules: ProviderRuleSet = {
      name: provider.name,
      behavior: response.provider.behavior,
      format: response.provider.format,
      entries: response.entries,
      ruleReferences: response.provider.ruleReferences || provider.ruleReferences || [],
    }
    providerCache.set(provider.name, { signature, rules })
    return { rules }
  } catch (error) {
    const helperError =
      error instanceof LocalHelperRequestError
        ? error
        : new LocalHelperRequestError('PROVIDER_LOAD_FAILED', 'Unable to load Rule Provider.')

    return {
      error: {
        provider: provider.name,
        code: helperError.code,
        message: helperError.message,
      },
    }
  }
}

export const loadLocalProviderRuleSets = async (
  signal?: AbortSignal,
): Promise<ProviderLoadResult> => {
  const metadata = await fetchLocalRuleProviders(signal)
  const readableProviders = metadata.filter(
    (provider) => provider.pathAccess === 'allowed' && provider.exists,
  )
  const currentNames = new Set(readableProviders.map((provider) => provider.name))

  for (const name of providerCache.keys()) {
    if (!currentNames.has(name)) providerCache.delete(name)
  }

  const results: Awaited<ReturnType<typeof loadOneProvider>>[] = []
  for (let offset = 0; offset < readableProviders.length; offset += MAX_CONCURRENT_READS) {
    const batch = readableProviders.slice(offset, offset + MAX_CONCURRENT_READS)
    results.push(...(await Promise.all(batch.map((provider) => loadOneProvider(provider, signal)))))
  }

  return {
    providers: results.flatMap((result) => (result.rules ? [result.rules] : [])),
    errors: [
      ...metadata
        .filter((provider) => provider.pathAccess === 'rejected' && provider.error)
        .map((provider) => ({ provider: provider.name, ...provider.error! })),
      ...results.flatMap((result) => (result.error ? [result.error] : [])),
    ],
  }
}

export const clearLocalProviderRuleCache = () => providerCache.clear()
