import { LocalHelperError } from './errors.mjs'

export const RULE_PROVIDER_PAGE_SIZE = 100
export const RULE_PROVIDER_MAX_PAGE_SIZE = 500

const EXPLORER_QUERY_KEYS = new Set([
  'page',
  'pageSize',
  'family',
  'search',
  'sortKey',
  'sortDirection',
])
const FAMILIES = new Set(['all', 'domain', 'ip', 'other'])
const SORT_KEYS = new Set(['type', 'content', 'params', 'raw'])
const SORT_DIRECTIONS = new Set(['default', 'asc', 'desc'])
const DOMAIN_TYPES = new Set([
  'DOMAIN',
  'DOMAIN-SUFFIX',
  'DOMAIN-KEYWORD',
  'DOMAIN-REGEX',
  'DOMAIN-WILDCARD',
  'GEOSITE',
])
const IP_TYPES = new Set([
  'IP-CIDR',
  'IP-CIDR6',
  'IP-SUFFIX',
  'IP-ASN',
  'GEOIP',
  'SRC-IP',
  'SRC-IP-CIDR',
  'SRC-IP-CIDR6',
  'SRC-IP-SUFFIX',
  'SRC-IP-ASN',
  'SRC-GEOIP',
])

const normalizeType = (type) =>
  String(type || '')
    .trim()
    .replaceAll('_', '-')
    .toUpperCase()

export const getRuleEntryFamily = (entry) => {
  const type = normalizeType(entry.type)

  if (DOMAIN_TYPES.has(type)) return 'domain'
  if (IP_TYPES.has(type)) return 'ip'
  return 'other'
}

export const getRuleEntryParams = (entry) => {
  const fields = String(entry.raw || '')
    .split(',')
    .map((field) => field.trim())

  if (fields.length < 3 || normalizeType(fields[0]) !== normalizeType(entry.type)) {
    return []
  }

  return fields.slice(2).filter(Boolean)
}

const readQueryValue = (query, key) => {
  if (query instanceof URLSearchParams) return query.get(key)
  return query?.[key] ?? null
}

const queryError = (message) => new LocalHelperError('RULE_PROVIDER_QUERY_INVALID', message, 400)

const parsePositiveInteger = (value, fallback, label, maximum = Number.MAX_SAFE_INTEGER) => {
  if (value === null || value === undefined || value === '') return fallback

  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw queryError(`${label} must be an integer between 1 and ${maximum}.`)
  }
  return parsed
}

const parseQuery = (query) => {
  const page = parsePositiveInteger(readQueryValue(query, 'page'), 1, 'page')
  const pageSize = parsePositiveInteger(
    readQueryValue(query, 'pageSize'),
    RULE_PROVIDER_PAGE_SIZE,
    'pageSize',
    RULE_PROVIDER_MAX_PAGE_SIZE,
  )
  const family = String(readQueryValue(query, 'family') || 'all').toLowerCase()
  const search = String(readQueryValue(query, 'search') || '').trim()
  const sortKeyValue = readQueryValue(query, 'sortKey')
  const sortKey = sortKeyValue ? String(sortKeyValue) : null
  const sortDirection = String(readQueryValue(query, 'sortDirection') || 'default').toLowerCase()

  if (!FAMILIES.has(family)) throw queryError('family is not supported.')
  if (search.length > 512) throw queryError('search must not exceed 512 characters.')
  if (sortKey !== null && !SORT_KEYS.has(sortKey)) throw queryError('sortKey is not supported.')
  if (!SORT_DIRECTIONS.has(sortDirection)) {
    throw queryError('sortDirection is not supported.')
  }
  if (sortDirection !== 'default' && sortKey === null) {
    throw queryError('sortKey is required when sorting is enabled.')
  }

  return { page, pageSize, family, search, sortKey, sortDirection }
}

const getSortValue = (item, sortKey) => {
  switch (sortKey) {
    case 'type':
      return item.entry.type
    case 'params':
      return item.params.join(',')
    case 'raw':
      return item.entry.raw
    default:
      return item.entry.value
  }
}

const compareText = (left, right) =>
  String(left || '').localeCompare(String(right || ''), undefined, {
    numeric: true,
    sensitivity: 'base',
  })

export const hasRuleProviderExplorerQuery = (searchParams) =>
  [...searchParams.keys()].some((key) => EXPLORER_QUERY_KEYS.has(key))

export const createRuleProviderPage = (providerResult, query = {}) => {
  const options = parseQuery(query)
  const search = options.search.toLocaleLowerCase()
  const counts = { all: 0, domain: 0, ip: 0, other: 0 }
  const matches = []

  providerResult.entries.forEach((entry, index) => {
    const family = getRuleEntryFamily(entry)
    const params = getRuleEntryParams(entry)
    counts.all += 1
    counts[family] += 1

    if (options.family !== 'all' && family !== options.family) return

    if (search) {
      const searchable = [entry.type, entry.value, entry.raw, ...params]
        .join('\n')
        .toLocaleLowerCase()
      if (!searchable.includes(search)) return
    }

    matches.push({ entry, index, family, params })
  })

  if (options.sortDirection !== 'default') {
    const direction = options.sortDirection === 'asc' ? 1 : -1
    matches.sort((left, right) => {
      const comparison = compareText(
        getSortValue(left, options.sortKey),
        getSortValue(right, options.sortKey),
      )
      return comparison === 0 ? left.index - right.index : comparison * direction
    })
  }

  const matched = matches.length
  const lastPage = Math.max(1, Math.ceil(matched / options.pageSize))
  const page = Math.min(options.page, lastPage)
  const start = (page - 1) * options.pageSize
  const items = matches.slice(start, start + options.pageSize).map((item) => ({
    ...item.entry,
    index: item.index + 1,
    family: item.family,
    params: item.params,
  }))

  return {
    provider: providerResult.provider,
    total: providerResult.entries.length,
    matched,
    page,
    pageSize: options.pageSize,
    hasMore: start + items.length < matched,
    counts,
    items,
    cache: providerResult.cache,
  }
}
