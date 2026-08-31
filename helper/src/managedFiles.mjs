import { randomBytes } from 'node:crypto'
import { chmod, open, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const writeLocks = new Map()

export const temporaryPath = (directory, label) =>
  join(directory, `.${label}-${process.pid}-${randomBytes(12).toString('hex')}.tmp`)

export const writeTemporary = async (path, source, mode = 0o600) => {
  const handle = await open(path, 'wx', mode)
  try {
    await handle.writeFile(source, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
}

export const syncDirectory = async (path) => {
  let handle
  try {
    handle = await open(path, 'r')
    await handle.sync()
  } catch (error) {
    if (!['EINVAL', 'EBADF', 'ENOTSUP', 'EPERM', 'EISDIR'].includes(error?.code)) throw error
  } finally {
    await handle?.close().catch(() => {})
  }
}

export const replaceCandidate = async (temporary, target, mode = 0o600) => {
  await rename(temporary, target)
  await chmod(target, mode).catch(() => {})
  await syncDirectory(dirname(target))
}

export const writeSourceAtomic = async (target, source, mode = 0o600) => {
  if (source === null) {
    await rm(target, { force: true })
    await syncDirectory(dirname(target))
    return
  }

  const temporary = temporaryPath(dirname(target), 'restore')
  try {
    await writeTemporary(temporary, source, mode)
    await replaceCandidate(temporary, target, mode)
  } finally {
    await rm(temporary, { force: true }).catch(() => {})
  }
}

export const withWriteLock = async (key, operation) => {
  const previous = writeLocks.get(key) ?? Promise.resolve()
  let release
  const gate = new Promise((resolveGate) => {
    release = resolveGate
  })
  const tail = previous.then(() => gate)
  writeLocks.set(key, tail)
  await previous
  try {
    return await operation()
  } finally {
    release()
    if (writeLocks.get(key) === tail) writeLocks.delete(key)
  }
}
