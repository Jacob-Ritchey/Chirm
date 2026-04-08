// render/admin.js — Admin panel: users, roles, invites, settings, emojis, theme

import App from '../state.js';
import api from '../api.js';
import { toast, esc, escInline, stringToColor } from '../utils.js';
import { loadMembers, renderMembersList } from './members.js';
import { showSimpleModal } from './modals.js';
import ChirmTheme from '../theme.js';

export function openAdmin() {
  if (typeof window.openModal === 'function') window.openModal('admin-modal');
  loadAdminUsers();
}

export async function loadAdminUsers() {
  const [usersPage, rolesPage, invitesPage, settings] = await Promise.all([
    api.get('/api/v1/users'),
    api.get('/api/v1/roles'),
    api.get('/api/v1/invites'),
    api.get('/api/v1/settings'),
  ]);
  renderAdminUsers(usersPage.items ?? usersPage, usersPage.has_more);
  renderAdminRoles(rolesPage.items ?? rolesPage, rolesPage.has_more);
  renderAdminInvites(invitesPage.items ?? invitesPage, settings);
  renderAdminSettings(settings);
  renderAdminTheme(settings);
  await renderAdminEmojis();
}

export async function loadMoreAdminUsers(afterId) {
  const page = await api.get(`/api/v1/users?before=${afterId}`).catch(() => null);
  if (!page) return;
  const el = document.getElementById('admin-users-list');
  const items = page.items ?? page;
  const tbody = el.querySelector('tbody');
  if (tbody) {
    items.forEach(u => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td><div class="flex-center gap-8"><div class="avatar avatar-sm" style="background:${stringToColor(u.username)}">${u.username[0].toUpperCase()}</div><div><div style="font-weight:600">${esc(u.username)}</div><div class="text-muted text-sm">${esc(u.email)}</div></div></div></td><td></td><td>${!u.is_owner ? `<button class="btn btn-sm btn-danger" onclick="adminDeleteUser('${u.id}','${esc(u.username)}')">Ban</button>` : ''}</td>`;
      tbody.appendChild(tr);
    });
  }
  el.querySelector('.btn-secondary.mt-8')?.remove();
  if (page.has_more && items.length) {
    const btn = document.createElement('button');
    btn.className = 'btn btn-secondary btn-sm mt-8';
    btn.textContent = 'Load more';
    btn.onclick = () => loadMoreAdminUsers(items.at(-1)?.id);
    el.appendChild(btn);
  }
}

export async function loadMoreAdminRoles(afterId) {
  const page = await api.get(`/api/v1/roles?before=${afterId}`).catch(() => null);
  if (!page) return;
  const el = document.getElementById('admin-roles-list');
  const items = page.items ?? page;
  const tbody = el.querySelector('tbody');
  if (tbody) {
    items.forEach(r => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td><span class="role-badge" style="color:${r.color};border-color:${r.color}40;background:${r.color}18">${esc(r.name)}</span></td><td><code class="mono" style="font-size:11px">${r.permissions}</code></td><td>${r.name !== '@everyone' ? `<button class="btn btn-sm btn-secondary" onclick="openEditRole('${r.id}')">Edit</button><button class="btn btn-sm btn-danger" onclick="adminDeleteRole('${r.id}')">Delete</button>` : ''}</td>`;
      tbody.appendChild(tr);
    });
  }
  el.querySelector('.btn-secondary.mt-8')?.remove();
  if (page.has_more && items.length) {
    const btn = document.createElement('button');
    btn.className = 'btn btn-secondary btn-sm mt-8';
    btn.textContent = 'Load more';
    btn.onclick = () => loadMoreAdminRoles(items.at(-1)?.id);
    el.appendChild(btn);
  }
}

