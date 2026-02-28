// state.js — Chirm application state
// Single source of truth for runtime application data.

export const App = {
  user: null,
  channels: [],
  categories: [],
  currentChannel: null,
  messages: {},          // channelId → []
  members: [],
  roles: [],
  unread: new Set((() => { try { return JSON.parse(localStorage.getItem('chirm_unread') || '[]'); } catch { return []; } })()),
  typingUsers: {},       // channelId → {userId: timestamp}
  voiceParticipants: {},  // channelId → Set of userIds
  token: null,
  replyTo: null,         // {id, content, authorName} | null
  collapsedCategories: new Set(),  // category ids that are collapsed
  serverInfoCollapsed: false,
  channelEditMode: false,
  customEmojis: [],      // [{id, name, filename, ...}]
  pendingUpload: null,   // attachment object waiting to be sent
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

export default App;
