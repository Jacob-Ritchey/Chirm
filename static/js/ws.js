// ws.js — WebSocket connection manager

const WS = (() => {
  let ws = null;
  let reconnectTimer = null;
  let reconnectDelay = 1000;
  let handlers = {};
  let currentChannelId = null;
  let isConnected = false;

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws`);

    ws.onopen = () => {
      isConnected = true;
      reconnectDelay = 1000;
      if (currentChannelId) {
        subscribe(currentChannelId);
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

  return { connect, subscribe, sendTyping, send, on, off };
})();
