export class LocalHelperError extends Error {
  constructor(code, message, status = 500, options = {}) {
    super(message, options)
    this.name = 'LocalHelperError'
    this.code = code
    this.status = status
  }
}

export const toPublicError = (error) => {
  if (error instanceof LocalHelperError) {
    return {
      status: error.status,
      body: {
        error: {
          code: error.code,
          message: error.message,
        },
      },
    }
  }

  console.error(error)
  return {
    status: 500,
    body: {
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Local Helper encountered an unexpected error.',
      },
    },
  }
}
