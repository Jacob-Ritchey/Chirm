// api.js — Chirm API client
// All REST calls go through the api object. Base path: /api/v1/

let isRefreshing = false;
let refreshQueue = []; // queued retries while a refresh is in-flight

async function attemptRefresh() {
  if (isRefreshing) {
    // Already refreshing — wait for the in-flight refresh to complete.
    return new Promise((resolve, reject) => refreshQueue.push({ resolve, reject }));
  }
  isRefreshing = true;
  try {
    const res = await fetch('/api/v1/auth/refresh', { method: 'POST', credentials: 'include' });
    if (!res.ok) throw new Error('refresh failed');
    refreshQueue.forEach(p => p.resolve());
  } catch (e) {
    refreshQueue.forEach(p => p.reject(e));
    throw e;
  } finally {
    refreshQueue = [];
    isRefreshing = false;
  }
}

export const api = {
  async fetch(path, opts = {}, _isRetry = false) {
    const res = await fetch(path, {
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...opts.headers },
      ...opts,
    });

    // On 401, try to refresh the access token once then retry.
    if (res.status === 401 && !_isRetry) {
      try {
        await attemptRefresh();
        return api.fetch(path, opts, true);
      } catch {
        // Refresh failed — redirect to login.
        window.location.href = '/login';
        throw new Error('session expired');
      }
    }

    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.ok === false) throw new Error(body.error?.message || `HTTP ${res.status}`);
    return body.data !== undefined ? body.data : body;
  },
  get: (p) => api.fetch(p),
  post: (p, body) => api.fetch(p, { method: 'POST', body: JSON.stringify(body) }),
  put: (p, body) => api.fetch(p, { method: 'PUT', body: JSON.stringify(body) }),
  del: (p) => api.fetch(p, { method: 'DELETE' }),
};

export default api;
