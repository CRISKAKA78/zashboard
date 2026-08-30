import { randomUUID } from 'node:crypto'
import { parseDocument, stringify } from 'yaml'
import { LocalHelperError } from './errors.mjs'

export const CUSTOM_RULE_TYPES = Object.freeze([
  'DOMAIN',
  'DOMAIN-SUFFIX',
  'DOMAIN-KEYWORD',
  'IP-CIDR',
  'IP-CIDR6',
  'RULE-SET',
  'GEOIP',
  'MATCH',
])

const CUSTOM_RULE_TYPE_SET = new Set(CUSTOM_RULE_TYPES)
const FALLBACK_TYPES = new Set(['MATCH', 'FINAL'])
const MAX_RULES_PER_SECTION = 1000
const MAX_FIELD_LENGTH = 2048
const ID_PATTERN = /^[\w-]{1,100}$/u
const PARAM_PATTERN = /^[\w=:+./-]{1,100}$/u

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

const normalizeType = (value) => {
  const compact = String(value || '')
    .trim()
    .replace(/[\s_-]+/gu, '')
    .toUpperCase()
  const aliases = {
    DOMAIN: 'DOMAIN',
    DOMAINSUFFIX: 'DOMAIN-SUFFIX',
    DOMAINKEYWORD: 'DOMAIN-KEYWORD',
    IPCIDR: 'IP-CIDR',
    IPCIDR6: 'IP-CIDR6',
    RULESET: 'RULE-SET',
    GEOIP: 'GEOIP',
    MATCH: 'MATCH',
    FINAL: 'FINAL',
  }
  return aliases[compact] || compact
}

const cleanField = (value, label, { required = true } = {}) => {
  if (typeof value !== 'string') {
    throw new LocalHelperError('CUSTOM_RULE_INVALID', `${label} must be a string.`, 422)
  }
  const cleaned = value.trim()
  if (required && !cleaned) {
    throw new LocalHelperError('CUSTOM_RULE_INVALID', `${label} is required.`, 422)
  }
  if (cleaned.length > MAX_FIELD_LENGTH || /[\r\n]/u.test(cleaned)) {
    throw new LocalHelperError(
      'CUSTOM_RULE_INVALID',
      `${label} is too long or contains a line break.`,
      422,
    )
  }
  return cleaned
}

const parseRawRule = (raw) => {
  const cleaned = cleanField(raw, 'Raw rule')
  const fields = cleaned.split(',').map((field) => field.trim())
  const type = normalizeType(fields[0])

  if (!CUSTOM_RULE_TYPE_SET.has(type)) {
    throw new LocalHelperError(
      'CUSTOM_RULE_TYPE_UNSUPPORTED',
      `Custom rule type "${fields[0]}" is not supported.`,
      422,
    )
  }

  const isMatch = type === 'MATCH'
  const minimumFields = isMatch ? 2 : 3
  if (fields.length < minimumFields || fields.some((field) => !field)) {
    throw new LocalHelperError(
      'CUSTOM_RULE_INVALID',
      `Raw ${type} rule must contain ${minimumFields} non-empty fields.`,
      422,
    )
  }

  const value = isMatch ? '' : fields[1]
  const target = isMatch ? fields[1] : fields[2]
  const params = fields.slice(isMatch ? 2 : 3)
  return { type, value, target, params, raw: fields.join(',') }
}

const validateParams = (params) => {
  if (!Array.isArray(params) || params.length > 8) {
    throw new LocalHelperError(
      'CUSTOM_RULE_INVALID',
      'Additional parameters must be an array with at most 8 entries.',
      422,
    )
  }

  return params.map((param) => {
    const cleaned = cleanField(param, 'Additional parameter')
    if (!PARAM_PATTERN.test(cleaned) || cleaned.includes(',')) {
      throw new LocalHelperError(
        'CUSTOM_RULE_INVALID',
        `Additional parameter "${cleaned}" is invalid.`,
        422,
      )
    }
    return cleaned
  })
}

const normalizeRule = (input, section, index) => {
  if (!isRecord(input)) {
    throw new LocalHelperError(
      'CUSTOM_RULE_INVALID',
      `${section}[${index}] must be an object.`,
      422,
    )
  }

  const id = input.id === undefined ? randomUUID() : cleanField(input.id, 'Rule id')
  if (!ID_PATTERN.test(id)) {
    throw new LocalHelperError('CUSTOM_RULE_INVALID', `Rule id "${id}" is invalid.`, 422)
  }

  const mode = input.mode === 'raw' ? 'raw' : 'structured'
  const parsed = mode === 'raw' ? parseRawRule(input.raw) : null
  const type = parsed?.type || normalizeType(input.type)
  if (!CUSTOM_RULE_TYPE_SET.has(type)) {
    throw new LocalHelperError(
      'CUSTOM_RULE_TYPE_UNSUPPORTED',
      `Custom rule type "${input.type}" is not supported.`,
      422,
    )
  }

  const value =
    parsed?.value ?? cleanField(input.value || '', 'Rule value', { required: type !== 'MATCH' })
  const target = parsed?.target ?? cleanField(input.target, 'Rule target')
  const params = validateParams(parsed?.params ?? input.params ?? [])
  for (const [label, field] of [
    ['Rule value', value],
    ['Rule target', target],
  ]) {
    if (field.includes(',')) {
      throw new LocalHelperError('CUSTOM_RULE_INVALID', `${label} cannot contain a comma.`, 422)
    }
  }

  const raw = [type, ...(type === 'MATCH' ? [] : [value]), target, ...params].join(',')
  return { id, mode, type, value, target, params, raw }
}

