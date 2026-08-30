import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { it } from 'node:test'
import { loadHelperSettings } from '../src/environment.mjs'
import { LocalHelperError } from '../src/errors.mjs'

it('derives the managed runtime path and parses custom-rule safety limits', () => {
  const customRulesDir = resolve('fixture/custom')
  const settings = loadHelperSettings({
    MIHOMO_CONFIG_PATH: resolve('fixture/config.yaml'),
    MIHOMO_BINARY: resolve('fixture/mihomo'),
    MIHOMO_RULES_DIR: resolve('fixture/rules'),
    MIHOMO_CUSTOM_RULES_DIR: customRulesDir,
    LOCAL_HELPER_CONFIG_VALIDATION_TIMEOUT_MS: '1234',
    LOCAL_HELPER_CUSTOM_RULES_BACKUPS: '7',
    LOCAL_HELPER_MAX_REQUEST_BYTES: '65536',
  })

  assert.equal(settings.customRulesDir, customRulesDir)
  assert.equal(settings.runtimeConfigPath, resolve(customRulesDir, 'runtime-config.yaml'))
  assert.equal(settings.configValidationTimeout, 1234)
  assert.equal(settings.customRulesBackupLimit, 7)
  assert.equal(settings.maxRequestBytes, 65536)
})

it('rejects unsafe custom-rule limit values', () => {
  for (const [name, value, code] of [
    ['LOCAL_HELPER_CONFIG_VALIDATION_TIMEOUT_MS', '99', 'INVALID_CONFIG_VALIDATION_TIMEOUT'],
    ['LOCAL_HELPER_CUSTOM_RULES_BACKUPS', '0', 'INVALID_CUSTOM_RULES_BACKUP_LIMIT'],
    ['LOCAL_HELPER_MAX_REQUEST_BYTES', '999', 'INVALID_MAX_REQUEST_BYTES'],
  ]) {
    assert.throws(
      () => loadHelperSettings({ [name]: value }),
      (error) => error instanceof LocalHelperError && error.code === code,
    )
  }
})
