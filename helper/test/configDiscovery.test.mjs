import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { getConfigInfo, getRuleProviderInfo, listRuleProviders } from '../src/configDiscovery.mjs'
import { LocalHelperError } from '../src/errors.mjs'
import { inspectMihomoBinary } from '../src/mihomo.mjs'

const createFixture = async (testContext) => {
  const root = await mkdtemp(join(tmpdir(), 'zashboard-helper-'))
  const configDir = join(root, 'mihomo')
  const configPath = join(configDir, 'config.yaml')
  const rulesDir = join(configDir, 'rules')

  await mkdir(rulesDir, { recursive: true })
  testContext.after(() => rm(root, { recursive: true, force: true }))

  return {
    root,
    configDir,
    configPath,
    rulesDir,
    settings: {
      configPath,
      rulesDir,
      binaryPath: join(root, 'missing-mihomo'),
      host: '127.0.0.1',
      port: 0,
      allowedOrigins: [],
    },
  }
}

const providerConfig = (path) => `
rule-providers:
  OpenAI:
    type: http
    behavior: domain
    format: mrs
    path: ${JSON.stringify(path)}
    url: https://example.com/openai.mrs
    interval: 86400
`

const providerConfigWithoutPath = `
rule-providers:
  OpenAI:
    type: http
    behavior: domain
    format: mrs
    url: https://example.com/openai.mrs
    interval: 86400
`

