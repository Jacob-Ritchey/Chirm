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
  const status = App.user.status || 'online';
  el.innerHTML = `
    ${avatar(App.user, 'avatar-sm', status)}
    <div class="user-info">
      <div class="user-name">${esc(App.user.username)}</div>
      <div class="user-tag">${App.user.is_owner ? 'Owner' : 'Member'}</div>
    </div>
  `;
  el.style.cursor = 'pointer';
  el.title = 'Change status';
  el.onclick = (e) => openStatusPicker(e);

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
    div.onclick = () => window.viewUserProfile?.(m.id);
    const roleBadge = m.is_owner ? `<span class="role-badge badge-owner" style="font-size:10px">Owner</span>` :
      m.roles?.length ? `<span style="color:${m.roles[0].color};font-size:11px">${esc(m.roles[0].name)}</span>` : '';
    div.innerHTML = `
      ${avatar(m, 'avatar-sm', m.status || 'online')}
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

export function openStatusPicker(e) {
  e.stopPropagation();
  document.getElementById('status-picker')?.remove();

  const picker = document.createElement('div');
  picker.id = 'status-picker';
  picker.className = 'status-picker';
  picker.innerHTML = `
    <div class="status-option" onclick="window.setMyStatus('online')">
      <div class="status-dot online" style="display:inline-block;position:static;flex-shrink:0"></div> Online
    </div>
    <div class="status-option" onclick="window.setMyStatus('away')">
      <div class="status-dot idle" style="display:inline-block;position:static;flex-shrink:0"></div> Away
    </div>
    <div class="status-option" onclick="window.setMyStatus('dnd')">
      <div class="status-dot dnd" style="display:inline-block;position:static;flex-shrink:0"></div> Do Not Disturb
    </div>
    <div class="status-option" onclick="window.setMyStatus('invisible')">
      <div class="status-dot invisible" style="display:inline-block;position:static;flex-shrink:0"></div> Invisible
    </div>
  `;
  document.body.appendChild(picker);

  const panel = document.getElementById('user-panel');
  if (panel) {
    const rect = panel.getBoundingClientRect();
    picker.style.bottom = (window.innerHeight - rect.top + 4) + 'px';
    picker.style.left = rect.left + 'px';
  }

  setTimeout(() => {
    document.addEventListener('click', () => document.getElementById('status-picker')?.remove(), { once: true });
  }, 0);
}

export async function setMyStatus(status) {
  document.getElementById('status-picker')?.remove();
  try {
    await api.put('/api/v1/me/status', { status });
    App.user.status = status;
    renderUserPanel();
  } catch (e) {
    console.error('Failed to set status', e);
  }
}
