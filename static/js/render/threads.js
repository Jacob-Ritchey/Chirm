// render/threads.js — Thread panel, forum view, gallery view

import App from '../state.js';
import { api } from '../api.js';
import { toast, esc, escInline, formatTimeShort, renderContent, formatSize, isAdmin, resizeInput } from '../utils.js';
import { renderMessage, renderReactions, fetchLinkPreview } from './messages.js';
import WS from '../ws.js';
import { handleFileUpload as _handleFileUpload, showUploadPreview as _showUploadPreview } from './media.js';
import { showSimpleModal } from './modals.js';

// ─── THREAD PANEL ─────────────────────────────────────────────────────────────

export function openThreadPanel(thread) {
  App.currentThread = thread;
  if (!App.threadMessages[thread.id]) App.threadMessages[thread.id] = [];

  const panel = document.getElementById('thread-panel');
  const app = document.getElementById('app');
  if (!panel) return;

  // Update header
  const titleEl = panel.querySelector('.thread-panel-title');
  if (titleEl) titleEl.textContent = thread.name;

  // Inject/update expand button
  const headerActions = panel.querySelector('.thread-panel-header-actions');
  if (headerActions) {
    headerActions.querySelector('.thread-expand-btn')?.remove();
    if (thread.thread_channel_id) {
      const expandBtn = document.createElement('button');
      expandBtn.className = 'thread-expand-btn icon-btn';
      expandBtn.title = 'Open as full channel';
      expandBtn.textContent = '⤢';
      expandBtn.onclick = () => {
        App.threadNavStack = [
          ...(App.threadNavStack || []),
          {
            id: App.currentChannel?.id,
            name: App.currentChannel?.name,
            type: App.currentChannel?.type || 'text',
            thread: thread,
          }
        ];
        window.openChannel?.({ id: thread.thread_channel_id, name: thread.name, type: 'thread' });
      };
      headerActions.prepend(expandBtn);
    }
  }

  // Show panel
  panel.classList.remove('hidden');
  app.classList.add('thread-panel-open');

  // Update thread input placeholder
  const input = document.getElementById('thread-message-input');
  if (input) input.placeholder = `Reply in ${thread.name}`;

  // Subscribe to thread channel for live updates
  if (thread.thread_channel_id) {
    WS.subscribeThread(thread.thread_channel_id);
  }

  // Load messages
  _loadThreadMessages(thread.id, true);
}

export function closeThreadPanel() {
  App.currentThread = null;
  WS.subscribeThread(''); // clear thread channel subscription
  const panel = document.getElementById('thread-panel');
  const app = document.getElementById('app');
  if (panel) panel.classList.add('hidden');
  if (app) app.classList.remove('thread-panel-open');
}

export async function _loadThreadMessages(threadId, reset = false) {
  if (reset) {
    App.threadMessages[threadId] = [];
    App.threadMessagesHasMore[threadId] = false;
  }

  const before = reset ? '' : (App.threadMessages[threadId]?.[0]?.id || '');
  // Use thread channel API if available (new architecture), else fall back to thread messages API
  const thread = App.currentThread?.id === threadId ? App.currentThread : null;
  const baseUrl = thread?.thread_channel_id
    ? `/api/v1/channels/${thread.thread_channel_id}/messages`
    : `/api/v1/threads/${threadId}/messages`;
  const url = `${baseUrl}${before ? `?before=${before}` : ''}`;
  const data = await api.get(url).catch(() => ({ messages: [], has_more: false }));
  const msgs = Array.isArray(data) ? data : (data.messages ?? []);
  const hasMore = Array.isArray(data) ? false : (data.has_more ?? false);

  App.threadMessagesHasMore[threadId] = hasMore;

  if (reset) {
    App.threadMessages[threadId] = msgs;
  } else {
    App.threadMessages[threadId] = [...msgs, ...(App.threadMessages[threadId] || [])];
  }

  if (App.currentThread?.id === threadId) {
    renderThreadMessages(threadId);
    if (reset) _scrollThreadToBottom(true);
  }
}