describe('Local Helper configuration discovery', () => {
  it('reports an existing valid config', async (t) => {
    const fixture = await createFixture(t)
    await writeFile(fixture.configPath, 'rule-providers: {}\n')

    const info = await getConfigInfo(fixture.settings)

    assert.equal(info.config.exists, true)
    assert.equal(info.config.valid, true)
    assert.equal(info.config.ruleProviderCount, 0)
  })

  it('reports a missing config without crashing health information', async (t) => {
    const fixture = await createFixture(t)

    const info = await getConfigInfo(fixture.settings)
    assert.equal(info.config.exists, false)
    assert.equal(info.config.error.code, 'CONFIG_NOT_FOUND')
    await assert.rejects(
      () => listRuleProviders(fixture.settings),
      (error) => error instanceof LocalHelperError && error.code === 'CONFIG_NOT_FOUND',
    )
  })

  it('rejects invalid YAML', async (t) => {
    const fixture = await createFixture(t)
    await writeFile(fixture.configPath, 'rule-providers: [\n')

    const info = await getConfigInfo(fixture.settings)
    assert.equal(info.config.valid, false)
    assert.equal(info.config.error.code, 'CONFIG_YAML_INVALID')
    await assert.rejects(
      () => listRuleProviders(fixture.settings),
      (error) => error instanceof LocalHelperError && error.code === 'CONFIG_YAML_INVALID',
    )
  })

  it('returns an empty list when rule-providers is empty', async (t) => {
    const fixture = await createFixture(t)
    await writeFile(fixture.configPath, 'rule-providers: {}\n')

    assert.deepEqual(await listRuleProviders(fixture.settings), [])
  })

  it('resolves a relative provider path and reads metadata', async (t) => {
    const fixture = await createFixture(t)
    const rulePath = join(fixture.rulesDir, 'openai.mrs')
    await writeFile(rulePath, 'rules')
    await writeFile(fixture.configPath, providerConfig('./rules/openai.mrs'))

    const [provider] = await listRuleProviders(fixture.settings)

    assert.equal(provider.path, await realpath(rulePath))
    assert.equal(provider.pathAccess, 'allowed')
    assert.equal(provider.exists, true)
    assert.equal(provider.size, 5)
    assert.match(provider.mtime, /^\d{4}-\d{2}-\d{2}T/)
  })

  it('reports RULE-SET targets and no-resolve modifiers', async (t) => {
    const fixture = await createFixture(t)
    await writeFile(
      fixture.configPath,
      `${providerConfig('./rules/openai.mrs')}
rules:
  - RULE-SET,OpenAI,AI,no-resolve
  - RuleSet,OpenAI,Fallback
`,
    )

    const [provider] = await listRuleProviders(fixture.settings)

    assert.deepEqual(provider.ruleReferences, [
      { target: 'AI', noResolve: true },
      { target: 'Fallback', noResolve: false },
    ])
  })

  it('accepts an absolute provider path inside MIHOMO_RULES_DIR', async (t) => {
    const fixture = await createFixture(t)
    const rulePath = join(fixture.rulesDir, 'absolute.yaml')
    await writeFile(rulePath, 'payload: []\n')
    await writeFile(fixture.configPath, providerConfig(rulePath))

    const provider = await getRuleProviderInfo(fixture.settings, 'OpenAI')

    assert.equal(provider.path, await realpath(rulePath))
    assert.equal(provider.exists, true)
  })

  it('reports a missing provider file inside the allowed directory', async (t) => {
    const fixture = await createFixture(t)
    await writeFile(fixture.configPath, providerConfig('./rules/missing.mrs'))

    const provider = await getRuleProviderInfo(fixture.settings, 'OpenAI')

    assert.equal(provider.path, join(await realpath(fixture.rulesDir), 'missing.mrs'))
    assert.equal(provider.pathAccess, 'allowed')
    assert.equal(provider.exists, false)
  })

  it('resolves Mihomo default HTTP provider cache paths from the URL hash', async (t) => {
    const fixture = await createFixture(t)
    const cacheFileName = 'b62820ebc3e7fe301534800766c419d8'
    const rulePath = join(fixture.rulesDir, cacheFileName)
    await writeFile(rulePath, 'mrs-cache')
    await writeFile(fixture.configPath, providerConfigWithoutPath)

    const provider = await getRuleProviderInfo(fixture.settings, 'OpenAI')

    assert.equal(provider.configuredPath, null)
    assert.equal(provider.path, await realpath(rulePath))
    assert.equal(provider.pathAccess, 'allowed')
    assert.equal(provider.exists, true)
    assert.equal(provider.size, 9)
  })

  it('expands YAML merge keys used by shared Mihomo provider defaults', async (t) => {
    const fixture = await createFixture(t)
    const cacheFileName = 'b62820ebc3e7fe301534800766c419d8'
    const rulePath = join(fixture.rulesDir, cacheFileName)
    await writeFile(rulePath, 'mrs-cache')
    await writeFile(
      fixture.configPath,
      `
provider-defaults: &provider-defaults
  type: http
  behavior: domain
  format: mrs
  interval: 86400
rule-providers:
  OpenAI:
    <<: *provider-defaults
    url: https://example.com/openai.mrs
`,
    )

    const provider = await getRuleProviderInfo(fixture.settings, 'OpenAI')

    assert.equal(provider.type, 'http')
    assert.equal(provider.behavior, 'domain')
    assert.equal(provider.format, 'mrs')
    assert.equal(provider.interval, 86400)
    assert.equal(provider.path, await realpath(rulePath))
    assert.equal(provider.exists, true)
  })

  it('rejects path traversal without reading the target', async (t) => {
    const fixture = await createFixture(t)
    await writeFile(join(fixture.root, 'secret'), 'secret')
    await writeFile(fixture.configPath, providerConfig('../secret'))

    const [provider] = await listRuleProviders(fixture.settings)
    assert.equal(provider.path, null)
    assert.equal(provider.pathAccess, 'rejected')
    assert.equal(provider.error.code, 'PROVIDER_PATH_OUTSIDE_RULES_DIR')
    await assert.rejects(
      () => getRuleProviderInfo(fixture.settings, 'OpenAI'),
      (error) =>
        error instanceof LocalHelperError && error.code === 'PROVIDER_PATH_OUTSIDE_RULES_DIR',
    )
  })

  it('rejects an absolute file outside MIHOMO_RULES_DIR', async (t) => {
    const fixture = await createFixture(t)
    const outsidePath = join(fixture.root, 'outside.mrs')
    await writeFile(outsidePath, 'outside')
    await writeFile(fixture.configPath, providerConfig(outsidePath))

    const [provider] = await listRuleProviders(fixture.settings)

    assert.equal(provider.pathAccess, 'rejected')
    assert.equal(provider.exists, false)
    assert.equal(provider.error.code, 'PROVIDER_PATH_OUTSIDE_RULES_DIR')
  })

  it('reports a missing Mihomo binary without executing a command', async (t) => {
    const fixture = await createFixture(t)

    const binary = await inspectMihomoBinary(fixture.settings.binaryPath)

    assert.deepEqual(binary, {
      path: fixture.settings.binaryPath,
      exists: false,
      executable: false,
      version: null,
      error: {
        code: 'MIHOMO_BINARY_NOT_FOUND',
        message: 'Configured Mihomo binary does not exist.',
      },
    })
  })
})
