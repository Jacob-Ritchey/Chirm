// render/messages.js — Message rendering, emoji picker, reactions, send/edit/delete

import App from '../state.js';
import api from '../api.js';
import WS from '../ws.js';
import ChirmCache from '../cache.js';
import { EMOJI_CATEGORY_ICONS, EMOJI_DATA, EMOJI_SHORTCODES } from '../emoji-data.js';
import { toast, esc, escInline, escAttr, avatar, stringToColor, formatTime, formatTimeShort, renderContent, formatSize, isAdmin, resizeInput } from '../utils.js';
import { clearUploadPreview } from './media.js';

// ─── RENDER MESSAGES ──────────────────────────────────────────────────────────

export function renderMessages(channelId) {
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

  if (App.messagesHasMore[channelId]) {
    const loadMoreBtn = document.createElement('button');
    loadMoreBtn.className = 'load-more-btn';
    loadMoreBtn.textContent = 'Load earlier messages';
    loadMoreBtn.onclick = () => loadMoreMessages(channelId);
    list.appendChild(loadMoreBtn);
  }

  let lastUserId = null;
  let lastTimestamp = null;

  msgs.forEach((msg) => {
    const ts = new Date(msg.created_at).getTime();
    const timeDiff = lastTimestamp ? ts - lastTimestamp : Infinity;
    const isContinued = msg.user_id === lastUserId && timeDiff < 5 * 60 * 1000;

    list.appendChild(renderMessage(msg, isContinued));

    lastUserId = msg.user_id;
    lastTimestamp = ts;
  });
}

export function renderMessage(msg, continued = false) {
  const el = document.createElement('div');
  el.className = `message-group${continued ? ' continued' : ' first-in-group'}${msg.pending ? ' msg-pending' : ''}`;
  el.dataset.messageId = msg.id;

  const isBot = !!msg.bot;
  const authorName = isBot ? (msg.bot?.name || 'Bot') : (msg.author?.username || 'Deleted User');
  const authorColor = stringToColor(authorName);
  const botBadge = isBot ? '<span class="bot-badge">BOT</span>' : '';
  const canEdit = !isBot && msg.user_id === App.user?.id;
  const canDelete = (!isBot && msg.user_id === App.user?.id) || isAdmin(App.user);

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
        return `<div class="msg-attachment"><img src="/api/v1/uploads/${escInline(att.filename)}" alt="${escInline(att.original_name)}" onclick="openImageViewer(this.src)" loading="lazy"></div>`;
      }
      if (att.mime_type.startsWith('video/')) {
        return `<div class="msg-attachment"><video src="/api/v1/uploads/${escInline(att.filename)}" controls preload="metadata" style="max-width:400px;max-height:300px;border-radius:var(--radius)"></video></div>`;
      }
      return `<div class="msg-attachment"><a class="msg-file-attachment" href="/api/v1/uploads/${escInline(att.filename)}" target="_blank" download="${escInline(att.original_name)}">📎 ${escInline(att.original_name)} <span class="text-muted text-sm">${formatSize(att.size)}</span></a></div>`;
    }).join('');
  }

  // Thread chip — shown when this message spawned a thread
  let threadChipHtml = '';
  if (msg.thread) {
    const t = msg.thread;
    const count = t.message_count || 0;
    threadChipHtml = `<div class="msg-thread-chip" data-thread-id="${escInline(t.id)}" onclick="openThreadById('${escInline(t.id)}')">
      <span class="thread-chip-icon">🧵</span>
      <span class="thread-chip-name">${escInline(t.name)}</span>
      <span class="thread-chip-count">${count} ${count === 1 ? 'reply' : 'replies'}</span>
      <span class="thread-chip-arrow">›</span>
    </div>`;
  }

  // Reactions
  const reactionsHtml = renderReactions(msg);

  // Floating action toolbar
  const msgIdSafe = msg.id;
  const authorNameEsc = authorName.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const contentPreview = (msg.content || '').slice(0, 80).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const canThread = !App.currentThread && App.currentChannel?.type !== 'voice' && App.currentChannel?.type !== 'forum' && App.currentChannel?.type !== 'gallery';
  const toolbar = `<div class="msg-toolbar">
    <button class="msg-toolbar-btn" title="React" onclick="openEmojiPicker(event, '${msgIdSafe}')">😊</button>
    <button class="msg-toolbar-btn" title="Reply" onclick="setReply('${msgIdSafe}', '${authorNameEsc}', '${contentPreview}')">↩</button>
    ${canThread ? `<button class="msg-toolbar-btn" title="Start Thread" onclick="openStartThreadModal('${msgIdSafe}')">🧵</button>` : ''}
    ${canEdit ? `<button class="msg-toolbar-btn" title="Edit" onclick="editMessage('${msgIdSafe}')">✎</button>` : ''}
    ${canDelete ? `<button class="msg-toolbar-btn danger" title="Delete" onclick="deleteMessage('${msgIdSafe}')">🗑</button>` : ''}
  </div>`;

  const memberStatus = App.members.find(m => m.id === msg.author?.id)?.status || '';
  const authorClickable = !isBot && msg.author?.id;
  const authorOnClick = authorClickable ? `onclick="window.viewUserProfile?.('${esc(msg.author.id)}')" style="cursor:pointer"` : '';

  el.innerHTML = `
    ${toolbar}
    <div class="msg-avatar-col" ${authorClickable ? `onclick="window.viewUserProfile?.('${esc(msg.author.id)}')" style="cursor:pointer"` : ''}>
      ${!continued ? (isBot ? `<div class="avatar avatar-sm" style="background:var(--accent);font-size:14px">🤖</div>` : avatar(msg.author, 'avatar-sm', memberStatus)) : `<span class="msg-time-hover">${formatTimeShort(msg.created_at)}</span>`}
    </div>
    <div class="msg-body">
      ${replyHtml}
      ${!continued ? `<div class="msg-header">
        <span class="msg-author" style="color:${authorColor}" ${authorOnClick}>${escInline(authorName)}</span>${botBadge}
        <span class="msg-timestamp">${formatTime(msg.created_at)}</span>
        ${msg.edited_at ? '<span class="msg-edited">(edited)</span>' : ''}
      </div>` : ''}
      <div class="msg-content">${renderContent(msg.content)}</div>
      ${attachmentsHtml}
      ${threadChipHtml}
      ${reactionsHtml}
    </div>
  `;

  // Async: inject link preview cards for any URLs found during render
  requestAnimationFrame(() => scheduleLinePreviews(el));

  return el;
}

