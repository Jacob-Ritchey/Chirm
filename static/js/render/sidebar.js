// render/sidebar.js — Channel list, server header, channel/category management

import App, { saveServerInfoState, saveCategoriesState } from '../state.js';
import api from '../api.js';
import Voice from '../voice.js';
import ChirmSettings from '../user-settings.js';
import { toast, esc, stringToColor, isAdmin } from '../utils.js';
import { showSimpleModal } from './modals.js';

// ─── DATA LOADING ─────────────────────────────────────────────────────────────

export async function loadChannels() {
  const [channelsPage, categories] = await Promise.all([
    api.get('/api/v1/channels').catch(() => null),
    api.get('/api/v1/channel-categories').catch(() => []),
  ]);
  App.channels = channelsPage ? (channelsPage.items ?? channelsPage) : [];
  App.categories = categories || [];
}

// ─── SERVER HEADER ────────────────────────────────────────────────────────────

function _applyServerHeader(s) {
  const name = s.server_name || 'Chirm';
  const desc = s.server_description || '';
  const icon = s.server_icon || '';

  document.getElementById('server-name').textContent = name;
  document.title = name;
  const descEl = document.getElementById('server-description');
  descEl.textContent = desc;
  descEl.style.display = desc ? '' : 'none';

  const iconWrap = document.getElementById('server-icon-display');
  if (icon) {
    iconWrap.innerHTML = `<img src="${esc(icon)}" alt="${esc(name)}">`;
    iconWrap.className = 'server-icon-img';
  } else {
    iconWrap.textContent = name[0]?.toUpperCase() || 'C';
    iconWrap.className = 'server-icon-letter';
    iconWrap.style.background = stringToColor(name);
  }
}

export function renderServerHeader() {
  if (App.publicSettings) {
    _applyServerHeader(App.publicSettings);
    return;
  }
  api.get('/api/v1/public-settings').then(s => {
    App.publicSettings = s;
    _applyServerHeader(s);
  }).catch(() => {});
}

export function toggleServerInfo() {
  App.serverInfoCollapsed = !App.serverInfoCollapsed;
  saveServerInfoState();
  const header = document.getElementById('server-header');
  const chevron = document.getElementById('server-chevron');
  if (App.serverInfoCollapsed) {
    header.classList.remove('server-header-expanded');
    header.classList.add('server-header-collapsed');
    chevron.textContent = '▸';
  } else {
    header.classList.add('server-header-expanded');
    header.classList.remove('server-header-collapsed');
    chevron.textContent = '▾';
  }
}

export function openServerRules() {
  const show = (s) => {
    const text = (s.agreement_enabled === '1' && s.agreement_text)
      ? s.agreement_text
      : (s.server_description || 'No information set.');
    showSimpleModal('Server Info', `<div style="white-space:pre-wrap;font-size:14px;line-height:1.6;color:var(--text-secondary)">${esc(text)}</div>`, null);
  };
  if (App.publicSettings) { show(App.publicSettings); return; }
  api.get('/api/v1/public-settings').then(s => { App.publicSettings = s; show(s); }).catch(() => {});
}

// ─── CHANNEL LIST ─────────────────────────────────────────────────────────────

