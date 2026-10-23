// Also bound native bridges that ignore abort signals, including body reads.
async function withTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("Diagnostics request timed out"));
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export function fetchWithTimeout(
  input: Parameters<typeof fetch>[0],
  init: RequestInit = {},
  timeoutMs = 5000,
) {
  return withTimeout((signal) => fetch(input, { ...init, signal }), timeoutMs);
}

export function fetchJsonWithTimeout(
  input: Parameters<typeof fetch>[0],
  timeoutMs = 2000,
): Promise<unknown> {
  return withTimeout(async (signal) => {
    const response = await fetch(input, { signal });
    if (!response.ok) throw new Error("Diagnostics manifest unavailable");
    return response.json();
  }, timeoutMs);
}