export function renderThreadMessages(threadId) {
  const list = document.getElementById('thread-messages-list');
  if (!list) return;
  const msgs = App.threadMessages[threadId] || [];

  list.innerHTML = '';

  if (App.threadMessagesHasMore[threadId]) {
    const btn = document.createElement('button');
    btn.className = 'load-more-btn';
    btn.textContent = 'Load earlier messages';
    btn.onclick = () => _loadThreadMessages(threadId);
    list.appendChild(btn);
  }

  if (msgs.length === 0) {
    list.innerHTML = '<div class="thread-empty">No messages yet. Start the conversation!</div>';
    return;
  }

  let lastUserId = null;
  let lastTimestamp = null;

  msgs.forEach(msg => {
    const ts = new Date(msg.created_at).getTime();
    const timeDiff = lastTimestamp ? ts - lastTimestamp : Infinity;
    const continued = msg.user_id === lastUserId && timeDiff < 5 * 60 * 1000;
    list.appendChild(renderMessage(msg, continued));
    lastUserId = msg.user_id;
    lastTimestamp = ts;
  });
}


function _scrollThreadToBottom(instant = false) {
  const c = document.getElementById('thread-messages-container');
  if (c) c.scrollTo({ top: c.scrollHeight, behavior: instant ? 'instant' : 'smooth' });
}

function _isThreadNearBottom() {
  const c = document.getElementById('thread-messages-container');
  if (!c) return false;
  return c.scrollHeight - c.scrollTop - c.clientHeight < 120;
}

// ─── THREAD MESSAGE SEND ──────────────────────────────────────────────────────

export async function sendThreadMessage() {
  if (!App.currentThread) return;
  const input = document.getElementById('thread-message-input');
  if (!input) return;
  const content = input.value.trim();
  if (!content && !App.pendingThreadUpload) return;

  input.value = '';
  resizeInput(input);

  const threadId = App.currentThread.id;
  if (!App.threadMessages[threadId]) App.threadMessages[threadId] = [];

  const tempId = 'pending_' + Date.now();
  const prev = App.threadMessages[threadId].at(-1);
  const tempMsg = {
    id: tempId,
    thread_id: threadId,
    user_id: App.user?.id,
    content,
    author: App.user ? { username: App.user.username, avatar: App.user.avatar, color: App.user.color } : {},
    created_at: new Date().toISOString(),
    pending: true,
  };
  App.threadMessages[threadId].push(tempMsg);
  const list = document.getElementById('thread-messages-list');
  if (list) {
    list.querySelector('.thread-empty')?.remove();
    const prevTs = prev ? new Date(prev.created_at).getTime() : 0;
    const continued = !!prev && prev.user_id === tempMsg.user_id && Date.now() - prevTs < 5 * 60 * 1000;
    list.appendChild(renderMessage(tempMsg, continued));
    if (_isThreadNearBottom()) _scrollThreadToBottom();
  }

  try {
    const body = { content };
    if (App.threadReplyTo) {
      body.reply_to_id = App.threadReplyTo.id;
      clearThreadReply();
    }
    if (App.pendingThreadUpload) {
      body.attachments = [App.pendingThreadUpload.id];
      clearThreadUploadPreview();
    }
    const endpoint = App.currentThread.thread_channel_id
      ? `/api/v1/channels/${App.currentThread.thread_channel_id}/messages`
      : `/api/v1/threads/${App.currentThread.id}/messages`;
    const msg = await api.post(endpoint, body);
    if (msg?.id) {
      const tempIdx = App.threadMessages[threadId].findIndex(m => m.id === tempId);
      if (tempIdx >= 0) {
        App.threadMessages[threadId][tempIdx] = msg;
        const domEl = document.querySelector(`[data-message-id="${tempId}"]`);
        if (domEl) domEl.replaceWith(renderMessage(msg, domEl.classList.contains('continued')));
      }
    }
  } catch (e) {
    toast(e.message || 'Failed to send', 'error');
    input.value = content;
    const tempIdx = App.threadMessages[threadId].findIndex(m => m.id === tempId);
    if (tempIdx >= 0) App.threadMessages[threadId].splice(tempIdx, 1);
    const domEl = document.querySelector(`[data-message-id="${tempId}"]`);
    if (domEl) domEl.remove();
  }
}

export function clearThreadUploadPreview() {
  App.pendingThreadUpload = null;
  const preview = document.getElementById('thread-upload-preview');
  if (preview) { preview.innerHTML = ''; preview.style.display = 'none'; }
}

