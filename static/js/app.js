// app.js — Nexus main application

// ─── STATE ───────────────────────────────────────────────────────────────────
const App = {
  user: null,
  channels: [],
  currentChannel: null,
  messages: {},          // channelId → []
  members: [],
  roles: [],
  unread: new Set(),
  typingUsers: {},       // channelId → {userId: timestamp}
  token: null,
};

// ─── API ──────────────────────────────────────────────────────────────────────
const api = {
  async fetch(path, opts = {}) {
    const res = await fetch(path, {
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...opts.headers },
      ...opts,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  },
  get: (p) => api.fetch(p),
  post: (p, body) => api.fetch(p, { method: 'POST', body: JSON.stringify(body) }),
  put: (p, body) => api.fetch(p, { method: 'PUT', body: JSON.stringify(body) }),
  del: (p) => api.fetch(p, { method: 'DELETE' }),
};

// ─── UTILITIES ────────────────────────────────────────────────────────────────
function toast(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  document.getElementById('toast-container').appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

function avatar(user, size = '') {
  const cls = `avatar ${size}`;
  if (user?.avatar) {
    return `<div class="${cls}"><img src="${user.avatar}" alt="${esc(user.username)}"><div class="status-dot online"></div></div>`;
  }
  const initials = (user?.username || '?')[0].toUpperCase();
  const color = stringToColor(user?.username || '');
  return `<div class="${cls}" style="background:${color}">${initials}<div class="status-dot online"></div></div>`;
}

function stringToColor(str) {
  const colors = ['#6c63ff','#3fba7a','#e05252','#e0a030','#3fa0e0','#a052e0','#e05290'];
  let hash = 0;
  for (const c of str) hash = c.charCodeAt(0) + ((hash << 5) - hash);
  return colors[Math.abs(hash) % colors.length];
}

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function formatTime(dateStr) {
  const d = new Date(dateStr);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  const isYesterday = d.toDateString() === new Date(now - 86400000).toDateString();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (isToday) return `Today at ${time}`;
  if (isYesterday) return `Yesterday at ${time}`;
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ` at ${time}`;
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes/1024).toFixed(1)} KB`;
  return `${(bytes/1048576).toFixed(1)} MB`;
}

function renderContent(content) {
  // Basic markdown-lite: **bold**, *italic*, `code`, URLs
  return esc(content)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`(.+?)`/g, '<code>$1</code>')
    .replace(/(https?:\/\/[^\s<>"']+)/g, '<a href="$1" target="_blank" rel="noopener" style="color:var(--text-link)">$1</a>');
}

function isAdmin(user) {
  if (!user) return false;
  if (user.is_owner) return true;
  const PERM_ADMIN = 64;
  const PERM_MANAGE_SERVER = 32;
  return (user.permissions & PERM_ADMIN) !== 0 || (user.permissions & PERM_MANAGE_SERVER) !== 0;
}

// ─── INIT ─────────────────────────────────────────────────────────────────────
async function init() {
  // Check setup
  const status = await api.get('/api/setup/status').catch(() => null);
  if (status && !status.setup_done) {
    window.location.href = '/setup';
    return;
  }

  // Check auth
  App.user = await api.get('/api/me').catch(() => null);
  if (!App.user) {
    window.location.href = '/login';
    return;
  }

  // Load data
  await Promise.all([loadChannels(), loadMembers(), loadRoles()]);

  // Render UI
  renderServerHeader();
  renderChannelList();
  renderUserPanel();
  renderMembersList();

  // Connect WebSocket
  WS.connect();
  setupWSHandlers();

  // Open first channel
  if (App.channels.length > 0) {
    openChannel(App.channels[0]);
  }

  // Admin panel button
  if (isAdmin(App.user)) {
    document.getElementById('admin-btn').style.display = 'block';
  }
}

// ─── DATA LOADING ─────────────────────────────────────────────────────────────
async function loadChannels() {
  App.channels = await api.get('/api/channels').catch(() => []);
}

async function loadMembers() {
  App.members = await api.get('/api/members').catch(() => []);
}

async function loadRoles() {
  App.roles = await api.get('/api/roles').catch(() => []);
}

async function loadMessages(channelId, before = null) {
  const url = `/api/channels/${channelId}/messages${before ? `?before=${before}` : ''}`;
  return api.get(url).catch(() => []);
}

// ─── RENDER ───────────────────────────────────────────────────────────────────
function renderServerHeader() {
  const settings = api.get('/api/settings').then(s => {
    document.getElementById('server-name').textContent = s.server_name || 'Nexus';
    document.title = s.server_name || 'Nexus';
  }).catch(() => {});
}

function renderChannelList() {
  const list = document.getElementById('channels-list');
  list.innerHTML = '';
  const header = document.createElement('div');
  header.className = 'channel-category';
  header.innerHTML = `<span>▾</span><span>Channels</span>`;
  if (isAdmin(App.user)) {
    header.innerHTML += `<button class="channel-edit-btn" onclick="openCreateChannel()" style="margin-left:auto" title="Add Channel">+</button>`;
  }
  list.appendChild(header);

  for (const ch of App.channels) {
    const item = document.createElement('div');
    item.className = `channel-item${App.currentChannel?.id === ch.id ? ' active' : ''}${App.unread.has(ch.id) && App.currentChannel?.id !== ch.id ? ' unread' : ''}`;
    item.dataset.channelId = ch.id;
    item.innerHTML = `
      <span class="ch-icon">#</span>
      <span class="ch-name">${esc(ch.name)}</span>
      <span class="unread-dot"></span>
      ${isAdmin(App.user) ? `<span class="channel-edit-actions">
        <button class="channel-edit-btn" onclick="event.stopPropagation();openEditChannel('${ch.id}')" title="Edit">✎</button>
        <button class="channel-edit-btn" onclick="event.stopPropagation();confirmDeleteChannel('${ch.id}')" title="Delete" style="color:var(--danger)">✕</button>
      </span>` : ''}
    `;
    item.addEventListener('click', () => openChannel(ch));
    list.appendChild(item);
  }
}

function renderUserPanel() {
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
}

function renderMembersList() {
  const list = document.getElementById('members-list');
  list.innerHTML = `<h3>Members — ${App.members.length}</h3>`;

  const owners = App.members.filter(m => m.is_owner);
  const others = App.members.filter(m => !m.is_owner);

  const renderMember = (m) => {
    const div = document.createElement('div');
    div.className = 'member-item';
    const color = stringToColor(m.username);
    const roleBadge = m.is_owner ? `<span class="role-badge badge-owner" style="font-size:10px">Owner</span>` :
      m.roles?.length ? `<span style="color:${m.roles[0].color};font-size:11px">${esc(m.roles[0].name)}</span>` : '';
    div.innerHTML = `
      <div class="avatar avatar-sm" style="background:${color}">${m.username[0].toUpperCase()}</div>
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

// ─── CHANNELS ─────────────────────────────────────────────────────────────────
async function openChannel(ch) {
  App.currentChannel = ch;
  App.unread.delete(ch.id);

  // Close mobile sidebar when channel selected
  if (PanelMgr.isMobile()) PanelMgr.close('channels');

  // Update sidebar
  document.querySelectorAll('.channel-item').forEach(el => {
    const id = el.dataset.channelId;
    el.classList.toggle('active', id === ch.id);
    if (id === ch.id) el.classList.remove('unread');
  });

  // Update header
  document.getElementById('ch-title').textContent = ch.name;
  document.getElementById('ch-desc').textContent = ch.description || '';
  document.getElementById('message-input').placeholder = `Message #${ch.name}`;

  // Subscribe via WebSocket
  WS.subscribe(ch.id);

  // Load messages
  const msgs = await loadMessages(ch.id);
  App.messages[ch.id] = msgs;
  renderMessages(ch.id);
  scrollToBottom(true);
}

// ─── MESSAGES ─────────────────────────────────────────────────────────────────
function renderMessages(channelId) {
  const list = document.getElementById('messages-list');
  const msgs = App.messages[channelId] || [];

  if (msgs.length === 0) {
    list.innerHTML = `<div class="empty-state" style="padding-top:80px">
      <div class="empty-icon">#</div>
      <h3>Welcome to #${esc(App.currentChannel?.name || '')}</h3>
      <p>This is the beginning of the channel. Send the first message!</p>
    </div>`;
    return;
  }

  list.innerHTML = '';

  // Load more button
  const loadMoreBtn = document.createElement('button');
  loadMoreBtn.className = 'load-more-btn';
  loadMoreBtn.textContent = 'Load earlier messages';
  loadMoreBtn.onclick = () => loadMoreMessages(channelId);
  list.appendChild(loadMoreBtn);

  let lastUserId = null;
  let lastTimestamp = null;

  msgs.forEach((msg, i) => {
    const ts = new Date(msg.created_at).getTime();
    const timeDiff = lastTimestamp ? ts - lastTimestamp : Infinity;
    const isContinued = msg.user_id === lastUserId && timeDiff < 5 * 60 * 1000;

    list.appendChild(renderMessage(msg, isContinued));

    lastUserId = msg.user_id;
    lastTimestamp = ts;
  });
}

function renderMessage(msg, continued = false) {
  const el = document.createElement('div');
  el.className = `message-group${continued ? ' continued' : ' first-in-group'}`;
  el.dataset.messageId = msg.id;

  const authorName = msg.author?.username || 'Deleted User';
  const authorColor = stringToColor(msg.author?.username || '');
  const canEdit = msg.user_id === App.user?.id;
  const canDelete = msg.user_id === App.user?.id || isAdmin(App.user);

  let attachmentsHtml = '';
  if (msg.attachments?.length) {
    attachmentsHtml = msg.attachments.map(att => {
      if (att.mime_type.startsWith('image/')) {
        return `<div class="msg-attachment"><img src="/uploads/${esc(att.filename)}" alt="${esc(att.original_name)}" onclick="openImageViewer(this.src)" loading="lazy"></div>`;
      }
      return `<div class="msg-attachment"><a class="msg-file-attachment" href="/uploads/${esc(att.filename)}" target="_blank" download="${esc(att.original_name)}">📎 ${esc(att.original_name)} <span class="text-muted text-sm">${formatSize(att.size)}</span></a></div>`;
    }).join('');
  }

  el.innerHTML = `
    <div class="msg-avatar">${avatar(msg.author, 'avatar-sm')}</div>
    <div class="msg-body">
      ${!continued ? `<div class="msg-header">
        <span class="msg-author" style="color:${authorColor}">${esc(authorName)}</span>
        <span class="msg-timestamp">${formatTime(msg.created_at)}</span>
        ${msg.edited_at ? '<span class="msg-edited">(edited)</span>' : ''}
      </div>` : ''}
      <div class="msg-content">${renderContent(msg.content)}</div>
      ${attachmentsHtml}
    </div>
    <div class="msg-actions">
      ${canEdit ? `<button onclick="editMessage('${msg.id}')" title="Edit">✎</button>` : ''}
      ${canDelete ? `<button class="danger" onclick="deleteMessage('${msg.id}')" title="Delete">🗑</button>` : ''}
    </div>
  `;

  return el;
}

async function loadMoreMessages(channelId) {
  const existing = App.messages[channelId] || [];
  if (!existing.length) return;
  const oldest = existing[0];
  const more = await loadMessages(channelId, oldest.id);
  if (!more.length) {
    toast('No more messages to load', 'info');
    return;
  }
  App.messages[channelId] = [...more, ...existing];
  renderMessages(channelId);
}

function scrollToBottom(instant = false) {
  const container = document.getElementById('messages-container');
  container.scrollTo({ top: container.scrollHeight, behavior: instant ? 'instant' : 'smooth' });
}

function isNearBottom() {
  const c = document.getElementById('messages-container');
  return c.scrollHeight - c.scrollTop - c.clientHeight < 120;
}

// ─── SEND MESSAGE ─────────────────────────────────────────────────────────────
let pendingUpload = null;

async function sendMessage() {
  if (!App.currentChannel) return;
  const input = document.getElementById('message-input');
  const content = input.value.trim();
  if (!content && !pendingUpload) return;

  input.value = '';
  resizeInput(input);

  try {
    const body = { content };
    if (pendingUpload) {
      body.attachments = [pendingUpload.id];
      clearUploadPreview();
    }
    const msg = await api.post(`/api/channels/${App.currentChannel.id}/messages`, body);
    // Message will come through WebSocket, no need to add manually
  } catch (e) {
    toast(e.message, 'error');
    input.value = content;
  }
}

// ─── EDIT / DELETE MESSAGES ───────────────────────────────────────────────────
function editMessage(id) {
  const el = document.querySelector(`[data-message-id="${id}"] .msg-content`);
  if (!el) return;
  const original = App.messages[App.currentChannel?.id]?.find(m => m.id === id);
  if (!original) return;

  el.contentEditable = 'true';
  el.focus();

  // Set cursor at end
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);

  el.addEventListener('keydown', async function handler(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const newContent = el.textContent.trim();
      el.contentEditable = 'false';
      el.removeEventListener('keydown', handler);
      if (newContent && newContent !== original.content) {
        try {
          await api.put(`/api/messages/${id}`, { content: newContent });
        } catch (err) {
          toast(err.message, 'error');
          el.textContent = renderContent(original.content);
        }
      } else {
        el.innerHTML = renderContent(original.content);
      }
    }
    if (e.key === 'Escape') {
      el.contentEditable = 'false';
      el.innerHTML = renderContent(original.content);
      el.removeEventListener('keydown', handler);
    }
  });
}

