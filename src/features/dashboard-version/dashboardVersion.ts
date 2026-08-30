export const OFFICIAL_DASHBOARD_REPOSITORY = 'https://github.com/Zephyruso/zashboard'

export const OFFICIAL_DASHBOARD_RELEASE_API =
  'https://api.github.com/repos/Zephyruso/zashboard/releases/latest'

export const normalizeDashboardVersion = (value: unknown) => {
  if (typeof value !== 'string') return ''

  const version = value.trim()
  if (!version) return ''

  return version.toLowerCase().startsWith('v') ? version : `v${version}`
}
