// user-settings.js — Chirm User Settings
// Locally persisted settings (localStorage).
// Settings schema:
//   disablePings: bool       — suppress all @mention notifications
//   mutedChannels: string[]  — channel IDs where ALL notifications are muted
//   notifyGranted: bool      — whether user has been asked about notifications
//   inBrowserOnly: bool      — suppress OS/push notifications; in-app toasts only

const ChirmSettings = (() => {
  const STORAGE_KEY = 'chirm_user_settings';

  const DEFAULTS = {
    disablePings: false,
    mutedChannels: [],
    notifyGranted: false,
    inBrowserOnly: false,
  };

  // ── Read / Write ────────────────────────────────────────────────────────────

  function get() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return { ...DEFAULTS };
      return { ...DEFAULTS, ...JSON.parse(raw) };
    } catch {
      return { ...DEFAULTS };
    }
  }

  function _save(settings) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {}
  }

  function set(key, value) {
    const s = get();
    s[key] = value;
    _save(s);
  }

  // ── Convenience helpers ─────────────────────────────────────────────────────

  function isChannelMuted(channelId) {
    return get().mutedChannels.includes(channelId);
  }

  function muteChannel(channelId) {
    const s = get();
    if (!s.mutedChannels.includes(channelId)) {
      s.mutedChannels.push(channelId);
      _save(s);
    }
  }

  function unmuteChannel(channelId) {
    const s = get();
    s.mutedChannels = s.mutedChannels.filter(id => id !== channelId);
    _save(s);
  }

  function toggleMuteChannel(channelId) {
    if (isChannelMuted(channelId)) {
      unmuteChannel(channelId);
      return false;
    } else {
      muteChannel(channelId);
      return true;
    }
  }

  function setDisablePings(value) {
    set('disablePings', !!value);
  }

  function isPingsDisabled() {
    return !!get().disablePings;
  }

  function setInBrowserOnly(value) {
    set('inBrowserOnly', !!value);
  }
  function isInBrowserOnly() {
    return !!get().inBrowserOnly;
  }

  // ── Settings Modal UI ───────────────────────────────────────────────────────

  function openSettingsModal() {
    const s = get();
    // Safely read permission state even if ChirmNotifs hasn't fully initialized yet
    const currentPerm = ('Notification' in window) ? Notification.permission : 'denied';
    const notifGranted = currentPerm === 'granted';
    const notifDenied  = currentPerm === 'denied';

    const channelRows = (App.channels || [])
      .filter(c => c.type !== 'voice')
      .map(ch => {
        const muted = s.mutedChannels.includes(ch.id);
        const icon = ch.emoji ? ch.emoji : '#';
        return `<label class="settings-ch-row">
          <span class="settings-ch-name">${icon} ${esc(ch.name)}</span>
          <span class="settings-toggle-wrap">
            <input type="checkbox" class="ch-mute-cb" data-ch-id="${ch.id}" ${muted ? 'checked' : ''}>
            <span class="settings-toggle-label">${muted ? 'Muted' : 'Active'}</span>
          </span>
        </label>`;
      }).join('');

    let notifSection = '';
    if (notifDenied) {
      notifSection = `<div class="settings-info-box">
        🔕 Notifications are blocked by your browser. Enable them in your browser settings to receive alerts.
      </div>`;
    } else if (!notifGranted) {
      notifSection = `<button class="btn btn-primary btn-sm" id="settings-enable-notifs">
        🔔 Enable Notifications
      </button>`;
    } else {
      notifSection = `<div class="settings-info-box success" style="display:flex;align-items:center;justify-content:space-between;gap:12px">
        <span>🔔 Browser notifications are enabled.</span>
        <button class="btn btn-sm btn-secondary" id="settings-test-notif" style="flex-shrink:0">Send test</button>
      </div>`;
    }

    const bodyHtml = `
      <div class="settings-section">
        <h4 class="settings-section-title">Notifications</h4>
        <div style="margin-bottom:12px">${notifSection}</div>

        <label class="settings-toggle-row">
          <div>
            <div class="settings-row-label">Disable @mention pings</div>
            <div class="settings-row-hint">You won't receive alerts when someone @mentions you</div>
          </div>
          <input type="checkbox" id="settings-disable-pings" ${s.disablePings ? 'checked' : ''}>
        </label>

        <label class="settings-toggle-row">
          <div>
            <div class="settings-row-label">In-browser notifications only</div>
            <div class="settings-row-hint">Show toasts inside the app but suppress OS and push notifications</div>
          </div>
          <input type="checkbox" id="settings-in-browser-only" ${s.inBrowserOnly ? 'checked' : ''}>
        </label>
      </div>

      <div class="settings-section">
        <h4 class="settings-section-title">Channel Notifications</h4>
        <div class="settings-row-hint" style="margin-bottom:10px">
          Muted channels won't show notifications unless someone @mentions you.
        </div>
        <div class="settings-ch-list">
          ${channelRows || '<p class="text-muted" style="font-size:13px">No text channels available.</p>'}
        </div>
      </div>

      <div class="settings-section">
        <h4 class="settings-section-title">Cache</h4>
        <div class="settings-row-hint" style="margin-bottom:10px">
          Messages are cached locally for faster channel switching.
        </div>
        <button class="btn btn-sm btn-secondary" id="settings-clear-cache">Clear Message Cache</button>
      </div>
    `;

    showSimpleModal('⚙ Notification Settings', bodyHtml, null);

    // Wire up interactions after modal renders
    setTimeout(() => {
      // Enable notifications button
      document.getElementById('settings-enable-notifs')?.addEventListener('click', async () => {
        const result = await ChirmNotifs.requestPermission();
        if (result === 'granted') {
          toast('Notifications enabled!', 'success');
          document.querySelector('.modal-overlay')?.remove();
          openSettingsModal(); // re-open refreshed
        } else {
          toast('Notification permission denied', 'error');
        }
      });

      // Test push notification button
      document.getElementById('settings-test-notif')?.addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        btn.textContent = 'Sending…';
        try {
          const res = await fetch('/api/push/test', { method: 'POST', credentials: 'include' });
          const data = await res.json();
          if (data.sent > 0) {
            toast(`Test notification sent to ${data.sent} device(s)`, 'success');
          } else if (data.error) {
            toast(`Push failed: ${data.error}`, 'error');
            console.error('[Chirm Push test]', data.error);
          } else {
            toast('No push subscriptions found. Make sure notifications are enabled on this device.', 'info');
          }
        } catch (err) {
          toast('Test failed: ' + err.message, 'error');
        }
        btn.disabled = false;
        btn.textContent = 'Send test';
      });

      // Disable pings toggle
      document.getElementById('settings-disable-pings')?.addEventListener('change', (e) => {
        setDisablePings(e.target.checked);
        toast(e.target.checked ? 'Pings muted' : 'Pings enabled', 'info');
      });

      // In-browser-only toggle
      document.getElementById('settings-in-browser-only')?.addEventListener('change', async (e) => {
        setInBrowserOnly(e.target.checked);
        // Sync to SW immediately — the SW cannot read localStorage so we must
        // push the value explicitly. This makes the setting take effect right away
        // without requiring a page reload, which is critical on mobile.
        if (typeof ChirmNotifs !== 'undefined') {
          await ChirmNotifs.syncPrefsToSW();
        }
        if (e.target.checked) {
          // Also remove push subscription server-side as belt-and-suspenders
          if (typeof ChirmNotifs !== 'undefined') await ChirmNotifs.unsubscribePush();
          toast('OS notifications suppressed — toasts only', 'info');
        } else {
          // Re-subscribe so push notifications flow again
          if (typeof ChirmNotifs !== 'undefined') await ChirmNotifs.requestPermission();
          toast('OS notifications re-enabled', 'info');
        }
      });

      // Per-channel mute checkboxes
      document.querySelectorAll('.ch-mute-cb').forEach(cb => {
        cb.addEventListener('change', (e) => {
          const chId = e.target.dataset.chId;
          const nowMuted = toggleMuteChannel(chId);
          const label = e.target.nextElementSibling;
          if (label) label.textContent = nowMuted ? 'Muted' : 'Active';
          // Refresh channel list to show mute indicator
          if (typeof renderChannelList === 'function') renderChannelList();
          toast(nowMuted ? 'Channel muted' : 'Channel unmuted', 'info');
        });
      });

      // Clear cache button
      document.getElementById('settings-clear-cache')?.addEventListener('click', () => {
        ChirmCache.clearAll();
        toast('Message cache cleared', 'success');
      });
    }, 50);
  }

  return {
    get,
    set,
    isChannelMuted,
    muteChannel,
    unmuteChannel,
    toggleMuteChannel,
    setDisablePings,
    isPingsDisabled,
    openSettingsModal,
  };
})();