export function setThreadReply(msgId, authorName, contentPreview) {
  App.threadReplyTo = { id: msgId, authorName, content: contentPreview };
  const bar = document.getElementById('thread-reply-bar');
  if (!bar) return;
  bar.style.display = 'flex';
  bar.querySelector('.reply-bar-author').textContent = authorName;
  bar.querySelector('.reply-bar-content').textContent = contentPreview || '';
  document.getElementById('thread-message-input')?.focus();
}

export function clearThreadReply() {
  App.threadReplyTo = null;
  const bar = document.getElementById('thread-reply-bar');
  if (bar) bar.style.display = 'none';
}

export function insertThreadEmoji(emoji) {
  const input = document.getElementById('thread-message-input');
  if (!input) return;
  const start = input.selectionStart;
  const end = input.selectionEnd;
  input.value = input.value.slice(0, start) + emoji + input.value.slice(end);
  input.selectionStart = input.selectionEnd = start + emoji.length;
  input.focus();
  resizeInput(input);
}

export async function handleThreadUpload(file) {
  if (!file) return;
  const formData = new FormData();
  formData.append('file', file);
  const toastEl = document.createElement('div');
  toastEl.className = 'toast info';
  toastEl.textContent = `Uploading ${file.name}…`;
  document.getElementById('toast-container')?.appendChild(toastEl);
  try {
    const res = await fetch('/api/v1/upload', { method: 'POST', credentials: 'include', body: formData });
    toastEl.remove();
    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error?.message || data.error || 'Upload failed');
    }
    const json = await res.json();
    const att = json.data ?? json;
    App.pendingThreadUpload = att;
    const preview = document.getElementById('thread-upload-preview');
    if (!preview) return;
    preview.style.display = 'flex';
    if (att.mime_type.startsWith('image/')) {
      const reader = new FileReader();
      reader.onload = (e) => {
        preview.innerHTML = `
          <img src="${e.target.result}" style="max-height:80px;border-radius:6px">
          <span style="font-size:13px;color:var(--text-secondary)">${escInline(file.name)}</span>
          <button onclick="clearThreadUploadPreview()" style="margin-left:auto;background:none;border:none;cursor:pointer;color:var(--text-muted);font-size:18px">✕</button>
        `;
      };
      reader.readAsDataURL(file);
    } else {
      preview.innerHTML = `
        <span>📎</span>
        <span style="font-size:13px;color:var(--text-secondary)">${escInline(file.name)} (${formatSize(att.size)})</span>
        <button onclick="clearThreadUploadPreview()" style="margin-left:auto;background:none;border:none;cursor:pointer;color:var(--text-muted);font-size:18px">✕</button>
      `;
    }
  } catch (e) {
    toastEl.remove();
    toast(e.message, 'error');
  }
}

export function onThreadInputKeydown(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendThreadMessage();
  }
}

// ─── START THREAD MODAL ───────────────────────────────────────────────────────

export function openStartThreadModal(sourceMessageId) {
  if (!App.currentChannel) return;
  const form = `<div class="form-group">
    <label>Thread Name</label>
    <input type="text" id="new-thread-name" placeholder="e.g. Planning discussion" maxlength="100">
  </div>`;
  showSimpleModal('Start a Thread', form, async () => {
    const name = document.getElementById('new-thread-name')?.value.trim();
    if (!name) { toast('Thread name required', 'error'); return false; }
    try {
      const body = { name };
      if (sourceMessageId) body.source_message_id = sourceMessageId;
      const thread = await api.post(`/api/v1/channels/${App.currentChannel.id}/threads`, body);
      if (thread?.id) openThreadPanel(thread);
    } catch (e) {
      toast(e.message || 'Failed to create thread', 'error');
    }
  });
  setTimeout(() => document.getElementById('new-thread-name')?.focus(), 50);
}

export function openThreadById(threadId) {
  // Fetch thread and open the panel
  api.get(`/api/v1/channels/${App.currentChannel?.id}/threads`).then(data => {
    const threads = data?.threads || [];
    const thread = threads.find(t => t.id === threadId);
    if (thread) {
      openThreadPanel(thread);
    } else {
      // Fetch individual thread details if not in list cache
      toast('Opening thread…', 'info');
    }
  }).catch(() => {});
}

