// scripts/critique/providers/fetchClient.ts
// A tiny fetch wrapper shared by every provider: an AbortController-based timeout, and one
// retry on 429 (rate limited) or any 5xx (server error) -- never on 4xx other than 429,
// since those are a request-shape problem a retry won't fix. No dependency, matching the
// rest of this repo's "small, fetch-based, no framework" convention (BRIEF LAW 5).
export interface FetchJsonOptions {
  timeoutMs: number;
  retries?: number;
  retryDelayMs?: number;
}

export class HttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

function isRetryable(status: number): boolean {
  return status === 429 || status >= 500;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** POSTs JSON and parses a JSON response. Times out via AbortController after `timeoutMs`;
 *  retries exactly once (default) on a 429/5xx response, waiting `retryDelayMs` (default
 *  1000ms) first. A timeout itself is NOT retried -- if the first attempt didn't answer in
 *  time, a second attempt of the same size is unlikely to either, and every retry spends
 *  real provider credits (the founder's spend guard covers call *count*, not retries, so
 *  keeping retries to "server said try again" cases only keeps the guard meaningful). */
export async function postJson(url: string, headers: Record<string, string>, body: unknown, opts: FetchJsonOptions): Promise<unknown> {
  const retries = opts.retries ?? 1;
  const retryDelayMs = opts.retryDelayMs ?? 1000;

  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        if (isRetryable(res.status) && attempt < retries) {
          await sleep(retryDelayMs);
          continue;
        }
        throw new HttpError(`HTTP ${res.status} from ${url}`, res.status, text);
      }
      return await res.json();
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      // AbortError (timeout) is not retried -- see doc comment above.
      break;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