export function renderChannelList() {
  const list = document.getElementById('channels-list');
  list.innerHTML = '';

  const admin = isAdmin(App.user);

  // Build category map
  const catMap = {};
  for (const cat of App.categories) catMap[cat.id] = cat;

  // Group channels by category
  const grouped = {};
  const uncategorized = [];
  for (const ch of App.channels) {
    if (ch.category_id && catMap[ch.category_id]) {
      if (!grouped[ch.category_id]) grouped[ch.category_id] = [];
      grouped[ch.category_id].push(ch);
    } else {
      uncategorized.push(ch);
    }
  }

  // Helper: render a single channel item
  function makeChannelItem(ch) {
    const isVoice = ch.type === 'voice';
    const participants = isVoice ? (App.voiceParticipants[ch.id] || new Set()) : null;
    const pCount = participants ? participants.size : 0;
    const inRoom = isVoice && Voice.isInChannel(ch.id);

    const item = document.createElement('div');
    item.className = `channel-item${App.currentChannel?.id === ch.id && !isVoice ? ' active' : ''}${inRoom ? ' voice-active' : ''}${App.unread.has(ch.id) && App.currentChannel?.id !== ch.id ? ' unread' : ''}${App.channelEditMode ? ' edit-mode' : ''}`;
    item.dataset.channelId = ch.id;
    item.dataset.categoryId = ch.category_id || '';

    const defaultIcon = ch.type === 'voice' ? '🔊' : ch.type === 'forum' ? '📋' : ch.type === 'gallery' ? '🖼' : '#';
    function renderChEmoji(raw) {
      const m = raw?.match(/^:([a-zA-Z0-9_]+):$/);
      if (m) {
        const e = App.customEmojis?.find(e => e.name === m[1]);
        if (e) return `<span class="ch-icon ch-emoji${isVoice ? ' ch-voice-emoji' : ''}"><img src="/api/v1/uploads/${esc(e.filename)}" alt="${esc(raw)}" class="custom-emoji" style="width:18px;height:18px;vertical-align:middle">${isVoice ? '<span class="voice-badge">🔊</span>' : ''}</span>`;
      }
      return `<span class="ch-icon ch-emoji${isVoice ? ' ch-voice-emoji' : ''}">${raw}${isVoice ? '<span class="voice-badge">🔊</span>' : ''}</span>`;
    }
    const iconHtml = ch.emoji
      ? renderChEmoji(ch.emoji)
      : `<span class="ch-icon ch-hash">${defaultIcon}</span>`;
    const badge = isVoice && pCount > 0 ? `<span class="voice-count">${pCount}</span>` : '';
    const muteIcon = (!isVoice && typeof ChirmSettings !== 'undefined' && ChirmSettings.isChannelMuted(ch.id))
      ? '<span class="ch-mute-badge" title="Muted">🔕</span>' : '';

    if (App.channelEditMode && admin) {
      item.draggable = true;
      item.innerHTML = `
        <span class="drag-handle" title="Drag to reorder">⠿</span>
        ${iconHtml}
        <span class="ch-name">${esc(ch.name)}</span>
        ${badge}
        <span class="unread-dot"></span>
        <span class="channel-edit-actions">
          <button class="channel-edit-btn" onclick="event.stopPropagation();openEditChannel('${ch.id}')" title="Edit">✎</button>
          <button class="channel-edit-btn" onclick="event.stopPropagation();confirmDeleteChannel('${ch.id}')" title="Delete" style="color:var(--danger)">✕</button>
        </span>
      `;
      item.addEventListener('dragstart', onChannelDragStart);
      item.addEventListener('dragover', onChannelDragOver);
      item.addEventListener('drop', onChannelDrop);
      item.addEventListener('dragend', onChannelDragEnd);
    } else {
      item.innerHTML = `
        ${iconHtml}
        <span class="ch-name">${esc(ch.name)}</span>
        ${badge}
        ${muteIcon}
        <span class="unread-dot"></span>
        ${admin ? `<span class="channel-edit-actions">
          <button class="channel-edit-btn" onclick="event.stopPropagation();openEditChannel('${ch.id}')" title="Edit">✎</button>
          <button class="channel-edit-btn" onclick="event.stopPropagation();confirmDeleteChannel('${ch.id}')" title="Delete" style="color:var(--danger)">✕</button>
        </span>` : ''}
      `;
      item.addEventListener('click', () => window.openChannel?.(ch));
    }

    if (isVoice && pCount > 0) {
      const memberNames = [...participants].map(uid => {
        const m = App.members.find(m => m.id === uid);
        return m ? esc(m.username) : uid.slice(0, 8);
      });
      const sub = document.createElement('div');
      sub.className = 'voice-participants-list';
      sub.innerHTML = memberNames.map(n =>
        `<div class="voice-participant-row"><span class="vp-dot"></span>${n}</div>`
      ).join('');
      item.appendChild(sub);
    }
    return item;
  }

  // Helper: render a category section
  function makeCategorySection(catId, catName, channels) {
    const collapsed = App.collapsedCategories.has(catId);
    const section = document.createElement('div');
    section.className = 'channel-category-section';
    section.dataset.catId = catId;

    const header = document.createElement('div');
    header.className = 'channel-category';
    const editBtns = App.channelEditMode && admin ? `
      <button class="channel-edit-btn" onclick="event.stopPropagation();openEditCategory('${catId}')" title="Rename">✎</button>
      <button class="channel-edit-btn" onclick="event.stopPropagation();confirmDeleteCategory('${catId}')" title="Delete" style="color:var(--danger)">✕</button>` : '';
    header.innerHTML = `
      ${App.channelEditMode && admin ? `<span class="drag-handle cat-drag-handle" title="Drag to reorder">⠿</span>` : ''}
      <span class="cat-chevron">${collapsed ? '▸' : '▾'}</span>
      <span class="cat-name">${esc(catName)}</span>
      ${admin ? `<span class="cat-actions">${editBtns}
        ${App.channelEditMode ? `<button class="channel-edit-btn add-ch-btn" onclick="event.stopPropagation();openCreateChannel('${catId}')" title="Add Channel">+</button>` : ''}
      </span>` : ''}
    `;
    header.addEventListener('click', () => toggleCategory(catId));

    if (App.channelEditMode && admin) {
      header.draggable = true;
      header.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('catId', catId);
        e.dataTransfer.effectAllowed = 'move';
        header.classList.add('dragging');
      });
      header.addEventListener('dragend', () => header.classList.remove('dragging'));
      header.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        header.classList.add('drag-over');
      });
      header.addEventListener('dragleave', () => header.classList.remove('drag-over'));
      header.addEventListener('drop', (e) => {
        e.preventDefault();
        header.classList.remove('drag-over');
        const fromCatId = e.dataTransfer.getData('catId');
        const chId = e.dataTransfer.getData('channelId');
        if (fromCatId && fromCatId !== catId) {
          onCategoryDrop(fromCatId, catId);
        } else if (chId) {
          moveChannelToCategory(chId, catId);
        }
      });
    }
    section.appendChild(header);

    if (!collapsed) {
      const channelList = document.createElement('div');
      channelList.className = 'category-channels';
      channelList.dataset.catId = catId;
      for (const ch of channels) channelList.appendChild(makeChannelItem(ch));
      if (App.channelEditMode && admin) {
        channelList.addEventListener('dragover', (e) => {
          e.preventDefault();
          channelList.classList.add('drag-over');
        });
        channelList.addEventListener('dragleave', () => channelList.classList.remove('drag-over'));
        channelList.addEventListener('drop', (e) => {
          e.preventDefault();
          channelList.classList.remove('drag-over');
          const chId = e.dataTransfer.getData('channelId');
          if (chId) moveChannelToCategory(chId, catId);
        });
      }
      section.appendChild(channelList);
    }
    return section;
  }

  // Admin toolbar
  if (admin) {
    const toolbar = document.createElement('div');
    toolbar.className = 'channel-list-toolbar';
    toolbar.innerHTML = `
      <button class="btn-edit-mode${App.channelEditMode ? ' active' : ''}" onclick="toggleChannelEditMode()" title="${App.channelEditMode ? 'Done Editing' : 'Edit Channels'}">
        ${App.channelEditMode ? '✓ Done' : '✎ Edit'}
      </button>
      ${App.channelEditMode ? `<button class="channel-edit-btn cat-add-btn" onclick="openCreateCategory()" title="New Category">📁 New Category</button>` : ''}
    `;
    list.appendChild(toolbar);
  }

  // Render named categories
  for (const cat of App.categories) {
    const chans = grouped[cat.id] || [];
    list.appendChild(makeCategorySection(cat.id, cat.name, chans));
  }

  // Uncategorized channels
  const collapsed = App.collapsedCategories.has('__uncategorized__');
  const section = document.createElement('div');
  section.className = 'channel-category-section';
  const header = document.createElement('div');
  header.className = 'channel-category';
  header.innerHTML = `
    <span class="cat-chevron">${collapsed ? '▸' : '▾'}</span>
    <span class="cat-name">Channels</span>
    ${admin && App.channelEditMode ? `<span class="cat-actions"><button class="channel-edit-btn add-ch-btn" onclick="event.stopPropagation();openCreateChannel('')" title="Add Channel" style="margin-left:auto">+</button></span>` : ''}
  `;
  header.addEventListener('click', () => toggleCategory('__uncategorized__'));
  section.appendChild(header);
  if (!collapsed) {
    const channelList = document.createElement('div');
    channelList.className = 'category-channels';
    channelList.dataset.catId = '';
    for (const ch of uncategorized) channelList.appendChild(makeChannelItem(ch));
    if (App.channelEditMode && admin) {
      channelList.addEventListener('dragover', (e) => { e.preventDefault(); channelList.classList.add('drag-over'); });
      channelList.addEventListener('dragleave', () => channelList.classList.remove('drag-over'));
      channelList.addEventListener('drop', (e) => {
        e.preventDefault(); channelList.classList.remove('drag-over');
        const chId = e.dataTransfer.getData('channelId');
        if (chId) moveChannelToCategory(chId, '');
      });
    }
    section.appendChild(channelList);
  }
  list.appendChild(section);
}

