// state.js — Chirm application state
// Single source of truth for runtime application data.

export const App = {
  user: null,
  channels: [],
  categories: [],
  currentChannel: null,
  messages: {},          // channelId → []
  messagesHasMore: {},   // channelId → bool
  members: [],
  roles: [],
  unread: new Set((() => { try { return JSON.parse(localStorage.getItem('chirm_unread') || '[]'); } catch { return []; } })()),
  typingUsers: {},       // channelId → {userId: timestamp}
  voiceParticipants: {},  // channelId → Set of userIds
  token: null,
  replyTo: null,         // {id, content, authorName} | null
  threadReplyTo: null,   // {id, content, authorName} | null - for thread message replies
  collapsedCategories: new Set((() => { try { return JSON.parse(localStorage.getItem('chirm_ui_categories') || '[]'); } catch { return []; } })()),
  serverInfoCollapsed: (() => { try { return localStorage.getItem('chirm_ui_server_info') === '1'; } catch { return false; } })(),
  channelEditMode: false,
  customEmojis: [],      // [{id, name, filename, ...}]
  pendingUpload: null,   // attachment object waiting to be sent
  publicSettings: null,  // cached /api/v1/public-settings response
  currentThread: null,         // Thread object | null
  threadMessages: {},          // threadId → []
  threadMessagesHasMore: {},   // threadId → bool
  pendingThreadUpload: null,   // attachment pending in thread input
  threadNavStack: [],          // breadcrumb history when viewing a thread full-screen
};

export function persistUnread() {
  try {
    localStorage.setItem('chirm_unread', JSON.stringify([...App.unread]));
  } catch {}
}

export function saveLastChannel(channelId) {
  try {
    localStorage.setItem('chirm_last_channel', channelId);
  } catch {}
}

export function loadLastChannel() {
  try {
    return localStorage.getItem('chirm_last_channel') || null;
  } catch { return null; }
}

export function saveServerInfoState() {
  try { localStorage.setItem('chirm_ui_server_info', App.serverInfoCollapsed ? '1' : '0'); } catch {}
}

export function saveCategoriesState() {
  try { localStorage.setItem('chirm_ui_categories', JSON.stringify([...App.collapsedCategories])); } catch {}
}

export default App;
