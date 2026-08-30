import type {
  CustomRulesDraft,
  CustomRulesRestoreInput,
  CustomRulesSaveInput,
  CustomRulesState,
  CustomRulesValidation,
} from './customRules'
import type { RuleEntry } from './types'

const LOCAL_HELPER_BASE_URL = (import.meta.env.VITE_LOCAL_HELPER_URL || '').replace(/\/+$/, '')
const DEFAULT_TIMEOUT = 2500
const PROVIDER_RULES_TIMEOUT = 125000

export type LocalHelperErrorInfo = {
  code: string
  message: string
}

export type LocalRuleProviderInfo = {
  name: string
  type: string | null
  behavior: string | null
  format: string | null
  configuredPath: string | null
  path: string | null
  pathAccess: 'allowed' | 'rejected' | 'not-configured'
  exists: boolean
  size: number | null
  mtime: string | null
  url: string | null
  interval: number | null
  error: LocalHelperErrorInfo | null
}

export type LocalHelperConfigInfo = {
  config: {
    path: string
    exists: boolean
    valid: boolean
    size: number | null
    mtime: string | null
    ruleProviderCount: number
    error: LocalHelperErrorInfo | null
  }
  rulesDirectory: {
    path: string
    exists: boolean
    directory: boolean
  }
  mihomo: {
    path: string
    exists: boolean
    executable: boolean
    version: string | null
    error: LocalHelperErrorInfo | null
  }
}

export class LocalHelperRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'LocalHelperRequestError'
  }
}

const helperUrl = (path: string) => `${LOCAL_HELPER_BASE_URL}${path}`