export function renderAdminUsers(users, hasMore) {
  const el = document.getElementById('admin-users-list');
  if (!users?.length) { el.innerHTML = '<p class="text-muted">No users found.</p>'; return; }

  el.innerHTML = `<table class="data-table">
    <thead><tr><th>User</th><th>Roles</th><th>Actions</th></tr></thead>
    <tbody>${users.map(u => `
      <tr>
        <td>
          <div class="flex-center gap-8">
            <div class="avatar avatar-sm" style="background:${stringToColor(u.username)}">${u.username[0].toUpperCase()}</div>
            <div>
              <div style="font-weight:600">${esc(u.username)}</div>
              <div class="text-muted text-sm">${esc(u.email)}</div>
            </div>
            ${u.is_owner ? '<span class="role-badge badge-owner" style="margin-left:4px">Owner</span>' : ''}
          </div>
        </td>
        <td><div class="flex gap-8" style="flex-wrap:wrap">${(u.roles||[]).map(r =>
          `<span class="role-badge" style="color:${r.color};border-color:${r.color}40;background:${r.color}18">${esc(r.name)}</span>`
        ).join('')}</div></td>
        <td>
          ${!u.is_owner ? `
            <button class="btn btn-sm btn-secondary" onclick="openAssignRole('${u.id}')">Roles</button>
            <button class="btn btn-sm btn-danger" onclick="adminDeleteUser('${u.id}','${esc(u.username)}')">Ban</button>
          ` : '<span class="text-muted text-sm">—</span>'}
        </td>
      </tr>`).join('')}
    </tbody>
  </table>
  ${hasMore ? `<button class="btn btn-secondary btn-sm mt-8" onclick="loadMoreAdminUsers('${users.at(-1)?.id}')">Load more</button>` : ''}`;
}

export function renderAdminRoles(roles, hasMore) {
  const el = document.getElementById('admin-roles-list');
  el.innerHTML = `
    <button class="btn btn-primary btn-sm mb-16" onclick="openCreateRole()">+ New Role</button>
    <table class="data-table">
      <thead><tr><th>Role</th><th>Permissions</th><th>Actions</th></tr></thead>
      <tbody>${roles.map(r => `
        <tr>
          <td><span class="role-badge" style="color:${r.color};border-color:${r.color}40;background:${r.color}18">${esc(r.name)}</span></td>
          <td><code class="mono" style="font-size:11px">${r.permissions}</code></td>
          <td>
            ${r.name !== '@everyone' ? `
              <button class="btn btn-sm btn-secondary" onclick="openEditRole('${r.id}')">Edit</button>
              <button class="btn btn-sm btn-danger" onclick="adminDeleteRole('${r.id}')">Delete</button>
            ` : '<button class="btn btn-sm btn-secondary" onclick="openEditRole(\''+r.id+'\')">Edit Permissions</button>'}
          </td>
        </tr>`).join('')}
      </tbody>
    </table>
    ${hasMore ? `<button class="btn btn-secondary btn-sm mt-8" onclick="loadMoreAdminRoles('${roles.at(-1)?.id}')">Load more</button>` : ''}`;
}

export function renderAdminInvites(invites, settings) {
  const el = document.getElementById('admin-invites-list');
  const host = window.location.origin;
  el.innerHTML = `
    <button class="btn btn-primary btn-sm mb-16" onclick="createInvite()">+ Create Invite</button>
    ${invites.length ? `<table class="data-table">
      <thead><tr><th>Code</th><th>Created By</th><th>Uses</th><th>Actions</th></tr></thead>
      <tbody>${invites.map(inv => `
        <tr>
          <td>
            <div class="invite-box" style="display:inline-flex;max-width:280px">
              <span>${host}/login?invite=${inv.code}</span>
              <button onclick="copyInvite('${host}/login?invite=${inv.code}')">Copy</button>
            </div>
          </td>
          <td>${esc(inv.creator?.username || 'Unknown')}</td>
          <td>${inv.uses}${inv.max_uses > 0 ? ` / ${inv.max_uses}` : ''}</td>
          <td><button class="btn btn-sm btn-danger" onclick="adminDeleteInvite('${inv.code}')">Delete</button></td>
        </tr>`).join('')}
      </tbody>
    </table>` : '<p class="text-muted">No active invites.</p>'}`;
}

