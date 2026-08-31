import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { parse } from 'yaml'
import { rollbackLocalRuleProvider, saveLocalRuleProvider } from '../src/localProviderRules.mjs'
import { clearProviderRulesCache, getRuleProviderRules } from '../src/providerRules.mjs'

const createFixture = async (
  testContext,
  {
    type = 'file',
    behavior = 'classical',
    format = 'text',
    extension = 'list',
    content = '# preserved comment\nDOMAIN-SUFFIX,first.example\nDOMAIN,second.example\n',
  } = {},
) => {
  const root = await mkdtemp(join(tmpdir(), 'zashboard-local-provider-'))
  const rulesDir = join(root, 'rules')
  const customRulesDir = join(root, 'custom')
  const configPath = join(root, 'config.yaml')
  const providerPath = join(rulesDir, `local.${extension}`)
  await mkdir(rulesDir)
  await writeFile(providerPath, content)
  await writeFile(
    configPath,
    `rule-providers:\n  Local:\n    type: ${type}\n    behavior: ${behavior}\n    format: ${format}\n    path: ./rules/local.${extension}\n`,
  )
  testContext.after(() => rm(root, { recursive: true, force: true }))
  clearProviderRulesCache()

  const settings = {
    configPath,
    rulesDir,
    customRulesDir,
    runtimeConfigPath: join(customRulesDir, 'runtime-config.yaml'),
    binaryPath: join(root, 'missing-mihomo'),
    host: '127.0.0.1',
    port: 0,
    maxProviderBytes: 1024 * 1024,
    maxRequestBytes: 512 * 1024,
    configValidationTimeout: 1000,
    customRulesBackupLimit: 3,
    allowedOrigins: [],
  }

  const validatedCandidates = []
  const dependencies = {
    validateConfig: async (_settings, validationPath) => {
      const config = parse(await readFile(validationPath, 'utf8'))
      const candidatePath = config['rule-providers'].Local.path
      validatedCandidates.push(await readFile(candidatePath, 'utf8'))
    },
  }

  return { settings, providerPath, dependencies, validatedCandidates }
}

