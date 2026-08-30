import type { ProxyChainAnalysis, ProxyChainMap } from './types'

const emptyAnalysis = (): ProxyChainAnalysis => ({
  path: [],
  finalOutbound: '',
  status: 'missing',
})

/**
 * Follow the active `now` selection until it reaches a terminal outbound.
 * The repeated node is retained in `path` when a cycle is found so the UI can
 * explain the exact loop (for example A → B → A).
 */
export const resolveProxyChain = (
  start: string,
  proxyMap: ProxyChainMap,
  groupNames: ReadonlySet<string> = new Set(),
): ProxyChainAnalysis => {
  if (!start) {
    return emptyAnalysis()
  }

  const path: string[] = []
  const visited = new Set<string>()
  let current = start

  while (true) {
    if (visited.has(current)) {
      path.push(current)
      return {
        path,
        finalOutbound: current,
        status: 'cycle',
        cycleAt: current,
      }
    }

    visited.add(current)
    path.push(current)

    const proxy = proxyMap[current]

    if (!proxy) {
      return {
        path,
        finalOutbound: current,
        status: 'missing',
        missingAt: current,
      }
    }

    if (!proxy.now) {
      return {
        path,
        finalOutbound: proxy.name || current,
        status: 'resolved',
      }
    }

    if (proxy.now === current && !groupNames.has(current) && !proxy.all) {
      return {
        path,
        finalOutbound: current,
        status: 'resolved',
      }
    }

    current = proxy.now
  }
}
