import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { describe, it } from 'node:test'
import { parse } from 'yaml'
import {
  buildManagedConfig,
  CUSTOM_RULE_TYPES,
  normalizeCustomRules,
  serializeManagedConfig,
} from '../src/customRuleModel.mjs'
import {
  getCustomRules,
  restoreCustomRulesBackup,
  saveCustomRules,
  validateCustomRules,
  validateMihomoConfig,
} from '../src/customRules.mjs'
import { LocalHelperError } from '../src/errors.mjs'

const baseConfig = `
mixed-port: 7890
proxies:
  - name: Node
    type: ss
    server: 127.0.0.1
    port: 443
    cipher: aes-128-gcm
    password: test
proxy-groups:
  - name: Proxy
    type: select
    proxies: [Node, DIRECT]
dns:
  enable: true
  fake-ip-filter:
    - source.example
rules:
  - DOMAIN,original.example,Proxy
  - MATCH,DIRECT
`

const createFixture = async (testContext, source = baseConfig) => {
  const root = await mkdtemp(join(tmpdir(), 'zashboard-custom-rules-'))
  const configPath = join(root, 'mihomo', 'config.yaml')
  const customRulesDir = join(root, 'mihomo', 'custom')
  const binaryPath = join(root, 'mihomo-bin')
  await mkdir(dirname(configPath), { recursive: true })
  await writeFile(configPath, source)
  await writeFile(binaryPath, 'fixture')
  await chmod(binaryPath, 0o755)
  testContext.after(() => rm(root, { recursive: true, force: true }))

  return {
    root,
    settings: {
      configPath,
      customRulesDir,
      runtimeConfigPath: join(customRulesDir, 'runtime-config.yaml'),
      binaryPath,
      configValidationTimeout: 1000,
      customRulesBackupLimit: 3,
    },
  }
}

const structuredRule = (id, type, value, target, params = []) => ({
  id,
  mode: 'structured',
  type,
  value,
  target,
  params,
})

const noOpValidation = async () => {}

const save = (fixture, state, pre, post, dependencies = {}, fakeIpFilter = state.fakeIpFilter) =>
  saveCustomRules(
    fixture.settings,
    { expectedVersion: state.version, pre, post, fakeIpFilter },
    { validateConfig: noOpValidation, ...dependencies },
  )