async function deleteMessage(id) {
  if (!confirm('Delete this message?')) return;
  try {
    await api.del(`/api/messages/${id}`);
  } catch (e) {
    toast(e.message, 'error');
  }
}

// ─── FILE UPLOAD ──────────────────────────────────────────────────────────────
async function handleFileUpload(file) {
  if (!file) return;

  const formData = new FormData();
  formData.append('file', file);

  const toast_el = document.createElement('div');
  toast_el.className = 'toast info';
  toast_el.textContent = `Uploading ${file.name}…`;
  document.getElementById('toast-container').appendChild(toast_el);

  try {
    const res = await fetch('/api/upload', {
      method: 'POST',
      credentials: 'include',
      body: formData,
    });
    toast_el.remove();
    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error);
    }
    const att = await res.json();
    pendingUpload = att;
    showUploadPreview(att, file);
  } catch (e) {
    toast_el.remove();
    toast(e.message, 'error');
  }
}

function showUploadPreview(att, file) {
  const preview = document.getElementById('upload-preview');
  preview.style.display = 'flex';
  if (att.mime_type.startsWith('image/')) {
    const reader = new FileReader();
    reader.onload = (e) => {
      preview.innerHTML = `
        <img src="${e.target.result}" style="max-height:80px;border-radius:6px">
        <span style="font-size:13px;color:var(--text-secondary)">${esc(file.name)}</span>
        <button onclick="clearUploadPreview()" style="margin-left:auto;background:none;border:none;cursor:pointer;color:var(--text-muted);font-size:18px">✕</button>
      `;
    };
    reader.readAsDataURL(file);
  } else {
    preview.innerHTML = `
      <span>📎</span>
      <span style="font-size:13px;color:var(--text-secondary)">${esc(file.name)} (${formatSize(att.size)})</span>
      <button onclick="clearUploadPreview()" style="margin-left:auto;background:none;border:none;cursor:pointer;color:var(--text-muted);font-size:18px">✕</button>
    `;
  }
}

