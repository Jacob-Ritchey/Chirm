// app.js — Chirm main application (boot, coordinator, WS handlers)

import App, { persistUnread as _persistUnread, saveLastChannel as _saveLastChannel, loadLastChannel as _loadLastChannel } from './state.js';
import { api } from './api.js';
import WS from './ws.js';
import ChirmCache from './cache.js';
import { EMOJI_CATEGORY_ICONS, EMOJI_DATA, EMOJI_SHORTCODES } from './emoji-data.js';
import ChirmSettings from './user-settings.js';
import ChirmNotifs from './notifications.js';
import ChirmMentions from './mentions.js';
import Voice from './voice.js';
import ChirmTheme from './theme.js';

// Apply user theme immediately (localStorage, synchronous — no flash on load)
ChirmTheme.loadUserTheme();

// ─── RENDER / UTILITY MODULES ─────────────────────────────────────────────────
import { toast, avatar, stringToColor, esc, escInline, escAttr, formatTime, formatSize, formatTimeShort, renderContent, isAdmin, resizeInput } from './utils.js';
import { loadMembers, renderUserPanel, renderMembersList, openStatusPicker, setMyStatus } from './render/members.js';
import { openModal, closeModal, showSimpleModal, openProfile, clearAvatar, viewUserProfile } from './render/modals.js';
import { handleFileUpload, showUploadPreview, clearUploadPreview, openImageViewer } from './render/media.js';
import {
  renderMessages, renderMessage, renderReactions, updateReactionsInDOM,
  scrollToBottom, isNearBottom, scrollToMessage, loadMoreMessages,
  sendMessage, setReply, clearReply, toggleReaction,
  buildEmojiPicker, openEmojiPicker, openInputEmojiPicker, positionPicker,
  switchEmojiTab, filterEmojis, selectEmoji, closeEmojiPicker, insertEmoji,
  editMessage, deleteMessage,
  onInputKeydown, updateTypingIndicator,
} from './render/messages.js';
import {
  openAdmin, loadAdminUsers, renderAdminUsers, renderAdminRoles, renderAdminInvites,
  renderAdminSettings, renderAdminEmojis, uploadServerIcon, clearServerIcon,
  uploadLoginBg, clearLoginBg, saveSettings,
  adminDeleteUser, adminDeleteRole, adminDeleteInvite, createInvite, copyInvite,
  openCreateRole, openEditRole, openAssignRole,
  adminUploadEmojiSelect, adminDoUploadEmoji, adminDeleteEmoji,
  switchAdminTab,
  renderAdminTheme, saveAdminTheme, clearAdminTheme, applyAdminThemePreset,
  deleteAdminThemePreset, saveAdminLocalPreset,
} from './render/admin.js';
import {
  loadChannels, renderServerHeader, toggleServerInfo, openServerRules,
  renderChannelList, toggleCategory, toggleChannelEditMode,
  moveChannelToCategory, onCategoryDrop,
  openChannelEmojiPicker, clearChannelEmoji,
  openCreateChannel, openEditChannel, confirmDeleteChannel,
  openCreateCategory, openEditCategory, confirmDeleteCategory,
} from './render/sidebar.js';

// ─── DATA LOADING ─────────────────────────────────────────────────────────────

async function loadRoles() {
  const page = await api.get('/api/v1/roles').catch(() => null);
  App.roles = page ? (page.items ?? page) : [];
}

async function loadVoiceRooms() {
  const data = await api.get('/api/v1/voice/rooms').catch(() => null);
  if (!data || !data.rooms) return;
  App.voiceParticipants = {};
  for (const [channelId, userIds] of Object.entries(data.rooms)) {
    App.voiceParticipants[channelId] = new Set(userIds);
  }
}

async function loadCustomEmojis() {
  App.customEmojis = await api.get('/api/v1/emojis').catch(() => []);
}

async function loadPublicSettings() {
  const s = await api.get('/api/v1/public-settings').catch(() => null);
  if (s) App.publicSettings = s;
}

// ─── STRUCTURE CACHE — server name/icon + channel list ────────────────────────
// Persists across page loads so renderServerHeader/renderChannelList can show
// real content immediately before the API calls finish.

const _STRUCT_KEY = 'chirm_struct';

function _saveStructCache() {
  try {
    localStorage.setItem(_STRUCT_KEY, JSON.stringify({
      s: App.publicSettings,
      ch: App.channels,
      cat: App.categories,
    }));
  } catch {}
}