export function toggleCategory(catId) {
  if (App.collapsedCategories.has(catId)) {
    App.collapsedCategories.delete(catId);
  } else {
    App.collapsedCategories.add(catId);
  }
  saveCategoriesState();
  renderChannelList();
}

export function toggleChannelEditMode() {
  App.channelEditMode = !App.channelEditMode;
  renderChannelList();
}

// ─── DRAG & DROP ──────────────────────────────────────────────────────────────

let _dragSrcChannel = null;

function onChannelDragStart(e) {
  _dragSrcChannel = this;
  e.dataTransfer.setData('channelId', this.dataset.channelId);
  e.dataTransfer.effectAllowed = 'move';
  this.classList.add('dragging');
}

function onChannelDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  if (this !== _dragSrcChannel) this.classList.add('drag-target');
}

function onChannelDrop(e) {
  e.preventDefault();
  e.stopPropagation();
  const srcId = e.dataTransfer.getData('channelId');
  const dstId = this.dataset.channelId;
  if (!srcId || srcId === dstId) return;
  const catId = this.dataset.categoryId || '';
  let inCat = App.channels.filter(c => (c.category_id || '') === catId);
  const others = App.channels.filter(c => (c.category_id || '') !== catId);
  const src = App.channels.find(c => c.id === srcId);
  if (!src) return;
  inCat = inCat.filter(c => c.id !== srcId);
  const dstIdx = inCat.findIndex(c => c.id === dstId);
  inCat.splice(dstIdx >= 0 ? dstIdx : inCat.length, 0, src);
  src.category_id = catId;
  App.channels = [...others, ...inCat];
  renderChannelList();
  const orders = inCat.map((c, i) => ({ id: c.id, position: i, category_id: catId }));
  api.post('/api/v1/channels/reorder', orders).catch(() => {
    toast('Failed to save order', 'error');
    loadChannels().then(renderChannelList);
  });
}

