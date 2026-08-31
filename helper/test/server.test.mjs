import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it } from 'node:test'
import { createLocalHelperServer } from '../src/server.mjs'

const startFixtureServer = async (testContext, dependencies = {}) => {
  const root = await mkdtemp(join(tmpdir(), 'zashboard-helper-server-'))
  const rulesDir = join(root, 'rules')
  const configPath = join(root, 'config.yaml')
  const rulePath = join(rulesDir, 'openai.yaml')
  await mkdir(rulesDir)
  await writeFile(rulePath, `payload:\n  - '+.chatgpt.com'\n`)
  await writeFile(
    configPath,
    `rule-providers:\n  OpenAI:\n    type: http\n    behavior: domain\n    format: yaml\n    path: ./rules/openai.yaml\n`,
  )

  const server = createLocalHelperServer(
    {
      configPath,
      rulesDir,
      binaryPath: join(root, 'missing-mihomo'),
      host: '127.0.0.1',
      port: 0,
      maxProviderBytes: 1024 * 1024,
      allowedOrigins: [],
    },
    dependencies,
  )
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const baseUrl = `http://127.0.0.1:${address.port}`

  testContext.after(async () => {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
    await rm(root, { recursive: true, force: true })
  })

  return baseUrl
}

it('serves the scoped Helper API without exposing a generic file route', async (t) => {
  const baseUrl = await startFixtureServer(t)

  const health = await fetch(`${baseUrl}/api/local/health`).then((response) => response.json())
  assert.deepEqual(health, {
    status: 'ok',
    service: 'zashboard-local-helper',
  })

  const configInfo = await fetch(`${baseUrl}/api/local/config-info`).then((response) =>
    response.json(),
  )
  assert.equal(configInfo.config.valid, true)
  assert.equal(configInfo.config.ruleProviderCount, 1)
  assert.equal(configInfo.mihomo.exists, false)

  const providers = await fetch(`${baseUrl}/api/local/rule-providers`).then((response) =>
    response.json(),
  )
  assert.equal(providers.providers.length, 1)
  assert.equal(providers.providers[0].name, 'OpenAI')

  const provider = await fetch(`${baseUrl}/api/local/rule-provider/OpenAI/info`).then((response) =>
    response.json(),
  )
  assert.equal(provider.exists, true)

  const providerRules = await fetch(`${baseUrl}/api/local/rule-provider/OpenAI/rules`).then(
    (response) => response.json(),
  )
  assert.equal(providerRules.entries.length, 1)
  assert.equal(providerRules.entries[0].type, 'DOMAIN-SUFFIX')
  assert.equal(providerRules.entries[0].value, 'chatgpt.com')
  assert.equal(providerRules.provider.editable, false)
  assert.equal(providerRules.version, null)

  const providerPage = await fetch(
    `${baseUrl}/api/local/rule-provider/OpenAI/rules?page=1&pageSize=100&family=domain&search=chatgpt&sortKey=content&sortDirection=asc`,
  ).then((response) => response.json())
  assert.equal(providerPage.total, 1)
  assert.equal(providerPage.matched, 1)
  assert.equal(providerPage.items.length, 1)
  assert.equal(providerPage.items[0].value, 'chatgpt.com')
  assert.deepEqual(providerPage.counts, { all: 1, domain: 1, ip: 0, other: 0 })
  assert.equal(providerPage.provider.editable, false)
  assert.equal(providerPage.version, null)

  const invalidQuery = await fetch(`${baseUrl}/api/local/rule-provider/OpenAI/rules?pageSize=1000`)
  assert.equal(invalidQuery.status, 400)
  assert.equal((await invalidQuery.json()).error.code, 'RULE_PROVIDER_QUERY_INVALID')

  const injectedProvider = await fetch(
    `${baseUrl}/api/local/rule-provider/${encodeURIComponent('../../etc/passwd')}/rules?page=1`,
  )
  assert.equal(injectedProvider.status, 404)

  const genericFileResponse = await fetch(`${baseUrl}/api/file?path=/etc/shadow`)
  assert.equal(genericFileResponse.status, 404)
})