function _loadStructCache() {
  try { return JSON.parse(localStorage.getItem(_STRUCT_KEY) || 'null'); } catch { return null; }
}

// ─── INIT ─────────────────────────────────────────────────────────────────────
async function init() {
  const status = await api.get('/api/v1/setup/status').catch(() => null);
  if (status?.setup_done === false) {
    window.location.href = '/setup';
    return;
  }

  App.user = await api.get('/api/v1/me').catch(() => null);
  if (!App.user) {
    window.location.href = '/login';
    return;
  }

  await Promise.all([loadChannels(), loadMembers(), loadRoles(), loadVoiceRooms(), loadCustomEmojis(), loadPublicSettings()]);

  // Persist fresh structural data for next page-load instant render
  _saveStructCache();

  // Apply server theme, then user overrides (before first paint of UI)
  ChirmTheme.loadServerTheme(App.publicSettings);
  ChirmTheme.loadUserTheme();

  renderServerHeader();
  renderChannelList();
  renderUserPanel();
  renderMembersList();

  WS.connect();
  setupWSHandlers();
  Voice.init();

  const msgInput = document.getElementById('message-input');
  if (msgInput) ChirmMentions.init(msgInput);

  const lastChannelId = _loadLastChannel();
  const lastChannel   = lastChannelId ? App.channels.find(c => c.id === lastChannelId && c.type !== 'voice') : null;
  const firstText     = App.channels.find(c => c.type !== 'voice') || App.channels[0];
  const channelToOpen = lastChannel || firstText;
  if (channelToOpen) {
    openChannel(channelToOpen);
  }

  if (isAdmin(App.user)) {
    document.getElementById('admin-btn').style.display = 'block';
  }

  setTimeout(async () => {
    if (Notification.permission === 'default') {
      const t = document.createElement('div');
      t.className = 'toast info';
      t.innerHTML = '🔔 <strong>Enable notifications?</strong> <button onclick="ChirmNotifs.requestPermission().then(r=>{if(r===\'granted\'){toast(\'Notifications enabled!\',\'success\');}else{toast(\'Blocked — you can enable later in ⚙ settings\',\'info\');}renderUserPanel();this.closest(\'.toast\').remove()})" style="margin-left:8px;padding:2px 8px;border-radius:4px;border:none;background:var(--accent);color:white;cursor:pointer;font-size:12px">Enable</button>';
      t.style.cssText += 'max-width:340px;cursor:default';
      document.getElementById('toast-container')?.appendChild(t);
      setTimeout(() => t.remove?.(), 14000);
    }
  }, 3000);
}