export function renderAdminSettings(settings) {
  const el = document.getElementById('admin-settings-form');
  el.innerHTML = `
    <div class="form-group">
      <label>Server Name</label>
      <input type="text" id="setting-server-name" value="${esc(settings.server_name||'')}">
    </div>
    <div class="form-group">
      <label>Server Description</label>
      <input type="text" id="setting-server-desc" value="${esc(settings.server_description||'')}">
    </div>
    <div class="form-group">
      <label>Server Icon</label>
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:8px">
        ${settings.server_icon ? `<img src="${esc(settings.server_icon)}" style="width:48px;height:48px;border-radius:50%;object-fit:cover;border:2px solid var(--border)">` : `<div style="width:48px;height:48px;border-radius:50%;background:var(--bg-elevated);border:2px dashed var(--border);display:flex;align-items:center;justify-content:center;font-size:20px">✦</div>`}
        <div>
          <input type="file" id="setting-server-icon-file" accept="image/*" style="display:none" onchange="uploadServerIcon()">
          <button class="btn btn-sm btn-secondary" onclick="document.getElementById('setting-server-icon-file').click()">Upload Icon</button>
          ${settings.server_icon ? `<button class="btn btn-sm btn-danger" style="margin-left:4px" onclick="clearServerIcon()">Remove</button>` : ''}
        </div>
      </div>
    </div>
    <div class="form-group">
      <label>Allow Registration</label>
      <select id="setting-allow-reg">
        <option value="1" ${settings.allow_registration==='1'?'selected':''}>Enabled</option>
        <option value="0" ${settings.allow_registration!=='1'?'selected':''}>Disabled</option>
      </select>
    </div>
    <div class="form-group">
      <label>Require Invite Code</label>
      <select id="setting-require-invite">
        <option value="0" ${settings.require_invite!=='1'?'selected':''}>No</option>
        <option value="1" ${settings.require_invite==='1'?'selected':''}>Yes</option>
      </select>
    </div>
    <div class="form-group">
      <label>Max Upload Size (MB)</label>
      <input type="number" id="setting-max-upload" value="${settings.max_upload_mb||25}" min="1" max="500">
    </div>
    <div style="border-top:1px solid var(--border);margin:20px 0;padding-top:20px">
      <h4 style="margin-bottom:16px;font-size:14px;color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.05em">Login Page Appearance</h4>
      <div class="form-group">
        <label>Background Color <span style="font-weight:400;color:var(--text-muted)">(hex or CSS color)</span></label>
        <div style="display:flex;gap:8px;align-items:center">
          <input type="color" id="setting-bg-color-picker" value="${settings.login_bg_color||'#0d0d12'}" style="width:40px;height:36px;padding:2px;border-radius:var(--radius);border:1px solid var(--border);background:none;cursor:pointer" oninput="document.getElementById('setting-bg-color').value=this.value">
          <input type="text" id="setting-bg-color" value="${esc(settings.login_bg_color||'')}" placeholder="#0d0d12 or transparent" style="flex:1" oninput="this.previousElementSibling.value=this.value">
        </div>
      </div>
      <div class="form-group">
        <label>Background Image</label>
        ${settings.login_bg_image ? `<div style="margin-bottom:8px;display:flex;align-items:center;gap:8px"><img src="${esc(settings.login_bg_image)}" style="height:48px;border-radius:var(--radius);object-fit:cover;max-width:120px"><button class="btn btn-sm btn-danger" onclick="clearLoginBg()">Remove</button></div>` : ''}
        <input type="file" id="setting-login-bg-file" accept="image/*" style="display:none" onchange="uploadLoginBg()">
        <button class="btn btn-sm btn-secondary" onclick="document.getElementById('setting-login-bg-file').click()">Upload Background Image</button>
        <p style="font-size:12px;color:var(--text-muted);margin-top:4px">If set, overrides the background color. Max 10MB.</p>
      </div>
      <div class="form-group">
        <label>Background Image Overlay Opacity <span style="font-weight:400;color:var(--text-muted)">(0 = fully visible, 100 = fully dark)</span></label>
        <div style="display:flex;gap:10px;align-items:center">
          <input type="range" id="setting-bg-overlay" min="0" max="100" value="${settings.login_bg_overlay||0}" style="flex:1" oninput="document.getElementById('setting-bg-overlay-val').textContent=this.value+'%'">
          <span id="setting-bg-overlay-val" style="font-size:13px;color:var(--text-muted);min-width:36px">${settings.login_bg_overlay||0}%</span>
        </div>
        <p style="font-size:12px;color:var(--text-muted);margin-top:4px">Darkens the background image. Set to 0 for a fully custom landing page graphic.</p>
      </div>
    </div>
    <div style="border-top:1px solid var(--border);margin:20px 0;padding-top:20px">
      <h4 style="margin-bottom:16px;font-size:14px;color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.05em">Join Agreement</h4>
      <div class="form-group">
        <label>Show Agreement on Registration</label>
        <select id="setting-agreement-enabled">
          <option value="0" ${settings.agreement_enabled!=='1'?'selected':''}>Disabled</option>
          <option value="1" ${settings.agreement_enabled==='1'?'selected':''}>Enabled</option>
        </select>
      </div>
      <div class="form-group">
        <label>Agreement Text <span style="font-weight:400;color:var(--text-muted)">(Markdown supported)</span></label>
        <textarea id="setting-agreement-text" style="min-height:140px;font-family:monospace;font-size:13px;resize:vertical" placeholder="## Community Rules&#10;&#10;By joining, you agree to...&#10;&#10;1. Be respectful&#10;2. No spam">${esc(settings.agreement_text||'')}</textarea>
      </div>
    </div>
    <button class="btn btn-primary" onclick="saveSettings()">Save Settings</button>
  `;
}

