// 组装层 · overview 门面。memory / traffic 统计流统一返回 { data, close } 流;
// honk 的 /stats 没有 WS,走 stats.ts 的轮询。
import * as clash from './clash'

export const fetchMemoryAPI = <T>() => clash.fetchMemoryAPI<T>()

export const fetchTrafficAPI = <T>() => clash.fetchTrafficAPI<T>()

export { fetchHonkStats, honkStats, startHonkStats, stopHonkStats } from './stats'