function clearUploadPreview() {
  pendingUpload = null;
  const preview = document.getElementById('upload-preview');
  preview.style.display = 'none';
  preview.innerHTML = '';
}

function openImageViewer(src) {
  // Close any open sidebars first so their overlay doesn't conflict
  closeAllPanels();

  const viewer = document.createElement('div');
  viewer.id = 'img-viewer';
  viewer.innerHTML = `
    <div id="img-viewer-bg"></div>
    <div id="img-viewer-toolbar">
      <button id="img-viewer-close" title="Close">✕</button>
      <a id="img-viewer-download" href="${src}" download title="Download" target="_blank">⬇</a>
    </div>
    <div id="img-viewer-stage">
      <img id="img-viewer-img" src="${src}" draggable="false">
    </div>
  `;
  document.body.appendChild(viewer);

  const stage  = viewer.querySelector('#img-viewer-stage');
  const img    = viewer.querySelector('#img-viewer-img');
  const bg     = viewer.querySelector('#img-viewer-bg');

  // Disable browser pinch-zoom while viewer is open
  const vpMeta = document.querySelector('meta[name=viewport]');
  if (vpMeta) vpMeta.content = 'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no';

  // ── State ──
  let scale = 1, minScale = 1, maxScale = 8;
  let tx = 0, ty = 0;
  let startTx = 0, startTy = 0;
  let isDragging = false;
  let didMove = false; // distinguish tap-to-close from pan

  // Pinch state
  let lastDist = 0, startScale = 1;
  let pinchOriginX = 0, pinchOriginY = 0;
  let isPinching = false;

  function clampTranslate(x, y, s) {
    const iw = img.naturalWidth  * s;
    const ih = img.naturalHeight * s;
    const sw = stage.clientWidth;
    const sh = stage.clientHeight;
    const maxX = Math.max(0, (iw - sw) / 2);
    const maxY = Math.max(0, (ih - sh) / 2);
    return [
      Math.min(maxX, Math.max(-maxX, x)),
      Math.min(maxY, Math.max(-maxY, y)),
    ];
  }

  function applyTransform(s, x, y, animate = false) {
    scale = Math.min(maxScale, Math.max(minScale, s));
    [tx, ty] = clampTranslate(x, y, scale);
    img.style.transition = animate ? 'transform 0.22s cubic-bezier(0.25,0.46,0.45,0.94)' : 'none';
    img.style.transform  = `translate(${tx}px, ${ty}px) scale(${scale})`;
    stage.style.cursor   = scale > minScale + 0.01 ? 'grab' : 'zoom-in';
  }

  function snapToFit(animate = true) {
    applyTransform(minScale, 0, 0, animate);
  }

  function dist(t) {
    return Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  }
  function mid(t) {
    return { x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2 };
  }

  // ── Touch ──
  stage.addEventListener('touchstart', (e) => {
    didMove = false;
    if (e.touches.length === 2) {
      isPinching = true;
      isDragging = false;
      e.preventDefault();
      lastDist   = dist(e.touches);
      startScale = scale;
      const m    = mid(e.touches);
      const rect = stage.getBoundingClientRect();
      pinchOriginX = m.x - rect.left - rect.width  / 2 - tx;
      pinchOriginY = m.y - rect.top  - rect.height / 2 - ty;
      startTx = tx; startTy = ty;
    } else if (e.touches.length === 1 && !isPinching) {
      isDragging = true;
      startTx = tx - e.touches[0].clientX;
      startTy = ty - e.touches[0].clientY;
    }
  }, { passive: false });

  stage.addEventListener('touchmove', (e) => {
    e.preventDefault();
    didMove = true;
    if (e.touches.length === 2 && isPinching) {
      const newDist  = dist(e.touches);
      const newScale = startScale * (newDist / lastDist);
      const ratio    = newScale / startScale;
      applyTransform(newScale,
        startTx - pinchOriginX * (ratio - 1),
        startTy - pinchOriginY * (ratio - 1)
      );
    } else if (e.touches.length === 1 && isDragging) {
      applyTransform(scale,
        e.touches[0].clientX + startTx,
        e.touches[0].clientY + startTy
      );
    }
  }, { passive: false });

  stage.addEventListener('touchend', (e) => {
    if (e.touches.length === 0) isPinching = false;
    if (e.touches.length < 2)  isDragging = false;
    // Snap back to fit if zoomed too far out
    if (scale < minScale + 0.02) snapToFit(true);
  });

  // Double-tap: toggle between fit and 3×
  let lastTap = 0;
  stage.addEventListener('touchend', (e) => {
    if (e.touches.length > 0 || didMove) return;
    const now = Date.now();
    if (now - lastTap < 280) {
      if (scale > minScale + 0.5) {
        snapToFit(true);
      } else {
        const t    = e.changedTouches[0];
        const rect = stage.getBoundingClientRect();
        applyTransform(3,
          -(t.clientX - rect.left - rect.width  / 2),
          -(t.clientY - rect.top  - rect.height / 2),
          true
        );
      }
    }
    lastTap = now;
  });

  // Single tap on stage (not image) → close
  stage.addEventListener('click', (e) => {
    if (didMove) return;
    // If the click is on the background (not the image itself), close
    if (e.target === stage) closeViewer();
  });
  bg.addEventListener('click', closeViewer);

  // ── Mouse wheel zoom ──
  stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect  = stage.getBoundingClientRect();
    const ox    = e.clientX - rect.left - rect.width  / 2 - tx;
    const oy    = e.clientY - rect.top  - rect.height / 2 - ty;
    const delta = e.deltaY < 0 ? 1.15 : 0.87;
    const ns    = scale * delta;
    const ratio = ns / scale;
    if (ns <= minScale + 0.02) { snapToFit(true); return; }
    applyTransform(ns, tx - ox * (ratio - 1), ty - oy * (ratio - 1));
  }, { passive: false });

  // ── Mouse drag ──
  let mouseDown = false;
  stage.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    didMove    = false;
    mouseDown  = true;
    isDragging = scale > minScale + 0.01;
    startTx = tx - e.clientX;
    startTy = ty - e.clientY;
    if (isDragging) { stage.style.cursor = 'grabbing'; e.preventDefault(); }
  });
  window.addEventListener('mousemove', (e) => {
    if (!mouseDown) return;
    if (Math.abs(e.movementX) + Math.abs(e.movementY) > 2) didMove = true;
    if (isDragging) applyTransform(scale, e.clientX + startTx, e.clientY + startTy);
  });
  window.addEventListener('mouseup', (e) => {
    if (!mouseDown) return;
    mouseDown = false;
    if (!isDragging && !didMove && e.target === stage) closeViewer();
    isDragging = false;
    stage.style.cursor = scale > minScale + 0.01 ? 'grab' : 'zoom-in';
  });

  // ── Close ──
  viewer.querySelector('#img-viewer-close').onclick = closeViewer;
  document.addEventListener('keydown', onKey);

  function onKey(e) { if (e.key === 'Escape') closeViewer(); }
  function closeViewer() {
    viewer.remove();
    document.removeEventListener('keydown', onKey);
    if (vpMeta) vpMeta.content = 'width=device-width, initial-scale=1.0';
  }

  // ── Init: compute fit scale after image loads ──
  function initScale() {
    const sw  = stage.clientWidth  || window.innerWidth;
    const sh  = stage.clientHeight || (window.innerHeight - 56);
    const fit = Math.min(sw / img.naturalWidth, sh / img.naturalHeight, 1);
    minScale  = fit;
    applyTransform(fit, 0, 0, false);
  }
  if (img.complete && img.naturalWidth) {
    initScale();
  } else {
    img.addEventListener('load', initScale);
  }
}