// ─── LINK PREVIEWS ────────────────────────────────────────────────────────────
const _previewCache = new Map();
const _previewInFlight = new Map();
const SKIP_PREVIEW_EXTS = /\.(png|jpe?g|gif|webp|svg|mp4|webm|ogg|mp3|wav|pdf|zip|tar|gz)(\?.*)?$/i;

export async function fetchLinkPreview(url) {
  if (_previewCache.has(url)) return _previewCache.get(url);
  if (_previewInFlight.has(url)) return _previewInFlight.get(url);

  const promise = api.get(`/api/link-preview?url=${encodeURIComponent(url)}`)
    .then(data => {
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

export function scheduleLinePreviews(msgEl) {
  const trigger = msgEl.querySelector('.link-preview-trigger');
  if (!trigger) return;
  const urls = trigger.dataset.urls?.split('|').filter(Boolean) || [];
  if (!urls.length) return;

  const body = msgEl.querySelector('.msg-body');
  if (!body) return;

  tryNextPreview(urls, 0, body);
}

export async function tryNextPreview(urls, idx, body) {
  if (idx >= urls.length) return;
  const url = urls[idx];

  if (SKIP_PREVIEW_EXTS.test(url)) {
    tryNextPreview(urls, idx + 1, body);
    return;
  }

  const data = await fetchLinkPreview(url);
  if (!data || (!data.title && !data.description)) {
    tryNextPreview(urls, idx + 1, body);
    return;
  }

  if (!document.body.contains(body)) return;

  body.querySelector('.link-preview-card')?.remove();

  const card = buildPreviewCard(data);
  const reactions = body.querySelector('.msg-reactions');
  if (reactions) {
    body.insertBefore(card, reactions);
  } else {
    body.appendChild(card);
  }
}

export function buildPreviewCard(data) {
  const card = document.createElement('a');
  card.className = 'link-preview-card';
  card.href = data.url;
  card.target = '_blank';
  card.rel = 'noopener';

  const hasImage = data.image && !data.image.includes('favicon');
  const siteLine = data.site_name ? `<span class="lp-site">${escInline(data.site_name)}</span>` : '';

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

// ─── REACTIONS ────────────────────────────────────────────────────────────────

export function renderReactions(msg) {
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

export function updateReactionsInDOM(messageId, reactions) {
  // Update state for regular channel messages
  const channelId = App.currentChannel?.id;
  if (channelId && App.messages[channelId]) {
    const m = App.messages[channelId].find(m => m.id === messageId);
    if (m) m.reactions = reactions;
  }
  // Update state for thread messages
  for (const arr of Object.values(App.threadMessages)) {
    const m = arr.find(m => m.id === messageId);
    if (m) { m.reactions = reactions; break; }
  }

  const el = document.querySelector(`[data-message-id="${messageId}"]`);
  if (!el) return;

  // Find message object from either source
  let msg = (App.messages[App.currentChannel?.id] || []).find(m => m.id === messageId);
  if (!msg) {
    for (const arr of Object.values(App.threadMessages)) {
      const found = arr.find(m => m.id === messageId);
      if (found) { msg = found; break; }
    }
  }
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

// ─── SCROLL / LOAD MORE ───────────────────────────────────────────────────────

export function scrollToBottom(instant = false) {
  const container = document.getElementById('messages-container');
  container.scrollTo({ top: container.scrollHeight, behavior: instant ? 'instant' : 'smooth' });
}

export function isNearBottom() {
  const c = document.getElementById('messages-container');
  return c.scrollHeight - c.scrollTop - c.clientHeight < 120;
}

export function scrollToMessage(id) {
  const el = document.querySelector(`[data-message-id="${id}"]`);
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('msg-highlight');
    setTimeout(() => el.classList.remove('msg-highlight'), 1500);
  }
}

async function loadMessages(channelId, before = null) {
  const url = `/api/channels/${channelId}/messages${before ? `?before=${before}` : ''}`;
  const res = await api.get(url).catch(() => ({ messages: [], has_more: false }));
  if (Array.isArray(res)) return { messages: res, hasMore: false };
  return { messages: res.messages ?? [], hasMore: res.has_more ?? false };
}

export async function loadMoreMessages(channelId) {
  const existing = App.messages[channelId] || [];
  if (!existing.length) return;
  const oldest = existing[0];
  const { messages: more, hasMore } = await loadMessages(channelId, oldest.id);
  App.messagesHasMore[channelId] = hasMore;
  if (!more.length) {
    App.messagesHasMore[channelId] = false;
    toast('No more messages to load', 'info');
    renderMessages(channelId);
    return;
  }
  App.messages[channelId] = [...more, ...existing];
  ChirmCache.set(channelId, App.messages[channelId]);
  renderMessages(channelId);
}

// ─── SEND / REPLY ─────────────────────────────────────────────────────────────

export async function sendMessage() {
  if (!App.currentChannel) return;
  const input = document.getElementById('message-input');
  const content = input.value.trim();
  if (!content && !App.pendingUpload) return;

  input.value = '';
  resizeInput(input);

  const replyToId = App.replyTo?.id || null;
  clearReply();

  const channelId = App.currentChannel.id;
  if (!App.messages[channelId]) App.messages[channelId] = [];

  const tempId = 'pending_' + Date.now();
  const prev = App.messages[channelId].at(-1);
  const tempMsg = {
    id: tempId,
    channel_id: channelId,
    user_id: App.user?.id,
    content,
    author: App.user ? { username: App.user.username, avatar: App.user.avatar, color: App.user.color } : {},
    created_at: new Date().toISOString(),
    pending: true,
  };
  App.messages[channelId].push(tempMsg);
  const list = document.getElementById('messages-list');
  if (list) {
    const prevTs = prev ? new Date(prev.created_at).getTime() : 0;
    const continued = !!prev && prev.user_id === tempMsg.user_id && Date.now() - prevTs < 5 * 60 * 1000;
    list.appendChild(renderMessage(tempMsg, continued));
    if (isNearBottom()) scrollToBottom();
  }

  try {
    const body = { content, reply_to_id: replyToId };
    if (App.pendingUpload) {
      body.attachments = [App.pendingUpload.id];
      clearUploadPreview();
    }
    const msg = await api.post(`/api/v1/channels/${channelId}/messages`, body);
    if (msg?.id) {
      const tempIdx = App.messages[channelId].findIndex(m => m.id === tempId);
      if (tempIdx >= 0) {
        App.messages[channelId][tempIdx] = msg;
        if (typeof ChirmCache !== 'undefined') ChirmCache.appendMessage(channelId, msg);
        const domEl = document.querySelector(`[data-message-id="${tempId}"]`);
        if (domEl) domEl.replaceWith(renderMessage(msg, domEl.classList.contains('continued')));
      }
      // If tempIdx === -1, the WS echo already resolved the pending message
    }
  } catch (e) {
    toast(e.message, 'error');
    input.value = content;
    const tempIdx = App.messages[channelId].findIndex(m => m.id === tempId);
    if (tempIdx >= 0) App.messages[channelId].splice(tempIdx, 1);
    const domEl = document.querySelector(`[data-message-id="${tempId}"]`);
    if (domEl) domEl.remove();
  }
}

export function setReply(msgId, authorName, contentPreview) {
  App.replyTo = { id: msgId, authorName, content: contentPreview };
  const bar = document.getElementById('reply-bar');
  bar.style.display = 'flex';
  bar.querySelector('.reply-bar-author').textContent = authorName;
  bar.querySelector('.reply-bar-content').textContent = contentPreview || 'Click to jump to message';
  document.getElementById('message-input').focus();
}

export function clearReply() {
  App.replyTo = null;
  const bar = document.getElementById('reply-bar');
  if (bar) bar.style.display = 'none';
}

// ─── REACTIONS ────────────────────────────────────────────────────────────────

export async function toggleReaction(messageId, emoji) {
  const msg = (App.messages[App.currentChannel?.id] || []).find(m => m.id === messageId);
  const reaction = msg?.reactions?.find(r => r.emoji === emoji);
  const alreadyReacted = reaction?.user_ids?.includes(App.user?.id);

  try {
    if (alreadyReacted) {
      await api.fetch(`/api/v1/messages/${messageId}/reactions`, {
        method: 'DELETE',
        body: JSON.stringify({ emoji }),
      });
    } else {
      await api.post(`/api/v1/messages/${messageId}/reactions`, { emoji });
    }
  } catch (e) {
    toast(e.message, 'error');
  }
}

// ─── EMOJI PICKER ─────────────────────────────────────────────────────────────

let activeEmojiPickerMsgId = null;
let activeEmojiPickerEl = null;
let emojiPickerMode = 'input';
let emojiPickerCallback = null;

export function buildEmojiPicker(mode, targetMsgId, callback) {
  closeEmojiPicker();
  emojiPickerMode = mode;
  activeEmojiPickerMsgId = targetMsgId || null;
  emojiPickerCallback = callback || null;

  const picker = document.createElement('div');
  picker.id = 'emoji-picker';
  picker.className = 'emoji-picker';

  const customEmojis = App.customEmojis || [];
  const categories = [];
  if (customEmojis.length > 0) {
    categories.push({ key: 'Custom', emojis: null, custom: true });
  }
  Object.keys(EMOJI_DATA).forEach(cat => categories.push({ key: cat, emojis: EMOJI_DATA[cat], custom: false }));

  const activeKey = categories[0]?.key || 'Smileys & Emotion';

  const tabBar = document.createElement('div');
  tabBar.className = 'emoji-picker-tabs';
  tabBar.innerHTML = categories.map((cat, i) => {
    const icon = cat.custom ? '⭐' : (EMOJI_CATEGORY_ICONS[cat.key] || cat.key[0]);
    return `<button class="emoji-tab${i===0?' active':''}" data-cat="${cat.key}"
      title="${cat.key}"
      onclick="event.stopPropagation(); switchEmojiTab(this)">${icon}</button>`;
  }).join('');
  picker.appendChild(tabBar);

  const searchWrap = document.createElement('div');
  searchWrap.className = 'emoji-search-wrap';
  searchWrap.innerHTML = `<input type="text" class="emoji-search" placeholder="Search emojis…" oninput="filterEmojis(this.value)" onclick="event.stopPropagation()">`;
  picker.appendChild(searchWrap);

  const body = document.createElement('div');
  body.className = 'emoji-picker-body';

  categories.forEach((cat, i) => {
    const panel = document.createElement('div');
    panel.className = `emoji-category${i===0?' active':''}`;
    panel.dataset.cat = cat.key;

    if (cat.custom) {
      panel.innerHTML = customEmojis.map(e =>
        `<button class="emoji-btn emoji-btn-custom" onclick="event.stopPropagation(); selectEmoji(':${e.name}:');" title=":${e.name}:">
          <img src="/api/v1/uploads/${e.filename}" alt="${e.name}">
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

export function openEmojiPicker(event, messageId) {
  event.stopPropagation();
  const picker = buildEmojiPicker('reaction', messageId);
  positionPicker(picker, event.currentTarget, false);
}

export function openInputEmojiPicker(event, callback) {
  event.stopPropagation();
  const picker = buildEmojiPicker('input', null, callback);
  positionPicker(picker, event.currentTarget, true);
}

export function positionPicker(picker, anchor, preferLeft) {
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

export function switchEmojiTab(btn) {
  const cat = btn.dataset.cat;
  document.querySelectorAll('.emoji-tab').forEach(t => t.classList.toggle('active', t === btn));
  document.querySelectorAll('.emoji-category').forEach(c => {
    if (c.id === 'emoji-search-results') { c.style.display = 'none'; return; }
    c.classList.toggle('active', c.dataset.cat === cat);
  });
  const searchEl = document.querySelector('.emoji-search');
  if (searchEl) { searchEl.value = ''; }
}

export function filterEmojis(query) {
  const resultsPanel = document.getElementById('emoji-search-results');
  if (!resultsPanel) return;

  if (!query.trim()) {
    resultsPanel.style.display = 'none';
    resultsPanel.innerHTML = '';
    document.querySelectorAll('.emoji-category:not(#emoji-search-results)').forEach(c => {
      c.classList.toggle('active', c.classList.contains('active') || false);
    });
    const activeTab = document.querySelector('.emoji-tab.active');
    if (activeTab) switchEmojiTab(activeTab);
    return;
  }

  document.querySelectorAll('.emoji-category:not(#emoji-search-results)').forEach(c => c.classList.remove('active'));

  const q = query.toLowerCase();
  const hits = [];

  (App.customEmojis || []).forEach(e => {
    if (e.name.includes(q)) {
      hits.push(`<button class="emoji-btn emoji-btn-custom" onclick="event.stopPropagation(); selectEmoji(':${e.name}:');" title=":${e.name}:">
        <img src="/api/v1/uploads/${e.filename}" alt="${e.name}"><span>${e.name}</span></button>`);
    }
  });

  Object.entries(EMOJI_SHORTCODES).forEach(([name, emoji]) => {
    if (name.includes(q)) {
      hits.push(`<button class="emoji-btn" onclick="event.stopPropagation(); selectEmoji('${emoji}');" title=":${name}: ${emoji}">${emoji}</button>`);
    }
  });

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

export async function selectEmoji(emoji) {
  if (emojiPickerCallback) {
    const cb = emojiPickerCallback;
    emojiPickerCallback = null;
    closeEmojiPicker();
    cb(emoji);
  } else if (emojiPickerMode === 'reaction' && activeEmojiPickerMsgId) {
    closeEmojiPicker();
    await toggleReaction(activeEmojiPickerMsgId, emoji);
    activeEmojiPickerMsgId = null;
  } else {
    closeEmojiPicker();
    insertEmoji(emoji);
  }
}

export function closeEmojiPicker() {
  if (activeEmojiPickerEl) {
    activeEmojiPickerEl.remove();
    activeEmojiPickerEl = null;
  }
}

export function insertEmoji(emoji) {
  const input = document.getElementById('message-input');
  const start = input.selectionStart;
  const end = input.selectionEnd;
  const val = input.value;
  input.value = val.slice(0, start) + emoji + val.slice(end);
  input.selectionStart = input.selectionEnd = start + emoji.length;
  input.focus();
  resizeInput(input);
}

// ─── EDIT / DELETE ────────────────────────────────────────────────────────────

export function editMessage(id) {
  const el = document.querySelector(`[data-message-id="${id}"] .msg-content`);
  if (!el) return;
  const original = App.messages[App.currentChannel?.id]?.find(m => m.id === id);
  if (!original) return;

  el.contentEditable = 'true';
  el.focus();

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

export async function deleteMessage(id) {
  if (!confirm('Delete this message?')) return;
  try {
    await api.del(`/api/messages/${id}`);
  } catch (e) {
    toast(e.message, 'error');
  }
}

// ─── TYPING INDICATOR ────────────────────────────────────────────────────────

let typingTimeout = null;

export function onInputKeydown(e) {
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

export function updateTypingIndicator(channelId) {
  if (App.currentChannel?.id !== channelId) return;
  const el = document.getElementById('typing-indicator');
  const users = App.typingUsers[channelId] || {};
  const names = Object.keys(users).map(uid => {
    const m = App.members.find(m => m.id === uid);
    return m?.username || 'Someone';
  }).filter(Boolean);

  if (!names.length) {
    el.innerHTML = '';
    el.style.display = 'none';
    return;
  }
  const text = names.length === 1 ? `${names[0]} is typing` :
    names.length === 2 ? `${names[0]} and ${names[1]} are typing` :
    'Several people are typing';
  el.innerHTML = `<div class="typing-dots"><span></span><span></span><span></span></div><span>${text}…</span>`;
  el.style.display = '';
}
