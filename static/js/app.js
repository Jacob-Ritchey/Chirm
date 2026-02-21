// app.js — Chirm main application

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
  voiceParticipants: {},  // channelId → Set of userIds
  token: null,
  replyTo: null,         // {id, content, authorName} | null
  customEmojis: [],      // [{id, name, filename, ...}]
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
  // ── Step 0: extract fenced code blocks to protect them from other transforms
  const codeBlocks = [];
  let s = content.replace(/```([a-zA-Z]*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const idx = codeBlocks.length;
    codeBlocks.push(`<pre class="msg-codeblock" data-lang="${esc(lang)}">${esc(code.trim())}</pre>`);
    return `\x00CB${idx}\x00`;
  });

  // ── Step 1: escape HTML in the remaining text
  s = esc(s);

  // Re-escape the placeholders that got double-escaped
  s = s.replace(/\x00CB(\d+)\x00/g, (_, i) => codeBlocks[parseInt(i)]);

  // ── Step 2: custom emoji :name: substitution (custom first, then shortcodes)
  s = s.replace(/:([a-zA-Z0-9_]+):/g, (match, name) => {
    // Check custom server emojis
    const custom = App.customEmojis?.find(e => e.name === name.toLowerCase());
    if (custom) {
      return `<img class="custom-emoji" src="/uploads/${esc(custom.filename)}" alt=":${esc(name)}:" title=":${esc(name)}:">`;
    }
    // Check standard shortcodes
    const std = EMOJI_SHORTCODES[name] || EMOJI_SHORTCODES[name.toLowerCase()];
    if (std) return std;
    return match; // unchanged
  });

  // ── Step 3: inline images  ![alt](url)
  s = s.replace(/!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g,
    (_, alt, url) => `<img class="msg-inline-img" src="${url}" alt="${esc(alt)}" loading="lazy" onclick="openImageViewer('${url}')">`);

  // ── Step 4: blockquotes
  s = s.replace(/^&gt; ?(.*)$/gm, '<div class="msg-blockquote">$1</div>');

  // ── Step 5: headers
  s = s.replace(/^### (.+)$/gm, '<h3 class="msg-h3 msg-h">$1</h3>');
  s = s.replace(/^## (.+)$/gm,  '<h2 class="msg-h2 msg-h">$1</h2>');
  s = s.replace(/^# (.+)$/gm,   '<h1 class="msg-h1 msg-h">$1</h1>');

  // ── Step 6: horizontal rule  --- or *** or ___
  s = s.replace(/^(?:-{3,}|\*{3,}|_{3,})\s*$/gm, '<hr class="msg-hr">');

  // ── Step 7: task list items  - [ ] / - [x]
  s = s.replace(/^- \[( |x)\] (.*)$/gm, (_, checked, text) => {
    const ch = checked === 'x' ? 'checked' : '';
    return `<div class="msg-task"><input type="checkbox" ${ch} disabled> ${text}</div>`;
  });

  // ── Step 8: unordered list items  - item  or  * item  (not task list)
  s = s.replace(/^[ \t]*[-*] (.+)$/gm, '<li class="msg-li">$1</li>');

  // ── Step 9: ordered list items  1. item
  s = s.replace(/^[ \t]*\d+\. (.+)$/gm, '<li class="msg-oli">$1</li>');

  // ── Step 10: wrap consecutive <li> into <ul>/<ol>
  s = s.replace(/(<li class="msg-li">[\s\S]*?<\/li>)(?![\s\S]*?<li class="msg-li">)/g, '<ul class="msg-ul">$1</ul>');
  s = s.replace(/(<li class="msg-oli">[\s\S]*?<\/li>)(?![\s\S]*?<li class="msg-oli">)/g, '<ol class="msg-ol">$1</ol>');
  // Group consecutive lis
  s = s.replace(/(<li class="msg-li">.*?<\/li>)\n(<li class="msg-li">)/g, '$1$2');
  s = s.replace(/(<li class="msg-oli">.*?<\/li>)\n(<li class="msg-oli">)/g, '$1$2');

  // ── Step 11: tables  | col | col |
  s = s.replace(/(\|.+\|\n)((?:\|[-: ]+\|\n))(\|.+\|\n?)+/g, (table) => {
    const rows = table.trim().split('\n').filter(r => r.trim());
    if (rows.length < 2) return table;
    const parseRow = r => r.split('|').slice(1, -1).map(c => c.trim());
    const headerCells = parseRow(rows[0]);
    const isSep = rows[1] && /^\|[-| :]+\|/.test(rows[1]);
    if (!isSep) return table;
    const align = parseRow(rows[1]).map(c => {
      if (c.startsWith(':') && c.endsWith(':')) return 'center';
      if (c.endsWith(':')) return 'right';
      return 'left';
    });
    const bodyRows = rows.slice(2);
    const thead = `<tr>${headerCells.map((c,i) => `<th style="text-align:${align[i]||'left'}">${c}</th>`).join('')}</tr>`;
    const tbody = bodyRows.map(r => {
      const cells = parseRow(r);
      return `<tr>${cells.map((c,i) => `<td style="text-align:${align[i]||'left'}">${c}</td>`).join('')}</tr>`;
    }).join('');
    return `<table class="msg-table"><thead>${thead}</thead><tbody>${tbody}</tbody></table>`;
  });

  // ── Step 12: inline code  `code`
  s = s.replace(/`([^`\n]+)`/g, '<code class="msg-inlinecode">$1</code>');

  // ── Step 13: bold+italic ***
  s = s.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  s = s.replace(/___(.+?)___/g, '<strong><em>$1</em></strong>');
  // Bold
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__(.+?)__/g, '<strong>$1</strong>');
  // Italic
  s = s.replace(/\*(.+?)\*/g, '<em>$1</em>');
  s = s.replace(/_([^_\s][^_]*)_/g, '<em>$1</em>');
  // Strikethrough
  s = s.replace(/~~(.+?)~~/g, '<del>$1</del>');

  // ── Step 14: URLs — match https?:// and bare www. addresses
  // Track which URLs appear for preview generation (stored on rendered element via data attr)
  const foundURLs = [];
  s = s.replace(/(?<!href="|src="|">|:\/\/)(https?:\/\/[^\s<>"')\]]+|www\.[a-zA-Z0-9-]+\.[a-zA-Z]{2,}[^\s<>"')\]]*)/g,
    (match) => {
      const href = match.startsWith('http') ? match : `https://${match}`;
      // Only collect first 2 unique http(s) URLs for previews
      if (foundURLs.length < 2 && href.startsWith('http') && !foundURLs.includes(href)) {
        foundURLs.push(href);
      }
      return `<a href="${href}" target="_blank" rel="noopener" class="msg-link">${match}</a>`;
    });
  // Encode collected URLs into a data attribute on a sentinel span for async preview
  if (foundURLs.length > 0) {
    s += `<span class="link-preview-trigger" data-urls="${escAttr(foundURLs.join('|'))}" style="display:none"></span>`;
  }

  // ── Step 15: newlines → <br> (skipping inside block-level tags)
  s = s.replace(/\n/g, '<br>');
  // Clean stray <br> around block elements
  const BLOCK = 'pre|ul|ol|li|div|hr|h[1-6]|table|thead|tbody|tr|th|td|blockquote';
  s = s.replace(new RegExp(`<br>(</?(?:${BLOCK})[^>]*>)`, 'g'), '$1');
  s = s.replace(new RegExp(`(</?(?:${BLOCK})[^>]*>)<br>`, 'g'), '$1');

  return s;
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
  await Promise.all([loadChannels(), loadMembers(), loadRoles(), loadVoiceRooms(), loadCustomEmojis()]);

  // Render UI
  renderServerHeader();
  renderChannelList();
  renderUserPanel();
  renderMembersList();

  // Connect WebSocket
  WS.connect();
  setupWSHandlers();
  Voice.init();

  // Open first text channel
  const firstText = App.channels.find(c => c.type !== 'voice') || App.channels[0];
  if (firstText) {
    openChannel(firstText);
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

async function loadVoiceRooms() {
  const data = await api.get('/api/voice/rooms').catch(() => null);
  if (!data || !data.rooms) return;
  // Populate App.voiceParticipants from the server snapshot
  App.voiceParticipants = {};
  for (const [channelId, userIds] of Object.entries(data.rooms)) {
    App.voiceParticipants[channelId] = new Set(userIds);
  }
}

async function loadCustomEmojis() {
  App.customEmojis = await api.get('/api/emojis').catch(() => []);
}

async function loadMessages(channelId, before = null) {
  const url = `/api/channels/${channelId}/messages${before ? `?before=${before}` : ''}`;
  return api.get(url).catch(() => []);
}

// ─── RENDER ───────────────────────────────────────────────────────────────────
function renderServerHeader() {
  const settings = api.get('/api/settings').then(s => {
    document.getElementById('server-name').textContent = s.server_name || 'Chirm';
    document.title = s.server_name || 'Chirm';
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
    const isVoice = ch.type === 'voice';
    const participants = isVoice ? (App.voiceParticipants[ch.id] || new Set()) : null;
    const pCount = participants ? participants.size : 0;
    const inRoom = isVoice && Voice.isInChannel(ch.id);

    const item = document.createElement('div');
    item.className = `channel-item${App.currentChannel?.id === ch.id && !isVoice ? ' active' : ''}${inRoom ? ' voice-active' : ''}${App.unread.has(ch.id) && App.currentChannel?.id !== ch.id ? ' unread' : ''}`;
    item.dataset.channelId = ch.id;

    const icon = isVoice ? '🔊' : '#';
    const badge = isVoice && pCount > 0 ? `<span class="voice-count">${pCount}</span>` : '';

    item.innerHTML = `
      <span class="ch-icon">${icon}</span>
      <span class="ch-name">${esc(ch.name)}</span>
      ${badge}
      <span class="unread-dot"></span>
      ${isAdmin(App.user) ? `<span class="channel-edit-actions">
        <button class="channel-edit-btn" onclick="event.stopPropagation();openEditChannel('${ch.id}')" title="Edit">✎</button>
        <button class="channel-edit-btn" onclick="event.stopPropagation();confirmDeleteChannel('${ch.id}')" title="Delete" style="color:var(--danger)">✕</button>
      </span>` : ''}
    `;

    if (isVoice && pCount > 0) {
      // Show participant names below the channel item
      const memberNames = [...participants].map(uid => {
        const m = App.members.find(m => m.id === uid);
        return m ? esc(m.username) : uid.slice(0,8);
      });
      const sub = document.createElement('div');
      sub.className = 'voice-participants-list';
      sub.innerHTML = memberNames.map(n =>
        `<div class="voice-participant-row"><span class="vp-dot"></span>${n}</div>`
      ).join('');
      item.appendChild(sub);
    }

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

// ─── CHANNELS ─────────────────────────────────────────────────────────────────
async function openChannel(ch) {
  // ── Voice channel: join/toggle voice room ──────────────────────────────
  if (ch.type === 'voice') {
    if (Voice.isInChannel(ch.id)) {
      // Already in this room — navigate to the full voice view without disconnecting.
      Voice.showFullView();
      if (PanelMgr.isMobile()) PanelMgr.close('channels');
    } else {
      // Joining a new room: loading screen + getUserMedia will be shown by Voice.join().
      // Update header
      document.getElementById('ch-title').textContent = ch.name;
      document.getElementById('ch-desc').textContent = ch.description || 'Voice Channel';
      document.querySelector('.ch-hash').textContent = '🔊';
      // Remove split-view class in case we were in split mode from a prior call
      document.getElementById('main').classList.remove('split-voice');

      const joined = await Voice.join(ch.id);

      if (joined) {
        // Optimistically add self to participant list immediately so the
        // sidebar shows the current user without waiting for the WS round-trip.
        if (!App.voiceParticipants[ch.id]) App.voiceParticipants[ch.id] = new Set();
        App.voiceParticipants[ch.id].add(App.user.id);
      }
    }
    renderChannelList();
    return;
  }

  // ── Text channel ───────────────────────────────────────────────────────
  // Restore text UI.
  document.getElementById('messages-container').style.display = '';
  document.getElementById('message-input-area').style.display = '';
  document.getElementById('typing-indicator').style.display = '';
  document.querySelector('.ch-hash').textContent = '#';

  // If the user is in an active voice call, activate split-view so the
  // mini voice panel stays visible at the bottom of the text channel.
  const main = document.getElementById('main');
  const voicePanel = document.getElementById('voice-panel');
  if (Voice.inCall()) {
    main.classList.add('split-voice');
    voicePanel.style.display = 'flex';
    // Reset collapse state when switching text channels
    voicePanel.classList.remove('vc-panel-collapsed');
    const colBtn = document.getElementById('vp-collapse-btn');
    if (colBtn) { colBtn.textContent = '▼'; colBtn.title = 'Collapse voice panel'; }
  } else {
    main.classList.remove('split-voice');
  }

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

  // Reply reference
  let replyHtml = '';
  if (msg.reply_to) {
    replyHtml = `<div class="msg-reply-ref" onclick="scrollToMessage('${msg.reply_to.id}')">
      <span class="msg-reply-icon">↩</span>
      <span class="msg-reply-author">${escInline(msg.reply_to.author_name)}</span>
      <span class="msg-reply-content">${escInline(msg.reply_to.content)}</span>
    </div>`;
  }

  // Attachments
  let attachmentsHtml = '';
  if (msg.attachments?.length) {
    attachmentsHtml = msg.attachments.map(att => {
      if (att.mime_type.startsWith('image/')) {
        return `<div class="msg-attachment"><img src="/uploads/${escInline(att.filename)}" alt="${escInline(att.original_name)}" onclick="openImageViewer(this.src)" loading="lazy"></div>`;
      }
      if (att.mime_type.startsWith('video/')) {
        return `<div class="msg-attachment"><video src="/uploads/${escInline(att.filename)}" controls preload="metadata" style="max-width:400px;max-height:300px;border-radius:var(--radius)"></video></div>`;
      }
      return `<div class="msg-attachment"><a class="msg-file-attachment" href="/uploads/${escInline(att.filename)}" target="_blank" download="${escInline(att.original_name)}">📎 ${escInline(att.original_name)} <span class="text-muted text-sm">${formatSize(att.size)}</span></a></div>`;
    }).join('');
  }

  // Reactions
  const reactionsHtml = renderReactions(msg);

  // Floating action toolbar
  const msgIdSafe = msg.id;
  const authorNameEsc = authorName.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const contentPreview = (msg.content || '').slice(0, 80).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const toolbar = `<div class="msg-toolbar">
    <button class="msg-toolbar-btn" title="React" onclick="openEmojiPicker(event, '${msgIdSafe}')">😊</button>
    <button class="msg-toolbar-btn" title="Reply" onclick="setReply('${msgIdSafe}', '${authorNameEsc}', '${contentPreview}')">↩</button>
    ${canEdit ? `<button class="msg-toolbar-btn" title="Edit" onclick="editMessage('${msgIdSafe}')">✎</button>` : ''}
    ${canDelete ? `<button class="msg-toolbar-btn danger" title="Delete" onclick="deleteMessage('${msgIdSafe}')">🗑</button>` : ''}
  </div>`;

  el.innerHTML = `
    ${toolbar}
    <div class="msg-avatar-col">${!continued ? avatar(msg.author, 'avatar-sm') : `<span class="msg-time-hover">${formatTimeShort(msg.created_at)}</span>`}</div>
    <div class="msg-body">
      ${replyHtml}
      ${!continued ? `<div class="msg-header">
        <span class="msg-author" style="color:${authorColor}">${escInline(authorName)}</span>
        <span class="msg-timestamp">${formatTime(msg.created_at)}</span>
        ${msg.edited_at ? '<span class="msg-edited">(edited)</span>' : ''}
      </div>` : ''}
      <div class="msg-content">${renderContent(msg.content)}</div>
      ${attachmentsHtml}
      ${reactionsHtml}
    </div>
  `;

  // Async: inject link preview cards for any URLs found during render
  requestAnimationFrame(() => scheduleLinePreviews(el));

  return el;
}

// ─── LINK PREVIEWS ────────────────────────────────────────────────────────────
const _previewCache = new Map(); // url → preview data (or null if failed/not interesting)
const _previewInFlight = new Map(); // url → Promise

// Media extensions we skip previews for
const SKIP_PREVIEW_EXTS = /\.(png|jpe?g|gif|webp|svg|mp4|webm|ogg|mp3|wav|pdf|zip|tar|gz)(\?.*)?$/i;

async function fetchLinkPreview(url) {
  if (_previewCache.has(url)) return _previewCache.get(url);
  if (_previewInFlight.has(url)) return _previewInFlight.get(url);

  const promise = api.get(`/api/link-preview?url=${encodeURIComponent(url)}`)
    .then(data => {
      // Only store if it has meaningful content
      const result = (data.title || data.description) ? data : null;
      _previewCache.set(url, result);
      _previewInFlight.delete(url);
      return result;
    })
    .catch(() => {
      _previewCache.set(url, null);
      _previewInFlight.delete(url);
      return null;
    });

  _previewInFlight.set(url, promise);
  return promise;
}

function scheduleLinePreviews(msgEl) {
  const trigger = msgEl.querySelector('.link-preview-trigger');
  if (!trigger) return;
  const urls = trigger.dataset.urls?.split('|').filter(Boolean) || [];
  if (!urls.length) return;

  // Only preview the first URL unless message is basically just a URL
  const body = msgEl.querySelector('.msg-body');
  if (!body) return;

  // Try each URL in order; use first one that yields a useful preview
  tryNextPreview(urls, 0, body);
}

async function tryNextPreview(urls, idx, body) {
  if (idx >= urls.length) return;
  const url = urls[idx];

  // Skip media/document URLs immediately
  if (SKIP_PREVIEW_EXTS.test(url)) {
    tryNextPreview(urls, idx + 1, body);
    return;
  }

  const data = await fetchLinkPreview(url);
  if (!data || (!data.title && !data.description)) {
    // Nothing useful — try next URL
    tryNextPreview(urls, idx + 1, body);
    return;
  }

  // Don't add if message element was removed from DOM
  if (!document.body.contains(body)) return;

  // Remove any existing preview for this message
  body.querySelector('.link-preview-card')?.remove();

  const card = buildPreviewCard(data);
  // Insert before reactions (if any), else append
  const reactions = body.querySelector('.msg-reactions');
  if (reactions) {
    body.insertBefore(card, reactions);
  } else {
    body.appendChild(card);
  }
}

function buildPreviewCard(data) {
  const card = document.createElement('a');
  card.className = 'link-preview-card';
  card.href = data.url;
  card.target = '_blank';
  card.rel = 'noopener';

  const hasImage = data.image && !data.image.includes('favicon');
  const siteLine = data.site_name ? `<span class="lp-site">${escInline(data.site_name)}</span>` : '';

  // Favicon
  const faviconHtml = data.favicon
    ? `<img class="lp-favicon" src="${escInline(data.favicon)}" alt="" onerror="this.style.display='none'">`
    : '';

  card.innerHTML = `
    <div class="lp-content">
      <div class="lp-meta">${faviconHtml}${siteLine}</div>
      ${data.title ? `<div class="lp-title">${escInline(data.title)}</div>` : ''}
      ${data.description ? `<div class="lp-desc">${escInline(data.description)}</div>` : ''}
      <div class="lp-url">${escInline(data.url.replace(/^https?:\/\//, '').slice(0, 60))}</div>
    </div>
    ${hasImage ? `<div class="lp-image"><img src="${escInline(data.image)}" alt="" loading="lazy" onerror="this.closest('.lp-image').remove()"></div>` : ''}
  `;

  return card;
}

// Safe inline escaping for use inside HTML attributes within template literals
function escInline(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// Escape for use in a double-quoted HTML attribute (lighter version)
function escAttr(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/"/g,'&quot;');
}

function renderReactions(msg) {
  if (!msg.reactions?.length) return '';
  const btns = msg.reactions.map(r => {
    const reacted = r.user_ids?.includes(App.user?.id);
    const names = (r.user_ids || []).map(uid => App.members.find(m => m.id === uid)?.username || 'Unknown').join(', ');
    return `<button class="reaction-btn${reacted ? ' reacted' : ''}" 
      onclick="toggleReaction('${msg.id}', '${escInline(r.emoji)}')" 
      title="${escInline(names)}">
      ${r.emoji} <span>${r.count}</span>
    </button>`;
  }).join('');
  return `<div class="msg-reactions">${btns}<button class="reaction-add-btn" title="Add reaction" onclick="openEmojiPicker(event, '${msg.id}')">+</button></div>`;
}

function updateReactionsInDOM(messageId, reactions) {
  const channelId = App.currentChannel?.id;
  if (channelId && App.messages[channelId]) {
    const msg = App.messages[channelId].find(m => m.id === messageId);
    if (msg) msg.reactions = reactions;
  }
  const el = document.querySelector(`[data-message-id="${messageId}"]`);
  if (!el) return;
  const msgs = App.messages[App.currentChannel?.id] || [];
  const msg = msgs.find(m => m.id === messageId);
  if (!msg) return;
  const existing = el.querySelector('.msg-reactions');
  const html = renderReactions(msg);
  if (existing) {
    existing.outerHTML = html || '<span></span>';
  } else {
    const body = el.querySelector('.msg-body');
    if (body && html) body.insertAdjacentHTML('beforeend', html);
  }
}

function formatTimeShort(dateStr) {
  return new Date(dateStr).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function scrollToMessage(id) {
  const el = document.querySelector(`[data-message-id="${id}"]`);
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('msg-highlight');
    setTimeout(() => el.classList.remove('msg-highlight'), 1500);
  }
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

  const replyToId = App.replyTo?.id || null;
  clearReply();

  try {
    const body = { content, reply_to_id: replyToId };
    if (pendingUpload) {
      body.attachments = [pendingUpload.id];
      clearUploadPreview();
    }
    await api.post(`/api/channels/${App.currentChannel.id}/messages`, body);
  } catch (e) {
    toast(e.message, 'error');
    input.value = content;
  }
}

// ─── REPLY ────────────────────────────────────────────────────────────────────
function setReply(msgId, authorName, contentPreview) {
  App.replyTo = { id: msgId, authorName, content: contentPreview };
  const bar = document.getElementById('reply-bar');
  bar.style.display = 'flex';
  bar.querySelector('.reply-bar-author').textContent = authorName;
  bar.querySelector('.reply-bar-content').textContent = contentPreview || 'Click to jump to message';
  document.getElementById('message-input').focus();
}

function clearReply() {
  App.replyTo = null;
  const bar = document.getElementById('reply-bar');
  if (bar) bar.style.display = 'none';
}

// ─── REACTIONS ────────────────────────────────────────────────────────────────
async function toggleReaction(messageId, emoji) {
  const msg = (App.messages[App.currentChannel?.id] || []).find(m => m.id === messageId);
  const reaction = msg?.reactions?.find(r => r.emoji === emoji);
  const alreadyReacted = reaction?.user_ids?.includes(App.user?.id);

  try {
    if (alreadyReacted) {
      await api.del(`/api/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`);
    } else {
      await api.post(`/api/messages/${messageId}/reactions`, { emoji });
    }
  } catch (e) {
    toast(e.message, 'error');
  }
}

// ─── EMOJI PICKER ─────────────────────────────────────────────────────────────
// ─── EMOJI SYSTEM ────────────────────────────────────────────────────────────
// EMOJI_DATA and EMOJI_CATEGORY_ICONS are loaded from emoji-data.js
// App.customEmojis is populated on init and updated via WS

let activeEmojiPickerMsgId = null;  // null = input mode, string = reaction mode
let activeEmojiPickerEl = null;
let emojiPickerMode = 'input'; // 'input' | 'reaction'

function buildEmojiPicker(mode, targetMsgId) {
  closeEmojiPicker();
  emojiPickerMode = mode;
  activeEmojiPickerMsgId = targetMsgId || null;

  const picker = document.createElement('div');
  picker.id = 'emoji-picker';
  picker.className = 'emoji-picker';

  // Build category list: Custom first (if any), then standard
  const customEmojis = App.customEmojis || [];
  const categories = [];
  if (customEmojis.length > 0) {
    categories.push({ key: 'Custom', emojis: null, custom: true });
  }
  Object.keys(EMOJI_DATA).forEach(cat => categories.push({ key: cat, emojis: EMOJI_DATA[cat], custom: false }));

  const activeKey = categories[0]?.key || 'Smileys & Emotion';

  // Tab bar
  const tabBar = document.createElement('div');
  tabBar.className = 'emoji-picker-tabs';
  tabBar.innerHTML = categories.map((cat, i) => {
    const icon = cat.custom ? '⭐' : (EMOJI_CATEGORY_ICONS[cat.key] || cat.key[0]);
    return `<button class="emoji-tab${i===0?' active':''}" data-cat="${cat.key}" 
      title="${cat.key}"
      onclick="event.stopPropagation(); switchEmojiTab(this)">${icon}</button>`;
  }).join('');
  picker.appendChild(tabBar);

  // Search box
  const searchWrap = document.createElement('div');
  searchWrap.className = 'emoji-search-wrap';
  searchWrap.innerHTML = `<input type="text" class="emoji-search" placeholder="Search emojis…" oninput="filterEmojis(this.value)" onclick="event.stopPropagation()">`;
  picker.appendChild(searchWrap);

  // Body panels
  const body = document.createElement('div');
  body.className = 'emoji-picker-body';

  categories.forEach((cat, i) => {
    const panel = document.createElement('div');
    panel.className = `emoji-category${i===0?' active':''}`;
    panel.dataset.cat = cat.key;

    if (cat.custom) {
      // Custom emoji grid with image thumbnails
      panel.innerHTML = customEmojis.map(e =>
        `<button class="emoji-btn emoji-btn-custom" onclick="event.stopPropagation(); selectEmoji(':${e.name}:');" title=":${e.name}:">
          <img src="/uploads/${e.filename}" alt="${e.name}">
          <span>${e.name}</span>
        </button>`
      ).join('');
    } else {
      panel.innerHTML = cat.emojis.map(e =>
        `<button class="emoji-btn" onclick="event.stopPropagation(); selectEmoji('${e}');" title="${e}">${e}</button>`
      ).join('');
    }

    body.appendChild(panel);
  });

  // Search results panel (hidden by default)
  const searchPanel = document.createElement('div');
  searchPanel.className = 'emoji-category';
  searchPanel.id = 'emoji-search-results';
  searchPanel.style.display = 'none';
  body.appendChild(searchPanel);

  picker.appendChild(body);
  document.body.appendChild(picker);
  activeEmojiPickerEl = picker;

  setTimeout(() => document.addEventListener('click', closeEmojiPicker, { once: true }), 10);
  return picker;
}

function openEmojiPicker(event, messageId) {
  event.stopPropagation();
  const picker = buildEmojiPicker('reaction', messageId);
  positionPicker(picker, event.currentTarget, false);
}

function openInputEmojiPicker(event) {
  event.stopPropagation();
  const picker = buildEmojiPicker('input', null);
  positionPicker(picker, event.currentTarget, true);
}

function positionPicker(picker, anchor, preferLeft) {
  const rect = anchor.getBoundingClientRect();
  const pickerW = 300, pickerH = 300;
  let top = rect.top - pickerH - 8;
  let left = preferLeft ? rect.right - pickerW : rect.left;
  if (top < 8) top = rect.bottom + 8;
  if (left + pickerW > window.innerWidth - 8) left = window.innerWidth - pickerW - 8;
  if (left < 8) left = 8;
  picker.style.top = `${top}px`;
  picker.style.left = `${left}px`;
}

function switchEmojiTab(btn) {
  const cat = btn.dataset.cat;
  document.querySelectorAll('.emoji-tab').forEach(t => t.classList.toggle('active', t === btn));
  document.querySelectorAll('.emoji-category').forEach(c => {
    if (c.id === 'emoji-search-results') { c.style.display = 'none'; return; }
    c.classList.toggle('active', c.dataset.cat === cat);
  });
  // Clear search when switching tabs
  const searchEl = document.querySelector('.emoji-search');
  if (searchEl) { searchEl.value = ''; }
}

function filterEmojis(query) {
  const resultsPanel = document.getElementById('emoji-search-results');
  if (!resultsPanel) return;

  if (!query.trim()) {
    resultsPanel.style.display = 'none';
    resultsPanel.innerHTML = '';
    // Re-show active category
    document.querySelectorAll('.emoji-category:not(#emoji-search-results)').forEach(c => {
      c.classList.toggle('active', c.classList.contains('active') || false);
    });
    // Restore proper active state
    const activeTab = document.querySelector('.emoji-tab.active');
    if (activeTab) switchEmojiTab(activeTab);
    return;
  }

  // Hide all category panels
  document.querySelectorAll('.emoji-category:not(#emoji-search-results)').forEach(c => c.classList.remove('active'));

  // Search standard emojis
  const q = query.toLowerCase();
  const hits = [];

  // Custom emojis matching name
  (App.customEmojis || []).forEach(e => {
    if (e.name.includes(q)) {
      hits.push(`<button class="emoji-btn emoji-btn-custom" onclick="event.stopPropagation(); selectEmoji(':${e.name}:');" title=":${e.name}:">
        <img src="/uploads/${e.filename}" alt="${e.name}"><span>${e.name}</span></button>`);
    }
  });

  // Shortcode search
  Object.entries(EMOJI_SHORTCODES).forEach(([name, emoji]) => {
    if (name.includes(q)) {
      hits.push(`<button class="emoji-btn" onclick="event.stopPropagation(); selectEmoji('${emoji}');" title=":${name}: ${emoji}">${emoji}</button>`);
    }
  });

  // Search all standard emoji categories (just emit first 60 hits)
  let count = hits.length;
  for (const [, emojis] of Object.entries(EMOJI_DATA)) {
    if (count >= 80) break;
    for (const e of emojis) {
      // We can only search by character itself since we have no name index — skip
    }
  }

  resultsPanel.style.display = 'flex';
  resultsPanel.style.flexWrap = 'wrap';
  resultsPanel.style.gap = '1px';
  resultsPanel.style.padding = '6px';
  resultsPanel.style.maxHeight = '220px';
  resultsPanel.style.overflowY = 'auto';
  resultsPanel.innerHTML = hits.length
    ? hits.join('')
    : '<span style="color:var(--text-muted);font-size:13px;padding:12px">No results</span>';
}

async function selectEmoji(emoji) {
  // emoji is either a unicode char or ':name:' for custom
  if (emojiPickerMode === 'reaction' && activeEmojiPickerMsgId) {
    closeEmojiPicker();
    await toggleReaction(activeEmojiPickerMsgId, emoji);
    activeEmojiPickerMsgId = null;
  } else {
    closeEmojiPicker();
    insertEmoji(emoji);
  }
}

function closeEmojiPicker() {
  if (activeEmojiPickerEl) {
    activeEmojiPickerEl.remove();
    activeEmojiPickerEl = null;
  }
}

function insertEmoji(emoji) {
  const input = document.getElementById('message-input');
  const start = input.selectionStart;
  const end = input.selectionEnd;
  const val = input.value;
  input.value = val.slice(0, start) + emoji + val.slice(end);
  input.selectionStart = input.selectionEnd = start + emoji.length;
  input.focus();
  resizeInput(input);
}
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

    // Get prev BEFORE push — slice(-2)[0] after push would return msg itself when array was empty
    const prev = App.messages[channelId].at(-1);
    App.messages[channelId].push(msg);

    if (App.currentChannel?.id === channelId) {
      const nearBottom = isNearBottom();
      const list = document.getElementById('messages-list');
      const ts     = new Date(msg.created_at).getTime();
      const prevTs = prev ? new Date(prev.created_at).getTime() : 0;
      const continued = !!prev && prev.user_id === msg.user_id && ts - prevTs < 5 * 60 * 1000;
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

  WS.on('reaction.update', ({ message_id, channel_id, reactions }) => {
    if (App.messages[channel_id]) {
      const msg = App.messages[channel_id].find(m => m.id === message_id);
      if (msg) msg.reactions = reactions;
    }
    if (App.currentChannel?.id === channel_id) {
      updateReactionsInDOM(message_id, reactions);
    }
  });

  WS.on('emoji.new', (emoji) => {
    if (!App.customEmojis.find(e => e.id === emoji.id)) {
      App.customEmojis.push(emoji);
    }
  });

  WS.on('emoji.delete', ({ id }) => {
    App.customEmojis = App.customEmojis.filter(e => e.id !== id);
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

  // ── Voice participant tracking (for sidebar counts) ──────────────────────
  WS.on('voice.joined', ({ channel_id, user_id }) => {
    if (!App.voiceParticipants[channel_id]) App.voiceParticipants[channel_id] = new Set();
    App.voiceParticipants[channel_id].add(user_id);
    renderChannelList();
  });

  WS.on('voice.left', ({ channel_id, user_id }) => {
    if (App.voiceParticipants[channel_id]) {
      App.voiceParticipants[channel_id].delete(user_id);
      if (App.voiceParticipants[channel_id].size === 0) {
        delete App.voiceParticipants[channel_id];
      }
    }
    renderChannelList();
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
  await renderAdminEmojis();
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
    <div class="form-group">
      <label>Channel Type</label>
      <select id="new-ch-type" style="width:100%;padding:8px 10px;background:var(--bg-input);color:var(--text-primary);border:1px solid var(--border-strong);border-radius:var(--radius-sm);font-family:inherit;font-size:14px">
        <option value="text">💬 Text Channel</option>
        <option value="voice">🔊 Voice Channel</option>
      </select>
    </div>
  `;
  showSimpleModal('Create Channel', form, async () => {
    const name = document.getElementById('new-ch-name').value.trim();
    if (!name) { toast('Name required', 'error'); return false; }
    const type = document.getElementById('new-ch-type').value;
    await api.post('/api/channels', { name, description: document.getElementById('new-ch-desc').value, type });
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

async function renderAdminEmojis() {
  const el = document.getElementById('admin-emojis-list');
  if (!el) return;

  const emojis = await api.get('/api/emojis').catch(() => []);
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
          <td><img src="/uploads/${esc(e.filename)}" style="width:32px;height:32px;object-fit:contain;border-radius:4px"></td>
          <td><code style="font-family:'Space Mono',monospace;font-size:13px">:${esc(e.name)}:</code></td>
          <td>${esc(e.uploader?.username || 'Unknown')}</td>
          <td><button class="btn btn-sm btn-danger" onclick="adminDeleteEmoji('${e.id}','${esc(e.name)}')">Delete</button></td>
        </tr>`).join('')}
      </tbody>
    </table>` : '<p class="text-muted" style="font-size:13px">No custom emojis yet. Upload some!</p>'}
  `;
}

let pendingEmojiFile = null;
function adminUploadEmojiSelect(input) {
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
  // Auto-fill name from filename
  const nameInput = document.getElementById('emoji-upload-name');
  if (nameInput && !nameInput.value) {
    const stem = file.name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase().slice(0, 32);
    nameInput.value = stem;
  }
}

async function adminDoUploadEmoji() {
  if (!pendingEmojiFile) { toast('No file selected', 'error'); return; }
  const name = document.getElementById('emoji-upload-name')?.value?.trim().toLowerCase();
  if (!name) { toast('Name required', 'error'); return; }

  const formData = new FormData();
  formData.append('image', pendingEmojiFile);
  formData.append('name', name);

  try {
    const res = await fetch('/api/emojis', { method: 'POST', credentials: 'include', body: formData });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    toast(`Emoji :${name}: uploaded!`, 'success');
    pendingEmojiFile = null;
    await renderAdminEmojis();
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function adminDeleteEmoji(id, name) {
  if (!confirm(`Delete emoji :${name}:? It will stop rendering in messages.`)) return;
  try {
    await api.del(`/api/emojis/${id}`);
    toast(`Emoji :${name}: deleted`, 'success');
    await renderAdminEmojis();
  } catch (e) { toast(e.message, 'error'); }
}

// ─── ADMIN TAB SWITCHING ──────────────────────────────────────────────────────
function switchAdminTab(tab) {
  document.querySelectorAll('.admin-tab').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.admin-pane').forEach(el => el.classList.remove('active'));
  document.querySelector(`.admin-tab[data-tab="${tab}"]`).classList.add('active');
  document.getElementById(`admin-pane-${tab}`).classList.add('active');
  if (tab === 'emojis') renderAdminEmojis();
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
// Uses visualViewport API (when available) which correctly reports height
// EXCLUDING the soft keyboard on Android/iOS — window.innerHeight often does not.
function fixViewportHeight() {
  const h = window.visualViewport ? window.visualViewport.height : window.innerHeight;
  const app = document.getElementById('app');
  if (app) app.style.height = h + 'px';

  // When keyboard is up, also ensure messages scroll to keep the last message visible
  if (isNearBottom && isNearBottom()) scrollToBottom();
}

if (window.visualViewport) {
  // visualViewport fires on keyboard open/close AND orientation change
  window.visualViewport.addEventListener('resize', fixViewportHeight);
  window.visualViewport.addEventListener('scroll', fixViewportHeight);
} else {
  // Fallback for browsers without visualViewport
  window.addEventListener('resize', fixViewportHeight);
}
window.addEventListener('orientationchange', () => setTimeout(fixViewportHeight, 200));

// Run before DOMContentLoaded so height is set before first paint
fixViewportHeight();
document.addEventListener('DOMContentLoaded', fixViewportHeight);

// ─── BOOT ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  init();

  // Message form
  const input = document.getElementById('message-input');
  input.addEventListener('keydown', onInputKeydown);
  input.addEventListener('input', () => resizeInput(input));

  // On mobile: when keyboard opens (input focus), scroll to bottom so
  // messages aren't hidden behind keyboard while input is revealed
  input.addEventListener('focus', () => {
    // Small delay lets the keyboard fully open and visualViewport update
    setTimeout(() => {
      fixViewportHeight();
      scrollToBottom(true);
    }, 300);
  });

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
