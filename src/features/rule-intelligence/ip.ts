type ParsedIpAddress = {
  version: 4 | 6
  bits: 32 | 128
  value: bigint
}

const parseIpv4Parts = (input: string) => {
  const parts = input.split('.')

  if (parts.length !== 4) return null

  const octets = parts.map((part) => {
    if (!/^\d{1,3}$/u.test(part)) return Number.NaN
    const value = Number(part)
    return value >= 0 && value <= 255 ? value : Number.NaN
  })

  return octets.every(Number.isFinite) ? octets : null
}

const parseIpv4 = (input: string): ParsedIpAddress | null => {
  const octets = parseIpv4Parts(input)
  if (!octets) return null

  let value = 0n
  for (const octet of octets) {
    value = (value << 8n) | BigInt(octet)
  }

  return { version: 4, bits: 32, value }
}

const expandEmbeddedIpv4 = (input: string) => {
  if (!input.includes('.')) return input

  const separator = input.lastIndexOf(':')
  if (separator < 0) return null

  const octets = parseIpv4Parts(input.slice(separator + 1))
  if (!octets) return null

  const high = ((octets[0] << 8) | octets[1]).toString(16)
  const low = ((octets[2] << 8) | octets[3]).toString(16)
  return `${input.slice(0, separator)}:${high}:${low}`
}

const parseIpv6 = (input: string): ParsedIpAddress | null => {
  const expandedInput = expandEmbeddedIpv4(input.toLowerCase())
  if (!expandedInput || expandedInput.includes('%')) return null

  const compressionParts = expandedInput.split('::')
  if (compressionParts.length > 2) return null

  const left = compressionParts[0] ? compressionParts[0].split(':') : []
  const right = compressionParts[1] ? compressionParts[1].split(':') : []
  const hasCompression = compressionParts.length === 2
  const missing = 8 - left.length - right.length

  if ((!hasCompression && missing !== 0) || (hasCompression && missing < 1)) return null

  const parts = [...left, ...Array.from({ length: missing }, () => '0'), ...right]
  if (parts.length !== 8 || parts.some((part) => !/^[\da-f]{1,4}$/u.test(part))) return null

  let value = 0n
  for (const part of parts) {
    value = (value << 16n) | BigInt(`0x${part}`)
  }

  return { version: 6, bits: 128, value }
}

export const parseIpAddress = (input: string): ParsedIpAddress | null =>
  parseIpv4(input) || parseIpv6(input)

export const isIpInCidr = (addressInput: string, cidrInput: string) => {
  const address = parseIpAddress(addressInput)
  const separator = cidrInput.lastIndexOf('/')

  if (!address || separator < 0) return false

  const network = parseIpAddress(cidrInput.slice(0, separator))
  const prefixText = cidrInput.slice(separator + 1)
  if (!network || network.version !== address.version || !/^\d{1,3}$/u.test(prefixText)) {
    return false
  }

  const prefix = Number(prefixText)
  if (prefix < 0 || prefix > address.bits) return false

  const shift = BigInt(address.bits - prefix)
  return address.value >> shift === network.value >> shift
}