// ─── THREAD CHIP UPDATE ────────────────────────────────────────────────────────

export function updateThreadChipInDOM(threadId, messageCount) {
  const chip = document.querySelector(`.msg-thread-chip[data-thread-id="${threadId}"]`);
  if (chip) {
    const countEl = chip.querySelector('.thread-chip-count');
    if (countEl) countEl.textContent = `${messageCount} ${messageCount === 1 ? 'reply' : 'replies'}`;
  }
}

export function injectThreadChip(sourceMessageId, thread) {
  const msgEl = document.querySelector(`[data-message-id="${sourceMessageId}"]`);
  if (!msgEl) return;
  // Remove existing chip for this thread if any
  msgEl.querySelector(`.msg-thread-chip[data-thread-id="${thread.id}"]`)?.remove();
  const body = msgEl.querySelector('.msg-body');
  if (!body) return;
  const chip = document.createElement('div');
  chip.className = 'msg-thread-chip';
  chip.dataset.threadId = thread.id;
  chip.onclick = () => openThreadPanel(thread);
  chip.innerHTML = `<span class="thread-chip-icon">🧵</span>
    <span class="thread-chip-name">${escInline(thread.name)}</span>
    <span class="thread-chip-count">${thread.message_count} ${thread.message_count === 1 ? 'reply' : 'replies'}</span>
    <span class="thread-chip-arrow">›</span>`;
  const reactions = body.querySelector('.msg-reactions');
  if (reactions) body.insertBefore(chip, reactions);
  else body.appendChild(chip);
}

// ─── PHASE 2: FORUM VIEW ──────────────────────────────────────────────────────

export async function renderForumView(channel) {
  const msgsList = document.getElementById('messages-list');
  const inputArea = document.getElementById('message-input-area');
  const typingIndicator = document.getElementById('typing-indicator');
  const replyBar = document.getElementById('reply-bar');
  if (!msgsList) return;

  // Hide text-channel-specific elements
  if (inputArea) inputArea.style.display = 'none';
  if (typingIndicator) typingIndicator.style.display = 'none';
  if (replyBar) replyBar.style.display = 'none';

  // Show "New Post" button in the channel header actions
  _injectNewPostButton(channel);

  msgsList.innerHTML = '<div class="forum-loading">Loading posts…</div>';

  try {
    const data = await api.get(`/api/v1/channels/${channel.id}/threads`);
    if (App.currentChannel?.id !== channel.id) return;
    const threads = data?.threads || [];

    if (threads.length === 0) {
      msgsList.innerHTML = `<div class="empty-state" style="padding-top:80px">
        <div class="empty-icon">📋</div>
        <h3>No posts yet</h3>
        <p>Be the first to post in <strong>#${esc(channel.name)}</strong>!</p>
      </div>`;
      return;
    }

    msgsList.innerHTML = '';
    const container = document.createElement('div');
    container.className = 'forum-posts-list';

    for (const thread of threads) {
      let firstMsg = null;
      try {
        const msgData = await api.get(`/api/v1/threads/${thread.id}/first-message`);
        firstMsg = msgData?.message || null;
      } catch {}
      container.appendChild(renderForumPostCard(thread, firstMsg));
    }
    if (App.currentChannel?.id !== channel.id) return;
    msgsList.appendChild(container);
  } catch (e) {
    msgsList.innerHTML = '<div class="forum-error">Failed to load posts.</div>';
  }
}

function _injectNewPostButton(channel) {
  const actions = document.getElementById('channel-header-actions');
  if (!actions) return;
  actions.querySelector('.new-post-btn')?.remove();
  if (!isAdmin(App.user) && !App.user) return;
  const btn = document.createElement('button');
  btn.className = 'new-post-btn';
  btn.title = 'New Post';
  btn.innerHTML = '✏ New Post';
  btn.onclick = () => openCreatePostModal(channel);
  actions.prepend(btn);
}

// Regex for skipping direct media files that don't have og:image metadata
const _SKIP_MEDIA_EXTS = /\.(png|jpe?g|gif|webp|svg|mp4|webm|ogg|mp3|wav|pdf|zip|tar|gz)(\?.*)?$/i;

