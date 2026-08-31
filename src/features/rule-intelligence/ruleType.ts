/**
 * Mihomo v1.19.30 rule types. The Controller serializes these as CamelCase
 * while configuration files and Rule Providers use upper-case kebab-case.
 * Keep every official spelling on one normalization path so new consumers do
 * not silently miss a rule merely because it came from a different API.
 */
const RULE_TYPE_ALIASES = new Map<string, string>([
  ['DOMAIN', 'DOMAIN'],
  ['DOMAINSUFFIX', 'DOMAIN-SUFFIX'],
  ['DOMAINKEYWORD', 'DOMAIN-KEYWORD'],
  ['DOMAINREGEX', 'DOMAIN-REGEX'],
  ['DOMAINWILDCARD', 'DOMAIN-WILDCARD'],
  ['GEOSITE', 'GEOSITE'],
  ['GEOIP', 'GEOIP'],
  ['SRCGEOIP', 'SRC-GEOIP'],
  ['IPASN', 'IP-ASN'],
  ['SRCIPASN', 'SRC-IP-ASN'],
  ['IPCIDR', 'IP-CIDR'],
  ['IPCIDR6', 'IP-CIDR6'],
  ['SRCIPCIDR', 'SRC-IP-CIDR'],
  ['SRCIPCIDR6', 'SRC-IP-CIDR6'],
  ['IPSUFFIX', 'IP-SUFFIX'],
  ['SRCIPSUFFIX', 'SRC-IP-SUFFIX'],
  ['SRCPORT', 'SRC-PORT'],
  ['DSTPORT', 'DST-PORT'],
  ['INPORT', 'IN-PORT'],
  ['DSCP', 'DSCP'],
  ['INUSER', 'IN-USER'],
  ['INNAME', 'IN-NAME'],
  ['INTYPE', 'IN-TYPE'],
  ['PROCESSNAME', 'PROCESS-NAME'],
  ['PROCESSPATH', 'PROCESS-PATH'],
  ['PROCESSNAMEREGEX', 'PROCESS-NAME-REGEX'],
  ['PROCESSPATHREGEX', 'PROCESS-PATH-REGEX'],
  ['PROCESSNAMEWILDCARD', 'PROCESS-NAME-WILDCARD'],
  ['PROCESSPATHWILDCARD', 'PROCESS-PATH-WILDCARD'],
  ['REMATCHNAME', 'REMATCH-NAME'],
  ['RULESET', 'RULE-SET'],
  ['NETWORK', 'NETWORK'],
  ['UID', 'UID'],
  ['SUBRULE', 'SUB-RULE'],
  ['SUBRULES', 'SUB-RULE'],
  ['MATCH', 'MATCH'],
  ['FINAL', 'FINAL'],
  ['AND', 'AND'],
  ['OR', 'OR'],
  ['NOT', 'NOT'],
])

export const DOMAIN_RULE_TYPES = new Set([
  'DOMAIN',
  'DOMAIN-SUFFIX',
  'DOMAIN-KEYWORD',
  'DOMAIN-REGEX',
  'DOMAIN-WILDCARD',
  'GEOSITE',
])

export const DESTINATION_IP_RULE_TYPES = new Set([
  'IP-CIDR',
  'IP-CIDR6',
  'IP-SUFFIX',
  'IP-ASN',
  'GEOIP',
])

export const SOURCE_IP_RULE_TYPES = new Set([
  'SRC-IP-CIDR',
  'SRC-IP-CIDR6',
  'SRC-IP-SUFFIX',
  'SRC-IP-ASN',
  'SRC-GEOIP',
])

export const CONTEXT_RULE_TYPES = new Set([
  ...SOURCE_IP_RULE_TYPES,
  'SRC-PORT',
  'DST-PORT',
  'IN-PORT',
  'DSCP',
  'IN-USER',
  'IN-NAME',
  'IN-TYPE',
  'PROCESS-NAME',
  'PROCESS-PATH',
  'PROCESS-NAME-REGEX',
  'PROCESS-PATH-REGEX',
  'PROCESS-NAME-WILDCARD',
  'PROCESS-PATH-WILDCARD',
  'REMATCH-NAME',
  'NETWORK',
  'UID',
  'SUB-RULE',
  'AND',
  'OR',
  'NOT',
])

export const normalizeRuleType = (type: string) => {
  const normalized = type
    .trim()
    .replace(/[\s_]+/gu, '-')
    .toUpperCase()
  return RULE_TYPE_ALIASES.get(normalized.replaceAll('-', '')) ?? normalized
}