const requestLocalHelper = async <T>(
  path: string,
  options: {
    signal?: AbortSignal
    timeout?: number
    method?: 'GET' | 'POST' | 'PUT'
    body?: object
  } = {},
): Promise<T> => {
  const controller = new AbortController()
  const timeoutId = window.setTimeout(() => controller.abort(), options.timeout ?? DEFAULT_TIMEOUT)
  const abort = () => controller.abort()
  options.signal?.addEventListener('abort', abort, { once: true })

  try {
    const response = await fetch(helperUrl(path), {
      method: options.method || 'GET',
      headers: {
        Accept: 'application/json',
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
      credentials: 'omit',
      cache: 'no-store',
      signal: controller.signal,
    })
    const body = (await response.json().catch(() => null)) as
      T | { error?: LocalHelperErrorInfo } | null

    if (!response.ok) {
      const error = body && typeof body === 'object' && 'error' in body ? body.error : undefined
      throw new LocalHelperRequestError(
        error?.code || 'HELPER_HTTP_ERROR',
        error?.message || `Local Helper returned HTTP ${response.status}.`,
        response.status,
      )
    }

    return body as T
  } catch (error) {
    if (error instanceof LocalHelperRequestError) {
      throw error
    }

    throw new LocalHelperRequestError(
      controller.signal.aborted ? 'HELPER_TIMEOUT' : 'HELPER_OFFLINE',
      controller.signal.aborted
        ? 'Local Helper request timed out.'
        : 'Local Helper is unavailable.',
    )
  } finally {
    window.clearTimeout(timeoutId)
    options.signal?.removeEventListener('abort', abort)
  }
}

export const probeLocalHelper = async (signal?: AbortSignal) => {
  try {
    const health = await requestLocalHelper<{
      status: 'ok'
      service: 'zashboard-local-helper'
    }>('/api/local/health', { signal, timeout: 1500 })

    return { online: true as const, health }
  } catch (error) {
    return {
      online: false as const,
      error:
        error instanceof LocalHelperRequestError
          ? error
          : new LocalHelperRequestError('HELPER_OFFLINE', 'Local Helper is unavailable.'),
    }
  }
}

export const fetchLocalConfigInfo = (signal?: AbortSignal) =>
  requestLocalHelper<LocalHelperConfigInfo>('/api/local/config-info', { signal })

export const fetchLocalRuleProviders = async (signal?: AbortSignal) => {
  const result = await requestLocalHelper<{ providers: LocalRuleProviderInfo[] }>(
    '/api/local/rule-providers',
    { signal },
  )

  if (!result || !Array.isArray(result.providers)) {
    throw new LocalHelperRequestError(
      'HELPER_INVALID_RESPONSE',
      'Local Helper returned an invalid Rule Provider response.',
    )
  }

  return result.providers
}

export const fetchLocalRuleProviderInfo = (name: string, signal?: AbortSignal) =>
  requestLocalHelper<LocalRuleProviderInfo>(
    `/api/local/rule-provider/${encodeURIComponent(name)}/info`,
    { signal },
  )

export type LocalProviderRulesResponse = {
  provider: LocalRuleProviderInfo
  entries: RuleEntry[]
  cache: 'hit' | 'miss'
}

export type RuleProviderFamily = 'all' | 'domain' | 'ip' | 'other'
export type RuleProviderSortKey = 'type' | 'content' | 'params' | 'raw'
export type RuleProviderSortDirection = 'default' | 'asc' | 'desc'

export type LocalProviderRuleItem = RuleEntry & {
  index: number
  family: Exclude<RuleProviderFamily, 'all'>
  params: string[]
}

export type LocalProviderRulePageResponse = {
  provider: LocalRuleProviderInfo
  total: number
  matched: number
  page: number
  pageSize: number
  hasMore: boolean
  counts: Record<RuleProviderFamily, number>
  items: LocalProviderRuleItem[]
  cache: 'hit' | 'miss'
}

export type LocalProviderRulePageQuery = {
  page: number
  pageSize: number
  family: RuleProviderFamily
  search?: string
  sortKey?: RuleProviderSortKey | null
  sortDirection: RuleProviderSortDirection
}

export const fetchLocalRuleProviderRules = (name: string, signal?: AbortSignal) =>
  requestLocalHelper<LocalProviderRulesResponse>(
    `/api/local/rule-provider/${encodeURIComponent(name)}/rules`,
    { signal, timeout: PROVIDER_RULES_TIMEOUT },
  )

export const fetchLocalRuleProviderRulePage = (
  name: string,
  query: LocalProviderRulePageQuery,
  signal?: AbortSignal,
) => {
  const searchParams = new URLSearchParams({
    page: String(query.page),
    pageSize: String(query.pageSize),
    family: query.family,
    sortDirection: query.sortDirection,
  })

  if (query.search) searchParams.set('search', query.search)
  if (query.sortKey) searchParams.set('sortKey', query.sortKey)

  return requestLocalHelper<LocalProviderRulePageResponse>(
    `/api/local/rule-provider/${encodeURIComponent(name)}/rules?${searchParams}`,
    { signal, timeout: PROVIDER_RULES_TIMEOUT },
  )
}

export const fetchLocalCustomRules = (signal?: AbortSignal) =>
  requestLocalHelper<CustomRulesState>('/api/local/custom-rules', { signal })

export const validateLocalCustomRules = (draft: CustomRulesDraft, signal?: AbortSignal) =>
  requestLocalHelper<CustomRulesValidation>('/api/local/custom-rules/validate', {
    method: 'POST',
    body: draft,
    signal,
    timeout: PROVIDER_RULES_TIMEOUT,
  })

export const saveLocalCustomRules = (input: CustomRulesSaveInput, signal?: AbortSignal) =>
  requestLocalHelper<CustomRulesState>('/api/local/custom-rules', {
    method: 'PUT',
    body: input,
    signal,
    timeout: PROVIDER_RULES_TIMEOUT,
  })

export const rollbackLocalCustomRules = (input: CustomRulesRestoreInput, signal?: AbortSignal) =>
  requestLocalHelper<CustomRulesState>('/api/local/custom-rules/rollback', {
    method: 'POST',
    body: input,
    signal,
    timeout: PROVIDER_RULES_TIMEOUT,
  })

export const restoreLocalCustomRules = (input: CustomRulesRestoreInput, signal?: AbortSignal) =>
  requestLocalHelper<CustomRulesState>('/api/local/custom-rules/restore', {
    method: 'POST',
    body: input,
    signal,
    timeout: PROVIDER_RULES_TIMEOUT,
  })