// ─── WEBSOCKET HANDLERS ───────────────────────────────────────────────────────
function setupWSHandlers() {
  WS.on('message.new', (msg) => {
    const channelId = msg.channel_id;
    if (!App.messages[channelId]) App.messages[channelId] = [];

    // Check for duplicate
    if (App.messages[channelId].find(m => m.id === msg.id)) return;
    App.messages[channelId].push(msg);

    if (App.currentChannel?.id === channelId) {
      const nearBottom = isNearBottom();
      const list = document.getElementById('messages-list');
      const prev = App.messages[channelId].slice(-2)[0];
      const ts = new Date(msg.created_at).getTime();
      const prevTs = prev ? new Date(prev.created_at).getTime() : 0;
      const continued = prev?.user_id === msg.user_id && ts - prevTs < 5 * 60 * 1000;
      list.appendChild(renderMessage(msg, continued));
      if (nearBottom) scrollToBottom();
    } else {
      App.unread.add(channelId);
      const el = document.querySelector(`[data-channel-id="${channelId}"]`);
      if (el) el.classList.add('unread');
    }
  });

  WS.on('message.edit', (msg) => {
    const channelId = msg.channel_id;
    if (App.messages[channelId]) {
      const idx = App.messages[channelId].findIndex(m => m.id === msg.id);
      if (idx >= 0) App.messages[channelId][idx] = msg;
    }
    if (App.currentChannel?.id === channelId) {
      const el = document.querySelector(`[data-message-id="${msg.id}"]`);
      if (el) {
        const content = el.querySelector('.msg-content');
        if (content) content.innerHTML = renderContent(msg.content);
        const header = el.querySelector('.msg-header');
        if (header && !header.querySelector('.msg-edited')) {
          header.innerHTML += '<span class="msg-edited">(edited)</span>';
        }
      }
    }
  });

  WS.on('message.delete', ({ id, channel_id }) => {
    if (App.messages[channel_id]) {
      App.messages[channel_id] = App.messages[channel_id].filter(m => m.id !== id);
    }
    const el = document.querySelector(`[data-message-id="${id}"]`);
    if (el) el.remove();
  });

  WS.on('channel.new', (ch) => {
    App.channels.push(ch);
    renderChannelList();
  });

  WS.on('channel.update', (ch) => {
    const idx = App.channels.findIndex(c => c.id === ch.id);
    if (idx >= 0) App.channels[idx] = ch;
    if (App.currentChannel?.id === ch.id) {
      App.currentChannel = ch;
      document.getElementById('ch-title').textContent = ch.name;
      document.getElementById('ch-desc').textContent = ch.description || '';
    }
    renderChannelList();
  });

  WS.on('channel.delete', ({ id }) => {
    App.channels = App.channels.filter(c => c.id !== id);
    if (App.currentChannel?.id === id) {
      App.currentChannel = null;
      document.getElementById('messages-list').innerHTML = '';
      if (App.channels.length) openChannel(App.channels[0]);
    }
    renderChannelList();
  });

  WS.on('typing', ({ user_id, channel_id }) => {
    if (user_id === App.user.id) return;
    if (!App.typingUsers[channel_id]) App.typingUsers[channel_id] = {};
    App.typingUsers[channel_id][user_id] = Date.now();
    updateTypingIndicator(channel_id);

    setTimeout(() => {
      if (App.typingUsers[channel_id]) {
        delete App.typingUsers[channel_id][user_id];
        updateTypingIndicator(channel_id);
      }
    }, 4000);
  });
}