// ─── CHANNELS ─────────────────────────────────────────────────────────────────
async function openChannel(ch) {
  // ── Voice channel ──────────────────────────────────────────────────────
  if (ch.type === 'voice') {
    if (Voice.isInChannel(ch.id)) {
      Voice.showFullView();
      if (PanelMgr.isMobile()) PanelMgr.close('channels');
    } else {
      document.getElementById('ch-title').textContent = ch.name;
      document.getElementById('ch-desc').textContent = ch.description || 'Voice Channel';
      document.getElementById('main').classList.remove('split-voice');

      const joined = await Voice.join(ch.id);

      if (joined) {
        if (!App.voiceParticipants[ch.id]) App.voiceParticipants[ch.id] = new Set();
        App.voiceParticipants[ch.id].add(App.user.id);
      }
    }
    renderChannelList();
    return;
  }

  // ── Text channel ───────────────────────────────────────────────────────
  document.getElementById('messages-container').style.display = '';
  document.getElementById('message-input-area').style.display = '';
  document.getElementById('typing-indicator').style.display = '';

  const main = document.getElementById('main');
  const voicePanel = document.getElementById('voice-panel');
  if (Voice.inCall()) {
    main.classList.add('split-voice');
    voicePanel.style.display = 'flex';
    voicePanel.classList.remove('vc-panel-collapsed');
    const colBtn = document.getElementById('vp-collapse-btn');
    if (colBtn) { colBtn.textContent = '▼'; colBtn.title = 'Collapse voice panel'; }
  } else {
    main.classList.remove('split-voice');
  }

  App.currentChannel = ch;
  App.unread.delete(ch.id);
  _persistUnread();
  _saveLastChannel(ch.id);

  if (PanelMgr.isMobile()) PanelMgr.close('channels');

  document.querySelectorAll('.channel-item').forEach(el => {
    const id = el.dataset.channelId;
    el.classList.toggle('active', id === ch.id);
    if (id === ch.id) el.classList.remove('unread');
  });

  const isMuted = typeof ChirmSettings !== 'undefined' && ChirmSettings.isChannelMuted(ch.id);
  document.getElementById('ch-title').textContent = (isMuted ? '🔕 ' : '') + ch.name;
  document.getElementById('ch-desc').textContent = ch.description || '';
  document.getElementById('message-input').placeholder = `Message #${ch.name}`;

  WS.subscribe(ch.id);

  const channelId = ch.id;
  if (!App.messages[channelId]) App.messages[channelId] = [];
  renderMessages(channelId);

  const cached = typeof ChirmCache !== 'undefined' ? ChirmCache.get(channelId) : null;

  if (cached && cached.messages.length > 0) {
    App.messages[channelId] = [...cached.messages];
    renderMessages(channelId);
    scrollToBottom(true);
  }

  api.get(`/api/v1/channels/${channelId}/messages`).catch(() => ({ messages: [], has_more: false })).then(data => {
    if (App.currentChannel?.id !== channelId) return;

    const freshMsgList = (Array.isArray(data) ? data : (data.messages ?? []));
    App.messagesHasMore[channelId] = Array.isArray(data) ? false : (data.has_more ?? false);

    const freshIds = new Set(freshMsgList.map(m => m.id));
    const wsOnlyMsgs = (App.messages[channelId] || []).filter(m => !freshIds.has(m.id));
    const merged = [...freshMsgList, ...wsOnlyMsgs].sort(
      (a, b) => new Date(a.created_at) - new Date(b.created_at)
    );

    App.messages[channelId] = merged;
    if (typeof ChirmCache !== 'undefined') ChirmCache.set(channelId, merged);

    const cachedCount = cached?.messages?.length ?? 0;
    if (merged.length !== cachedCount || wsOnlyMsgs.length > 0 || !cached) {
      renderMessages(channelId);
      scrollToBottom(true);
    }
  });
}

