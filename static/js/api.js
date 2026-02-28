// api.js — Chirm API client
// All REST calls go through the api object. Base path: /api/v1/

export const api = {
  async fetch(path, opts = {}) {
    const res = await fetch(path, {
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...opts.headers },
      ...opts,
    });
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