let typingTimeout = null;
function onInputKeydown(e) {
  if (!App.currentChannel) return;
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
    return;
  }
  clearTimeout(typingTimeout);
  WS.sendTyping(App.currentChannel.id);
  typingTimeout = setTimeout(() => {}, 3000);
}

function updateTypingIndicator(channelId) {
  if (App.currentChannel?.id !== channelId) return;
  const el = document.getElementById('typing-indicator');
  const users = App.typingUsers[channelId] || {};
  const names = Object.keys(users).map(uid => {
    const m = App.members.find(m => m.id === uid);
    return m?.username || 'Someone';
  }).filter(Boolean);

  if (!names.length) {
    el.innerHTML = '';
    return;
  }
  const text = names.length === 1 ? `${names[0]} is typing` :
    names.length === 2 ? `${names[0]} and ${names[1]} are typing` :
    'Several people are typing';
  el.innerHTML = `<div class="typing-dots"><span></span><span></span><span></span></div><span>${text}…</span>`;
}

// ─── INPUT RESIZE ─────────────────────────────────────────────────────────────
function resizeInput(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 200) + 'px';
}

// ─── ADMIN PANEL ──────────────────────────────────────────────────────────────
function openAdmin() {
  openModal('admin-modal');
  loadAdminUsers();
}

