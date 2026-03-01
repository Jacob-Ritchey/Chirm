// user-settings.js — Chirm User Settings
// Locally persisted settings (localStorage).
// Settings schema:
//   disablePings: bool       — suppress all @mention notifications
//   mutedChannels: string[]  — channel IDs where ALL notifications are muted
//   notifyGranted: bool      — whether user has been asked about notifications
//   inBrowserOnly: bool      — suppress OS/push notifications; in-app toasts only

import App from './state.js';
import api from './api.js';
import { toast, esc, escAttr, escInline, stringToColor } from './utils.js';
import ChirmCache from './cache.js';
import ChirmNotifs from './notifications.js';
import ChirmTheme from './theme.js';

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

  // ── Tab switcher ────────────────────────────────────────────────────────────

  function switchUserSettingsTab(tab) {
    const modal = document.getElementById('user-settings-modal');
    if (!modal) return;
    modal.querySelectorAll('.us-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    modal.querySelectorAll('.us-pane').forEach(p => p.classList.toggle('active', p.id === `us-pane-${tab}`));
  }

  // ── Profile tab state ────────────────────────────────────────────────────────

  let _profileLinks = [];

  function _buildLinksEditor() {
    if (!_profileLinks.length) {
      return `<div id="profile-links-list" style="margin-bottom:8px"></div>`;
    }
    const rows = _profileLinks.map((l, i) => `
      <div class="profile-link-row" style="display:flex;gap:8px;margin-bottom:6px;align-items:center">
        <input type="text" placeholder="Label" value="${escAttr(l.label || '')}"
          oninput="ChirmSettings._updateLink(${i},'label',this.value)"
          style="flex:1;min-width:0">
        <input type="text" placeholder="URL" value="${escAttr(l.url || '')}"
          oninput="ChirmSettings._updateLink(${i},'url',this.value)"
          style="flex:2;min-width:0">
        <button class="btn btn-sm btn-ghost" onclick="ChirmSettings.removeProfileLink(${i})" title="Remove">✕</button>
      </div>
    `).join('');
    return `<div id="profile-links-list" style="margin-bottom:8px">${rows}</div>`;
  }

  // ── Profile tab HTML ────────────────────────────────────────────────────────

  function _buildProfileTab() {
    // Init links from App.user
    try { _profileLinks = JSON.parse(App.user.links || '[]'); } catch { _profileLinks = []; }

    const bannerStyle = App.user.banner
      ? `background:url('${esc(App.user.banner)}') center/cover;aspect-ratio:16/9;border-radius:var(--radius) var(--radius) 0 0;position:relative`
      : `background:linear-gradient(135deg,var(--accent),var(--bg-surface));aspect-ratio:16/9;border-radius:var(--radius) var(--radius) 0 0;position:relative`;
    const avatarHtml = App.user.avatar
      ? `<img src="${esc(App.user.avatar)}" style="width:72px;height:72px;border-radius:50%;object-fit:cover;border:3px solid var(--bg-surface)">`
      : `<div class="avatar avatar-lg" style="background:${stringToColor(App.user.username)};border:3px solid var(--bg-surface)">${App.user.username[0].toUpperCase()}</div>`;
    const bio = App.user.bio || '';
    return `
      <div style="background:var(--bg-elevated);border-radius:var(--radius);margin-bottom:20px;overflow:hidden">
        <div id="banner-preview-wrap" style="${bannerStyle}">
          <label class="btn btn-sm btn-secondary"
            style="position:absolute;bottom:8px;right:8px;cursor:pointer;display:inline-flex;align-items:center;gap:6px">
            🖼 Change Banner
            <input type="file" id="profile-banner-file" accept="image/jpeg,image/png,image/gif,image/webp" style="display:none">
          </label>
          ${App.user.banner ? `<button class="btn btn-sm btn-ghost" onclick="ChirmSettings._clearBanner()"
            style="position:absolute;bottom:8px;right:144px">Remove</button>` : ''}
        </div>
        <div style="display:flex;align-items:flex-end;gap:12px;padding:0 16px 16px;margin-top:-36px;position:relative;z-index:1">
          <div id="avatar-preview-wrap">${avatarHtml}</div>
          <div style="flex:1">
            <div style="font-weight:600;margin-bottom:4px">${esc(App.user.username)}</div>
            <div style="display:flex;gap:6px;flex-wrap:wrap">
              <label class="btn btn-sm btn-secondary" style="cursor:pointer;display:inline-flex;align-items:center;gap:6px">
                📷 Change Avatar
                <input type="file" id="profile-avatar-file" accept="image/jpeg,image/png,image/gif,image/webp" style="display:none">
              </label>
              ${App.user.avatar ? `<button class="btn btn-sm btn-ghost" id="avatar-remove-btn" onclick="clearAvatar()">Remove</button>` : ''}
            </div>
          </div>
        </div>
      </div>
      <div class="form-group">
        <label>Username</label>
        <input type="text" id="profile-username" value="${esc(App.user.username)}">
      </div>
      <div class="form-group">
        <label>About Me <span style="font-size:11px;color:var(--text-muted)">(markdown supported)</span></label>
        <textarea id="profile-bio" rows="4" maxlength="500"
          placeholder="Write something about yourself…"
          style="resize:vertical;width:100%"
          oninput="document.getElementById('bio-char-count').textContent=this.value.length">${escAttr(bio)}</textarea>
        <div style="font-size:11px;color:var(--text-muted);text-align:right;margin-top:2px">
          <span id="bio-char-count">${bio.length}</span>/500
        </div>
      </div>
      <div class="form-group">
        <label>Links <span style="font-size:11px;color:var(--text-muted)">(up to 5)</span></label>
        ${_buildLinksEditor()}
        <button class="btn btn-sm btn-secondary" id="profile-add-link-btn">+ Add Link</button>
      </div>
      <div id="avatar-upload-status" style="font-size:12px;color:var(--text-muted);margin-bottom:8px"></div>
      <button class="btn btn-primary" id="profile-save-btn">Save Profile</button>
    `;
  }

  // ── Notifications tab HTML ──────────────────────────────────────────────────

  function _buildNotificationsTab() {
    const s = get();
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

    return `
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
  }

  // ── Appearance tab HTML ─────────────────────────────────────────────────────

  function _buildPresetSelect() {
    const custom = ChirmTheme.getCustomPresets();
    const builtinOpts = ChirmTheme.THEME_PRESETS.map(p =>
      `<option value="${esc(p.name)}">${esc(p.name)}</option>`
    ).join('');
    const customOpts = custom.length
      ? `<optgroup label="Custom">${custom.map(p => `<option value="${esc(p.name)}">${esc(p.name)}</option>`).join('')}</optgroup>`
      : '';
    return `<optgroup label="Built-in">${builtinOpts}</optgroup>${customOpts}`;
  }

  function _buildAppearanceTab() {
    const userVars = (() => {
      try { return JSON.parse(localStorage.getItem('chirm_user_theme') || '{}'); } catch { return {}; }
    })();
    const serverVars = (() => {
      try { return JSON.parse(App.publicSettings?.theme_css_vars || '{}'); } catch { return {}; }
    })();

    const currentValue = (key) => {
      if (userVars[key]) return userVars[key];
      if (serverVars[key]) return serverVars[key];
      return getComputedStyle(document.documentElement).getPropertyValue(key).trim();
    };

    const groups = ChirmTheme.COLOR_GROUPS.map(g => {
      const items = g.vars.map(v => {
        const val = currentValue(v.key);
        const inputId = `theme-input-${v.key.slice(2)}`;
        return `<div class="theme-color-item">
          <input type="color" id="${inputId}" value="${esc(val)}" title="${esc(v.key)}">
          <label for="${inputId}">${esc(v.label)}</label>
        </div>`;
      }).join('');
      return `<div class="settings-section">
        <h4 class="settings-section-title">${esc(g.label)}</h4>
        <div class="theme-color-grid">${items}</div>
      </div>`;
    }).join('');

    return `
      <div class="settings-section" style="margin-bottom:0">
        <h4 class="settings-section-title">Preset Themes</h4>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px">
          <select id="theme-preset-select" style="flex:1;min-width:160px">
            <option value="">— Select a preset —</option>
            ${_buildPresetSelect()}
          </select>
          <button class="btn btn-sm btn-secondary" id="theme-apply-preset">Apply</button>
          <button class="btn btn-sm btn-danger" id="theme-delete-preset" title="Delete selected custom preset">🗑</button>
        </div>
      </div>
      ${groups}
      <div style="display:flex;gap:8px;margin-top:4px;flex-wrap:wrap;align-items:center">
        <button class="btn btn-primary" id="theme-save-btn">Save Appearance</button>
        <button class="btn btn-secondary" id="theme-reset-btn">Reset to Default</button>
      </div>
      <div class="settings-section" style="margin-top:12px;padding-top:12px;border-top:1px solid var(--border)">
        <h4 class="settings-section-title">Save as Custom Preset</h4>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <input type="text" id="theme-preset-name" placeholder="My Theme" style="flex:1;min-width:120px">
          <button class="btn btn-sm btn-secondary" id="theme-save-preset-btn">Save Preset</button>
        </div>
      </div>
    `;
  }

  // ── Wire notifications tab interactions ─────────────────────────────────────

  function _wireNotifications() {
    document.getElementById('settings-enable-notifs')?.addEventListener('click', async () => {
      const result = await ChirmNotifs.requestPermission();
      if (result === 'granted') {
        toast('Notifications enabled!', 'success');
        // Refresh just the notifications pane
        document.getElementById('us-pane-notifications').innerHTML = _buildNotificationsTab();
        setTimeout(_wireNotifications, 50);
      } else {
        toast('Notification permission denied', 'error');
      }
    });

    document.getElementById('settings-test-notif')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      btn.textContent = 'Sending…';
      try {
        const res = await fetch('/api/v1/push/test', { method: 'POST', credentials: 'include' });
        const data = await res.json();
        if (data.sent > 0) {
          toast(`Test notification sent to ${data.sent} device(s)`, 'success');
        } else if (data.error) {
          toast(`Push failed: ${data.error}`, 'error');
        } else {
          toast('No push subscriptions found.', 'info');
        }
      } catch (err) {
        toast('Test failed: ' + err.message, 'error');
      }
      btn.disabled = false;
      btn.textContent = 'Send test';
    });

    document.getElementById('settings-disable-pings')?.addEventListener('change', (e) => {
      setDisablePings(e.target.checked);
      toast(e.target.checked ? 'Pings muted' : 'Pings enabled', 'info');
    });

    document.getElementById('settings-in-browser-only')?.addEventListener('change', async (e) => {
      setInBrowserOnly(e.target.checked);
      if (typeof ChirmNotifs !== 'undefined') await ChirmNotifs.syncPrefsToSW?.();
      if (e.target.checked) {
        if (typeof ChirmNotifs !== 'undefined') await ChirmNotifs.unsubscribePush();
        toast('OS notifications suppressed — toasts only', 'info');
      } else {
        if (typeof ChirmNotifs !== 'undefined') await ChirmNotifs.requestPermission();
        toast('OS notifications re-enabled', 'info');
      }
    });

    document.querySelectorAll('.ch-mute-cb').forEach(cb => {
      cb.addEventListener('change', (e) => {
        const chId = e.target.dataset.chId;
        const nowMuted = toggleMuteChannel(chId);
        const label = e.target.nextElementSibling;
        if (label) label.textContent = nowMuted ? 'Muted' : 'Active';
        if (typeof window.renderChannelList === 'function') window.renderChannelList();
        toast(nowMuted ? 'Channel muted' : 'Channel unmuted', 'info');
      });
    });

    document.getElementById('settings-clear-cache')?.addEventListener('click', () => {
      ChirmCache.clearAll();
      toast('Message cache cleared', 'success');
    });
  }

  // ── Wire profile tab interactions ────────────────────────────────────────────

  function _wireProfile() {
    // Avatar preview on file select
    document.getElementById('profile-avatar-file')?.addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        const wrap = document.getElementById('avatar-preview-wrap');
        if (wrap) wrap.innerHTML = `<img src="${ev.target.result}" style="width:72px;height:72px;border-radius:50%;object-fit:cover;border:3px solid var(--accent)">`;
      };
      reader.readAsDataURL(file);
      const status = document.getElementById('avatar-upload-status');
      if (status) status.textContent = `Avatar selected: ${file.name}`;
    });

    // Banner preview on file select
    document.getElementById('profile-banner-file')?.addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        const wrap = document.getElementById('banner-preview-wrap');
        if (wrap) wrap.style.backgroundImage = `url('${ev.target.result}')`;
      };
      reader.readAsDataURL(file);
    });

    // Add link button
    document.getElementById('profile-add-link-btn')?.addEventListener('click', () => {
      if (_profileLinks.length >= 5) { toast('Maximum 5 links', 'error'); return; }
      _profileLinks.push({ label: '', url: '' });
      _refreshLinksEditor();
    });

    document.getElementById('profile-save-btn')?.addEventListener('click', async () => {
      const username = document.getElementById('profile-username').value.trim();
      if (!username) { toast('Username required', 'error'); return; }

      const bio = document.getElementById('profile-bio')?.value || '';
      const links = JSON.stringify(_profileLinks.filter(l => l.url.trim()));

      const statusEl = document.getElementById('avatar-upload-status');

      // Upload banner if selected
      const bannerFile = document.getElementById('profile-banner-file')?.files?.[0];
      if (bannerFile) {
        const formData = new FormData();
        formData.append('banner', bannerFile);
        if (statusEl) statusEl.textContent = 'Uploading banner…';
        try {
          const res = await fetch('/api/v1/me/banner', { method: 'POST', credentials: 'include', body: formData });
          const body = await res.json();
          if (!res.ok) {
            toast(body.error?.message || 'Banner upload failed', 'error');
            return;
          }
          App.user = { ...App.user, ...(body.data ?? body) };
        } catch {
          toast('Banner upload failed', 'error');
          return;
        }
      }

      // Upload avatar if selected
      const avatarFile = document.getElementById('profile-avatar-file')?.files?.[0];
      let avatarUrl = App.user.avatar || '';
      if (avatarFile) {
        const formData = new FormData();
        formData.append('avatar', avatarFile);
        if (statusEl) statusEl.textContent = 'Uploading avatar…';
        try {
          const res = await fetch('/api/v1/me/avatar', { method: 'POST', credentials: 'include', body: formData });
          const body = await res.json();
          if (!res.ok) {
            toast(body.error?.message || 'Avatar upload failed', 'error');
            return;
          }
          const updatedUser = body.data ?? body;
          App.user = { ...App.user, ...updatedUser };
          avatarUrl = App.user.avatar;
        } catch {
          toast('Avatar upload failed', 'error');
          return;
        }
      }

      // Save profile data
      if (statusEl) statusEl.textContent = '';
      try {
        const updated = await api.put('/api/v1/me', { username, avatar: avatarUrl, bio, links });
        App.user = updated;
        if (typeof window.renderUserPanel === 'function') window.renderUserPanel();
        toast('Profile updated', 'success');
      } catch (e) { toast(e.message || 'Failed to save profile', 'error'); }
    });
  }

  function _refreshLinksEditor() {
    const list = document.getElementById('profile-links-list');
    if (!list) return;
    if (!_profileLinks.length) { list.innerHTML = ''; return; }
    list.innerHTML = _profileLinks.map((l, i) => `
      <div class="profile-link-row" style="display:flex;gap:8px;margin-bottom:6px;align-items:center">
        <input type="text" placeholder="Label" value="${escAttr(l.label || '')}"
          oninput="ChirmSettings._updateLink(${i},'label',this.value)"
          style="flex:1;min-width:0">
        <input type="text" placeholder="URL (https://…)" value="${escAttr(l.url || '')}"
          oninput="ChirmSettings._updateLink(${i},'url',this.value)"
          style="flex:2;min-width:0">
        <button class="btn btn-sm btn-ghost" onclick="ChirmSettings.removeProfileLink(${i})" title="Remove">✕</button>
      </div>
    `).join('');
  }

  function addProfileLink() {
    if (_profileLinks.length >= 5) { toast('Maximum 5 links', 'error'); return; }
    _profileLinks.push({ label: '', url: '' });
    _refreshLinksEditor();
  }

  function removeProfileLink(i) {
    _profileLinks.splice(i, 1);
    _refreshLinksEditor();
  }

  function _updateLink(i, field, value) {
    if (_profileLinks[i]) _profileLinks[i][field] = value;
  }

  function _clearBanner() {
    App.user.banner = '';
    const wrap = document.getElementById('banner-preview-wrap');
    if (wrap) {
      wrap.style.background = 'linear-gradient(135deg,var(--accent),var(--bg-surface))';
      wrap.style.backgroundImage = '';
    }
    api.put('/api/v1/me', {
      username: App.user.username,
      avatar: App.user.avatar || '',
      bio: App.user.bio || '',
      links: App.user.links || '[]',
      banner: '',
    }).then(u => { App.user = u; }).catch(() => {});
  }

  // ── Wire appearance tab interactions ─────────────────────────────────────────

  function _refreshAppearancePane() {
    const pane = document.getElementById('us-pane-appearance');
    if (pane) { pane.innerHTML = _buildAppearanceTab(); setTimeout(_wireAppearance, 50); }
  }

  function _collectCurrentVars() {
    const vars = {};
    for (const key of ChirmTheme.COLOR_VARS) {
      const el = document.getElementById(`theme-input-${key.slice(2)}`);
      if (el) vars[key] = el.value;
    }
    return vars;
  }

  function _wireAppearance() {
    document.getElementById('theme-apply-preset')?.addEventListener('click', () => {
      const name = document.getElementById('theme-preset-select').value;
      if (!name) return;
      const preset = ChirmTheme.getAllPresets().find(p => p.name === name);
      if (!preset) return;
      for (const [key, val] of Object.entries(preset.vars)) {
        const el = document.getElementById(`theme-input-${key.slice(2)}`);
        if (el) el.value = val;
      }
      ChirmTheme.applyVars(preset.vars);
      ChirmTheme.saveUserTheme(preset.vars);
    });

    document.getElementById('theme-delete-preset')?.addEventListener('click', () => {
      const name = document.getElementById('theme-preset-select').value;
      if (!name) return;
      const isBuiltin = ChirmTheme.THEME_PRESETS.some(p => p.name === name);
      if (isBuiltin) { toast('Cannot delete built-in presets', 'error'); return; }
      ChirmTheme.deleteCustomPreset(name);
      _refreshAppearancePane();
      toast(`Preset "${name}" deleted`, 'info');
    });

    document.getElementById('theme-save-btn')?.addEventListener('click', () => {
      const vars = _collectCurrentVars();
      ChirmTheme.saveUserTheme(vars);
      ChirmTheme.applyVars(vars);
      toast('Appearance saved', 'success');
    });

    document.getElementById('theme-reset-btn')?.addEventListener('click', () => {
      ChirmTheme.resetUserTheme();
      _refreshAppearancePane();
      toast('Appearance reset to server default', 'info');
    });

    document.getElementById('theme-save-preset-btn')?.addEventListener('click', () => {
      const name = document.getElementById('theme-preset-name').value.trim();
      if (!name) { toast('Enter a preset name', 'error'); return; }
      const vars = _collectCurrentVars();
      ChirmTheme.saveCustomPreset(name, vars);
      _refreshAppearancePane();
      toast(`Preset "${name}" saved`, 'success');
    });

    // Live preview on color input changes
    document.getElementById('us-pane-appearance')?.querySelectorAll('input[type="color"]').forEach(input => {
      input.addEventListener('input', (e) => {
        document.documentElement.style.setProperty(`--${e.target.id.replace('theme-input-', '')}`, e.target.value);
      });
    });
  }

  // ── Unified Settings Modal ──────────────────────────────────────────────────

  function openUserSettings(defaultTab = 'profile') {
    // Remove any existing instance
    document.getElementById('user-settings-modal')?.remove();

    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.id = 'user-settings-modal';
    modal.innerHTML = `
      <div class="modal" style="max-width:520px;width:95%;height:min(680px,85vh);display:flex;flex-direction:column">
        <div class="modal-header">
          <h2>⚙ Settings</h2>
          <button class="modal-close" onclick="document.getElementById('user-settings-modal').remove()">✕</button>
        </div>
        <div class="modal-body" style="padding-top:0;overflow-y:auto;flex:1">
          <div class="admin-tabs" style="position:sticky;top:0;background:var(--bg-elevated);z-index:1;margin-bottom:16px">
            <button class="admin-tab us-tab${defaultTab === 'profile' ? ' active' : ''}" data-tab="profile"
              onclick="ChirmSettings.switchUserSettingsTab('profile')">Profile</button>
            <button class="admin-tab us-tab${defaultTab === 'notifications' ? ' active' : ''}" data-tab="notifications"
              onclick="ChirmSettings.switchUserSettingsTab('notifications')">Notifications</button>
            <button class="admin-tab us-tab${defaultTab === 'appearance' ? ' active' : ''}" data-tab="appearance"
              onclick="ChirmSettings.switchUserSettingsTab('appearance')">Appearance</button>
          </div>
          <div id="us-pane-profile" class="us-pane${defaultTab === 'profile' ? ' active' : ''}" style="${defaultTab !== 'profile' ? 'display:none' : ''}">
            ${_buildProfileTab()}
          </div>
          <div id="us-pane-notifications" class="us-pane${defaultTab === 'notifications' ? ' active' : ''}" style="${defaultTab !== 'notifications' ? 'display:none' : ''}">
            ${_buildNotificationsTab()}
          </div>
          <div id="us-pane-appearance" class="us-pane${defaultTab === 'appearance' ? ' active' : ''}" style="${defaultTab !== 'appearance' ? 'display:none' : ''}">
            ${_buildAppearanceTab()}
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });

    setTimeout(() => {
      _wireProfile();
      _wireNotifications();
      _wireAppearance();
    }, 50);
  }

  // switchUserSettingsTab shows/hides panes inside the modal
  function switchUserSettingsTab(tab) {
    const modal = document.getElementById('user-settings-modal');
    if (!modal) return;
    modal.querySelectorAll('.us-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    modal.querySelectorAll('.us-pane').forEach(p => {
      const active = p.id === `us-pane-${tab}`;
      p.classList.toggle('active', active);
      p.style.display = active ? '' : 'none';
    });
  }

  // Keep openSettingsModal as an alias for backwards compatibility
  const openSettingsModal = () => openUserSettings('notifications');

  return {
    get,
    set,
    isChannelMuted,
    muteChannel,
    unmuteChannel,
    toggleMuteChannel,
    setDisablePings,
    isPingsDisabled,
    setInBrowserOnly,
    isInBrowserOnly,
    openSettingsModal,
    openUserSettings,
    switchUserSettingsTab,
    addProfileLink,
    removeProfileLink,
    _updateLink,
    _clearBanner,
  };
})();

export default ChirmSettings;