export function renderForumPostCard(thread, firstMsg) {
  const card = document.createElement('div');
  card.className = 'forum-post-card';
  card.dataset.threadId = thread.id;
  card.onclick = () => openThreadPanel(thread);

  const authorName = thread.creator?.username || 'Unknown';
  const preview = firstMsg ? (firstMsg.content || '').slice(0, 200) : '';
  const hasMore = firstMsg && firstMsg.content && firstMsg.content.length > 200;
  const images = (firstMsg?.attachments || []).filter(a => a.mime_type?.startsWith('image/'));
  const directImage = images[0];

  // Left thumbnail: direct attachment image shown immediately; link og:image filled async
  const thumbHtml = directImage
    ? `<div class="fpc-thumb"><img class="fpc-thumb-img" src="/api/v1/uploads/${escInline(directImage.filename)}" alt="${escInline(directImage.original_name)}" loading="lazy"></div>`
    : `<div class="fpc-thumb" style="display:none"><img class="fpc-thumb-img" alt="" loading="lazy"></div>`;

  card.innerHTML = `
    ${thumbHtml}
    <div class="fpc-main">
      <div class="fpc-header">
        <span class="fpc-title">${escInline(thread.name)}</span>
        <span class="fpc-meta">
          <span class="fpc-author">${escInline(authorName)}</span>
          · <span class="fpc-time">${formatTimeShort(thread.created_at)}</span>
        </span>
      </div>
      ${preview ? `<div class="fpc-body">${renderContent(preview)}${hasMore ? '…' : ''}</div>` : ''}
      <div class="fpc-footer">
        <span class="fpc-replies">💬 <span class="fpc-reply-count">${thread.message_count}</span> ${thread.message_count === 1 ? 'reply' : 'replies'}</span>
        <span class="fpc-activity">Last activity ${formatTimeShort(thread.last_activity_at)}</span>
      </div>
    </div>
  `;

  // Direct attachment image → open lightbox on click, don't open thread
  if (directImage) {
    const thumbEl = card.querySelector('.fpc-thumb');
    thumbEl.onclick = (e) => {
      e.stopPropagation();
      if (typeof window.openImageViewer === 'function') {
        window.openImageViewer(`/api/v1/uploads/${directImage.filename}`);
      }
    };
  } else if (firstMsg?.content) {
    // Async: fill thumbnail from link preview og:image
    _scheduleForumLinkThumb(card, firstMsg.content);
  }

  return card;
}

