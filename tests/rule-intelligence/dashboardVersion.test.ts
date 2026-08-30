import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import {
  normalizeDashboardVersion,
  OFFICIAL_DASHBOARD_RELEASE_API,
  OFFICIAL_DASHBOARD_REPOSITORY,
} from '../../src/features/dashboard-version/dashboardVersion.ts'

describe('dashboard version metadata', () => {
  it('normalizes custom and official version values for display', () => {
    assert.equal(normalizeDashboardVersion('3.24.0'), 'v3.24.0')
    assert.equal(normalizeDashboardVersion('v1.1.0'), 'v1.1.0')
    assert.equal(normalizeDashboardVersion('  v3.24.0  '), 'v3.24.0')
    assert.equal(normalizeDashboardVersion(''), '')
    assert.equal(normalizeDashboardVersion(null), '')
  })

  it('uses the official upstream release metadata endpoint', () => {
    assert.equal(OFFICIAL_DASHBOARD_REPOSITORY, 'https://github.com/Zephyruso/zashboard')
    assert.equal(
      OFFICIAL_DASHBOARD_RELEASE_API,
      'https://api.github.com/repos/Zephyruso/zashboard/releases/latest',
    )
  })
})

describe('dashboard upgrade removal', () => {
  const readSource = (relativePath: string) =>
    readFileSync(new URL(relativePath, import.meta.url), 'utf8')

  it('contains no UI upgrade API or persisted auto-upgrade setting', () => {
    const sources = [
      readSource('../../src/api/clash.ts'),
      readSource('../../src/assembly/version.ts'),
      readSource('../../src/assembly/backend.ts'),
      readSource('../../src/store/settings.ts'),
      readSource('../../src/components/settings/general/GeneralSettings.vue'),
      readSource('../../src/config/settingsItems.ts'),
    ]

    for (const source of sources) {
      assert.doesNotMatch(
        source,
        /upgradeUIAPI|\/upgrade\/ui|autoUpgradeDashboard|dashboardUpgrade/,
      )
    }
  })
})