export async function uploadServerIcon() {
  const file = document.getElementById('setting-server-icon-file').files[0];
  if (!file) return;
  const form = new FormData();
  form.append('icon', file);
  try {
    await fetch('/api/v1/settings/icon', { method: 'POST', credentials: 'include', body: form });
    toast('Server icon updated', 'success');
    loadAdminUsers();
  } catch (e) { toast('Failed to upload icon', 'error'); }
}

export async function clearServerIcon() {
  try {
    await api.put('/api/v1/settings', { server_icon: '' });
    toast('Server icon removed', 'success');
    loadAdminUsers();
  } catch (e) { toast(e.message, 'error'); }
}

export async function uploadLoginBg() {
  const file = document.getElementById('setting-login-bg-file').files[0];
  if (!file) return;
  const form = new FormData();
  form.append('bg', file);
  try {
    await fetch('/api/v1/settings/login-bg', { method: 'POST', credentials: 'include', body: form });
    toast('Login background updated', 'success');
    loadAdminUsers();
  } catch (e) { toast('Failed to upload background', 'error'); }
}

export async function clearLoginBg() {
  try {
    await api.put('/api/v1/settings', { login_bg_image: '' });
    toast('Background removed', 'success');
    loadAdminUsers();
  } catch (e) { toast(e.message, 'error'); }
}

export async function saveSettings() {
  const settings = {
    server_name: document.getElementById('setting-server-name')?.value,
    server_description: document.getElementById('setting-server-desc')?.value,
    allow_registration: document.getElementById('setting-allow-reg')?.value,
    require_invite: document.getElementById('setting-require-invite')?.value,
    max_upload_mb: document.getElementById('setting-max-upload')?.value,
    login_bg_color: document.getElementById('setting-bg-color')?.value,
    login_bg_overlay: document.getElementById('setting-bg-overlay')?.value,
    agreement_enabled: document.getElementById('setting-agreement-enabled')?.value,
    agreement_text: document.getElementById('setting-agreement-text')?.value,
  };
  try {
    await api.put('/api/v1/settings', settings);
    App.publicSettings = null; // invalidate cache so header re-fetches
    toast('Settings saved', 'success');
    if (typeof window.renderServerHeader === 'function') window.renderServerHeader();
  } catch (e) {
    toast(e.message, 'error');
  }
}