const normalizeSection = (value, section) => {
  if (!Array.isArray(value)) {
    throw new LocalHelperError('CUSTOM_RULES_INVALID', `${section} rules must be an array.`, 422)
  }
  if (value.length > MAX_RULES_PER_SECTION) {
    throw new LocalHelperError(
      'CUSTOM_RULES_LIMIT_EXCEEDED',
      `${section} rules cannot exceed ${MAX_RULES_PER_SECTION} entries.`,
      422,
    )
  }
  return value.map((rule, index) => normalizeRule(rule, section, index))
}

export const normalizeCustomRules = (input, baseConfig = {}) => {
  if (!isRecord(input)) {
    throw new LocalHelperError(
      'CUSTOM_RULES_INVALID',
      'Custom rules payload must be an object.',
      422,
    )
  }

  const pre = normalizeSection(input.pre ?? [], 'Pre')
  const post = normalizeSection(input.post ?? [], 'Post')
  const ids = new Set()
  for (const rule of [...pre, ...post]) {
    if (ids.has(rule.id)) {
      throw new LocalHelperError(
        'CUSTOM_RULE_ID_DUPLICATE',
        `Custom rule id "${rule.id}" is duplicated.`,
        422,
      )
    }
    ids.add(rule.id)
  }

  if (pre.some((rule) => rule.type === 'MATCH')) {
    throw new LocalHelperError(
      'CUSTOM_MATCH_POSITION_INVALID',
      'MATCH is only allowed as the last Post custom rule.',
      422,
    )
  }

  const matchIndex = post.findIndex((rule) => rule.type === 'MATCH')
  if (matchIndex >= 0 && matchIndex !== post.length - 1) {
    throw new LocalHelperError(
      'CUSTOM_MATCH_POSITION_INVALID',
      'MATCH must be the last Post custom rule.',
      422,
    )
  }

  const originalRules = Array.isArray(baseConfig.rules) ? baseConfig.rules : []
  const hasOriginalFallback = originalRules.some(
    (rule) => typeof rule === 'string' && FALLBACK_TYPES.has(normalizeType(rule.split(',')[0])),
  )
  if (matchIndex >= 0 && hasOriginalFallback) {
    throw new LocalHelperError(
      'CUSTOM_MATCH_CONFLICTS_WITH_FALLBACK',
      'Custom MATCH cannot be used while the source configuration already has MATCH or FINAL.',
      422,
    )
  }

  return { pre, post }
}

const requireOriginalRules = (baseConfig) => {
  if (baseConfig.rules === undefined || baseConfig.rules === null) return []
  if (
    !Array.isArray(baseConfig.rules) ||
    baseConfig.rules.some((rule) => typeof rule !== 'string')
  ) {
    throw new LocalHelperError(
      'CONFIG_RULES_INVALID',
      'Source configuration rules must be a YAML sequence of strings.',
      422,
    )
  }
  return baseConfig.rules.map((rule) => rule.trim()).filter(Boolean)
}

export const buildManagedConfig = (baseConfig, customRules) => {
  if (!isRecord(baseConfig)) {
    throw new LocalHelperError(
      'CONFIG_ROOT_INVALID',
      'Source configuration must be a mapping.',
      422,
    )
  }
  const originalRules = requireOriginalRules(baseConfig)
  const firstFallback = originalRules.findIndex((rule) =>
    FALLBACK_TYPES.has(normalizeType(rule.split(',')[0])),
  )
  const nonFallback = firstFallback < 0 ? originalRules : originalRules.slice(0, firstFallback)
  const fallback = firstFallback < 0 ? [] : originalRules.slice(firstFallback)

  return {
    ...baseConfig,
    rules: [
      ...customRules.pre.map((rule) => rule.raw),
      ...nonFallback,
      ...customRules.post.map((rule) => rule.raw),
      ...fallback,
    ],
  }
}

export const serializeCustomRuleFile = (rules) =>
  stringify(
    {
      version: 1,
      rules: rules.map(({ id, mode, type, value, target, params, raw }) => ({
        id,
        mode,
        type,
        value,
        target,
        ...(params.length ? { params } : {}),
        raw,
      })),
    },
    { lineWidth: 0 },
  )

export const parseCustomRuleFile = (source, label) => {
  if (!source) return []
  const document = parseDocument(source, { prettyErrors: true, uniqueKeys: true })
  if (document.errors.length) {
    throw new LocalHelperError(
      'CUSTOM_RULES_YAML_INVALID',
      `${label} custom rules YAML is invalid: ${document.errors[0].message}`,
      422,
    )
  }
  const value = document.toJS({ maxAliasCount: 20 })
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.rules)) {
    throw new LocalHelperError(
      'CUSTOM_RULES_YAML_INVALID',
      `${label} custom rules file must contain version: 1 and a rules sequence.`,
      422,
    )
  }
  return value.rules
}

export const serializeManagedConfig = (config) => stringify(config, { lineWidth: 0 })
