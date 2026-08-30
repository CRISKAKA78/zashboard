import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { access, realpath, stat } from 'node:fs/promises'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const errorInfo = (code, message) => ({ code, message })

export const inspectMihomoBinary = async (binaryPath) => {
  let resolvedPath = binaryPath
  let binaryStat

  try {
    resolvedPath = await realpath(binaryPath)
    binaryStat = await stat(resolvedPath)
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return {
        path: binaryPath,
        exists: false,
        executable: false,
        version: null,
        error: errorInfo('MIHOMO_BINARY_NOT_FOUND', 'Configured Mihomo binary does not exist.'),
      }
    }
    throw error
  }

  if (!binaryStat.isFile()) {
    return {
      path: resolvedPath,
      exists: true,
      executable: false,
      version: null,
      error: errorInfo('MIHOMO_BINARY_NOT_FILE', 'Configured Mihomo binary is not a file.'),
    }
  }

  try {
    await access(resolvedPath, constants.X_OK)
  } catch {
    return {
      path: resolvedPath,
      exists: true,
      executable: false,
      version: null,
      error: errorInfo(
        'MIHOMO_BINARY_NOT_EXECUTABLE',
        'Configured Mihomo binary is not executable.',
      ),
    }
  }

  try {
    const { stdout, stderr } = await execFileAsync(resolvedPath, ['-v'], {
      encoding: 'utf8',
      timeout: 3000,
      maxBuffer: 64 * 1024,
      windowsHide: true,
    })
    const version = `${stdout || ''}\n${stderr || ''}`.trim().slice(0, 1000)

    return {
      path: resolvedPath,
      exists: true,
      executable: true,
      version: version || null,
      error: version
        ? null
        : errorInfo('MIHOMO_VERSION_EMPTY', 'Mihomo version command returned no output.'),
    }
  } catch (error) {
    return {
      path: resolvedPath,
      exists: true,
      executable: true,
      version: null,
      error: errorInfo(
        'MIHOMO_VERSION_FAILED',
        error?.killed ? 'Mihomo version command timed out.' : 'Unable to read the Mihomo version.',
      ),
    }
  }
}