export function renderAdminTheme(settings) {
  const el = document.getElementById('admin-theme-form');
  if (!el) return;

  const serverVars = (() => {
    try { return JSON.parse(settings.theme_css_vars || '{}'); } catch { return {}; }
  })();

  const currentValue = (key) => {
    if (serverVars[key]) return serverVars[key];
    return getComputedStyle(document.documentElement).getPropertyValue(key).trim();
  };

  const buildPresetSelect = () => {
    const custom = ChirmTheme.getCustomPresets();
    const builtinOpts = ChirmTheme.THEME_PRESETS.map(p =>
      `<option value="${esc(p.name)}">${esc(p.name)}</option>`
    ).join('');
    const customOpts = custom.length
      ? `<optgroup label="Custom">${custom.map(p => `<option value="${esc(p.name)}">${esc(p.name)}</option>`).join('')}</optgroup>`
      : '';
    return `<optgroup label="Built-in">${builtinOpts}</optgroup>${customOpts}`;
  };

  const groups = ChirmTheme.COLOR_GROUPS.map(g => {
    const items = g.vars.map(v => {
      const val = currentValue(v.key);
      const inputId = `admin-theme-input-${v.key.slice(2)}`;
      return `<div class="theme-color-item">
        <input type="color" id="${inputId}" value="${esc(val)}" title="${esc(v.key)}"
          oninput="document.documentElement.style.setProperty('${v.key}', this.value)">
        <label for="${inputId}">${esc(v.label)}</label>
      </div>`;
    }).join('');
    return `<div style="margin-bottom:16px">
      <h4 style="font-size:12px;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-secondary);margin-bottom:10px">${esc(g.label)}</h4>
      <div class="theme-color-grid">${items}</div>
    </div>`;
  }).join('');

  el.innerHTML = `
    <div class="form-group">
      <label>Preset Themes</label>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:4px">
        <select id="admin-theme-preset" style="flex:1;min-width:160px">
          <option value="">— Select a preset to fill pickers —</option>
          ${buildPresetSelect()}
        </select>
        <button class="btn btn-sm btn-secondary" onclick="applyAdminThemePreset()">Apply</button>
        <button class="btn btn-sm btn-danger" onclick="deleteAdminThemePreset()" title="Delete selected custom preset">🗑</button>
      </div>
      <p style="font-size:12px;color:var(--text-muted);margin-top:4px">
        Sets the server-wide default palette. Users can override in their own Appearance settings.
      </p>
    </div>
    ${groups}
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">
      <button class="btn btn-primary" onclick="saveAdminTheme()">Save as Server Theme</button>
      <button class="btn btn-secondary" onclick="clearAdminTheme()">Reset to CSS Defaults</button>
    </div>
    <div style="border-top:1px solid var(--border);margin-top:16px;padding-top:16px">
      <label style="font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;color:var(--text-secondary);display:block;margin-bottom:6px">Save as Local Preset</label>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <input type="text" id="admin-theme-preset-name" placeholder="My Theme" style="flex:1;min-width:120px">
        <button class="btn btn-sm btn-secondary" onclick="saveAdminLocalPreset()">Save Preset</button>
      </div>
      <p style="font-size:12px;color:var(--text-muted);margin-top:4px">Saves to your browser's local storage for reuse.</p>
    </div>
  `;
}

export async function saveAdminTheme() {
  const vars = {};
  for (const { key } of ChirmTheme.COLOR_VARS.map(k => ({ key: k }))) {
    const inputId = `admin-theme-input-${key.slice(2)}`;
    const el = document.getElementById(inputId);
    if (el) vars[key] = el.value;
  }
  try {
    await api.put('/api/v1/settings', { theme_css_vars: JSON.stringify(vars) });
    App.publicSettings = null; // invalidate cache
    ChirmTheme.applyVars(vars);
    toast('Server theme saved', 'success');
    // Re-fetch so publicSettings.theme_css_vars is fresh
    const fresh = await api.get('/api/v1/public-settings').catch(() => null);
    if (fresh) App.publicSettings = fresh;
  } catch (e) { toast(e.message, 'error'); }
}

export async function clearAdminTheme() {
  try {
    await api.put('/api/v1/settings', { theme_css_vars: '{}' });
    App.publicSettings = null;
    ChirmTheme.COLOR_VARS.forEach(v => document.documentElement.style.removeProperty(v));
    toast('Server theme reset to CSS defaults', 'info');
    const fresh = await api.get('/api/v1/public-settings').catch(() => null);
    if (fresh) App.publicSettings = fresh;
    loadAdminUsers();
  } catch (e) { toast(e.message, 'error'); }
}