describe('local Rule Provider management', () => {
  it('adds, edits, deletes, and rolls back text rules while preserving comments', async (t) => {
    const fixture = await createFixture(t)
    const initial = await getRuleProviderRules(fixture.settings, 'Local')

    assert.equal(initial.provider.editable, true)
    assert.equal(typeof initial.version, 'string')

    const added = await saveLocalRuleProvider(
      fixture.settings,
      'Local',
      {
        expectedVersion: initial.version,
        operation: 'add',
        raw: 'DOMAIN-WILDCARD,*.added.example',
      },
      fixture.dependencies,
    )
    assert.equal(added.entries.length, 3)
    assert.match(added.backupId, /^\d+-[a-f\d]{16}$/u)
    assert.match(await readFile(fixture.providerPath, 'utf8'), /^# preserved comment/u)

    const updated = await saveLocalRuleProvider(
      fixture.settings,
      'Local',
      {
        expectedVersion: added.version,
        operation: 'update',
        index: 1,
        raw: 'DOMAIN-SUFFIX,updated.example',
      },
      fixture.dependencies,
    )
    assert.equal(updated.entries[0].value, 'updated.example')

    const deleted = await saveLocalRuleProvider(
      fixture.settings,
      'Local',
      {
        expectedVersion: updated.version,
        operation: 'delete',
        index: 2,
      },
      fixture.dependencies,
    )
    assert.deepEqual(
      deleted.entries.map((entry) => entry.value),
      ['updated.example', '*.added.example'],
    )

    const restored = await rollbackLocalRuleProvider(
      fixture.settings,
      'Local',
      {
        expectedVersion: deleted.version,
        backupId: deleted.backupId,
      },
      fixture.dependencies,
    )
    assert.deepEqual(
      restored.entries.map((entry) => entry.value),
      ['updated.example', 'second.example', '*.added.example'],
    )
    assert.equal(fixture.validatedCandidates.length, 4)
  })

  it('adds, updates, and deletes a local YAML Provider payload without exposing a generic file write', async (t) => {
    const fixture = await createFixture(t, {
      behavior: 'domain',
      format: 'yaml',
      extension: 'yaml',
      content: "# provider comment\npayload:\n  - '+.first.example'\n",
    })
    const initial = await getRuleProviderRules(fixture.settings, 'Local')
    const saved = await saveLocalRuleProvider(
      fixture.settings,
      'Local',
      {
        expectedVersion: initial.version,
        operation: 'add',
        raw: '+.second.example',
      },
      fixture.dependencies,
    )

    assert.deepEqual(
      saved.entries.map((entry) => entry.value),
      ['first.example', 'second.example'],
    )
    const updated = await saveLocalRuleProvider(
      fixture.settings,
      'Local',
      {
        expectedVersion: saved.version,
        operation: 'update',
        index: 1,
        raw: '+.updated.example',
      },
      fixture.dependencies,
    )
    const deleted = await saveLocalRuleProvider(
      fixture.settings,
      'Local',
      {
        expectedVersion: updated.version,
        operation: 'delete',
        index: 2,
      },
      fixture.dependencies,
    )

    assert.deepEqual(
      deleted.entries.map((entry) => entry.value),
      ['updated.example'],
    )
    assert.match(await readFile(fixture.providerPath, 'utf8'), /^# provider comment/u)
  })

  it('keeps remote Providers read-only even when their cache path is local', async (t) => {
    const fixture = await createFixture(t, { type: 'http' })
    const current = await getRuleProviderRules(fixture.settings, 'Local')

    assert.equal(current.provider.editable, false)
    assert.equal(current.version, null)
    await assert.rejects(
      saveLocalRuleProvider(
        fixture.settings,
        'Local',
        { expectedVersion: 'anything', operation: 'add', raw: 'DOMAIN,blocked.example' },
        fixture.dependencies,
      ),
      (error) => error.code === 'RULE_PROVIDER_READ_ONLY' && error.status === 409,
    )
  })

  it('rejects stale writers and malformed rule lines', async (t) => {
    const fixture = await createFixture(t)
    const initial = await getRuleProviderRules(fixture.settings, 'Local')
    await writeFile(fixture.providerPath, '# preserved comment\nDOMAIN-SUFFIX,external.example\n')

    await assert.rejects(
      saveLocalRuleProvider(
        fixture.settings,
        'Local',
        { expectedVersion: initial.version, operation: 'add', raw: 'DOMAIN,new.example' },
        fixture.dependencies,
      ),
      (error) => error.code === 'RULE_PROVIDER_VERSION_CONFLICT' && error.status === 409,
    )

    const changed = await getRuleProviderRules(fixture.settings, 'Local')
    await assert.rejects(
      saveLocalRuleProvider(
        fixture.settings,
        'Local',
        { expectedVersion: changed.version, operation: 'add', raw: '# not a rule' },
        fixture.dependencies,
      ),
      (error) => error.code === 'RULE_PROVIDER_RULE_INVALID' && error.status === 400,
    )
  })

  it('does not replace the Provider when Mihomo validation fails', async (t) => {
    const fixture = await createFixture(t)
    const initial = await getRuleProviderRules(fixture.settings, 'Local')
    const before = await readFile(fixture.providerPath, 'utf8')

    await assert.rejects(
      saveLocalRuleProvider(
        fixture.settings,
        'Local',
        { expectedVersion: initial.version, operation: 'add', raw: 'DOMAIN,new.example' },
        {
          validateConfig: async () => {
            const error = new Error('invalid')
            error.code = 'TEST_VALIDATION_FAILED'
            throw error
          },
        },
      ),
      (error) => error.code === 'RULE_PROVIDER_WRITE_FAILED',
    )
    assert.equal(await readFile(fixture.providerPath, 'utf8'), before)
  })

  it('serializes simultaneous saves and rejects the stale writer', async (t) => {
    const fixture = await createFixture(t)
    const initial = await getRuleProviderRules(fixture.settings, 'Local')
    let releaseValidation
    let validationStarted
    const validationStartedGate = new Promise((resolve) => {
      validationStarted = resolve
    })
    const validationGate = new Promise((resolve) => {
      releaseValidation = resolve
    })
    let validations = 0
    const dependencies = {
      validateConfig: async () => {
        validations += 1
        if (validations === 1) {
          validationStarted()
          await validationGate
        }
      },
    }

    const first = saveLocalRuleProvider(
      fixture.settings,
      'Local',
      { expectedVersion: initial.version, operation: 'add', raw: 'DOMAIN,first-write.example' },
      dependencies,
    )
    await validationStartedGate
    const second = saveLocalRuleProvider(
      fixture.settings,
      'Local',
      { expectedVersion: initial.version, operation: 'add', raw: 'DOMAIN,stale-write.example' },
      dependencies,
    )
    releaseValidation()

    await first
    await assert.rejects(
      second,
      (error) => error.code === 'RULE_PROVIDER_VERSION_CONFLICT' && error.status === 409,
    )
  })
})