function onChannelDragEnd() {
  document.querySelectorAll('.channel-item').forEach(el => el.classList.remove('dragging', 'drag-target'));
  _dragSrcChannel = null;
}

export function moveChannelToCategory(chId, newCatId) {
  const ch = App.channels.find(c => c.id === chId);
  if (!ch || (ch.category_id || '') === newCatId) return;
  ch.category_id = newCatId;
  const pos = App.channels.filter(c => (c.category_id || '') === newCatId && c.id !== chId).length;
  ch.position = pos;
  renderChannelList();
  api.post('/api/v1/channels/reorder', [{ id: chId, position: pos, category_id: newCatId }]).catch(() => {
    toast('Failed to move channel', 'error');
    loadChannels().then(renderChannelList);
  });
}

export function onCategoryDrop(fromCatId, toCatId) {
  const fromIdx = App.categories.findIndex(c => c.id === fromCatId);
  const toIdx = App.categories.findIndex(c => c.id === toCatId);
  if (fromIdx < 0 || toIdx < 0) return;
  const cats = [...App.categories];
  const [moved] = cats.splice(fromIdx, 1);
  cats.splice(toIdx, 0, moved);
  App.categories = cats;
  renderChannelList();
  const orders = cats.map((c, i) => ({ id: c.id, position: i }));
  api.post('/api/v1/channel-categories/reorder', orders).catch(() => {
    toast('Failed to save category order', 'error');
    api.get('/api/v1/channel-categories').then(cats => { App.categories = cats; renderChannelList(); });
  });
}

