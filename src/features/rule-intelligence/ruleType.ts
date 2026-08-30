const RULE_TYPE_ALIASES = new Map([
  ['RULESET', 'RULE-SET'],
  ['DOMAINSUFFIX', 'DOMAIN-SUFFIX'],
  ['DOMAINKEYWORD', 'DOMAIN-KEYWORD'],
  ['IPCIDR', 'IP-CIDR'],
  ['IPCIDR6', 'IP-CIDR6'],
])

export const normalizeRuleType = (type: string) => {
  const normalized = type
    .trim()
    .replace(/[\s_]+/gu, '-')
    .toUpperCase()
  return RULE_TYPE_ALIASES.get(normalized.replaceAll('-', '')) ?? normalized
}