async function loadAdminUsers() {
  const [users, roles, invites, settings] = await Promise.all([
    api.get('/api/users'),
    api.get('/api/roles'),
    api.get('/api/invites'),
    api.get('/api/settings'),
  ]);
  renderAdminUsers(users);
  renderAdminRoles(roles);
  renderAdminInvites(invites, settings);
  renderAdminSettings(settings);
}

function renderAdminUsers(users) {
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
  </table>`;
}

function renderAdminRoles(roles) {
  const el = document.getElementById('admin-roles-list');
  const editableRoles = roles.filter(r => r.name !== '@everyone');
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
    </table>`;
}

function renderAdminInvites(invites, settings) {
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

function renderAdminSettings(settings) {
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
    <button class="btn btn-primary" onclick="saveSettings()">Save Settings</button>
  `;
}

async function saveSettings() {
  const settings = {
    server_name: document.getElementById('setting-server-name')?.value,
    server_description: document.getElementById('setting-server-desc')?.value,
    allow_registration: document.getElementById('setting-allow-reg')?.value,
    require_invite: document.getElementById('setting-require-invite')?.value,
    max_upload_mb: document.getElementById('setting-max-upload')?.value,
  };
  try {
    await api.put('/api/settings', settings);
    toast('Settings saved', 'success');
    renderServerHeader();
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function adminDeleteUser(id, name) {
  if (!confirm(`Ban/delete user "${name}"? This cannot be undone.`)) return;
  try {
    await api.del(`/api/users/${id}`);
    toast(`${name} deleted`, 'success');
    loadAdminUsers();
    loadMembers().then(renderMembersList);
  } catch (e) { toast(e.message, 'error'); }
}

async function adminDeleteRole(id) {
  if (!confirm('Delete this role?')) return;
  try {
    await api.del(`/api/roles/${id}`);
    toast('Role deleted', 'success');
    loadAdminUsers();
  } catch (e) { toast(e.message, 'error'); }
}

async function adminDeleteInvite(code) {
  try {
    await api.del(`/api/invites/${code}`);
    toast('Invite deleted', 'success');
    loadAdminUsers();
  } catch (e) { toast(e.message, 'error'); }
}

async function createInvite() {
  try {
    await api.post('/api/invites', { max_uses: 0 });
    toast('Invite created', 'success');
    loadAdminUsers();
  } catch (e) { toast(e.message, 'error'); }
}

function copyInvite(url) {
  navigator.clipboard.writeText(url).then(() => toast('Copied!', 'success')).catch(() => {
    prompt('Copy this invite link:', url);
  });
}

// ─── CHANNEL MANAGEMENT ───────────────────────────────────────────────────────
function openCreateChannel() {
  const form = `
    <div class="form-group"><label>Channel Name</label><input type="text" id="new-ch-name" placeholder="new-channel"></div>
    <div class="form-group"><label>Description</label><input type="text" id="new-ch-desc" placeholder="Optional description"></div>
  `;
  showSimpleModal('Create Channel', form, async () => {
    const name = document.getElementById('new-ch-name').value.trim();
    if (!name) { toast('Name required', 'error'); return false; }
    await api.post('/api/channels', { name, description: document.getElementById('new-ch-desc').value });
    await loadChannels();
    renderChannelList();
  });
}

function openEditChannel(id) {
  const ch = App.channels.find(c => c.id === id);
  if (!ch) return;
  const form = `
    <div class="form-group"><label>Channel Name</label><input type="text" id="edit-ch-name" value="${esc(ch.name)}"></div>
    <div class="form-group"><label>Description</label><input type="text" id="edit-ch-desc" value="${esc(ch.description)}"></div>
  `;
  showSimpleModal('Edit Channel', form, async () => {
    const name = document.getElementById('edit-ch-name').value.trim();
    if (!name) { toast('Name required', 'error'); return false; }
    await api.put(`/api/channels/${id}`, { name, description: document.getElementById('edit-ch-desc').value });
    await loadChannels();
    renderChannelList();
  });
}

async function confirmDeleteChannel(id) {
  const ch = App.channels.find(c => c.id === id);
  if (!confirm(`Delete #${ch?.name}? All messages will be lost.`)) return;
  await api.del(`/api/channels/${id}`);
  await loadChannels();
  renderChannelList();
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

function openCreateRole() {
  const form = `
    <div class="form-group"><label>Role Name</label><input type="text" id="new-role-name" placeholder="Moderator"></div>
    <div class="form-group"><label>Color</label><input type="color" id="new-role-color" value="#7c6af5" style="height:38px;cursor:pointer"></div>
    <div class="form-group"><label>Permissions</label><div id="role-perms">${permCheckboxes(3)}</div></div>
  `;
  showSimpleModal('Create Role', form, async () => {
    const name = document.getElementById('new-role-name').value.trim();
    if (!name) { toast('Name required', 'error'); return false; }
    const perms = getPermValue(document.getElementById('role-perms'));
    await api.post('/api/roles', { name, color: document.getElementById('new-role-color').value, permissions: perms });
    toast('Role created', 'success');
    loadAdminUsers();
  });
}

function openEditRole(id) {
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
    await loadRoles();
    loadAdminUsers();
  });
}

