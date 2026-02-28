// render/members.js — Member sidebar rendering

import App from '../state.js';
import api from '../api.js';
import { avatar, esc, stringToColor } from '../utils.js';

export async function loadMembers() {
  const page = await api.get('/api/v1/members').catch(() => null);
  App.members = page ? (page.items ?? page) : [];
}

export function renderUserPanel() {
  const el = document.getElementById('user-info');
  const avatarHtml = App.user.avatar
    ? `<div class="avatar avatar-sm"><img src="${esc(App.user.avatar)}" alt="${esc(App.user.username)}"></div>`
    : `<div class="avatar avatar-sm" style="background:${stringToColor(App.user.username)}">${App.user.username[0].toUpperCase()}</div>`;
  el.innerHTML = `
    ${avatarHtml}
    <div class="user-info">
      <div class="user-name">${esc(App.user.username)}</div>
      <div class="user-tag">${App.user.is_owner ? 'Owner' : 'Member'}</div>
    </div>
  `;

  // Update notification bell icon based on permission state
  const notifBtn = document.getElementById('notif-settings-btn');
  if (notifBtn) {
    const perm = ('Notification' in window) ? Notification.permission : 'denied';
    notifBtn.textContent = perm === 'granted' ? '🔔' : perm === 'denied' ? '🔕' : '🔔';
    notifBtn.title = `Notification Settings (${perm})`;
    notifBtn.style.opacity = perm === 'denied' ? '0.5' : '1';
  }
}

export function renderMembersList() {
  const list = document.getElementById('members-list');
  list.innerHTML = `<h3>Members — ${App.members.length}</h3>`;

  const owners = App.members.filter(m => m.is_owner);
  const others = App.members.filter(m => !m.is_owner);

  const renderMember = (m) => {
    const div = document.createElement('div');
    div.className = 'member-item';
    const roleBadge = m.is_owner ? `<span class="role-badge badge-owner" style="font-size:10px">Owner</span>` :
      m.roles?.length ? `<span style="color:${m.roles[0].color};font-size:11px">${esc(m.roles[0].name)}</span>` : '';
    div.innerHTML = `
      ${avatar(m, 'avatar-sm')}
      <div style="flex:1;min-width:0">
        <div class="member-name">${esc(m.username)}</div>
        ${roleBadge}
      </div>
    `;
    return div;
  };

  if (owners.length) {
    const cat = document.createElement('div');
    cat.className = 'channel-category';
    cat.textContent = 'Owner';
    list.appendChild(cat);
    owners.forEach(m => list.appendChild(renderMember(m)));
  }
  if (others.length) {
    const cat = document.createElement('div');
    cat.className = 'channel-category';
    cat.textContent = 'Members';
    list.appendChild(cat);
    others.forEach(m => list.appendChild(renderMember(m)));
  }
}
