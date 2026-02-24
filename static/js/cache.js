// cache.js — Chirm Message Cache
// Stores messages per channel in localStorage with a TTL.
// On channel open: serve from cache immediately, then keep in sync via WS events.

const ChirmCache = (() => {
  const PREFIX = 'chirm_cache_ch_';
  const TTL_MS = 10 * 60 * 1000; // 10 minutes
  const MAX_MSGS_PER_CHANNEL = 100;
  const MAX_CHANNELS = 20; // max channels to keep in cache before LRU eviction

  // ── Private helpers ────────────────────────────────────────────────────────

  function _key(channelId) {
    return PREFIX + channelId;
  }

  function _read(channelId) {
    try {
      const raw = localStorage.getItem(_key(channelId));
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return null;
      return parsed;
    } catch {
      return null;
    }
  }

  function _write(channelId, entry) {
    try {
      localStorage.setItem(_key(channelId), JSON.stringify(entry));
      _updateLRU(channelId);
    } catch (e) {
      // localStorage full — evict oldest channel and retry once
      _evictOldest();
      try {
        localStorage.setItem(_key(channelId), JSON.stringify(entry));
      } catch {
        // Give up silently — cache is best-effort
      }
    }
  }

  // ── LRU tracking ──────────────────────────────────────────────────────────

  function _getLRU() {
    try {
      return JSON.parse(localStorage.getItem('chirm_cache_lru') || '[]');
    } catch { return []; }
  }

  function _updateLRU(channelId) {
    let lru = _getLRU().filter(id => id !== channelId);
    lru.unshift(channelId);
    if (lru.length > MAX_CHANNELS) {
      const evicted = lru.splice(MAX_CHANNELS);
      evicted.forEach(id => localStorage.removeItem(_key(id)));
    }
    try {
      localStorage.setItem('chirm_cache_lru', JSON.stringify(lru));
    } catch {}
  }

  function _evictOldest() {
    const lru = _getLRU();
    if (lru.length) {
      const oldest = lru.pop();
      localStorage.removeItem(_key(oldest));
      try {
        localStorage.setItem('chirm_cache_lru', JSON.stringify(lru));
      } catch {}
    }
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Get cached messages for a channel.
   * Returns { messages, cachedAt, fresh } or null if no cache or expired.
   */
  function get(channelId) {
    const entry = _read(channelId);
    if (!entry) return null;
    const age = Date.now() - (entry.cachedAt || 0);
    return {
      messages: entry.messages || [],
      cachedAt: entry.cachedAt,
      fresh: age < TTL_MS,
    };
  }

  /**
   * Store a full set of messages for a channel (called after API load).
   */
  function set(channelId, messages) {
    const limited = messages.slice(-MAX_MSGS_PER_CHANNEL);
    _write(channelId, {
      messages: limited,
      cachedAt: Date.now(),
    });
  }

  /**
   * Append a single new message to the cache (called on WS message.new).
   * Keeps the list bounded to MAX_MSGS_PER_CHANNEL.
   */
  function appendMessage(channelId, msg) {
    const entry = _read(channelId);
    if (!entry) return; // don't create a cache entry from a single message
    const msgs = entry.messages || [];
    // Deduplicate
    if (!msgs.find(m => m.id === msg.id)) {
      msgs.push(msg);
      if (msgs.length > MAX_MSGS_PER_CHANNEL) msgs.shift();
    }
    _write(channelId, { messages: msgs, cachedAt: entry.cachedAt });
  }

  /**
   * Update a message in cache (called on WS message.edit).
   */
  function updateMessage(channelId, updatedMsg) {
    const entry = _read(channelId);
    if (!entry) return;
    const msgs = entry.messages || [];
    const idx = msgs.findIndex(m => m.id === updatedMsg.id);
    if (idx >= 0) msgs[idx] = updatedMsg;
    _write(channelId, { messages: msgs, cachedAt: entry.cachedAt });
  }

  /**
   * Remove a message from cache (called on WS message.delete).
   */
  function deleteMessage(channelId, messageId) {
    const entry = _read(channelId);
    if (!entry) return;
    const msgs = (entry.messages || []).filter(m => m.id !== messageId);
    _write(channelId, { messages: msgs, cachedAt: entry.cachedAt });
  }

  /**
   * Update reactions for a message in cache.
   */
  function updateReactions(channelId, messageId, reactions) {
    const entry = _read(channelId);
    if (!entry) return;
    const msgs = entry.messages || [];
    const msg = msgs.find(m => m.id === messageId);
    if (msg) msg.reactions = reactions;
    _write(channelId, { messages: msgs, cachedAt: entry.cachedAt });
  }

  /**
   * Invalidate a specific channel's cache.
   */
  function invalidate(channelId) {
    localStorage.removeItem(_key(channelId));
  }

  /**
   * Clear all Chirm caches.
   */
  function clearAll() {
    const lru = _getLRU();
    lru.forEach(id => localStorage.removeItem(_key(id)));
    localStorage.removeItem('chirm_cache_lru');
  }

  /**
   * Return cache metadata for debugging.
   */
  function stats() {
    const lru = _getLRU();
    return lru.map(id => {
      const entry = _read(id);
      return {
        channelId: id,
        messageCount: entry?.messages?.length || 0,
        cachedAt: entry?.cachedAt ? new Date(entry.cachedAt).toLocaleTimeString() : 'never',
        ageSec: entry?.cachedAt ? Math.round((Date.now() - entry.cachedAt) / 1000) : null,
      };
    });
  }

  return { get, set, appendMessage, updateMessage, deleteMessage, updateReactions, invalidate, clearAll, stats };
})();
