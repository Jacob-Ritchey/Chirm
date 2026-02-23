// notifications.js — Chirm Notification System v2
// Handles: permission requests, SW push subscription, in-page toasts,
// and routing of notification events.

const ChirmNotifs = (() => {
  let _swReg = null;
  let _permState = Notification?.permission ?? 'denied';

  // ── Init ────────────────────────────────────────────────────────────────────

  async function init(swReg) {
    _swReg = swReg;
    _permState = Notification?.permission ?? 'denied';

    // Handle SW-forwarded notification clicks (user clicked OS notification,
    // SW focused our tab and posted a message telling us which channel to open)
    navigator.serviceWorker?.addEventListener('message', (event) => {
      if (event.data?.type === 'notification.clicked') {
        const ch = App.channels?.find(c => c.id === event.data.channel_id);
        if (ch) openChannel(ch);
      }
    });

    // Sync the inBrowserOnly preference into the SW immediately.
    // The SW cannot read localStorage, so we must push the value explicitly.
    // This also handles the case where the user set the pref on a previous session.
    await _syncPrefsToSW();

    // Belt-and-suspenders: also remove the push subscription server-side so the
    // server doesn't waste cycles sending pushes that the SW will silently drop.
    if (typeof ChirmSettings !== 'undefined' &&
        typeof ChirmSettings.isInBrowserOnly === 'function' &&
        ChirmSettings.isInBrowserOnly()) {
      await unsubscribePush();
    }

    console.log('[Chirm Notifs] init, permission:', _permState, '| inBrowserOnly:',
      typeof ChirmSettings !== 'undefined' ? ChirmSettings.isInBrowserOnly?.() : 'unknown');
  }

  // Push current settings into the SW context via postMessage.
  // Must be called whenever inBrowserOnly changes, and on every page load.
  async function _syncPrefsToSW() {
    if (!_swReg) return;
    const sw = _swReg.active || _swReg.waiting || _swReg.installing;
    if (!sw) return;
    const inBrowserOnly = typeof ChirmSettings !== 'undefined' &&
      typeof ChirmSettings.isInBrowserOnly === 'function' &&
      ChirmSettings.isInBrowserOnly();
    sw.postMessage({ type: 'set-notification-prefs', inBrowserOnly });
  }

  // ── Permission request ───────────────────────────────────────────────────────

  async function requestPermission() {
    if (!('Notification' in window)) {
      console.warn('[Chirm Notifs] Notifications not supported');
      return 'denied';
    }
    if (Notification.permission === 'granted') {
      _permState = 'granted';
      await _trySubscribePush();
      return 'granted';
    }
    if (Notification.permission === 'denied') {
      _permState = 'denied';
      return 'denied';
    }
    const result = await Notification.requestPermission();
    _permState = result;
    console.log('[Chirm Notifs] Permission result:', result);
    if (result === 'granted') {
      await _trySubscribePush();
    }
    return result;
  }

  // ── Push Subscription ────────────────────────────────────────────────────────

  async function _trySubscribePush() {
    if (!_swReg) {
      console.warn('[Chirm Notifs] No SW registration, skipping push subscription');
      return;
    }
    try {
      const res = await fetch('/api/push/vapid-public-key', { credentials: 'include' });
      if (!res.ok) {
        console.warn('[Chirm Notifs] Could not fetch VAPID key:', res.status);
        return;
      }
      const { public_key } = await res.json();
      if (!public_key) {
        console.warn('[Chirm Notifs] Server returned no VAPID public key');
        return;
      }

      const appServerKey = _urlBase64ToUint8Array(public_key);
      let subscription = await _swReg.pushManager.getSubscription();

      if (!subscription) {
        subscription = await _swReg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: appServerKey,
        });
        console.log('[Chirm Notifs] New push subscription:', subscription.endpoint);
      } else {
        console.log('[Chirm Notifs] Existing push subscription:', subscription.endpoint);
      }

      // Send subscription to server
      const saveRes = await fetch('/api/push/subscribe', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(subscription.toJSON()),
      });
      if (!saveRes.ok) {
        console.warn('[Chirm Notifs] Failed to save subscription:', saveRes.status);
      } else {
        console.log('[Chirm Notifs] Push subscription saved to server');
      }

      // Register periodic background sync (Chrome 80+)
      if ('periodicSync' in _swReg) {
        try {
          const status = await navigator.permissions.query({ name: 'periodic-background-sync' });
          if (status.state === 'granted') {
            await _swReg.periodicSync.register('chirm-check-messages', {
              minInterval: 5 * 60 * 1000,
            });
            console.log('[Chirm Notifs] Periodic sync registered');
          }
        } catch (e) {
          console.warn('[Chirm Notifs] Periodic sync unavailable:', e.message);
        }
      }
    } catch (err) {
      // Common failure: LAN IP with self-signed cert — browser blocks push subscribe
      console.error('[Chirm Notifs] Push subscription failed:', err.message,
        '\n  Tip: Push subscriptions require valid HTTPS. For LAN testing, use a tunnel (ngrok, cloudflared) or a proper cert.');
    }
  }

  async function unsubscribePush() {
    if (!_swReg) return;
    try {
      const sub = await _swReg.pushManager.getSubscription();
      if (sub) {
        await fetch('/api/push/unsubscribe', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ endpoint: sub.endpoint }),
        });
        await sub.unsubscribe();
        console.log('[Chirm Notifs] Unsubscribed from push');
      }
    } catch (err) {
      console.warn('[Chirm Notifs] Unsubscribe failed:', err.message);
    }
  }

  // ── Notification routing ─────────────────────────────────────────────────────

  /**
   * Called from the WS message.new handler whenever the page is not fully
   * active (hidden, unfocused, or user is in a different channel).
   * Decides whether to show a notification based on settings.
   */
  function onNewMessage(msg, channelName) {
    const settings = typeof ChirmSettings !== 'undefined' ? ChirmSettings.get() : {};

    // Never self-notify
    if (msg.user_id === App.user?.id) return;

    const channelId = msg.channel_id;
    const isMuted = settings.mutedChannels?.includes(channelId);
    const isMention = _isMentioned(msg.content);
    const pingsDisabled = settings.disablePings;

    // Muted channels only get through if it's a mention AND pings aren't globally disabled
    if (isMuted && (!isMention || pingsDisabled)) return;

    // If pings are globally off and it's only a mention, skip
    if (!isMuted && isMention && pingsDisabled) return;

    const authorName = msg.author?.username || 'Someone';
    const isCurrentChannel = App.currentChannel?.id === channelId;
    const pageHidden = document.visibilityState === 'hidden';
    const pageUnfocused = !document.hasFocus();

    const msgPreview = _truncate(
      msg.content || (msg.attachments?.length ? '📎 Attachment' : '…'),
      120
    );

    // Case 1: Page is hidden (tab not visible at all) — show OS notification
    if (pageHidden) {
      const title = isMention
        ? `${authorName} mentioned you in #${channelName}`
        : `#${channelName} — ${authorName}`;
      _showOsNotification(title, msgPreview, channelId, msg.id);
      return;
    }

    // Case 2: Page is visible but unfocused (another window is in front)
    // Show OS notification only for mentions
    if (pageUnfocused) {
      if (isMention) {
        _showOsNotification(`${authorName} mentioned you in #${channelName}`, msgPreview, channelId, msg.id);
      }
      return;
    }

    // Case 3: Page is visible AND focused
    // Mentions get both the in-app toast (for context) AND an OS notification
    // (for the sound/taskbar ping) — they're high-priority enough to warrant both.
    // Non-mentions are silent when the user is actively in the app.
    if (isMention) {
      _showMentionToast(authorName, channelName, msgPreview, channelId);
      _showOsNotification(`${authorName} mentioned you in #${channelName}`, msgPreview, channelId, msg.id);
    }
  }

  // ── OS notification ──────────────────────────────────────────────────────────

  function _showOsNotification(title, body, channelId, messageId) {
    // Always read the live browser permission — _permState can go stale if
    // the user changes their browser settings mid-session or in another tab.
    if (Notification?.permission !== 'granted') return;

    // User may have opted into in-browser toasts only — skip OS notifications.
    // Guard is typeof-safe in case an old cached user-settings.js is still active.
    if (typeof ChirmSettings !== 'undefined' &&
        typeof ChirmSettings.isInBrowserOnly === 'function' &&
        ChirmSettings.isInBrowserOnly()) return;

    // Always use the direct Notification API from the page context.
    // swReg.showNotification() is only reliable inside a SW push event — calling
    // it from the page silently fails in Chrome after the first invocation, and
    // the new Notification() fallback is then also blocked when a SW is registered.
    // Using new Notification() directly is the correct approach here; push events
    // in sw.js still use self.registration.showNotification() as intended.
    //
    // Tag includes the message ID so every ping re-fires the OS alert instead of
    // silently replacing the previous notification for the same channel.
    if (!('Notification' in window)) return;
    try {
      const tag = messageId ? `chirm-${channelId}-${messageId}` : `chirm-${channelId}-${Date.now()}`;
      const n = new Notification(title, {
        body,
        icon: '/assets/jenn-circle.png',
        tag,
      });
      n.onclick = () => {
        window.focus();
        const ch = App.channels?.find(c => c.id === channelId);
        if (ch) openChannel(ch);
        n.close();
      };
    } catch (err) {
      console.warn('[Chirm Notifs] Notification() failed:', err.message);
    }
  }

  // ── In-page mention toast ────────────────────────────────────────────────────

  function _showMentionToast(authorName, channelName, body, channelId) {
    const container = document.getElementById('toast-container');
    if (!container) return;

    // Strip markdown syntax that looks noisy in a one-line preview,
    // then truncate to match the reply bar's 80-char pipeline.
    const cleanBody = _formatPreview(body, 80);

    const el = document.createElement('div');
    el.className = 'toast mention-toast';
    el.title = 'Go to channel';
    el.innerHTML =
      `<div class="mention-toast-header">` +
        `<span>@you · <strong>#${esc(channelName)}</strong></span>` +
        `<button class="mention-toast-dismiss" title="Dismiss">✕</button>` +
      `</div>` +
      `<div class="mention-toast-body">${esc(authorName)}: ${esc(cleanBody)}</div>`;

    // Dismiss button — closes without navigating
    el.querySelector('.mention-toast-dismiss').addEventListener('click', (e) => {
      e.stopPropagation();
      _dismissToast(el);
    });

    // Click anywhere else on the toast → navigate to channel
    el.addEventListener('click', () => {
      const ch = App.channels?.find(c => c.id === channelId);
      if (ch) openChannel(ch);
      _dismissToast(el);
    });

    container.appendChild(el);

    // Auto-dismiss after 8 s (with fade-out)
    const timer = setTimeout(() => _dismissToast(el), 8000);
    el._dismissTimer = timer;
  }

  function _dismissToast(el) {
    clearTimeout(el._dismissTimer);
    el.style.transition = 'opacity 0.2s, transform 0.2s';
    el.style.opacity = '0';
    el.style.transform = 'translateX(12px)';
    setTimeout(() => el.remove(), 200);
  }

  // Strip common markdown tokens and truncate for use in a preview line.
  function _formatPreview(text, maxLen) {
    if (!text) return '';
    return text
      .replace(/\*\*(.+?)\*\*/g, '$1')   // **bold**
      .replace(/\*(.+?)\*/g,   '$1')     // *italic*
      .replace(/`(.+?)`/g,     '$1')     // `code`
      .replace(/~~(.+?)~~/g,   '$1')     // ~~strike~~
      .replace(/^> /gm,        '')       // > blockquote prefix
      .replace(/\n+/g,         ' ')      // collapse newlines
      .trim()
      .slice(0, maxLen) + (text.trim().length > maxLen ? '…' : '');
  }

  // ── Mention detection ────────────────────────────────────────────────────────

  function _isMentioned(content) {
    if (!content || !App.user?.username) return false;
    const pattern = new RegExp(`@${_escapeRegex(App.user.username)}(?:\\b|$)`, 'i');
    return pattern.test(content);
  }

  // Public alias so WS handler in app.js can call it without coupling
  function _isMentionedPublic(content) {
    return _isMentioned(content);
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────

  function _urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(base64);
    return Uint8Array.from(raw, c => c.charCodeAt(0));
  }

  function _truncate(str, len) {
    return str.length > len ? str.slice(0, len) + '…' : str;
  }

  function _escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function isPermissionGranted() { return _permState === 'granted'; }
  function isPermissionDenied()  { return _permState === 'denied';  }

  return {
    init,
    requestPermission,
    unsubscribePush,
    onNewMessage,
    isPermissionGranted,
    isPermissionDenied,
    syncPrefsToSW: _syncPrefsToSW,
    _isMentionedPublic,   // exposed for WS handler
  };
})();