export function applyAdminThemePreset() {
  const name = document.getElementById('admin-theme-preset')?.value;
  if (!name) return;
  const preset = ChirmTheme.getAllPresets().find(p => p.name === name);
  if (!preset) return;
  for (const [key, val] of Object.entries(preset.vars)) {
    const el = document.getElementById(`admin-theme-input-${key.slice(2)}`);
    if (el) el.value = val;
  }
  ChirmTheme.applyVars(preset.vars);
}

export function deleteAdminThemePreset() {
  const name = document.getElementById('admin-theme-preset')?.value;
  if (!name) return;
  if (ChirmTheme.THEME_PRESETS.some(p => p.name === name)) {
    toast('Cannot delete built-in presets', 'error');
    return;
  }
  ChirmTheme.deleteCustomPreset(name);
  toast(`Preset "${name}" deleted`, 'info');
  loadAdminUsers(); // re-renders theme tab
}

export function saveAdminLocalPreset() {
  const name = document.getElementById('admin-theme-preset-name')?.value.trim();
  if (!name) { toast('Enter a preset name', 'error'); return; }
  const vars = {};
  for (const key of ChirmTheme.COLOR_VARS) {
    const el = document.getElementById(`admin-theme-input-${key.slice(2)}`);
    if (el) vars[key] = el.value;
  }
  ChirmTheme.saveCustomPreset(name, vars);
  toast(`Preset "${name}" saved locally`, 'success');
  loadAdminUsers(); // re-renders theme tab with updated dropdown
}

export async function adminDeleteUser(id, name) {
  if (!confirm(`Ban/delete user "${name}"? This cannot be undone.`)) return;
  try {
    await api.del(`/api/users/${id}`);
    toast(`${name} deleted`, 'success');
    loadAdminUsers();
    loadMembers().then(renderMembersList);
  } catch (e) { toast(e.message, 'error'); }
}

export async function adminDeleteRole(id) {
  if (!confirm('Delete this role?')) return;
  try {
    await api.del(`/api/roles/${id}`);
    toast('Role deleted', 'success');
    loadAdminUsers();
  } catch (e) { toast(e.message, 'error'); }
}

export async function adminDeleteInvite(code) {
  try {
    await api.del(`/api/invites/${code}`);
    toast('Invite deleted', 'success');
    loadAdminUsers();
  } catch (e) { toast(e.message, 'error'); }
}

export async function createInvite() {
  try {
    await api.post('/api/v1/invites', { max_uses: 0 });
    toast('Invite created', 'success');
    loadAdminUsers();
  } catch (e) { toast(e.message, 'error'); }
}

export function copyInvite(url) {
  navigator.clipboard.writeText(url).then(() => toast('Copied!', 'success')).catch(() => {
    prompt('Copy this invite link:', url);
  });
}

// ─── ROLE MANAGEMENT ──────────────────────────────────────────────────────────

const PERMS = [
  { bit: 1, label: 'Read Messages' },
  { bit: 2, label: 'Send Messages' },
  { bit: 4, label: 'Manage Messages' },
  { bit: 8, label: 'Manage Channels' },
  { bit: 16, label: 'Manage Roles' },
  { bit: 32, label: 'Manage Server' },
  { bit: 64, label: 'Administrator' },
];

function permCheckboxes(current = 0) {
  return PERMS.map(p => `
    <label style="display:flex;align-items:center;gap:8px;font-size:13.5px;font-weight:400;text-transform:none;letter-spacing:0;margin-bottom:6px;cursor:pointer">
      <input type="checkbox" data-perm="${p.bit}" ${(current & p.bit) ? 'checked' : ''}>
      ${p.label}
    </label>`).join('');
}

function getPermValue(container) {
  let val = 0;
  container.querySelectorAll('[data-perm]').forEach(cb => {
    if (cb.checked) val |= parseInt(cb.dataset.perm);
  });
  return val;
}

