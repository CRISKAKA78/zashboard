import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { LocalHelperError } from '../src/errors.mjs'
import { convertMrsToText } from '../src/mrsConversion.mjs'

const createSource = async (testContext, content = 'mrs-binary') => {
  const root = await mkdtemp(join(tmpdir(), 'zashboard-mrs-test-'))
  const sourcePath = join(root, 'source.mrs')
  await writeFile(sourcePath, content)
  testContext.after(() => rm(root, { recursive: true, force: true }))
  return sourcePath
}

const conversionOptions = (sourcePath, overrides = {}) => ({
  binaryPath: join(dirname(sourcePath), 'mihomo'),
  behavior: 'domain',
  sourcePath,
  timeoutMs: 1000,
  maxBytes: 1024 * 1024,
  ...overrides,
})

const fakeExecutable = async () => 'fake-mihomo'

describe('Mihomo MRS conversion', () => {
  it('uses an argument array, a private copy, and always removes its temporary directory', async (t) => {
    const sourcePath = await createSource(t)
    let temporarySource
    let temporaryTarget

    const result = await convertMrsToText(conversionOptions(sourcePath), {
      ensureExecutable: fakeExecutable,
      execute: async (binary, args, options) => {
        assert.equal(binary, 'fake-mihomo')
        assert.deepEqual(args.slice(0, 3), ['convert-ruleset', 'domain', 'mrs'])
        assert.equal(options.timeout, 1000)
        temporarySource = args[3]
        temporaryTarget = args[4]
        assert.notEqual(temporarySource, sourcePath)
        assert.equal(await readFile(temporarySource, 'utf8'), 'mrs-binary')
        await writeFile(temporaryTarget, '+.openai.com\n')
      },
    })

    assert.equal(result.source, '+.openai.com\n')
    await assert.rejects(() => stat(dirname(temporaryTarget)), { code: 'ENOENT' })
  })

  it('rejects an empty MRS source before executing Mihomo', async (t) => {
    const sourcePath = await createSource(t, '')
    let executed = false

    await assert.rejects(
      () =>
        convertMrsToText(conversionOptions(sourcePath), {
          ensureExecutable: fakeExecutable,
          execute: async () => {
            executed = true
          },
        }),
      (error) => error instanceof LocalHelperError && error.code === 'MRS_SOURCE_EMPTY',
    )
    assert.equal(executed, false)
  })

  it('reports a missing Mihomo binary', async (t) => {
    const sourcePath = await createSource(t)

    await assert.rejects(
      () => convertMrsToText(conversionOptions(sourcePath)),
      (error) => error instanceof LocalHelperError && error.code === 'MIHOMO_BINARY_NOT_FOUND',
    )
  })

  it('maps a damaged MRS conversion exit into a friendly error', async (t) => {
    const sourcePath = await createSource(t, 'damaged')

    await assert.rejects(
      () =>
        convertMrsToText(conversionOptions(sourcePath), {
          ensureExecutable: fakeExecutable,
          execute: async () => {
            throw Object.assign(new Error('conversion failed'), {
              code: 1,
              stderr: 'invalid MRS payload',
            })
          },
        }),
      (error) =>
        error instanceof LocalHelperError &&
        error.code === 'MRS_CONVERSION_FAILED' &&
        error.message === 'Mihomo convert-ruleset returned exit code 1: invalid MRS payload',
    )
  })

  it('maps binary execution permission failure', async (t) => {
    const sourcePath = await createSource(t)

    await assert.rejects(
      () =>
        convertMrsToText(conversionOptions(sourcePath), {
          ensureExecutable: fakeExecutable,
          execute: async () => {
            throw Object.assign(new Error('access denied'), { code: 'EACCES' })
          },
        }),
      (error) => error instanceof LocalHelperError && error.code === 'MIHOMO_BINARY_NOT_EXECUTABLE',
    )
  })

  it('maps a conversion timeout and removes temporary files', async (t) => {
    const sourcePath = await createSource(t)
    let temporaryTarget

    await assert.rejects(
      () =>
        convertMrsToText(conversionOptions(sourcePath), {
          ensureExecutable: fakeExecutable,
          execute: async (_binary, args) => {
            temporaryTarget = args[4]
            throw Object.assign(new Error('timed out'), { killed: true })
          },
        }),
      (error) => error instanceof LocalHelperError && error.code === 'MRS_CONVERSION_TIMEOUT',
    )
    await assert.rejects(() => stat(dirname(temporaryTarget)), { code: 'ENOENT' })
  })

  it('rejects unsupported MRS behavior without executing Mihomo', async (t) => {
    const sourcePath = await createSource(t)

    await assert.rejects(
      () =>
        convertMrsToText(conversionOptions(sourcePath, { behavior: 'classical' }), {
          ensureExecutable: fakeExecutable,
        }),
      (error) => error instanceof LocalHelperError && error.code === 'MRS_BEHAVIOR_UNSUPPORTED',
    )
  })
})