// ─── WEBSOCKET HANDLERS ───────────────────────────────────────────────────────
function setupWSHandlers() {
  WS.on('message.activity', (data) => {
    if (!data || !data.channel_id) return;
    const channelId = data.channel_id;
    if (App.currentChannel?.id === channelId) return;

    const isMuted = typeof ChirmSettings !== 'undefined' && ChirmSettings.isChannelMuted(channelId);

    if (!isMuted) {
      App.unread.add(channelId);
      _persistUnread();
      const el = document.querySelector(`[data-channel-id="${channelId}"]`);
      if (el) el.classList.add('unread');
    }

    if (data.author_id && data.author_id === App.user?.id) return;
    if (typeof ChirmNotifs === 'undefined') return;

    const syntheticMsg = {
      channel_id: channelId,
      user_id:    data.author_id,
      content:    data.preview || '',
      author:     { username: data.author || 'Someone' },
      id:         data.message_id,
    };
    ChirmNotifs.onNewMessage(syntheticMsg, data.channel_name || channelId);
  });

  WS.on('message.new', (msg) => {
    const channelId = msg.channel_id;
    if (!App.messages[channelId]) App.messages[channelId] = [];

    if (App.messages[channelId].find(m => m.id === msg.id)) return;

    const prev = App.messages[channelId].at(-1);
    App.messages[channelId].push(msg);

    if (typeof ChirmCache !== 'undefined') ChirmCache.appendMessage(channelId, msg);

    const isCurrentChannel = App.currentChannel?.id === channelId;
    const pageVisible = document.visibilityState === 'visible';
    const pageHasFocus = document.hasFocus();

    if (isCurrentChannel && pageVisible && pageHasFocus) {
      try {
        const nearBottom = isNearBottom();
        const list = document.getElementById('messages-list');
        const ts = new Date(msg.created_at).getTime();
        const prevTs = prev ? new Date(prev.created_at).getTime() : 0;
        const continued = !!prev && prev.user_id === msg.user_id && ts - prevTs < 5 * 60 * 1000;
        if (list) list.appendChild(renderMessage(msg, continued));
        if (nearBottom) scrollToBottom();
      } catch (err) { console.error('[message.new] render error:', err); }
    } else {
      if (isCurrentChannel) {
        try {
          const nearBottom = isNearBottom();
          const list = document.getElementById('messages-list');
          const ts = new Date(msg.created_at).getTime();
          const prevTs = prev ? new Date(prev.created_at).getTime() : 0;
          const continued = !!prev && prev.user_id === msg.user_id && ts - prevTs < 5 * 60 * 1000;
          if (list) list.appendChild(renderMessage(msg, continued));
          if (nearBottom) scrollToBottom();
        } catch (err) { console.error('[message.new] render error:', err); }
      }

      if (typeof ChirmNotifs !== 'undefined') {
        const ch = App.channels.find(c => c.id === channelId);
        ChirmNotifs.onNewMessage(msg, ch?.name || 'channel');
      }
    }
  });

  WS.on('message.edit', (msg) => {
    const channelId = msg.channel_id;
    if (App.messages[channelId]) {
      const idx = App.messages[channelId].findIndex(m => m.id === msg.id);
      if (idx >= 0) App.messages[channelId][idx] = msg;
    }
    if (typeof ChirmCache !== 'undefined') ChirmCache.updateMessage(channelId, msg);
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
    if (typeof ChirmCache !== 'undefined') ChirmCache.deleteMessage(channel_id, id);
    const el = document.querySelector(`[data-message-id="${id}"]`);
    if (el) el.remove();
  });

  WS.on('reaction.update', ({ message_id, channel_id, reactions }) => {
    if (App.messages[channel_id]) {
      const msg = App.messages[channel_id].find(m => m.id === message_id);
      if (msg) msg.reactions = reactions;
    }
    if (typeof ChirmCache !== 'undefined') ChirmCache.updateReactions(channel_id, message_id, reactions);
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

  WS.on('channels.reorder', (channels) => {
    App.channels = channels;
    renderChannelList();
  });

  WS.on('category.new', (cat) => {
    App.categories.push(cat);
    renderChannelList();
  });

  WS.on('categories.update', (cats) => {
    App.categories = cats;
    renderChannelList();
  });

  WS.on('category.delete', ({ id, channels }) => {
    App.categories = App.categories.filter(c => c.id !== id);
    if (channels) App.channels = channels;
    renderChannelList();
  });

  WS.on('member.new', (member) => {
    if (App.members.find(m => m.id === member.id)) return;
    App.members.push(member);
    renderMembersList();
  });

  WS.on('member.leave', ({ id }) => {
    App.members = App.members.filter(m => m.id !== id);
    renderMembersList();
  });

  WS.on('member.status', ({ id, status }) => {
    const m = App.members.find(m => m.id === id);
    if (m) { m.status = status; renderMembersList(); }
    if (App.user?.id === id) { App.user.status = status; renderUserPanel(); }
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

// ─── LOGOUT ───────────────────────────────────────────────────────────────────
async function logout() {
  if (typeof ChirmNotifs !== 'undefined') {
    await ChirmNotifs.unsubscribePush().catch(() => {});
  }
  await api.post('/api/v1/auth/logout', {});
  window.location.href = '/login';
}

// ─── PANEL MANAGER ────────────────────────────────────────────────────────────
const PanelMgr = (() => {
  let current = null;

  const overlay = () => document.getElementById('sidebar-overlay');
  const main    = () => document.getElementById('main');

  function _showOverlay(onClick) {
    const el = overlay();
    el.classList.add('open');
    el._closeHandler = onClick;
    el.addEventListener('click', onClick, { once: true });
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

  function closeAll() { if (current) close(current); }
  function isOpen(panel) { return current === panel; }
  function isMobile()    { return window.innerWidth <= 768; }
  function isTablet()    { return window.innerWidth <= 1024; }

  return { open, close, closeAll, isOpen, isMobile, isTablet };
})();

function closeAllPanels() { PanelMgr.closeAll(); }

function toggleSidebar(forceClose = false) {
  if (PanelMgr.isMobile()) {
    if (forceClose || PanelMgr.isOpen('channels')) {
      PanelMgr.close('channels');
    } else {
      PanelMgr.open('channels');
    }
  } else {
    const sidebar = document.getElementById('sidebar');
    if (forceClose) {
      sidebar.classList.add('desktop-collapsed');
    } else {
      sidebar.classList.toggle('desktop-collapsed');
    }
    try { localStorage.setItem('chirm_ui_sidebar_hidden', sidebar.classList.contains('desktop-collapsed') ? '1' : '0'); } catch {}
  }
}

function toggleMembers() {
  const panel = document.getElementById('members-sidebar');
  if (PanelMgr.isTablet()) {
    if (PanelMgr.isOpen('members')) {
      PanelMgr.close('members');
    } else {
      PanelMgr.open('members');
    }
  } else {
    panel.classList.toggle('collapsed');
    try { localStorage.setItem('chirm_ui_members', panel.classList.contains('collapsed') ? '1' : '0'); } catch {}
  }
}

// ─── SWIPE TO CLOSE SIDEBARS ──────────────────────────────────────────────────
(function addSwipeListeners() {
  let swipeStartX = 0, swipeStartY = 0;
  const THRESHOLD = 60;
  const ANGLE_MAX = 40;

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
    if (dx < 0 && PanelMgr.isOpen('channels')) PanelMgr.close('channels');
    if (dx > 0 && PanelMgr.isOpen('members')) PanelMgr.close('members');
  }

  document.addEventListener('DOMContentLoaded', () => {
    const sidebar = document.getElementById('sidebar');
    const members = document.getElementById('members-sidebar');
    [sidebar, members].forEach(el => {
      el.addEventListener('touchstart', onTouchStart, { passive: true });
      el.addEventListener('touchend',   onTouchEnd,   { passive: true });
    });
    const ovl = document.getElementById('sidebar-overlay');
    ovl.addEventListener('touchstart', onTouchStart, { passive: true });
    ovl.addEventListener('touchend',   onTouchEnd,   { passive: true });
  });
})();

// ─── VIEWPORT HEIGHT FIX ──────────────────────────────────────────────────────
function fixViewportHeight() {
  const h = window.visualViewport ? window.visualViewport.height : window.innerHeight;
  const app = document.getElementById('app');
  if (app) app.style.height = h + 'px';
  if (isNearBottom && isNearBottom()) scrollToBottom();
}

if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', fixViewportHeight);
  window.visualViewport.addEventListener('scroll', fixViewportHeight);
} else {
  window.addEventListener('resize', fixViewportHeight);
}
window.addEventListener('orientationchange', () => setTimeout(fixViewportHeight, 200));
fixViewportHeight();
document.addEventListener('DOMContentLoaded', fixViewportHeight);

// ─── BOOT ─────────────────────────────────────────────────────────────────────

// Apply stored UI state synchronously before first paint to prevent flash
function applyStoredUIState() {
  // Disable transitions so collapsed elements snap to position instead of animating
  document.documentElement.classList.add('no-transition');

  if (localStorage.getItem('chirm_ui_members') === '1')
    document.getElementById('members-sidebar')?.classList.add('collapsed');

  if (localStorage.getItem('chirm_ui_server_info') === '1') {
    const hdr = document.getElementById('server-header');
    if (hdr) { hdr.classList.remove('server-header-expanded'); hdr.classList.add('server-header-collapsed'); }
    const chev = document.getElementById('server-chevron');
    if (chev) chev.textContent = '▸';
  }

  if (localStorage.getItem('chirm_ui_sidebar_hidden') === '1')
    document.getElementById('sidebar')?.classList.add('desktop-collapsed');

  // Render server name/icon and channel list from cache so content appears
  // immediately instead of blank until the API calls in init() complete
  const _struct = _loadStructCache();
  if (_struct) {
    if (_struct.s)   App.publicSettings = _struct.s;
    if (_struct.ch)  App.channels       = _struct.ch;
    if (_struct.cat) App.categories     = _struct.cat;
    renderServerHeader();
    renderChannelList();
  }

  // Two rAFs: first commits the layout paint, second re-enables transitions
  requestAnimationFrame(() => requestAnimationFrame(() => {
    document.documentElement.classList.remove('no-transition');
  }));
}

document.addEventListener('DOMContentLoaded', () => {
  applyStoredUIState();
  init();

  const input = document.getElementById('message-input');
  input.addEventListener('keydown', onInputKeydown);
  input.addEventListener('input', () => resizeInput(input));
  input.addEventListener('focus', () => {
    setTimeout(() => { fixViewportHeight(); scrollToBottom(true); }, 300);
  });

  const form = document.getElementById('message-form');
  form.addEventListener('submit', (e) => { e.preventDefault(); sendMessage(); });

  const fileInput = document.getElementById('file-input');
  fileInput.addEventListener('change', () => {
    if (fileInput.files[0]) handleFileUpload(fileInput.files[0]);
    fileInput.value = '';
  });

  const mc = document.getElementById('messages-container');
  mc.addEventListener('dragover', (e) => { e.preventDefault(); mc.style.outline = '2px dashed var(--accent)'; });
  mc.addEventListener('dragleave', () => { mc.style.outline = ''; });
  mc.addEventListener('drop', (e) => {
    e.preventDefault();
    mc.style.outline = '';
    const file = e.dataTransfer.files[0];
    if (file) handleFileUpload(file);
  });

  document.getElementById('admin-modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'admin-modal') closeModal('admin-modal');
  });
});

// ─── WINDOW GLOBALS ───────────────────────────────────────────────────────────
// Expose module-scoped names that HTML onclick handlers reference as globals.
window.App            = App;
window.Voice          = Voice;
window.ChirmSettings  = ChirmSettings;
window.ChirmNotifs    = ChirmNotifs;
window.ChirmTheme     = ChirmTheme;

// Utils
window.toast          = toast;
window.esc            = esc;
window.stringToColor  = stringToColor;
window.resizeInput    = resizeInput;

// Coordinator
window.openChannel    = openChannel;
window.logout         = logout;
window.closeAllPanels = closeAllPanels;
window.toggleSidebar  = toggleSidebar;
window.toggleMembers  = toggleMembers;

// Members
window.renderUserPanel   = renderUserPanel;
window.renderMembersList = renderMembersList;
window.openStatusPicker  = openStatusPicker;
window.setMyStatus       = setMyStatus;

// Modals
window.openModal       = openModal;
window.closeModal      = closeModal;
window.showSimpleModal = showSimpleModal;
window.openProfile      = openProfile;
window.clearAvatar      = clearAvatar;
window.viewUserProfile  = viewUserProfile;

// Media
window.openImageViewer    = openImageViewer;
window.clearUploadPreview = clearUploadPreview;

// Messages
window.clearReply           = clearReply;
window.setReply             = setReply;
window.openEmojiPicker      = openEmojiPicker;
window.openInputEmojiPicker = openInputEmojiPicker;
window.editMessage          = editMessage;
window.deleteMessage        = deleteMessage;
window.scrollToMessage      = scrollToMessage;
window.toggleReaction       = toggleReaction;
window.switchEmojiTab       = switchEmojiTab;
window.filterEmojis         = filterEmojis;
window.selectEmoji          = selectEmoji;

// Sidebar
window.renderServerHeader    = renderServerHeader;
window.renderChannelList     = renderChannelList;
window.toggleServerInfo      = toggleServerInfo;
window.openServerRules       = openServerRules;
window.toggleChannelEditMode = toggleChannelEditMode;
window.openCreateCategory    = openCreateCategory;
window.openEditCategory      = openEditCategory;
window.confirmDeleteCategory = confirmDeleteCategory;
window.openCreateChannel     = openCreateChannel;
window.openEditChannel       = openEditChannel;
window.confirmDeleteChannel  = confirmDeleteChannel;
window.openChannelEmojiPicker = openChannelEmojiPicker;
window.clearChannelEmoji     = clearChannelEmoji;

// Admin
window.openAdmin              = openAdmin;
window.switchAdminTab         = switchAdminTab;
window.openAssignRole         = openAssignRole;
window.adminDeleteUser        = adminDeleteUser;
window.openEditRole           = openEditRole;
window.adminDeleteRole        = adminDeleteRole;
window.createInvite           = createInvite;
window.copyInvite             = copyInvite;
window.adminDeleteInvite      = adminDeleteInvite;
window.uploadServerIcon       = uploadServerIcon;
window.clearServerIcon        = clearServerIcon;
window.uploadLoginBg          = uploadLoginBg;
window.clearLoginBg           = clearLoginBg;
window.saveSettings           = saveSettings;
window.adminUploadEmojiSelect = adminUploadEmojiSelect;
window.adminDoUploadEmoji     = adminDoUploadEmoji;
window.adminDeleteEmoji       = adminDeleteEmoji;
window.openCreateRole         = openCreateRole;
window.saveAdminTheme         = saveAdminTheme;
window.clearAdminTheme        = clearAdminTheme;
window.applyAdminThemePreset  = applyAdminThemePreset;
window.deleteAdminThemePreset = deleteAdminThemePreset;
window.saveAdminLocalPreset   = saveAdminLocalPreset;