export function openCreateRole() {
  const form = `
    <div class="form-group"><label>Role Name</label><input type="text" id="new-role-name" placeholder="Moderator"></div>
    <div class="form-group"><label>Color</label><input type="color" id="new-role-color" value="#7c6af5" style="height:38px;cursor:pointer"></div>
    <div class="form-group"><label>Permissions</label><div id="role-perms">${permCheckboxes(3)}</div></div>
  `;
  showSimpleModal('Create Role', form, async () => {
    const name = document.getElementById('new-role-name').value.trim();
    if (!name) { toast('Name required', 'error'); return false; }
    const perms = getPermValue(document.getElementById('role-perms'));
    await api.post('/api/v1/roles', { name, color: document.getElementById('new-role-color').value, permissions: perms });
    toast('Role created', 'success');
    loadAdminUsers();
  });
}

export function openEditRole(id) {
  const role = App.roles.find(r => r.id === id);
  if (!role) return;
  const form = `
    <div class="form-group"><label>Role Name</label><input type="text" id="edit-role-name" value="${esc(role.name)}" ${role.name==='@everyone'?'readonly':''}></div>
    <div class="form-group"><label>Color</label><input type="color" id="edit-role-color" value="${role.color}" style="height:38px;cursor:pointer"></div>
    <div class="form-group"><label>Permissions</label><div id="edit-role-perms">${permCheckboxes(role.permissions)}</div></div>
  `;
  showSimpleModal('Edit Role', form, async () => {
    const perms = getPermValue(document.getElementById('edit-role-perms'));
    await api.put(`/api/roles/${id}`, {
      name: document.getElementById('edit-role-name').value,
      color: document.getElementById('edit-role-color').value,
      permissions: perms,
    });
    toast('Role updated', 'success');
    const rolesPage = await api.get('/api/v1/roles').catch(() => null);
    if (rolesPage) App.roles = rolesPage.items ?? rolesPage;
    loadAdminUsers();
  });
}

export async function openAssignRole(userId) {
  const [rolesPage, usersPage] = await Promise.all([api.get('/api/v1/roles'), api.get('/api/v1/users')]);
  const roles = rolesPage.items ?? rolesPage;
  const allUsers = usersPage.items ?? usersPage;
  const u = allUsers.find(x => x.id === userId);
  const assignedIds = new Set((u?.roles||[]).map(r => r.id));

  const form = `<div style="display:flex;flex-direction:column;gap:6px">
    ${roles.filter(r=>r.name!=='@everyone').map(r => `
      <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-weight:400;text-transform:none;letter-spacing:0;font-size:14px">
        <input type="checkbox" data-role-id="${r.id}" ${assignedIds.has(r.id)?'checked':''}>
        <span class="role-badge" style="color:${r.color};border-color:${r.color}40;background:${r.color}18">${esc(r.name)}</span>
      </label>`).join('')}
  </div>`;

  showSimpleModal(`Roles for ${esc(u?.username||'user')}`, form, async () => {
    const checkboxes = document.querySelectorAll('[data-role-id]');
    for (const cb of checkboxes) {
      const roleId = cb.dataset.roleId;
      const wasAssigned = assignedIds.has(roleId);
      if (cb.checked && !wasAssigned) await api.post(`/api/users/${userId}/roles/${roleId}`, {});
      if (!cb.checked && wasAssigned) await api.del(`/api/users/${userId}/roles/${roleId}`);
    }
    toast('Roles updated', 'success');
    loadAdminUsers();
    loadMembers().then(renderMembersList);
  });
}

// ─── EMOJI MANAGEMENT ────────────────────────────────────────────────────────

