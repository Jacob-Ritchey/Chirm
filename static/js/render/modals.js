// render/modals.js — Modal utilities and profile modal

import App from '../state.js';
import api from '../api.js';
import { toast, esc, escInline, escAttr, stringToColor, avatar, formatTime, renderContent } from '../utils.js';
import { renderUserPanel } from './members.js';

export function openModal(id) {
  document.getElementById(id).style.display = 'flex';
}

export function closeModal(id) {
  document.getElementById(id).style.display = 'none';
}

export function showSimpleModal(title, bodyHtml, onConfirm) {
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.id = 'simple-modal';
  const footerHtml = onConfirm
    ? `<button class="btn btn-secondary" onclick="this.closest('.modal-overlay').remove()">Cancel</button>
       <button class="btn btn-primary" id="simple-modal-confirm">Confirm</button>`
    : `<button class="btn btn-primary" onclick="this.closest('.modal-overlay').remove()">Close</button>`;
  modal.innerHTML = `
    <div class="modal" style="max-width:440px">
      <div class="modal-header">
        <h2>${title}</h2>
        <button class="modal-close" onclick="this.closest('.modal-overlay').remove()">✕</button>
      </div>
      <div class="modal-body">${bodyHtml}</div>
      <div class="modal-footer">${footerHtml}</div>
    </div>
  `;
  document.body.appendChild(modal);
  if (onConfirm) {
    modal.querySelector('#simple-modal-confirm').onclick = async () => {
      try {
        const result = await onConfirm();
        if (result !== false) modal.remove();
      } catch (e) { toast(e.message, 'error'); }
    };
  }
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
}

// openProfile shows own profile view modal (with Edit Profile option)
export function openProfile() {
  if (App.user?.id) viewUserProfile(App.user.id);
}

export async function viewUserProfile(userId) {
  let profile;
  try {
    profile = await api.get(`/api/v1/users/${userId}`);
  } catch {
    return;
  }

  let links = [];
  try { links = JSON.parse(profile.links || '[]'); } catch {}

  const isOwnProfile = profile.id === App.user?.id;
  const statusLabel = { online: 'Online', away: 'Away', dnd: 'Do Not Disturb' }[profile.status] || 'Online';
  const statusClass = profile.status || 'online';

  const bannerStyle = profile.banner
    ? `background:url('${esc(profile.banner)}') center/cover`
    : 'background:linear-gradient(135deg,var(--accent),var(--bg-surface))';

  const rolesHtml = (profile.roles?.length)
    ? profile.roles.map(r =>
        `<span class="role-badge" style="color:${r.color || 'inherit'}">${escInline(r.name)}</span>`
      ).join(' ')
    : '';

  const linksHtml = links.length
    ? links.map(l =>
        `<a href="${escAttr(l.url)}" target="_blank" rel="noopener noreferrer" class="profile-link">
          ${escInline(l.label || l.url)}
        </a>`
      ).join('')
    : '';

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay profile-view-overlay';
  overlay.innerHTML = `
    <div class="modal profile-view-modal">
      <div class="profile-banner" style="${bannerStyle}"></div>
      <div class="profile-header">
        <div class="profile-avatar-wrap">
          ${avatar(profile, 'avatar-lg', statusClass)}
        </div>
        <div class="profile-title">
          <span class="profile-username">${escInline(profile.username)}</span>
          ${profile.is_owner ? '<span class="role-badge badge-owner">Owner</span>' : ''}
          <span class="profile-status-label" title="${escAttr(statusLabel)}">
            <span class="status-dot ${statusClass}" style="display:inline-block;position:static;width:10px;height:10px;margin-right:4px"></span>
            ${escInline(statusLabel)}
          </span>
        </div>
      </div>
      <div class="profile-body">
        ${rolesHtml ? `<div class="profile-meta"><div class="profile-section-label">Roles</div><div>${rolesHtml}</div></div>` : ''}
        <div class="profile-meta">
          <div class="profile-section-label">Member Since</div>
          <div style="font-size:13px">${formatTime(profile.created_at)}</div>
        </div>
        ${profile.bio ? `
          <div class="profile-section-label">About Me</div>
          <div class="profile-bio">${renderContent(profile.bio)}</div>
        ` : ''}
        ${linksHtml ? `
          <div class="profile-section-label">Links</div>
          <div class="profile-links">${linksHtml}</div>
        ` : ''}
        ${isOwnProfile ? `
          <div style="margin-top:16px;text-align:right">
            <button class="btn btn-sm btn-secondary"
              onclick="window.ChirmSettings?.openUserSettings('profile')">Edit Profile</button>
          </div>
        ` : ''}
      </div>
      <button class="modal-close" style="position:absolute;top:12px;right:12px;z-index:1">✕</button>
    </div>
  `;

  overlay.querySelector('.modal-close').onclick = () => overlay.remove();
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

  const onKey = (e) => { if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', onKey); } };
  document.addEventListener('keydown', onKey);

  document.body.appendChild(overlay);
}

export async function clearAvatar() {
  try {
    App.user = await api.put('/api/v1/me', { username: App.user.username, avatar: '' });
    renderUserPanel();
    toast('Avatar removed', 'success');
    // Update avatar preview in-place if settings modal is open
    const wrap = document.getElementById('avatar-preview-wrap');
    if (wrap) {
      wrap.innerHTML = `<div class="avatar avatar-lg" style="background:${stringToColor(App.user.username)}">${App.user.username[0].toUpperCase()}</div>`;
    }
    document.getElementById('avatar-remove-btn')?.remove();
  } catch (e) { toast(e.message, 'error'); }
}