// ─── CHANNEL MANAGEMENT ───────────────────────────────────────────────────────

function _categoryOptions(selectedId = '') {
  const opts = App.categories.map(c =>
    `<option value="${esc(c.id)}"${c.id === selectedId ? ' selected' : ''}>${esc(c.name)}</option>`
  ).join('');
  return `<option value=""${!selectedId ? ' selected' : ''}>— None (Uncategorized) —</option>${opts}`;
}

function _emojiPickerField(currentEmoji = '') {
  return `
    <div class="form-group">
      <label>Channel Icon (Emoji)</label>
      <div style="display:flex;align-items:center;gap:8px">
        <div id="ch-emoji-preview" style="font-size:22px;width:36px;height:36px;display:flex;align-items:center;justify-content:center;background:var(--bg-elevated);border-radius:var(--radius-sm);border:1px solid var(--border)">${currentEmoji || '#'}</div>
        <button type="button" class="btn btn-sm" onclick="openChannelEmojiPicker(event)" style="font-size:13px">Pick Emoji</button>
        ${currentEmoji ? `<button type="button" class="btn btn-sm btn-danger" onclick="clearChannelEmoji()" style="font-size:13px">Clear</button>` : ''}
      </div>
      <input type="hidden" id="ch-emoji-value" value="${esc(currentEmoji)}">
    </div>
  `;
}

export function openChannelEmojiPicker(e) {
  // Use openInputEmojiPicker via window global to avoid circular import
  if (typeof window.openInputEmojiPicker === 'function') {
    window.openInputEmojiPicker(e, (emoji) => {
      document.getElementById('ch-emoji-value').value = emoji;
      document.getElementById('ch-emoji-preview').textContent = emoji;
    });
  }
}

export function clearChannelEmoji() {
  document.getElementById('ch-emoji-value').value = '';
  document.getElementById('ch-emoji-preview').textContent = '#';
}

export function openCreateChannel(defaultCategoryId = '') {
  const catSelect = App.categories.length > 0 ? `
    <div class="form-group">
      <label>Category</label>
      <select id="new-ch-cat" style="width:100%;padding:8px 10px;background:var(--bg-input);color:var(--text-primary);border:1px solid var(--border-strong);border-radius:var(--radius-sm);font-family:inherit;font-size:14px">
        ${_categoryOptions(defaultCategoryId)}
      </select>
    </div>` : '';

  const form = `
    ${_emojiPickerField()}
    <div class="form-group"><label>Channel Name</label><input type="text" id="new-ch-name" placeholder="new-channel"></div>
    <div class="form-group"><label>Description</label><input type="text" id="new-ch-desc" placeholder="Optional description"></div>
    <div class="form-group">
      <label>Channel Type</label>
      <select id="new-ch-type" style="width:100%;padding:8px 10px;background:var(--bg-input);color:var(--text-primary);border:1px solid var(--border-strong);border-radius:var(--radius-sm);font-family:inherit;font-size:14px">
        <option value="text">💬 Text Channel</option>
        <option value="voice">🔊 Voice Channel</option>
        <option value="forum">📋 Forum Channel</option>
        <option value="gallery">🖼 Gallery Channel</option>
      </select>
    </div>
    ${catSelect}
  `;
  showSimpleModal('Create Channel', form, async () => {
    const name = document.getElementById('new-ch-name').value.trim();
    if (!name) { toast('Name required', 'error'); return false; }
    const type = document.getElementById('new-ch-type').value;
    const emoji = document.getElementById('ch-emoji-value')?.value || '';
    const category_id = document.getElementById('new-ch-cat')?.value || defaultCategoryId || '';
    await api.post('/api/v1/channels', { name, description: document.getElementById('new-ch-desc').value, type, emoji, category_id });
    await loadChannels();
    renderChannelList();
  });
}

