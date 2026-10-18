export class OperationTimeoutError extends Error {}

/** Bound waiting even for bindings that have no AbortSignal support. */
export async function withTimeout<T>(operation: Promise<T>, ms: number, cancel?: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          try { cancel?.() } finally { reject(new OperationTimeoutError(`operation timed out after ${ms}ms`)) }
        }, ms)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
