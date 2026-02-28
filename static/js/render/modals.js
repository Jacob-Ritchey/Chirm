// render/modals.js — Modal utilities and profile modal

import App from '../state.js';
import api from '../api.js';
import { toast, esc, stringToColor } from '../utils.js';
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

export function openProfile() {
  const avatarPreview = App.user.avatar
    ? `<img src="${esc(App.user.avatar)}" style="width:72px;height:72px;border-radius:50%;object-fit:cover;border:2px solid var(--border-strong)">`
    : `<div class="avatar avatar-lg" style="background:${stringToColor(App.user.username)}">${App.user.username[0].toUpperCase()}</div>`;

  const form = `
    <div style="display:flex;align-items:center;gap:16px;margin-bottom:20px;padding:16px;background:var(--bg-elevated);border-radius:var(--radius)">
      <div id="avatar-preview-wrap">${avatarPreview}</div>
      <div>
        <div style="font-weight:600;margin-bottom:4px">${esc(App.user.username)}</div>
        <label class="btn btn-sm btn-secondary" style="cursor:pointer;display:inline-flex;align-items:center;gap:6px">
          📷 Change Avatar
          <input type="file" id="profile-avatar-file" accept="image/jpeg,image/png,image/gif,image/webp" style="display:none">
        </label>
        ${App.user.avatar ? `<button class="btn btn-sm btn-ghost" style="margin-left:4px" onclick="clearAvatar()">Remove</button>` : ''}
      </div>
    </div>
    <div class="form-group"><label>Username</label><input type="text" id="profile-username" value="${esc(App.user.username)}"></div>
    <div id="avatar-upload-status" style="font-size:12px;color:var(--text-muted);margin-top:-8px;margin-bottom:8px"></div>
  `;

  showSimpleModal('Edit Profile', form, async () => {
    const username = document.getElementById('profile-username').value.trim();
    if (!username) { toast('Username required', 'error'); return false; }

    const fileInput = document.getElementById('profile-avatar-file');
    let avatarUrl = App.user.avatar || '';

    if (fileInput?.files?.length > 0) {
      const formData = new FormData();
      formData.append('avatar', fileInput.files[0]);
      const statusEl = document.getElementById('avatar-upload-status');
      if (statusEl) statusEl.textContent = 'Uploading avatar…';
      try {
        const res = await fetch('/api/v1/me/avatar', {
          method: 'POST',
          credentials: 'include',
          body: formData,
        });
        if (!res.ok) {
          const d = await res.json();
          toast(d.error?.message || d.error || 'Avatar upload failed', 'error');
          return false;
        }
        const updated = await res.json();
        App.user = updated;
        renderUserPanel();
        toast('Profile updated', 'success');
        return true;
      } catch (e) {
        toast('Avatar upload failed', 'error');
        return false;
      }
    }

    try {
      App.user = await api.put('/api/v1/me', { username, avatar: avatarUrl });
      renderUserPanel();
      toast('Profile updated', 'success');
    } catch (e) { toast(e.message, 'error'); return false; }
  });

  // Wire up file input preview after modal renders
  setTimeout(() => {
    const fileInput = document.getElementById('profile-avatar-file');
    if (!fileInput) return;
    fileInput.addEventListener('change', () => {
      if (!fileInput.files?.length) return;
      const file = fileInput.files[0];
      const reader = new FileReader();
      reader.onload = (e) => {
        const wrap = document.getElementById('avatar-preview-wrap');
        if (wrap) wrap.innerHTML = `<img src="${e.target.result}" style="width:72px;height:72px;border-radius:50%;object-fit:cover;border:2px solid var(--accent)">`;
      };
      reader.readAsDataURL(file);
      const status = document.getElementById('avatar-upload-status');
      if (status) status.textContent = `Selected: ${file.name}`;
    });
  }, 50);
}

export async function clearAvatar() {
  try {
    App.user = await api.put('/api/v1/me', { username: App.user.username, avatar: '' });
    renderUserPanel();
    toast('Avatar removed', 'success');
    document.querySelector('.modal-overlay')?.remove();
  } catch (e) { toast(e.message, 'error'); }
}