it('routes custom-rules reads, validation, saves, rollback, and restore without accepting paths', async (t) => {
  const calls = []
  const response = {
    version: 'v1',
    pre: [],
    post: [],
    runtimeConfigPath: '/managed/runtime-config.yaml',
    backups: [],
  }
  const handler = (action) => async (_settings, body) => {
    calls.push({ action, body })
    return action === 'validate' ? { valid: true } : response
  }
  const baseUrl = await startFixtureServer(t, {
    customRulesApi: {
      get: handler('get'),
      validate: handler('validate'),
      save: handler('save'),
      rollback: handler('rollback'),
      restore: handler('restore'),
    },
  })

  assert.equal((await fetch(`${baseUrl}/api/local/custom-rules`)).status, 200)
  for (const [method, path, action] of [
    ['POST', 'validate', 'validate'],
    ['PUT', '', 'save'],
    ['POST', 'rollback', 'rollback'],
    ['POST', 'restore', 'restore'],
  ]) {
    const result = await fetch(`${baseUrl}/api/local/custom-rules${path ? `/${path}` : ''}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pre: [], post: [], path: '/etc/passwd' }),
    })
    assert.equal(result.status, 200)
    assert.equal(calls.at(-1).action, action)
  }

  assert.equal((await fetch(`${baseUrl}/api/local/write-file`, { method: 'POST' })).status, 404)
})

it('requires JSON for custom-rules writes', async (t) => {
  const baseUrl = await startFixtureServer(t, {
    customRulesApi: {
      get: async () => ({}),
      validate: async () => ({}),
      save: async () => ({}),
      rollback: async () => ({}),
      restore: async () => ({}),
    },
  })
  const response = await fetch(`${baseUrl}/api/local/custom-rules`, {
    method: 'PUT',
    body: '{}',
  })
  const body = await response.json()

  assert.equal(response.status, 415)
  assert.equal(body.error.code, 'CONTENT_TYPE_REQUIRED')
})

it('routes local Rule Provider mutations by configured name only', async (t) => {
  const calls = []
  const response = {
    provider: { name: 'OpenAI', editable: true },
    entries: [],
    version: 'saved-version',
    backupId: 'backup-1',
  }
  const baseUrl = await startFixtureServer(t, {
    localProviderRulesApi: {
      save: async (_settings, name, body) => {
        calls.push({ action: 'save', name, body })
        return response
      },
      rollback: async (_settings, name, body) => {
        calls.push({ action: 'rollback', name, body })
        return { ...response, backupId: undefined }
      },
    },
  })

  const mutation = { expectedVersion: 'old-version', operation: 'add', raw: 'DOMAIN,example.com' }
  const saved = await fetch(`${baseUrl}/api/local/rule-provider/OpenAI/rules`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(mutation),
  })
  assert.equal(saved.status, 200)
  assert.deepEqual(calls.at(-1), { action: 'save', name: 'OpenAI', body: mutation })

  const restore = { expectedVersion: 'saved-version', backupId: 'backup-1' }
  const rolledBack = await fetch(`${baseUrl}/api/local/rule-provider/OpenAI/rules/rollback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(restore),
  })
  assert.equal(rolledBack.status, 200)
  assert.deepEqual(calls.at(-1), { action: 'rollback', name: 'OpenAI', body: restore })

  const genericWrite = await fetch(`${baseUrl}/api/local/rule-provider`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...mutation, path: '/etc/passwd' }),
  })
  assert.equal(genericWrite.status, 404)
})

it('rejects an unconfigured cross-origin request', async (t) => {
  const baseUrl = await startFixtureServer(t)
  const response = await fetch(`${baseUrl}/api/local/health`, {
    headers: { Origin: 'https://evil.example' },
  })
  const body = await response.json()

  assert.equal(response.status, 403)
  assert.equal(body.error.code, 'ORIGIN_NOT_ALLOWED')
})