export async function renderAdminEmojis() {
  const el = document.getElementById('admin-emojis-list');
  if (!el) return;

  const emojis = await api.get('/api/v1/emojis').catch(() => []);
  App.customEmojis = emojis;

  const used = emojis.length;

  el.innerHTML = `
    <div style="margin-bottom:16px">
      <label class="btn btn-primary btn-sm" style="cursor:pointer;display:inline-flex;align-items:center;gap:8px">
        📤 Upload Emoji
        <input type="file" id="emoji-upload-file" accept="image/png,image/gif,image/webp,image/jpeg" style="display:none" onchange="adminUploadEmojiSelect(this)">
      </label>
    </div>
    <div id="emoji-upload-form" style="display:none;background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--radius);padding:16px;margin-bottom:16px">
      <div class="form-group">
        <label>Preview</label>
        <img id="emoji-upload-preview" style="max-width:64px;max-height:64px;border-radius:var(--radius-sm);border:1px solid var(--border)" alt="preview">
      </div>
      <div class="form-group">
        <label>Emoji Name <span style="color:var(--text-muted);font-size:12px">(used as :name:)</span></label>
        <input type="text" id="emoji-upload-name" placeholder="e.g. hooray" style="text-transform:lowercase" oninput="this.value=this.value.replace(/[^a-zA-Z0-9_]/g,'').toLowerCase()">
      </div>
      <div style="display:flex;gap:8px">
        <button class="btn btn-primary btn-sm" onclick="adminDoUploadEmoji()">Upload</button>
        <button class="btn btn-secondary btn-sm" onclick="document.getElementById('emoji-upload-form').style.display='none'">Cancel</button>
      </div>
    </div>
    <h4 style="margin-bottom:8px;color:var(--text-secondary);font-size:13px">${used} custom emoji${used !== 1 ? 's' : ''}</h4>
    ${emojis.length ? `<table class="data-table">
      <thead><tr><th>Image</th><th>Name</th><th>Uploaded By</th><th>Actions</th></tr></thead>
      <tbody>${emojis.map(e => `
        <tr>
          <td><img src="/api/v1/uploads/${esc(e.filename)}" style="width:32px;height:32px;object-fit:contain;border-radius:4px"></td>
          <td><code style="font-family:'Space Mono',monospace;font-size:13px">:${esc(e.name)}:</code></td>
          <td>${esc(e.uploader?.username || 'Unknown')}</td>
          <td><button class="btn btn-sm btn-danger" onclick="adminDeleteEmoji('${e.id}','${esc(e.name)}')">Delete</button></td>
        </tr>`).join('')}
      </tbody>
    </table>` : '<p class="text-muted" style="font-size:13px">No custom emojis yet. Upload some!</p>'}
  `;
}

let pendingEmojiFile = null;

export function adminUploadEmojiSelect(input) {
  const file = input.files[0];
  if (!file) return;
  if (file.size > 256 * 1024) { toast('Emoji image must be under 256KB', 'error'); return; }
  pendingEmojiFile = file;
  document.getElementById('emoji-upload-form').style.display = 'block';
  const reader = new FileReader();
  reader.onload = e => {
    const img = document.getElementById('emoji-upload-preview');
    if (img) img.src = e.target.result;
  };
  reader.readAsDataURL(file);
  const nameInput = document.getElementById('emoji-upload-name');
  if (nameInput && !nameInput.value) {
    const stem = file.name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase().slice(0, 32);
    nameInput.value = stem;
  }
}

export async function adminDoUploadEmoji() {
  if (!pendingEmojiFile) { toast('No file selected', 'error'); return; }
  const name = document.getElementById('emoji-upload-name')?.value?.trim().toLowerCase();
  if (!name) { toast('Name required', 'error'); return; }

  const formData = new FormData();
  formData.append('image', pendingEmojiFile);
  formData.append('name', name);

  try {
    const res = await fetch('/api/v1/emojis', { method: 'POST', credentials: 'include', body: formData });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || data.error || `HTTP ${res.status}`);
    toast(`Emoji :${name}: uploaded!`, 'success');
    pendingEmojiFile = null;
    await renderAdminEmojis();
  } catch (e) {
    toast(e.message, 'error');
  }
}

export async function adminDeleteEmoji(id, name) {
  if (!confirm(`Delete emoji :${name}:? It will stop rendering in messages.`)) return;
  try {
    await api.del(`/api/emojis/${id}`);
    toast(`Emoji :${name}: deleted`, 'success');
    await renderAdminEmojis();
  } catch (e) { toast(e.message, 'error'); }
}

export function switchAdminTab(tab) {
  document.querySelectorAll('.admin-tab').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.admin-pane').forEach(el => el.classList.remove('active'));
  document.querySelector(`.admin-tab[data-tab="${tab}"]`).classList.add('active');
  document.getElementById(`admin-pane-${tab}`).classList.add('active');
  if (tab === 'emojis') renderAdminEmojis();
}