async function openAssignRole(userId) {
  const roles = await api.get('/api/roles');
  const user = await api.get(`/api/me`); // we can only get current user easily; use admin list
  const allUsers = await api.get('/api/users');
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

// ─── PROFILE MODAL ────────────────────────────────────────────────────────────
function openProfile() {
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

    // Avatar: upload file if selected, otherwise keep existing
    const fileInput = document.getElementById('profile-avatar-file');
    let avatarUrl = App.user.avatar || '';

    if (fileInput?.files?.length > 0) {
      const formData = new FormData();
      formData.append('avatar', fileInput.files[0]);
      const statusEl = document.getElementById('avatar-upload-status');
      if (statusEl) statusEl.textContent = 'Uploading avatar…';
      try {
        const res = await fetch('/api/me/avatar', {
          method: 'POST',
          credentials: 'include',
          body: formData,
        });
        if (!res.ok) {
          const d = await res.json();
          toast(d.error || 'Avatar upload failed', 'error');
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
      App.user = await api.put('/api/me', { username, avatar: avatarUrl });
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

async function clearAvatar() {
  try {
    App.user = await api.put('/api/me', { username: App.user.username, avatar: '' });
    renderUserPanel();
    toast('Avatar removed', 'success');
    document.querySelector('.modal-overlay')?.remove();
  } catch (e) { toast(e.message, 'error'); }
}

// ─── MODAL HELPERS ────────────────────────────────────────────────────────────
function openModal(id) {
  document.getElementById(id).style.display = 'flex';
}
function closeModal(id) {
  document.getElementById(id).style.display = 'none';
}

function showSimpleModal(title, bodyHtml, onConfirm) {
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.id = 'simple-modal';
  modal.innerHTML = `
    <div class="modal" style="max-width:440px">
      <div class="modal-header">
        <h2>${title}</h2>
        <button class="modal-close" onclick="this.closest('.modal-overlay').remove()">✕</button>
      </div>
      <div class="modal-body">${bodyHtml}</div>
      <div class="modal-footer">
        <button class="btn btn-secondary" onclick="this.closest('.modal-overlay').remove()">Cancel</button>
        <button class="btn btn-primary" id="simple-modal-confirm">Confirm</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  modal.querySelector('#simple-modal-confirm').onclick = async () => {
    try {
      const result = await onConfirm();
      if (result !== false) modal.remove();
    } catch (e) { toast(e.message, 'error'); }
  };
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
}

// ─── LOGOUT ───────────────────────────────────────────────────────────────────
async function logout() {
  await api.post('/api/auth/logout', {});
  window.location.href = '/login';
}

// ─── ADMIN TAB SWITCHING ──────────────────────────────────────────────────────
function switchAdminTab(tab) {
  document.querySelectorAll('.admin-tab').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.admin-pane').forEach(el => el.classList.remove('active'));
  document.querySelector(`.admin-tab[data-tab="${tab}"]`).classList.add('active');
  document.getElementById(`admin-pane-${tab}`).classList.add('active');
}

// ─── PANEL MANAGER ────────────────────────────────────────────────────────────
// Single source of truth for which panel (if any) is open on mobile.
// Prevents the shared-overlay conflicts that caused cross-opening bugs.

const PanelMgr = (() => {
  let current = null; // 'channels' | 'members' | null

  const overlay = () => document.getElementById('sidebar-overlay');
  const main    = () => document.getElementById('main');

  function _showOverlay(onClick) {
    const el = overlay();
    el.classList.add('open');
    el._closeHandler = onClick;
    el.addEventListener('click', onClick, { once: true });
    // Dead-zone: prevent accidental taps/edits on the chat while a panel is open
    const m = main();
    if (m) m.style.pointerEvents = 'none';
  }

  function _hideOverlay() {
    const el = overlay();
    if (el._closeHandler) {
      el.removeEventListener('click', el._closeHandler);
      el._closeHandler = null;
    }
    el.classList.remove('open');
    const m = main();
    if (m) m.style.pointerEvents = '';
  }

  function open(panel) {
    if (current && current !== panel) close(current);
    current = panel;

    if (panel === 'channels') {
      document.getElementById('sidebar').classList.add('open');
    } else if (panel === 'members') {
      document.getElementById('members-sidebar').classList.add('overlay-open');
    }
    _showOverlay(() => close(panel));
  }

  function close(panel) {
    if (panel === 'channels') {
      document.getElementById('sidebar').classList.remove('open');
    } else if (panel === 'members') {
      document.getElementById('members-sidebar').classList.remove('overlay-open');
    }
    _hideOverlay();
    if (current === panel) current = null;
  }

  function closeAll() {
    if (current) close(current);
  }

  function isOpen(panel) { return current === panel; }
  function isMobile()    { return window.innerWidth <= 768; }
  function isTablet()    { return window.innerWidth <= 1024; }

  return { open, close, closeAll, isOpen, isMobile, isTablet };
})();

function closeAllPanels() { PanelMgr.closeAll(); }

function toggleSidebar(forceClose = false) {
  if (forceClose || PanelMgr.isOpen('channels')) {
    PanelMgr.close('channels');
  } else {
    // Only use overlay behaviour on mobile; on desktop the sidebar is always visible
    if (PanelMgr.isMobile()) {
      PanelMgr.open('channels');
    }
  }
}

function toggleMembers() {
  const panel = document.getElementById('members-sidebar');

  if (PanelMgr.isTablet()) {
    // Tablet/mobile: overlay panel
    if (PanelMgr.isOpen('members')) {
      PanelMgr.close('members');
    } else {
      PanelMgr.open('members');
    }
  } else {
    // Desktop: collapse in-place
    panel.classList.toggle('collapsed');
  }
}

// ─── SWIPE TO CLOSE SIDEBARS ──────────────────────────────────────────────────
(function addSwipeListeners() {
  let swipeStartX = 0, swipeStartY = 0;
  const THRESHOLD = 60;  // px needed to trigger close
  const ANGLE_MAX = 40;  // max angle from horizontal (degrees)

  function onTouchStart(e) {
    swipeStartX = e.touches[0].clientX;
    swipeStartY = e.touches[0].clientY;
  }

  function onTouchEnd(e) {
    const dx = e.changedTouches[0].clientX - swipeStartX;
    const dy = e.changedTouches[0].clientY - swipeStartY;
    const angle = Math.abs(Math.atan2(dy, dx) * 180 / Math.PI);
    const isHorizontal = angle < ANGLE_MAX || angle > (180 - ANGLE_MAX);

    if (!isHorizontal || Math.abs(dx) < THRESHOLD) return;

    // Swipe LEFT on channels (left panel) → close
    if (dx < 0 && PanelMgr.isOpen('channels')) {
      PanelMgr.close('channels');
    }
    // Swipe RIGHT on members (right panel) → close
    if (dx > 0 && PanelMgr.isOpen('members')) {
      PanelMgr.close('members');
    }
  }

  // Attach to sidebars themselves so swiping on them closes them
  document.addEventListener('DOMContentLoaded', () => {
    const sidebar  = document.getElementById('sidebar');
    const members  = document.getElementById('members-sidebar');
    [sidebar, members].forEach(el => {
      el.addEventListener('touchstart', onTouchStart, { passive: true });
      el.addEventListener('touchend',   onTouchEnd,   { passive: true });
    });
    // Also swipe from overlay
    const ovl = document.getElementById('sidebar-overlay');
    ovl.addEventListener('touchstart', onTouchStart, { passive: true });
    ovl.addEventListener('touchend',   onTouchEnd,   { passive: true });
  });
})();

// ─── VIEWPORT HEIGHT FIX ──────────────────────────────────────────────────────
// Sets --app-height to window.innerHeight so mobile browsers that misreport
// 100svh (including some Android Firefox versions) still get the right value.
function fixViewportHeight() {
  const h = window.innerHeight;
  document.documentElement.style.setProperty('--app-height', h + 'px');
  // Apply directly to #app as well as a belt-and-suspenders approach
  const app = document.getElementById('app');
  if (app) app.style.height = h + 'px';
}
window.addEventListener('resize', fixViewportHeight);
window.addEventListener('orientationchange', () => setTimeout(fixViewportHeight, 150));
// Run immediately before DOM is fully ready, and again after
fixViewportHeight();
document.addEventListener('DOMContentLoaded', fixViewportHeight);

// ─── BOOT ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  init();

  // Message form
  const input = document.getElementById('message-input');
  input.addEventListener('keydown', onInputKeydown);
  input.addEventListener('input', () => resizeInput(input));

  const form = document.getElementById('message-form');
  form.addEventListener('submit', (e) => { e.preventDefault(); sendMessage(); });

  // File input
  const fileInput = document.getElementById('file-input');
  fileInput.addEventListener('change', () => {
    if (fileInput.files[0]) handleFileUpload(fileInput.files[0]);
    fileInput.value = '';
  });

  // Drag & drop on messages area
  const mc = document.getElementById('messages-container');
  mc.addEventListener('dragover', (e) => { e.preventDefault(); mc.style.outline = '2px dashed var(--accent)'; });
  mc.addEventListener('dragleave', () => { mc.style.outline = ''; });
  mc.addEventListener('drop', (e) => {
    e.preventDefault();
    mc.style.outline = '';
    const file = e.dataTransfer.files[0];
    if (file) handleFileUpload(file);
  });

  // Close modal on overlay click
  document.getElementById('admin-modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'admin-modal') closeModal('admin-modal');
  });
});
