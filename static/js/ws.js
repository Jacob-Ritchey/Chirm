// ws.js — WebSocket connection manager

const WS = (() => {
  let ws = null;
  let reconnectTimer = null;
  let reconnectDelay = 1000;
  let handlers = {};
  let currentChannelId = null;
  let currentThreadChannelId = null;
  let isConnected = false;

  async function connect() {
    // Obtain a single-use CSRF token before upgrading the WebSocket connection.
    let csrfToken = '';
    try {
      const res = await fetch('/api/v1/auth/csrf', { credentials: 'include' });
      if (res.ok) {
        const body = await res.json();
        csrfToken = body.data?.token || '';
      }
    } catch {}

    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = csrfToken
      ? `${proto}://${location.host}/ws?csrf=${encodeURIComponent(csrfToken)}`
      : `${proto}://${location.host}/ws`;
    ws = new WebSocket(url);

    ws.onopen = () => {
      isConnected = true;
      reconnectDelay = 1000;
      if (currentChannelId) {
        subscribe(currentChannelId);
      }
      if (currentThreadChannelId) {
        subscribeThread(currentThreadChannelId);
      }
      dispatch('ws.connected', {});
    };

    ws.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data);
        dispatch(event.type, event.data);
      } catch {}
    };

    ws.onclose = () => {
      isConnected = false;
      dispatch('ws.disconnected', {});
      scheduleReconnect();
    };

    ws.onerror = () => {
      ws.close();
    };
  }

  function scheduleReconnect() {
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      connect();
    }, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 1.5, 30000);
  }

  function send(type, data) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type, data }));
    }
  }

  function subscribe(channelId) {
    currentChannelId = channelId;
    send('subscribe', { channel_id: channelId });
  }

  function subscribeThread(channelId) {
    currentThreadChannelId = channelId || null;
    send('thread_subscribe', { channel_id: channelId || '' });
  }

  function sendTyping(channelId) {
    send('typing', { channel_id: channelId });
  }

  function on(type, handler) {
    if (!handlers[type]) handlers[type] = [];
    handlers[type].push(handler);
    return () => off(type, handler);
  }

  function off(type, handler) {
    if (handlers[type]) {
      handlers[type] = handlers[type].filter(h => h !== handler);
    }
  }

  function dispatch(type, data) {
    (handlers[type] || []).forEach(h => h(data));
  }

  return { connect, subscribe, subscribeThread, sendTyping, send, on, off };
})();

export default WS;
