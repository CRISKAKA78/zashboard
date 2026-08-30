import { realpathSync } from 'node:fs'
import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'
import { getConfigInfo, getRuleProviderInfo, listRuleProviders } from './configDiscovery.mjs'
import {
  getCustomRules,
  restoreCustomRulesBackup,
  rollbackCustomRules,
  saveCustomRules,
  validateCustomRules,
} from './customRules.mjs'
import { loadHelperSettings } from './environment.mjs'
import { LocalHelperError, toPublicError } from './errors.mjs'
import { createRuleProviderPage, hasRuleProviderExplorerQuery } from './providerExplorer.mjs'
import { getRuleProviderRules } from './providerRules.mjs'

const API_PREFIX = '/api/local'

const sendJson = (response, status, body) => {
  response.statusCode = status
  response.setHeader('Content-Type', 'application/json; charset=utf-8')
  response.setHeader('Cache-Control', 'no-store')
  response.setHeader('X-Content-Type-Options', 'nosniff')
  response.end(JSON.stringify(body))
}

const sameOriginHost = (origin, host) => {
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

const applyCors = (request, response, settings) => {
  const origin = request.headers.origin

  if (!origin) {
    return
  }

  const allowed =
    settings.allowedOrigins.includes('*') ||
    settings.allowedOrigins.includes(origin) ||
    sameOriginHost(origin, request.headers.host)

  if (!allowed) {
    throw new LocalHelperError(
      'ORIGIN_NOT_ALLOWED',
      'Request origin is not allowed by Local Helper.',
      403,
    )
  }

  response.setHeader(
    'Access-Control-Allow-Origin',
    settings.allowedOrigins.includes('*') ? '*' : origin,
  )
  response.setHeader('Access-Control-Allow-Methods', 'GET, PUT, POST, OPTIONS')
  response.setHeader('Access-Control-Allow-Headers', 'Accept, Content-Type')
  response.setHeader('Vary', 'Origin')
}

const decodeProviderName = (pathname, action) => {
  const match = pathname.match(new RegExp(`^/api/local/rule-provider/([^/]+)/${action}$`))

  if (!match) {
    return null
  }

  try {
    return decodeURIComponent(match[1])
  } catch {
    throw new LocalHelperError('INVALID_PROVIDER_NAME', 'Rule Provider name is invalid.', 400)
  }
}

const requireMethod = (request, expected) => {
  if (request.method === expected) return
  throw new LocalHelperError('METHOD_NOT_ALLOWED', `This route only supports ${expected}.`, 405)
}

const readJsonBody = async (request, settings) => {
  if (
    !String(request.headers['content-type'] || '')
      .toLowerCase()
      .startsWith('application/json')
  ) {
    throw new LocalHelperError(
      'CONTENT_TYPE_REQUIRED',
      'Custom rules requests must use application/json.',
      415,
    )
  }

  const maximum = settings.maxRequestBytes ?? 512 * 1024
  const declared = Number(request.headers['content-length'])
  if (Number.isFinite(declared) && declared > maximum) {
    throw new LocalHelperError('REQUEST_BODY_TOO_LARGE', 'Request body is too large.', 413)
  }

  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > maximum) {
      throw new LocalHelperError('REQUEST_BODY_TOO_LARGE', 'Request body is too large.', 413)
    }
    chunks.push(chunk)
  }

  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('not an object')
    return body
  } catch (error) {
    throw new LocalHelperError(
      'REQUEST_JSON_INVALID',
      'Request body must be a valid JSON object.',
      400,
      { cause: error },
    )
  }
}

const routeRequest = async (request, settings, dependencies) => {
  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`)
  const customRulesApi = dependencies.customRulesApi || {
    get: getCustomRules,
    validate: validateCustomRules,
    save: saveCustomRules,
    rollback: rollbackCustomRules,
    restore: restoreCustomRulesBackup,
  }

  if (url.pathname === `${API_PREFIX}/health`) {
    requireMethod(request, 'GET')
    return {
      status: 200,
      body: {
        status: 'ok',
        service: 'zashboard-local-helper',
      },
    }
  }

  if (url.pathname === `${API_PREFIX}/config-info`) {
    requireMethod(request, 'GET')
    return { status: 200, body: await getConfigInfo(settings) }
  }

  if (url.pathname === `${API_PREFIX}/rule-providers`) {
    requireMethod(request, 'GET')
    return { status: 200, body: { providers: await listRuleProviders(settings) } }
  }

  if (url.pathname === `${API_PREFIX}/custom-rules`) {
    if (request.method === 'GET') {
      return { status: 200, body: await customRulesApi.get(settings) }
    }
    requireMethod(request, 'PUT')
    return {
      status: 200,
      body: await customRulesApi.save(settings, await readJsonBody(request, settings)),
    }
  }

  if (url.pathname === `${API_PREFIX}/custom-rules/validate`) {
    requireMethod(request, 'POST')
    return {
      status: 200,
      body: await customRulesApi.validate(settings, await readJsonBody(request, settings)),
    }
  }

  if (url.pathname === `${API_PREFIX}/custom-rules/rollback`) {
    requireMethod(request, 'POST')
    return {
      status: 200,
      body: await customRulesApi.rollback(settings, await readJsonBody(request, settings)),
    }
  }

  if (url.pathname === `${API_PREFIX}/custom-rules/restore`) {
    requireMethod(request, 'POST')
    return {
      status: 200,
      body: await customRulesApi.restore(settings, await readJsonBody(request, settings)),
    }
  }

  const providerRulesName = decodeProviderName(url.pathname, 'rules')
  if (providerRulesName !== null) {
    requireMethod(request, 'GET')
    const providerRules = await getRuleProviderRules(settings, providerRulesName)
    return {
      status: 200,
      body: hasRuleProviderExplorerQuery(url.searchParams)
        ? createRuleProviderPage(providerRules, url.searchParams)
        : providerRules,
    }
  }

  const providerName = decodeProviderName(url.pathname, 'info')
  if (providerName !== null) {
    requireMethod(request, 'GET')
    return { status: 200, body: await getRuleProviderInfo(settings, providerName) }
  }

  throw new LocalHelperError('ROUTE_NOT_FOUND', 'Local Helper route was not found.', 404)
}

export const createLocalHelperServer = (settings = loadHelperSettings(), dependencies = {}) => {
  const server = createServer(async (request, response) => {
    try {
      applyCors(request, response, settings)

      if (request.method === 'OPTIONS') {
        response.statusCode = 204
        response.end()
        return
      }

      const result = await routeRequest(request, settings, dependencies)
      sendJson(response, result.status, result.body)
    } catch (error) {
      const publicError = toPublicError(error)
      sendJson(response, publicError.status, publicError.body)
    }
  })

  server.requestTimeout = Math.max(5000, (settings.configValidationTimeout ?? 20_000) + 5000)
  server.headersTimeout = 6000
  server.keepAliveTimeout = 5000

  return server
}

export const startLocalHelper = (settings = loadHelperSettings()) => {
  const server = createLocalHelperServer(settings)

  server.listen(settings.port, settings.host, () => {
    console.log(`zashboard Local Helper listening on http://${settings.host}:${settings.port}`)
  })

  const shutdown = () => {
    server.close(() => process.exit(0))
  }

  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)

  return server
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
if (isMain) {
  startLocalHelper()
}