async function _scheduleForumLinkThumb(card, content) {
  const match = content.match(/https?:\/\/[^\s<>"')\]]+/);
  if (!match) return;
  const url = match[0];
  if (_SKIP_MEDIA_EXTS.test(url)) return;

  const data = await fetchLinkPreview(url).catch(() => null);
  if (!data?.image) return;

  const thumbEl = card.querySelector('.fpc-thumb');
  if (!thumbEl) return;
  const img = thumbEl.querySelector('.fpc-thumb-img');
  img.src = data.image;
  img.onerror = () => { thumbEl.style.display = 'none'; };
  thumbEl.style.display = '';
  thumbEl.dataset.href = data.url || url;
  thumbEl.onclick = (e) => {
    e.stopPropagation();
    window.open(thumbEl.dataset.href, '_blank', 'noopener');
  };
}

export function openCreatePostModal(channel) {
  let modalAttachmentId = null;

  const form = `
    <div class="form-group">
      <label>Post Title</label>
      <input type="text" id="new-post-title" placeholder="What's this post about?" maxlength="100">
    </div>
    <div class="form-group">
      <label>Content <span class="text-muted" style="font-size:12px">(optional)</span></label>
      <textarea id="new-post-content" rows="4" placeholder="Add more details…" style="width:100%;padding:8px 10px;background:var(--bg-input);color:var(--text-primary);border:1px solid var(--border-strong);border-radius:var(--radius-sm);font-family:inherit;font-size:14px;resize:vertical"></textarea>
    </div>
    <div class="form-group">
      <label>Attachment <span class="text-muted" style="font-size:12px">(optional)</span></label>
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <input type="file" id="new-post-file-input" style="display:none" accept="image/*,video/*,audio/*,.pdf,.txt,.zip">
        <button type="button" onclick="document.getElementById('new-post-file-input').click()" style="padding:5px 10px;background:var(--bg-input);color:var(--text-primary);border:1px solid var(--border-strong);border-radius:var(--radius-sm);cursor:pointer;font-size:13px">📎 Attach</button>
        <span id="new-post-attachment-name" style="font-size:12px;color:var(--text-secondary)"></span>
        <button type="button" id="new-post-attachment-clear" style="display:none;background:none;border:none;cursor:pointer;color:var(--text-muted);font-size:16px" title="Remove">✕</button>
      </div>
      <div id="new-post-preview" style="margin-top:6px"></div>
    </div>
  `;
  showSimpleModal('New Post', form, async () => {
    const title = document.getElementById('new-post-title')?.value.trim();
    const content = document.getElementById('new-post-content')?.value.trim();
    if (!title) { toast('Post title required', 'error'); return false; }
    try {
      const body = { name: title };
      if (content) body.initial_message = content;
      if (modalAttachmentId) body.attachments = [modalAttachmentId];
      const thread = await api.post(`/api/v1/channels/${channel.id}/threads`, body);
      if (thread?.id) {
        openThreadPanel(thread);
        if (channel.type === 'forum') prependForumCard(channel, thread);
        else if (channel.type === 'gallery') prependGalleryCard(channel, thread);
      }
    } catch (e) {
      toast(e.message || 'Failed to create post', 'error');
    }
  });
  setTimeout(() => {
    document.getElementById('new-post-title')?.focus();
    const fileInput = document.getElementById('new-post-file-input');
    const clearBtn = document.getElementById('new-post-attachment-clear');
    if (fileInput) {
      fileInput.addEventListener('change', async () => {
        const file = fileInput.files[0];
        if (!file) return;
        const formData = new FormData();
        formData.append('file', file);
        const toastEl = document.createElement('div');
        toastEl.className = 'toast info';
        toastEl.textContent = `Uploading ${file.name}…`;
        document.getElementById('toast-container')?.appendChild(toastEl);
        try {
          const res = await fetch('/api/v1/upload', { method: 'POST', credentials: 'include', body: formData });
          toastEl.remove();
          if (!res.ok) {
            const data = await res.json();
            throw new Error(data.error?.message || data.error || 'Upload failed');
          }
          const json = await res.json();
          const att = json.data ?? json;
          modalAttachmentId = att.id;
          const nameEl = document.getElementById('new-post-attachment-name');
          if (nameEl) nameEl.textContent = file.name;
          if (clearBtn) clearBtn.style.display = '';
          const prev = document.getElementById('new-post-preview');
          if (prev && att.mime_type?.startsWith('image/')) {
            prev.innerHTML = `<img src="/api/v1/uploads/${escInline(att.filename)}" style="max-height:80px;border-radius:6px">`;
          }
        } catch (e) {
          toastEl.remove();
          toast(e.message, 'error');
        }
        fileInput.value = '';
      });
    }
    if (clearBtn) {
      clearBtn.onclick = () => {
        modalAttachmentId = null;
        const nameEl = document.getElementById('new-post-attachment-name');
        if (nameEl) nameEl.textContent = '';
        clearBtn.style.display = 'none';
        const prev = document.getElementById('new-post-preview');
        if (prev) prev.innerHTML = '';
      };
    }
  }, 50);
}

// ─── PHASE 3: GALLERY VIEW ────────────────────────────────────────────────────

export async function renderGalleryView(channel) {
  const msgsList = document.getElementById('messages-list');
  const inputArea = document.getElementById('message-input-area');
  const typingIndicator = document.getElementById('typing-indicator');
  const replyBar = document.getElementById('reply-bar');
  if (!msgsList) return;

  if (inputArea) inputArea.style.display = 'none';
  if (typingIndicator) typingIndicator.style.display = 'none';
  if (replyBar) replyBar.style.display = 'none';

  _injectNewPostButton(channel);

  msgsList.innerHTML = '<div class="forum-loading">Loading gallery…</div>';

  try {
    const data = await api.get(`/api/v1/channels/${channel.id}/threads`);
    if (App.currentChannel?.id !== channel.id) return;
    const threads = data?.threads || [];

    if (threads.length === 0) {
      msgsList.innerHTML = `<div class="empty-state" style="padding-top:80px">
        <div class="empty-icon">🖼</div>
        <h3>No posts yet</h3>
        <p>Be the first to post in <strong>#${esc(channel.name)}</strong>!</p>
      </div>`;
      return;
    }

    msgsList.innerHTML = '';
    const grid = document.createElement('div');
    grid.className = 'gallery-grid';
    msgsList.appendChild(grid);

    for (const thread of threads) {
      let firstMsg = null;
      try {
        const msgData = await api.get(`/api/v1/threads/${thread.id}/first-message`);
        firstMsg = msgData?.message || null;
      } catch {}
      if (App.currentChannel?.id !== channel.id) { grid.remove(); return; }
      grid.appendChild(renderGalleryCard(thread, firstMsg));
    }
  } catch (e) {
    msgsList.innerHTML = '<div class="forum-error">Failed to load gallery.</div>';
  }
}

export function renderGalleryCard(thread, firstMsg) {
  const card = document.createElement('div');
  card.className = 'gallery-card';
  card.dataset.threadId = thread.id;
  card.onclick = () => openThreadPanel(thread);

  const images = (firstMsg?.attachments || []).filter(a => a.mime_type?.startsWith('image/'));
  const primaryImage = images[0];
  const preview = firstMsg ? (firstMsg.content || '').slice(0, 120) : '';

  const mediaHtml = primaryImage
    ? `<div class="gallery-card-media"><img src="/api/v1/uploads/${escInline(primaryImage.filename)}" alt="${escInline(primaryImage.original_name)}" loading="lazy"></div>`
    : `<div class="gallery-card-media gallery-card-text-media"><p>${preview ? escInline(preview) : escInline(thread.name)}</p></div>`;

  card.innerHTML = `
    ${mediaHtml}
    <div class="gallery-card-overlay">
      <span class="gallery-card-title">${escInline(thread.name)}</span>
      <span class="gallery-card-stats">💬 ${thread.message_count}</span>
    </div>
  `;

  // Async: use link preview og:image as card media when there's no direct attachment image
  if (!primaryImage && firstMsg?.content) {
    _scheduleGalleryLinkMedia(card, firstMsg.content);
  }

  return card;
}

async function _scheduleGalleryLinkMedia(card, content) {
  const match = content.match(/https?:\/\/[^\s<>"')\]]+/);
  if (!match) return;
  const url = match[0];
  if (_SKIP_MEDIA_EXTS.test(url)) return;

  const data = await fetchLinkPreview(url).catch(() => null);
  if (!data) return;

  const mediaDiv = card.querySelector('.gallery-card-media');
  if (!mediaDiv) return;

  const hasText = data.title || data.description;

  if (hasText) {
    // Text metadata takes priority: site + title + description, og:image as thumbnail strip
    const siteHtml = data.site_name
      ? `<div class="glp-site">${escInline(data.site_name)}</div>`
      : '';
    const thumbHtml = data.image
      ? `<div class="glp-thumb"><img src="${escInline(data.image)}" alt="" loading="lazy" onerror="this.closest('.glp-thumb').remove()"></div>`
      : '';
    mediaDiv.className = 'gallery-card-media gallery-card-link-meta';
    mediaDiv.innerHTML = `
      ${thumbHtml}
      <div class="glp-body">
        ${siteHtml}
        ${data.title ? `<div class="glp-title">${escInline(data.title)}</div>` : ''}
        ${data.description ? `<div class="glp-desc">${escInline(data.description)}</div>` : ''}
      </div>
    `;
  } else if (data.image) {
    // No text metadata — fall back to full-bleed og:image
    mediaDiv.className = 'gallery-card-media';
    mediaDiv.innerHTML = `<img src="${escInline(data.image)}" alt="" loading="lazy" onerror="this.closest('.gallery-card-media').classList.add('gallery-card-text-media')">`;
  }
  // No metadata at all — leave existing text fallback unchanged
}

// ─── CARD PREPEND HELPERS (used by WS thread.new handler) ────────────────────

export async function prependForumCard(channel, thread) {
  if (App.currentChannel?.id !== channel.id) return;
  let container = document.querySelector('.forum-posts-list');
  if (!container) {
    // First post on an empty channel — replace the empty-state with a fresh list
    const msgsList = document.getElementById('messages-list');
    if (!msgsList) return;
    container = document.createElement('div');
    container.className = 'forum-posts-list';
    msgsList.innerHTML = '';
    msgsList.appendChild(container);
  }
  if (container.querySelector(`[data-thread-id="${thread.id}"]`)) return;
  let firstMsg = null;
  try {
    const msgData = await api.get(`/api/v1/threads/${thread.id}/messages?limit=1`);
    firstMsg = (msgData?.messages || [])[0] || null;
  } catch {}
  if (App.currentChannel?.id !== channel.id) return;
  if (container.querySelector(`[data-thread-id="${thread.id}"]`)) return;
  container.prepend(renderForumPostCard(thread, firstMsg));
}

export async function prependGalleryCard(channel, thread) {
  if (App.currentChannel?.id !== channel.id) return;
  let grid = document.querySelector('.gallery-grid');
  if (!grid) {
    // First post on an empty channel — replace the empty-state with a fresh grid
    const msgsList = document.getElementById('messages-list');
    if (!msgsList) return;
    grid = document.createElement('div');
    grid.className = 'gallery-grid';
    msgsList.innerHTML = '';
    msgsList.appendChild(grid);
  }
  if (grid.querySelector(`[data-thread-id="${thread.id}"]`)) return;
  const card = renderGalleryCard(thread, null);
  grid.prepend(card);
  let firstMsg = null;
  try {
    const msgData = await api.get(`/api/v1/threads/${thread.id}/messages?limit=1`);
    firstMsg = (msgData?.messages || [])[0] || null;
  } catch {}
  if (firstMsg) {
    if (App.currentChannel?.id !== channel.id) return;
    const existing = grid.querySelector(`[data-thread-id="${thread.id}"]`);
    if (existing) existing.replaceWith(renderGalleryCard(thread, firstMsg));
  }
}

// ─── THREAD WS MESSAGE APPEND ─────────────────────────────────────────────────

// Called from app.js WS handler when a new thread message arrives.
// Works for both new arch (msg.channel_id === thread.thread_channel_id)
// and legacy arch (msg.thread_id === thread.id).
export function appendThreadMessage(msg) {
  const thread = App.currentThread;
  if (!thread) return;

  // For legacy events that carry thread_id, verify it matches the open thread
  if (msg.thread_id && msg.thread_id !== thread.id) return;

  const threadId = thread.id;
  if (!App.threadMessages[threadId]) App.threadMessages[threadId] = [];

  // Resolve a pending placeholder if this is our own message echoed back
  if (msg.user_id === App.user?.id) {
    const pendingIdx = App.threadMessages[threadId].findIndex(m => m.pending);
    if (pendingIdx >= 0) {
      const pendingId = App.threadMessages[threadId][pendingIdx].id;
      App.threadMessages[threadId][pendingIdx] = msg;
      const el = document.querySelector(`[data-message-id="${pendingId}"]`);
      if (el) el.replaceWith(renderMessage(msg, el.classList.contains('continued')));
      return;
    }
  }

  if (App.threadMessages[threadId].find(m => m.id === msg.id)) return;

  const prev = App.threadMessages[threadId].at(-1);
  App.threadMessages[threadId].push(msg);

  const nearBottom = _isThreadNearBottom();
  const list = document.getElementById('thread-messages-list');
  if (list) {
    list.querySelector('.thread-empty')?.remove();
    const ts = new Date(msg.created_at).getTime();
    const prevTs = prev ? new Date(prev.created_at).getTime() : 0;
    const continued = !!prev && prev.user_id === msg.user_id && ts - prevTs < 5 * 60 * 1000;
    list.appendChild(renderMessage(msg, continued));
    if (nearBottom) _scrollThreadToBottom();
  }
}

export function removeThreadMessage(messageId, threadId) {
  if (App.threadMessages[threadId]) {
    App.threadMessages[threadId] = App.threadMessages[threadId].filter(m => m.id !== messageId);
  }
  const el = document.querySelector(`#thread-messages-list [data-message-id="${messageId}"]`);
  if (el) el.remove();
}
