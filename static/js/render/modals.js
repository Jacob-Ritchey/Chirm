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

// openProfile delegates to the unified settings modal (Profile tab)
export function openProfile() {
  window.ChirmSettings?.openUserSettings('profile');
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
