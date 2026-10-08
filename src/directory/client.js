// Client for the kpdd.com staff API (docs/kpdd-api.md).

export class StaffApiError extends Error {
  constructor(message, { status, retryable = false } = {}) {
    super(message);
    this.status = status;
    this.retryable = retryable;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createStaffClient({ url, key, fetch = globalThis.fetch, maxRetries = 3, wait = sleep }) {
  if (!url || !key) throw new Error('KPDD_API_URL and KPDD_API_KEY are required for directory sync');

  async function request(path) {
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await fetch(url + path, { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' } });
      } catch (err) {
        if (attempt >= maxRetries) throw new StaffApiError(`staff API unreachable: ${err.message}`, { retryable: true });
        await wait(1000 * 2 ** attempt);
        continue;
      }

      if (res.ok) return { status: res.status, body: await res.json() };
      if (res.status === 404) return { status: 404 };
      if (res.status === 401 || res.status === 403) {
        // A key problem won't fix itself; stop instead of retrying.
        const body = await res.json().catch(() => ({}));
        throw new StaffApiError(`staff API refused the key (${res.status}${body.error ? ` ${body.error}` : ''})`, { status: res.status });
      }
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= maxRetries) {
        throw new StaffApiError(`staff API ${res.status} on ${path}`, { status: res.status, retryable });
      }
      const retryAfter = Number(res.headers.get('retry-after'));
      await wait(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt);
    }
  }

  // Yields one page at a time: { data, asOf }. Every page of one listing shares as_of.
  async function* pages({ updatedSince, limit = 1000 } = {}) {
    let cursor = null;
    do {
      const q = new URLSearchParams({ limit: String(limit) });
      if (updatedSince) q.set('updated_since', updatedSince);
      if (cursor) q.set('cursor', cursor);
      const { body } = await request(`/staff?${q}`);
      yield { data: body.data, asOf: body.as_of };
      cursor = body.next_cursor;
    } while (cursor);
  }

  async function get(dashStaffId) {
    const res = await request(`/staff/${encodeURIComponent(dashStaffId)}`);
    return res.status === 404 ? null : res.body;
  }

  return { pages, get };
}
