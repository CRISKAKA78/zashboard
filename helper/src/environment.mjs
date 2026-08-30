import { dirname, join, resolve } from 'node:path'
import { LocalHelperError } from './errors.mjs'

const DEFAULT_CONFIG_PATH = '/etc/mihomo/config.yaml'
const DEFAULT_BINARY_PATH = '/usr/bin/mihomo'
const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 8787
const DEFAULT_MAX_PROVIDER_BYTES = 8 * 1024 * 1024
const DEFAULT_MRS_CONVERSION_TIMEOUT = 15_000
const DEFAULT_CONFIG_VALIDATION_TIMEOUT = 20_000
const DEFAULT_CUSTOM_RULES_BACKUPS = 3
const DEFAULT_MAX_REQUEST_BYTES = 512 * 1024

const parsePort = (value) => {
  const port = value ? Number(value) : DEFAULT_PORT

  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new LocalHelperError(
      'INVALID_HELPER_PORT',
      'LOCAL_HELPER_PORT must be an integer between 0 and 65535.',
      500,
    )
  }

  return port
}

const parseAllowedOrigins = (value = '') =>
  value
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)

const parseMaxProviderBytes = (value) => {
  const bytes = value ? Number(value) : DEFAULT_MAX_PROVIDER_BYTES

  if (!Number.isSafeInteger(bytes) || bytes < 1) {
    throw new LocalHelperError(
      'INVALID_MAX_PROVIDER_BYTES',
      'LOCAL_HELPER_MAX_PROVIDER_BYTES must be a positive safe integer.',
      500,
    )
  }

  return bytes
}

const parseMrsConversionTimeout = (value) => {
  const timeout = value ? Number(value) : DEFAULT_MRS_CONVERSION_TIMEOUT

  if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > 120_000) {
    throw new LocalHelperError(
      'INVALID_MRS_CONVERSION_TIMEOUT',
      'LOCAL_HELPER_MRS_TIMEOUT_MS must be an integer between 100 and 120000.',
      500,
    )
  }

  return timeout
}

const parseConfigValidationTimeout = (value) => {
  const timeout = value ? Number(value) : DEFAULT_CONFIG_VALIDATION_TIMEOUT

  if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > 120_000) {
    throw new LocalHelperError(
      'INVALID_CONFIG_VALIDATION_TIMEOUT',
      'LOCAL_HELPER_CONFIG_VALIDATION_TIMEOUT_MS must be an integer between 100 and 120000.',
      500,
    )
  }

  return timeout
}

const parseBackupLimit = (value) => {
  const limit = value ? Number(value) : DEFAULT_CUSTOM_RULES_BACKUPS

  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) {
    throw new LocalHelperError(
      'INVALID_CUSTOM_RULES_BACKUP_LIMIT',
      'LOCAL_HELPER_CUSTOM_RULES_BACKUPS must be an integer between 1 and 20.',
      500,
    )
  }

  return limit
}

const parseMaxRequestBytes = (value) => {
  const bytes = value ? Number(value) : DEFAULT_MAX_REQUEST_BYTES

  if (!Number.isSafeInteger(bytes) || bytes < 1024 || bytes > 4 * 1024 * 1024) {
    throw new LocalHelperError(
      'INVALID_MAX_REQUEST_BYTES',
      'LOCAL_HELPER_MAX_REQUEST_BYTES must be between 1024 and 4194304.',
      500,
    )
  }

  return bytes
}

export const loadHelperSettings = (env = process.env) => {
  const configPath = resolve(env.MIHOMO_CONFIG_PATH || DEFAULT_CONFIG_PATH)
  const customRulesDir = resolve(env.MIHOMO_CUSTOM_RULES_DIR || join(dirname(configPath), 'custom'))

  return Object.freeze({
    configPath,
    binaryPath: resolve(env.MIHOMO_BINARY || DEFAULT_BINARY_PATH),
    rulesDir: resolve(env.MIHOMO_RULES_DIR || resolve(dirname(configPath), 'rules')),
    customRulesDir,
    runtimeConfigPath: join(customRulesDir, 'runtime-config.yaml'),
    host: env.LOCAL_HELPER_HOST || DEFAULT_HOST,
    port: parsePort(env.LOCAL_HELPER_PORT),
    maxProviderBytes: parseMaxProviderBytes(env.LOCAL_HELPER_MAX_PROVIDER_BYTES),
    mrsConversionTimeout: parseMrsConversionTimeout(env.LOCAL_HELPER_MRS_TIMEOUT_MS),
    configValidationTimeout: parseConfigValidationTimeout(
      env.LOCAL_HELPER_CONFIG_VALIDATION_TIMEOUT_MS,
    ),
    customRulesBackupLimit: parseBackupLimit(env.LOCAL_HELPER_CUSTOM_RULES_BACKUPS),
    maxRequestBytes: parseMaxRequestBytes(env.LOCAL_HELPER_MAX_REQUEST_BYTES),
    allowedOrigins: Object.freeze(parseAllowedOrigins(env.LOCAL_HELPER_ALLOWED_ORIGINS)),
  })
}