export function openEditChannel(id) {
  const ch = App.channels.find(c => c.id === id);
  if (!ch) return;
  const catSelect = App.categories.length > 0 ? `
    <div class="form-group">
      <label>Category</label>
      <select id="edit-ch-cat" style="width:100%;padding:8px 10px;background:var(--bg-input);color:var(--text-primary);border:1px solid var(--border-strong);border-radius:var(--radius-sm);font-family:inherit;font-size:14px">
        ${_categoryOptions(ch.category_id || '')}
      </select>
    </div>` : '';

  const form = `
    ${_emojiPickerField(ch.emoji || '')}
    <div class="form-group"><label>Channel Name</label><input type="text" id="edit-ch-name" value="${esc(ch.name)}"></div>
    <div class="form-group"><label>Description</label><input type="text" id="edit-ch-desc" value="${esc(ch.description)}"></div>
    ${catSelect}
  `;
  showSimpleModal('Edit Channel', form, async () => {
    const name = document.getElementById('edit-ch-name').value.trim();
    if (!name) { toast('Name required', 'error'); return false; }
    const emoji = document.getElementById('ch-emoji-value')?.value || '';
    const category_id = document.getElementById('edit-ch-cat')?.value || '';
    await api.put(`/api/channels/${id}`, { name, description: document.getElementById('edit-ch-desc').value, emoji, category_id });
    await loadChannels();
    renderChannelList();
  });
}

export async function confirmDeleteChannel(id) {
  const ch = App.channels.find(c => c.id === id);
  if (!confirm(`Delete #${ch?.name}? All messages will be lost.`)) return;
  await api.del(`/api/channels/${id}`);
  await loadChannels();
  renderChannelList();
}

// ─── CATEGORY MANAGEMENT ──────────────────────────────────────────────────────

export function openCreateCategory() {
  const form = `<div class="form-group"><label>Category Name</label><input type="text" id="new-cat-name" placeholder="e.g. General, Gaming, Info"></div>`;
  showSimpleModal('New Category', form, async () => {
    const name = document.getElementById('new-cat-name').value.trim();
    if (!name) { toast('Name required', 'error'); return false; }
    await api.post('/api/v1/channel-categories', { name });
    await loadChannels();
    renderChannelList();
  });
}

export function openEditCategory(id) {
  const cat = App.categories.find(c => c.id === id);
  if (!cat) return;
  const form = `<div class="form-group"><label>Category Name</label><input type="text" id="edit-cat-name" value="${esc(cat.name)}"></div>`;
  showSimpleModal('Rename Category', form, async () => {
    const name = document.getElementById('edit-cat-name').value.trim();
    if (!name) { toast('Name required', 'error'); return false; }
    await api.put(`/api/channel-categories/${id}`, { name });
    await loadChannels();
    renderChannelList();
  });
}

export async function confirmDeleteCategory(id) {
  const cat = App.categories.find(c => c.id === id);
  const count = App.channels.filter(c => c.category_id === id).length;
  const msg = count > 0
    ? `Delete category "${cat?.name}"? ${count} channel(s) will become uncategorized.`
    : `Delete category "${cat?.name}"?`;
  if (!confirm(msg)) return;
  await api.del(`/api/channel-categories/${id}`);
  await loadChannels();
  renderChannelList();
}