describe('custom rules management', () => {
  it('accepts every Mihomo rule type exposed by the editor, including nested logical raw rules', async (t) => {
    const fixture = await createFixture(t)
    const rules = CUSTOM_RULE_TYPES.filter((type) => type !== 'MATCH').map((type, index) =>
      structuredRule(
        `type-${index}`,
        type,
        ['AND', 'OR', 'NOT'].includes(type) ? '((NETWORK,TCP),(DST-PORT,443))' : 'value',
        'DIRECT',
      ),
    )
    const nestedRaw = {
      id: 'nested',
      mode: 'raw',
      raw: 'AND,((NETWORK,TCP),(DST-PORT,443)),REJECT',
    }

    const validation = await validateCustomRules(
      fixture.settings,
      { pre: [...rules, nestedRaw], post: [], fakeIpFilter: ['source.example'] },
      { validateConfig: noOpValidation },
    )

    assert.equal(validation.preCount, rules.length + 1)
  })

  it('manages Fake-IP filters in the same validated runtime, version, backup, and rollback flow', async (t) => {
    const fixture = await createFixture(t)
    const initial = await getCustomRules(fixture.settings)
    assert.deepEqual(initial.fakeIpFilter, ['source.example'])

    const first = await saveCustomRules(
      fixture.settings,
      {
        expectedVersion: initial.version,
        pre: [],
        post: [],
        fakeIpFilter: ['+.one.example', 'localhost', '+.one.example'],
      },
      { validateConfig: noOpValidation },
    )
    assert.deepEqual(first.fakeIpFilter, ['+.one.example', 'localhost'])
    const runtime = parse(await readFile(first.runtimeConfigPath, 'utf8'))
    assert.deepEqual(runtime.dns['fake-ip-filter'], ['+.one.example', 'localhost'])
    assert.deepEqual(
      parse(await readFile(join(fixture.settings.customRulesDir, 'fake-ip-filter.yaml'), 'utf8'))[
        'fake-ip-filter'
      ],
      ['+.one.example', 'localhost'],
    )

    const second = await saveCustomRules(
      fixture.settings,
      {
        expectedVersion: first.version,
        pre: [],
        post: [],
        fakeIpFilter: ['+.two.example'],
      },
      { validateConfig: noOpValidation },
    )
    const restored = await restoreCustomRulesBackup(
      fixture.settings,
      { expectedVersion: second.version, backupId: second.backupId },
      { validateConfig: noOpValidation },
    )
    assert.deepEqual(restored.fakeIpFilter, ['+.one.example', 'localhost'])
  })

  it('rejects malformed Fake-IP filter state before writing managed files', async (t) => {
    const fixture = await createFixture(t)

    await assert.rejects(
      () =>
        validateCustomRules(
          fixture.settings,
          { pre: [], post: [], fakeIpFilter: ['valid.example', ''] },
          { validateConfig: noOpValidation },
        ),
      (error) => error instanceof LocalHelperError && error.code === 'CUSTOM_RULE_INVALID',
    )
  })

  it('adds, edits, deletes, and reorders rules while keeping fallback last', async (t) => {
    const fixture = await createFixture(t)
    const initial = await getCustomRules(fixture.settings)
    const one = structuredRule('one', 'DOMAIN', 'one.example', 'DIRECT')
    const two = structuredRule('two', 'DOMAIN-SUFFIX', 'two.example', 'Proxy')
    const post = structuredRule('post', 'IP-CIDR', '10.0.0.0/8', 'REJECT', ['no-resolve'])

    const added = await save(fixture, initial, [one, two], [post])
    assert.deepEqual(
      added.pre.map((rule) => rule.id),
      ['one', 'two'],
    )

    const edited = { ...one, value: 'edited.example' }
    const changed = await save(fixture, added, [two, edited], [])
    assert.deepEqual(
      changed.pre.map((rule) => rule.id),
      ['two', 'one'],
    )
    assert.equal(changed.pre[1].value, 'edited.example')
    assert.equal(changed.post.length, 0)

    const runtime = parse(await readFile(changed.runtimeConfigPath, 'utf8'))
    assert.deepEqual(runtime.rules, [
      'DOMAIN-SUFFIX,two.example,Proxy',
      'DOMAIN,edited.example,DIRECT',
      'DOMAIN,original.example,Proxy',
      'MATCH,DIRECT',
    ])
  })

  it('places Pre before original rules and Post immediately before fallback', async (t) => {
    const fixture = await createFixture(t)
    const initial = await getCustomRules(fixture.settings)
    const saved = await save(
      fixture,
      initial,
      [structuredRule('pre', 'DOMAIN', 'pre.example', 'DIRECT')],
      [structuredRule('post', 'DOMAIN-KEYWORD', 'post', 'REJECT')],
    )
    const runtime = parse(await readFile(saved.runtimeConfigPath, 'utf8'))

    assert.deepEqual(runtime.rules, [
      'DOMAIN,pre.example,DIRECT',
      'DOMAIN,original.example,Proxy',
      'DOMAIN-KEYWORD,post,REJECT',
      'MATCH,DIRECT',
    ])
  })

  it('rejects unsupported and malformed rules', async (t) => {
    const fixture = await createFixture(t)

    await assert.rejects(
      () =>
        validateCustomRules(
          fixture.settings,
          {
            pre: [structuredRule('bad', 'SCRIPT', 'x', 'DIRECT')],
            post: [],
          },
          { validateConfig: noOpValidation },
        ),
      (error) => error instanceof LocalHelperError && error.code === 'CUSTOM_RULE_TYPE_UNSUPPORTED',
    )
    await assert.rejects(
      () =>
        validateCustomRules(
          fixture.settings,
          { pre: [], post: [{ id: 'raw', mode: 'raw', raw: 'DOMAIN,missing-target' }] },
          { validateConfig: noOpValidation },
        ),
      (error) => error instanceof LocalHelperError && error.code === 'CUSTOM_RULE_INVALID',
    )
  })

  it('allows MATCH only as the final Post rule when the source has no fallback', async (t) => {
    const withoutFallback = baseConfig.replace('  - MATCH,DIRECT\n', '')
    const fixture = await createFixture(t, withoutFallback)
    const initial = await getCustomRules(fixture.settings)

    await assert.rejects(
      () => save(fixture, initial, [structuredRule('match', 'MATCH', '', 'DIRECT')], []),
      (error) =>
        error instanceof LocalHelperError && error.code === 'CUSTOM_MATCH_POSITION_INVALID',
    )
    const saved = await save(
      fixture,
      initial,
      [],
      [
        structuredRule('post', 'DOMAIN', 'post.example', 'DIRECT'),
        structuredRule('match', 'MATCH', '', 'REJECT'),
      ],
    )
    const runtime = parse(await readFile(saved.runtimeConfigPath, 'utf8'))
    assert.equal(runtime.rules.at(-1), 'MATCH,REJECT')

    await assert.rejects(
      () =>
        save(
          fixture,
          saved,
          [],
          [
            structuredRule('match', 'MATCH', '', 'REJECT'),
            structuredRule('post', 'DOMAIN', 'post.example', 'DIRECT'),
          ],
        ),
      (error) =>
        error instanceof LocalHelperError && error.code === 'CUSTOM_MATCH_POSITION_INVALID',
    )
  })

  it('rejects invalid external custom rules YAML', async (t) => {
    const fixture = await createFixture(t)
    await mkdir(fixture.settings.customRulesDir, { recursive: true })
    await writeFile(join(fixture.settings.customRulesDir, 'pre-rules.yaml'), 'version: [')

    await assert.rejects(
      () => getCustomRules(fixture.settings),
      (error) => error instanceof LocalHelperError && error.code === 'CUSTOM_RULES_YAML_INVALID',
    )
  })

  it('keeps old files when Mihomo validation fails', async (t) => {
    const fixture = await createFixture(t)
    const initial = await getCustomRules(fixture.settings)
    const saved = await save(
      fixture,
      initial,
      [structuredRule('old', 'DOMAIN', 'old.example', 'DIRECT')],
      [],
    )

    await assert.rejects(
      () =>
        save(fixture, saved, [structuredRule('new', 'DOMAIN', 'new.example', 'REJECT')], [], {
          validateConfig: async () => {
            throw new LocalHelperError(
              'MIHOMO_VALIDATION_FAILED',
              'Mihomo rejected the fixture.',
              422,
            )
          },
        }),
      (error) => error instanceof LocalHelperError && error.code === 'MIHOMO_VALIDATION_FAILED',
    )

    const current = await getCustomRules(fixture.settings)
    assert.deepEqual(
      current.pre.map((rule) => rule.id),
      ['old'],
    )
  })

  it('keeps old files when a temporary disk write fails', async (t) => {
    const fixture = await createFixture(t)
    const initial = await getCustomRules(fixture.settings)
    const saved = await save(
      fixture,
      initial,
      [structuredRule('old', 'DOMAIN', 'old.example', 'DIRECT')],
      [],
    )
    const diskError = Object.assign(new Error('disk full'), { code: 'ENOSPC' })

    await assert.rejects(
      () =>
        save(fixture, saved, [structuredRule('new', 'DOMAIN', 'new.example', 'DIRECT')], [], {
          writeTemporary: async () => {
            throw diskError
          },
        }),
      (error) => error instanceof LocalHelperError && error.code === 'CUSTOM_RULES_WRITE_FAILED',
    )
    const current = await getCustomRules(fixture.settings)
    assert.deepEqual(
      current.pre.map((rule) => rule.id),
      ['old'],
    )
  })

  it('restores every old file when an atomic replacement fails partway through', async (t) => {
    const fixture = await createFixture(t)
    const initial = await getCustomRules(fixture.settings)
    const saved = await save(
      fixture,
      initial,
      [structuredRule('old', 'DOMAIN', 'old.example', 'DIRECT')],
      [],
    )
    let replacements = 0
    const diskError = Object.assign(new Error('rename failed'), { code: 'EIO' })

    await assert.rejects(
      () =>
        save(
          fixture,
          saved,
          [structuredRule('new', 'DOMAIN', 'new.example', 'REJECT')],
          [],
          {
            replaceCandidate: async (temporary, target) => {
              replacements += 1
              if (replacements === 4) throw diskError
              await rename(temporary, target)
            },
          },
          ['changed.example'],
        ),
      (error) => error instanceof LocalHelperError && error.code === 'CUSTOM_RULES_WRITE_FAILED',
    )

    const current = await getCustomRules(fixture.settings)
    assert.deepEqual(
      current.pre.map((rule) => rule.id),
      ['old'],
    )
    const runtime = parse(await readFile(current.runtimeConfigPath, 'utf8'))
    assert.equal(runtime.rules[0], 'DOMAIN,old.example,DIRECT')
    assert.deepEqual(current.fakeIpFilter, ['source.example'])
    assert.deepEqual(runtime.dns['fake-ip-filter'], ['source.example'])
  })

  it('serializes simultaneous saves and rejects the stale writer', async (t) => {
    const fixture = await createFixture(t)
    const initial = await getCustomRules(fixture.settings)
    const delayedValidation = async () => new Promise((resolve) => setTimeout(resolve, 20))
    const attempts = await Promise.allSettled([
      save(fixture, initial, [structuredRule('one', 'DOMAIN', 'one.example', 'DIRECT')], [], {
        validateConfig: delayedValidation,
      }),
      save(fixture, initial, [structuredRule('two', 'DOMAIN', 'two.example', 'DIRECT')], [], {
        validateConfig: delayedValidation,
      }),
    ])

    assert.deepEqual(attempts.map((attempt) => attempt.status).sort(), ['fulfilled', 'rejected'])
    const rejected = attempts.find((attempt) => attempt.status === 'rejected')
    assert.equal(rejected.reason.code, 'CUSTOM_RULES_VERSION_CONFLICT')
  })

  it('detects external file changes using the version token', async (t) => {
    const fixture = await createFixture(t)
    const initial = await getCustomRules(fixture.settings)
    await mkdir(fixture.settings.customRulesDir, { recursive: true })
    await writeFile(
      join(fixture.settings.customRulesDir, 'pre-rules.yaml'),
      'version: 1\nrules: []\n# external edit\n',
    )

    await assert.rejects(
      () => save(fixture, initial, [], []),
      (error) =>
        error instanceof LocalHelperError && error.code === 'CUSTOM_RULES_VERSION_CONFLICT',
    )
  })

  it('restores a bounded backup through the same validation pipeline', async (t) => {
    const fixture = await createFixture(t)
    const initial = await getCustomRules(fixture.settings)
    const first = await save(
      fixture,
      initial,
      [structuredRule('first', 'DOMAIN', 'first.example', 'DIRECT')],
      [],
    )
    const second = await save(
      fixture,
      first,
      [structuredRule('second', 'DOMAIN', 'second.example', 'REJECT')],
      [],
    )

    const restored = await restoreCustomRulesBackup(
      fixture.settings,
      { expectedVersion: second.version, backupId: second.backupId },
      { validateConfig: noOpValidation },
    )
    assert.deepEqual(
      restored.pre.map((rule) => rule.id),
      ['first'],
    )
    assert.ok(restored.backups.length <= 3)
  })

  it('passes Mihomo validation through execFile with an argument array', async (t) => {
    const fixture = await createFixture(t)
    const candidatePath = join(fixture.root, 'candidate.yaml')
    await writeFile(candidatePath, baseConfig)
    let invocation

    await validateMihomoConfig(fixture.settings, candidatePath, async (...args) => {
      invocation = args
      return { stdout: '', stderr: '' }
    })

    assert.equal(invocation[0], fixture.settings.binaryPath)
    assert.deepEqual(invocation[1], [
      '-t',
      '-d',
      dirname(fixture.settings.configPath),
      '-f',
      candidatePath,
    ])
    assert.equal(invocation[2].timeout, 1000)
  })

  it('generates 2,000 custom rules over a 10,000-rule source within budget', (t) => {
    const base = {
      rules: [
        ...Array.from({ length: 10_000 }, (_, index) => `DOMAIN,source-${index}.example,DIRECT`),
        'MATCH,DIRECT',
      ],
    }
    const input = {
      pre: Array.from({ length: 1_000 }, (_, index) =>
        structuredRule(`pre-${index}`, 'DOMAIN', `pre-${index}.example`, 'DIRECT'),
      ),
      post: Array.from({ length: 1_000 }, (_, index) =>
        structuredRule(`post-${index}`, 'DOMAIN-SUFFIX', `post-${index}.example`, 'REJECT'),
      ),
    }

    const started = performance.now()
    const normalized = normalizeCustomRules(input, base)
    const managed = buildManagedConfig(base, normalized)
    const source = serializeManagedConfig(managed)
    const elapsed = performance.now() - started

    assert.equal(managed.rules.length, 12_001)
    assert.equal(managed.rules.at(-1), 'MATCH,DIRECT')
    assert.ok(source.length > 100_000)
    assert.ok(elapsed < 2_000, `generation took ${elapsed.toFixed(2)} ms`)
    t.diagnostic(`12k-rule runtime generation=${elapsed.toFixed(2)}ms`)
  })
})
