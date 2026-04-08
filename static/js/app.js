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
import {
  openThreadPanel, closeThreadPanel, renderThreadMessages,
  appendThreadMessage, removeThreadMessage,
  openStartThreadModal, openThreadById,
  updateThreadChipInDOM, injectThreadChip,
  sendThreadMessage, onThreadInputKeydown,
  renderForumView, renderGalleryView, openCreatePostModal,
  setThreadReply, clearThreadReply, insertThreadEmoji,
  handleThreadUpload, clearThreadUploadPreview,
  prependForumCard, prependGalleryCard,
} from './render/threads.js';

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
let _wsFirstConnectDone = false;

function _saveStructCache() {
  try {
    localStorage.setItem(_STRUCT_KEY, JSON.stringify({
      s: App.publicSettings,
      ch: App.channels,
      cat: App.categories,
      mb: App.members,
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

  // Phase 1 — essential: channels + public settings. This is all we need to
  // render the sidebar and open the last channel with cached messages.
  await Promise.all([loadChannels(), loadPublicSettings()]);

  // Apply server theme, then user overrides (before first paint of UI)
  ChirmTheme.loadServerTheme(App.publicSettings);
  ChirmTheme.loadUserTheme();

  renderServerHeader();
  renderChannelList();
  renderUserPanel();

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

  // Phase 2 — non-essential: load members, roles, emojis, voice in background.
  // Sequential rather than concurrent to avoid bursting the DB with simultaneous
  // writes immediately after page load.
  (async () => {
    try {
      await loadMembers();
      await loadRoles();
      await loadVoiceRooms();
      await loadCustomEmojis();
      renderMembersList();
      _saveStructCache();
    } catch {}
  })();

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

// ─── THREAD BREADCRUMB ────────────────────────────────────────────────────────

function _renderThreadBreadcrumb(currentCh) {
  const bar = document.getElementById('thread-breadcrumb');
  if (!bar) return;
  bar.innerHTML = '';
  bar.classList.remove('hidden');

  (App.threadNavStack || []).forEach((entry, i) => {
    const item = document.createElement('span');
    item.className = 'breadcrumb-item';
    const prefix = (entry.type === 'text' || entry.type === 'forum' || entry.type === 'gallery') ? '#' : '';
    item.textContent = prefix + entry.name;
    item.onclick = () => _navigateToBreadcrumb(i);
    bar.appendChild(item);

    const sep = document.createElement('span');
    sep.className = 'breadcrumb-sep';
    sep.textContent = ' ›';
    bar.appendChild(sep);
  });

  const current = document.createElement('span');
  current.className = 'breadcrumb-current';
  current.textContent = currentCh.name;
  bar.appendChild(current);
}

function _clearThreadBreadcrumb() {
  const bar = document.getElementById('thread-breadcrumb');
  if (bar) bar.classList.add('hidden');
}

async function _navigateToBreadcrumb(index) {
  const entry = App.threadNavStack[index];
  if (!entry) return;
  App.threadNavStack = App.threadNavStack.slice(0, index);
  await openChannel({ id: entry.id, name: entry.name, type: entry.type });
  if (entry.thread) openThreadPanel(entry.thread);
}

// ─── CHANNELS ─────────────────────────────────────────────────────────────────
async function openChannel(ch) {
  // ── Clear thread breadcrumb when leaving thread channels ──────────────
  if (ch.type !== 'thread') {
    App.threadNavStack = [];
    _clearThreadBreadcrumb();
  }

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

  // ── Close thread panel if switching channels ───────────────────────────
  if (App.currentThread && App.currentThread.channel_id !== ch.id) {
    closeThreadPanel();
  }

  // ── Forum / Gallery channels ───────────────────────────────────────────
  if (ch.type === 'forum' || ch.type === 'gallery') {
    if (App.currentChannel?.id === ch.id) return;
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

    document.getElementById('ch-title').textContent = ch.name;
    document.getElementById('ch-desc').textContent = ch.description || '';

    // Remove "New Post" button from a previous forum/gallery channel
    document.querySelector('.new-post-btn')?.remove();

    WS.subscribe(ch.id);

    if (ch.type === 'gallery') {
      await renderGalleryView(ch);
    } else {
      await renderForumView(ch);
    }
    // Retry if render failed and WS was already connected before the fetch ran (Case 2 race)
    if (_wsFirstConnectDone && App.currentChannel?.id === ch.id && document.querySelector('.forum-error')) {
      if (ch.type === 'gallery') renderGalleryView(ch);
      else renderForumView(ch);
      _retryForumIfFailed(ch);
    }
    return;
  }

  // ── Text channel ───────────────────────────────────────────────────────
  if (App.currentChannel?.id === ch.id) return;

  // Restore channel-specific UI that may have been hidden by forum/gallery view
  document.getElementById('message-input-area').style.display = '';
  document.getElementById('typing-indicator').style.display = '';
  // Remove "New Post" button if we're leaving a forum/gallery channel
  document.querySelector('.new-post-btn')?.remove();

  document.getElementById('messages-container').style.display = '';

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

  if (ch.type === 'thread') {
    _renderThreadBreadcrumb(ch);
  }

  const channelId = ch.id;
  if (!App.messages[channelId]) App.messages[channelId] = [];
  renderMessages(channelId);

  const cached = typeof ChirmCache !== 'undefined' ? ChirmCache.get(channelId) : null;

  if (cached && cached.fresh && cached.messages.length > 0) {
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

    const cachedTailIds = (cached?.messages || []).slice(-5).map(m => m.id).join(',');
    const mergedTailIds = merged.slice(-5).map(m => m.id).join(',');
    const needsRerender = !cached || !cached.fresh
      || merged.length !== (cached.messages?.length ?? 0)
      || wsOnlyMsgs.length > 0
      || cachedTailIds !== mergedTailIds;
    if (needsRerender) {
      renderMessages(channelId);
      scrollToBottom(true);
    }
  });
}

// ─── FORUM / GALLERY RESILIENT RETRY ─────────────────────────────────────────
// Schedules a follow-up render attempt after `delay` ms. Guards against transient
// server-side 500s that outlast the initial WS-connected retry.
function _retryForumIfFailed(ch, delay = 3000) {
  setTimeout(() => {
    if (App.currentChannel?.id !== ch.id || !document.querySelector('.forum-error')) return;
    if (ch.type === 'gallery') renderGalleryView(ch);
    else renderForumView(ch);
  }, delay);
}

// ─── WEBSOCKET HANDLERS ───────────────────────────────────────────────────────
function setupWSHandlers() {
  // On reconnect (not the initial connect), refresh structural data and invalidate
  // the message cache — we may have missed channel/settings/message events while down.
  WS.on('ws.connected', async () => {
    if (!_wsFirstConnectDone) {
      _wsFirstConnectDone = true;
      // If the forum/gallery failed to load before WS auth completed, retry now.
      const ch = App.currentChannel;
      if (ch && (ch.type === 'forum' || ch.type === 'gallery') && document.querySelector('.forum-error')) {
        if (ch.type === 'gallery') {
          renderGalleryView(ch);
        } else {
          renderForumView(ch);
        }
        _retryForumIfFailed(ch);
      }
      return;
    }
    ChirmCache.clearAll();
    await Promise.all([loadChannels(), loadPublicSettings(), loadMembers()]).catch(() => {});
    ChirmTheme.loadServerTheme(App.publicSettings);
    renderServerHeader();
    renderChannelList();
    renderMembersList();
    _saveStructCache();
  });

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
    // Route to thread panel if message belongs to the open thread's channel
    if (App.currentThread?.thread_channel_id && msg.channel_id === App.currentThread.thread_channel_id) {
      appendThreadMessage(msg);
      return;
    }

    const channelId = msg.channel_id;
    if (!App.messages[channelId]) App.messages[channelId] = [];

    // Resolve a pending placeholder if this is our own message echoed back
    if (msg.user_id === App.user?.id) {
      const pendingIdx = App.messages[channelId].findIndex(m => m.pending);
      if (pendingIdx >= 0) {
        const pendingId = App.messages[channelId][pendingIdx].id;
        App.messages[channelId][pendingIdx] = msg;
        if (typeof ChirmCache !== 'undefined') ChirmCache.appendMessage(channelId, msg);
        const pendingEl = document.querySelector(`[data-message-id="${pendingId}"]`);
        if (pendingEl) pendingEl.replaceWith(renderMessage(msg, pendingEl.classList.contains('continued')));
        return;
      }
    }

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
    // Always call — handles both channel and thread messages; DOM guard is inside the function
    updateReactionsInDOM(message_id, reactions);
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
    _saveStructCache();
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
    _saveStructCache();
  });

  WS.on('channel.delete', ({ id }) => {
    App.channels = App.channels.filter(c => c.id !== id);
    if (App.currentChannel?.id === id) {
      App.currentChannel = null;
      document.getElementById('messages-list').innerHTML = '';
      if (App.channels.length) openChannel(App.channels[0]);
    }
    renderChannelList();
    _saveStructCache();
  });

  WS.on('channels.reorder', (channels) => {
    App.channels = channels;
    renderChannelList();
    _saveStructCache();
  });

  WS.on('category.new', (cat) => {
    App.categories.push(cat);
    renderChannelList();
    _saveStructCache();
  });

  WS.on('categories.update', (cats) => {
    App.categories = cats;
    renderChannelList();
    _saveStructCache();
  });

  WS.on('category.delete', ({ id, channels }) => {
    App.categories = App.categories.filter(c => c.id !== id);
    if (channels) App.channels = channels;
    renderChannelList();
    _saveStructCache();
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

  WS.on('member.update', ({ id, username, avatar }) => {
    const m = App.members.find(m => m.id === id);
    if (m) {
      if (username) m.username = username;
      if (avatar !== undefined) m.avatar = avatar;
      renderMembersList();
    }
    if (App.user?.id === id) {
      if (username) App.user.username = username;
      if (avatar !== undefined) App.user.avatar = avatar;
      renderUserPanel();
    }
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

  WS.on('thread.new', ({ thread, channel_id }) => {
    if (!thread) return;
    // If viewing the channel this thread belongs to, inject a chip on the source message
    if (App.currentChannel?.id === channel_id && thread.source_message_id) {
      injectThreadChip(thread.source_message_id, thread);
    }
    // If viewing a forum/gallery channel, prepend just the new card (avoids full re-render race)
    if (App.currentChannel?.id === channel_id) {
      const ch = App.currentChannel;
      if (ch.type === 'forum') prependForumCard(ch, thread);
      else if (ch.type === 'gallery') prependGalleryCard(ch, thread);
    }
  });

  WS.on('thread.delete', ({ thread_id, channel_id }) => {
    // Close panel if the deleted thread is currently open
    if (App.currentThread?.id === thread_id) closeThreadPanel();
    // Remove from forum/gallery view if applicable
    document.querySelector(`[data-thread-id="${thread_id}"]`)?.remove();
    // Remove thread chip from source message
    document.querySelector(`.msg-thread-chip[data-thread-id="${thread_id}"]`)?.remove();
  });

  WS.on('thread.message.new', (msg) => {
    if (!msg || !msg.thread_id) return;
    appendThreadMessage(msg);
    // Update thread chip count on source message
    const threadId = msg.thread_id;
    if (App.threadMessages[threadId]) {
      const count = App.threadMessages[threadId].length;
      updateThreadChipInDOM(threadId, count);
    }
    // Update reply count on forum/gallery post card
    if (App.currentChannel?.type === 'forum' || App.currentChannel?.type === 'gallery') {
      const card = document.querySelector(`[data-thread-id="${threadId}"] .fpc-reply-count`);
      if (card) {
        const current = parseInt(card.textContent, 10) || 0;
        card.textContent = current + 1;
      }
    }
  });

  WS.on('thread.message.delete', ({ id, thread_id, channel_id }) => {
    if (!thread_id) return;
    removeThreadMessage(id, thread_id);
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
    if (_struct.mb)  App.members        = _struct.mb;
    renderServerHeader();
    renderChannelList();
    if (_struct.mb?.length) renderMembersList();
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

  // Thread panel input
  const threadInput = document.getElementById('thread-message-input');
  if (threadInput) {
    threadInput.addEventListener('keydown', onThreadInputKeydown);
    threadInput.addEventListener('input', () => resizeInput(threadInput));
  }
  const threadForm = document.getElementById('thread-message-form');
  if (threadForm) threadForm.addEventListener('submit', (e) => { e.preventDefault(); sendThreadMessage(); });

  const fileInput = document.getElementById('file-input');
  fileInput.addEventListener('change', () => {
    if (fileInput.files[0]) handleFileUpload(fileInput.files[0]);
    fileInput.value = '';
  });

  const threadFileInput = document.getElementById('thread-file-input');
  if (threadFileInput) {
    threadFileInput.addEventListener('change', () => {
      if (threadFileInput.files[0]) handleThreadUpload(threadFileInput.files[0]);
      threadFileInput.value = '';
    });
  }

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
// Route setReply to thread panel when clicking reply on a thread message
window.setReply = (msgId, authorName, content) => {
  const msgInThread = document.querySelector(`#thread-messages-list [data-message-id="${msgId}"]`);
  if (msgInThread && App.currentThread) {
    setThreadReply(msgId, authorName, content);
  } else {
    setReply(msgId, authorName, content);
  }
};
window.openEmojiPicker      = openEmojiPicker;
window.openInputEmojiPicker = openInputEmojiPicker;
window.editMessage          = editMessage;
window.deleteMessage        = deleteMessage;
window.scrollToMessage      = scrollToMessage;
window.toggleReaction       = toggleReaction;
window.switchEmojiTab       = switchEmojiTab;
window.filterEmojis         = filterEmojis;
window.selectEmoji          = selectEmoji;

// Threads
window.openStartThreadModal      = openStartThreadModal;
window.openThreadById            = openThreadById;
window.closeThreadPanel          = closeThreadPanel;
window.sendThreadMessage         = sendThreadMessage;
window.onThreadInputKeydown      = onThreadInputKeydown;
window.setThreadReply            = setThreadReply;
window.clearThreadReply          = clearThreadReply;
window.insertThreadEmoji         = insertThreadEmoji;
window.clearThreadUploadPreview  = clearThreadUploadPreview;

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
