export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
  });
  let result: unknown;
  try { result = await response.json(); }
  catch { throw new Error('The server returned an unexpected response. Check that RelayDesk is running.'); }
  if (!response.ok) {
    const failure = result as { error?: { message?: string } };
    throw new Error(failure.error?.message || `Request failed (${response.status}).`);
  }
  return result as T;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong. Please try again.';
}
