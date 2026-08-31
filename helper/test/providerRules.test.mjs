import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { clearProviderRulesCache, getRuleProviderRules } from '../src/providerRules.mjs'

const createFixture = async (testContext, { behavior, format, extension, content }) => {
  const root = await mkdtemp(join(tmpdir(), 'zashboard-provider-rules-'))
  const rulesDir = join(root, 'rules')
  const configPath = join(root, 'config.yaml')
  const providerPath = join(rulesDir, `provider.${extension}`)
  await mkdir(rulesDir)
  await writeFile(providerPath, content)
  await writeFile(
    configPath,
    `rule-providers:\n  Test:\n    type: file\n    behavior: ${behavior}\n    format: ${format}\n    path: ./rules/provider.${extension}\n`,
  )
  testContext.after(() => rm(root, { recursive: true, force: true }))
  clearProviderRulesCache()

  return {
    settings: {
      configPath,
      rulesDir,
      binaryPath: join(root, 'missing-mihomo'),
      host: '127.0.0.1',
      port: 0,
      maxProviderBytes: 1024 * 1024,
      mrsConversionTimeout: 1000,
      allowedOrigins: [],
    },
    providerPath,
  }
}

describe('Text/YAML Rule Provider parsing', () => {
  it('normalizes a YAML domain payload with source lines', async (t) => {
    const fixture = await createFixture(t, {
      behavior: 'domain',
      format: 'yaml',
      extension: 'yaml',
      content: `payload:\n  - '+.google.com'\n  - 'chatgpt.com'\n`,
    })

    const result = await getRuleProviderRules(fixture.settings, 'Test')

    assert.equal(result.provider.editable, true)
    assert.equal(typeof result.version, 'string')
    assert.equal(result.entries[0].type, 'DOMAIN-SUFFIX')
    assert.equal(result.entries[0].value, 'google.com')
    assert.equal(result.entries[0].line, 2)
    assert.equal(result.entries[1].type, 'DOMAIN')
  })

  it('normalizes classical text rules and reuses the metadata cache', async (t) => {
    const fixture = await createFixture(t, {
      behavior: 'classical',
      format: 'text',
      extension: 'txt',
      content: `# comment\nDOMAIN-KEYWORD,openai\nIP-CIDR,8.8.8.0/24\n`,
    })

    const first = await getRuleProviderRules(fixture.settings, 'Test')
    const second = await getRuleProviderRules(fixture.settings, 'Test')

    assert.equal(first.cache, 'miss')
    assert.equal(second.cache, 'hit')
    assert.deepEqual(
      first.entries.map(({ type, value }) => ({ type, value })),
      [
        { type: 'DOMAIN-KEYWORD', value: 'openai' },
        { type: 'IP-CIDR', value: '8.8.8.0/24' },
      ],
    )
  })

  it('invalidates the text cache when Provider metadata changes', async (t) => {
    const fixture = await createFixture(t, {
      behavior: 'domain',
      format: 'text',
      extension: 'txt',
      content: `first.example\n`,
    })

    const first = await getRuleProviderRules(fixture.settings, 'Test')
    await writeFile(fixture.providerPath, `second.example\nthird.example\n`)
    const changedTime = new Date(Date.now() + 5000)
    await utimes(fixture.providerPath, changedTime, changedTime)
    const second = await getRuleProviderRules(fixture.settings, 'Test')

    assert.equal(first.entries[0].value, 'first.example')
    assert.deepEqual(
      second.entries.map((item) => item.value),
      ['second.example', 'third.example'],
    )
    assert.equal(second.cache, 'miss')
  })

  it('normalizes an ipcidr text payload as IPv4 and IPv6 entries', async (t) => {
    const fixture = await createFixture(t, {
      behavior: 'ipcidr',
      format: 'text',
      extension: 'txt',
      content: `8.8.8.0/24\n2001:db8::/32\n`,
    })

    const result = await getRuleProviderRules(fixture.settings, 'Test')
    assert.deepEqual(
      result.entries.map((entry) => entry.type),
      ['IP-CIDR', 'IP-CIDR6'],
    )
  })

  it('rejects an unsupported Provider format without affecting other providers', async (t) => {
    const fixture = await createFixture(t, {
      behavior: 'classical',
      format: 'binary',
      extension: 'bin',
      content: 'not-a-supported-provider',
    })

    await assert.rejects(
      getRuleProviderRules(fixture.settings, 'Test'),
      (error) => error.code === 'RULE_PROVIDER_FORMAT_UNSUPPORTED' && error.status === 415,
    )
  })

  it('normalizes a domain MRS conversion into the shared RuleEntry shape', async (t) => {
    const fixture = await createFixture(t, {
      behavior: 'domain',
      format: 'mrs',
      extension: 'mrs',
      content: 'binary',
    })
    const result = await getRuleProviderRules(fixture.settings, 'Test', {
      convertMrs: async ({ behavior, sourcePath }) => {
        assert.equal(behavior, 'domain')
        assert.equal(sourcePath, await realpath(fixture.providerPath))
        return {
          source: `+.openai.com\nchatgpt.com\n`,
          stat: await stat(sourcePath),
        }
      },
    })

    assert.equal(result.provider.editable, false)
    assert.equal(result.version, null)
    assert.deepEqual(
      result.entries.map(({ source, type, value, raw, behavior, format, line }) => ({
        source,
        type,
        value,
        raw,
        behavior,
        format,
        line,
      })),
      [
        {
          source: 'Test',
          type: 'DOMAIN-SUFFIX',
          value: 'openai.com',
          raw: 'DOMAIN-SUFFIX,openai.com',
          behavior: 'domain',
          format: 'mrs',
          line: undefined,
        },
        {
          source: 'Test',
          type: 'DOMAIN',
          value: 'chatgpt.com',
          raw: 'DOMAIN,chatgpt.com',
          behavior: 'domain',
          format: 'mrs',
          line: undefined,
        },
      ],
    )
  })

  it('normalizes an ipcidr MRS conversion into IPv4 and IPv6 RuleEntry values', async (t) => {
    const fixture = await createFixture(t, {
      behavior: 'ipcidr',
      format: 'mrs',
      extension: 'mrs',
      content: 'binary',
    })
    const result = await getRuleProviderRules(fixture.settings, 'Test', {
      convertMrs: async ({ sourcePath }) => ({
        source: `8.8.8.0/24\n2001:db8::/32\n`,
        stat: await stat(sourcePath),
      }),
    })

    assert.deepEqual(
      result.entries.map(({ type, value, raw, format }) => ({ type, value, raw, format })),
      [
        { type: 'IP-CIDR', value: '8.8.8.0/24', raw: 'IP-CIDR,8.8.8.0/24', format: 'mrs' },
        {
          type: 'IP-CIDR6',
          value: '2001:db8::/32',
          raw: 'IP-CIDR6,2001:db8::/32',
          format: 'mrs',
        },
      ],
    )
  })

  it('reuses a cached MRS conversion while metadata is unchanged', async (t) => {
    const fixture = await createFixture(t, {
      behavior: 'domain',
      format: 'mrs',
      extension: 'mrs',
      content: 'binary-one',
    })
    let conversionCount = 0
    const convertMrs = async ({ sourcePath }) => {
      conversionCount += 1
      return { source: 'cached.example\n', stat: await stat(sourcePath) }
    }

    const first = await getRuleProviderRules(fixture.settings, 'Test', { convertMrs })
    const second = await getRuleProviderRules(fixture.settings, 'Test', { convertMrs })

    assert.equal(first.cache, 'miss')
    assert.equal(second.cache, 'hit')
    assert.equal(conversionCount, 1)
  })

  it('invalidates the MRS cache when mtime changes', async (t) => {
    const fixture = await createFixture(t, {
      behavior: 'domain',
      format: 'mrs',
      extension: 'mrs',
      content: 'binary-one',
    })
    let conversionCount = 0
    const convertMrs = async ({ sourcePath }) => {
      conversionCount += 1
      return { source: `version-${conversionCount}.example\n`, stat: await stat(sourcePath) }
    }

    const first = await getRuleProviderRules(fixture.settings, 'Test', { convertMrs })
    const changedTime = new Date(Date.now() + 5000)
    await utimes(fixture.providerPath, changedTime, changedTime)
    const second = await getRuleProviderRules(fixture.settings, 'Test', { convertMrs })

    assert.equal(first.entries[0].value, 'version-1.example')
    assert.equal(second.entries[0].value, 'version-2.example')
    assert.equal(conversionCount, 2)
  })

  it('deduplicates concurrent conversion requests for the same MRS Provider', async (t) => {
    const fixture = await createFixture(t, {
      behavior: 'domain',
      format: 'mrs',
      extension: 'mrs',
      content: 'binary',
    })
    let conversionCount = 0
    const convertMrs = async ({ sourcePath }) => {
      conversionCount += 1
      await new Promise((resolve) => setTimeout(resolve, 25))
      return { source: 'shared.example\n', stat: await stat(sourcePath) }
    }

    const [first, second, third] = await Promise.all([
      getRuleProviderRules(fixture.settings, 'Test', { convertMrs }),
      getRuleProviderRules(fixture.settings, 'Test', { convertMrs }),
      getRuleProviderRules(fixture.settings, 'Test', { convertMrs }),
    ])

    assert.equal(conversionCount, 1)
    assert.deepEqual([first.cache, second.cache, third.cache].sort(), ['hit', 'hit', 'miss'])
    assert.equal(third.entries[0].value, 'shared.example')
  })
})
