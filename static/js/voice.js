// voice.js — WebRTC voice/video room manager for Nexus
// Mesh P2P topology: each peer connects directly to every other peer.
// The server only relays signaling messages (offer/answer/ICE).

const Voice = (() => {
  // ── State ─────────────────────────────────────────────────────────────────
  let currentChannelId = null;
  let localStream = null;
  let micEnabled = true;
  let camEnabled = false;
  let videoTrackAvailable = false; // did the user grant camera permission?

  // peers: userId → { pc: RTCPeerConnection }
  const peers = {};

  const ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ];

  // ── Secure context check ──────────────────────────────────────────────────
  // getUserMedia requires HTTPS on non-localhost origins (all mobile browsers,
  // Chrome on LAN, Firefox on LAN). Detect this early and give a clear message.
  function checkSecureContext() {
    if (window.isSecureContext) return true;
    const host = location.hostname;
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true;
    // Not secure and not localhost — media APIs will be blocked
    const httpsUrl = 'https://' + location.hostname + ':8443' + location.pathname;
    toast(
      '🔒 Voice requires HTTPS on this network. ' +
      'Open ' + httpsUrl + ' (accept the self-signed cert warning), then try again.',
      'error'
    );
    return false;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  async function join(channelId) {
    if (currentChannelId) await leave();

    if (!checkSecureContext()) return false;

    currentChannelId = channelId;

    // Request audio + video together so the browser shows one combined prompt.
    // If video is denied we gracefully fall back to audio-only.
    // If audio itself is denied, we abort entirely.
    videoTrackAvailable = false;
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
      videoTrackAvailable = true;
      // Start with video muted — user must explicitly enable it
      localStream.getVideoTracks().forEach(t => { t.enabled = false; });
    } catch (avErr) {
      // Video denied or no camera — try audio only
      try {
        localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        videoTrackAvailable = false;
      } catch (aErr) {
        const msg = aErr.name === 'NotAllowedError'
          ? 'Microphone access denied. Please allow microphone in browser/system settings.'
          : 'Could not access microphone: ' + aErr.message;
        toast(msg, 'error');
        currentChannelId = null;
        return false;
      }
    }

    micEnabled = true;
    camEnabled = false;

    renderVoiceUI();
    attachLocalVideo();

    // Tell server we're joining
    WS.send('voice.join', { channel_id: channelId });
    return true;
  }

  async function leave() {
    if (!currentChannelId) return;
    const chId = currentChannelId;
    currentChannelId = null;

    WS.send('voice.leave', { channel_id: chId });

    // Close all peer connections
    for (const uid of Object.keys(peers)) {
      destroyPeer(uid);
    }

    // Stop local tracks
    if (localStream) {
      localStream.getTracks().forEach(t => t.stop());
      localStream = null;
    }

    videoTrackAvailable = false;
    camEnabled = false;

    hideVoiceUI();
  }

  function toggleMic() {
    if (!localStream) return;
    micEnabled = !micEnabled;
    localStream.getAudioTracks().forEach(t => { t.enabled = micEnabled; });
    updateVoiceControls();
  }

  function toggleCam() {
    if (!localStream) return;

    if (!videoTrackAvailable) {
      toast('Camera not available — it was denied when joining. Rejoin to grant camera access.', 'error');
      return;
    }

    camEnabled = !camEnabled;
    localStream.getVideoTracks().forEach(t => { t.enabled = camEnabled; });

    // If we're now showing video, make sure it's flowing to existing peers
    if (camEnabled) {
      const videoTrack = localStream.getVideoTracks()[0];
      if (videoTrack) {
        for (const uid of Object.keys(peers)) {
          const sender = peers[uid].pc.getSenders().find(s => s.track?.kind === 'video');
          if (sender) {
            sender.replaceTrack(videoTrack).catch(() => {});
          }
        }
      }
    }

    attachLocalVideo();
    updateVoiceControls();
  }

  // ── WebSocket event handlers ──────────────────────────────────────────────

  // Server tells us who is already in the room
  function onRoomState(data) {
    if (data.channel_id !== currentChannelId) return;
    const participants = data.participants || [];
    for (const uid of participants) {
      if (uid !== App.user.id) {
        createPeer(uid, true); // we are the offerer
      }
    }
  }

  // A new user joined the room after us
  function onUserJoined(data) {
    if (data.channel_id !== currentChannelId) return;
    if (data.user_id === App.user.id) return;
    createPeer(data.user_id, false); // they will send us an offer
  }

  // A user left the room
  function onUserLeft(data) {
    if (data.user_id === App.user.id) return;
    destroyPeer(data.user_id);
    removePeerTile(data.user_id);
  }

  // Incoming WebRTC offer
  async function onOffer(data) {
    if (data.channel_id !== currentChannelId) return;
    const uid = data.from_user_id;
    if (!peers[uid]) createPeer(uid, false);
    const pc = peers[uid].pc;
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(data.payload));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      WS.send('voice.answer', {
        channel_id: currentChannelId,
        target_user_id: uid,
        payload: pc.localDescription,
      });
    } catch (e) {
      console.warn('voice offer error:', e);
    }
  }

  // Incoming WebRTC answer
  async function onAnswer(data) {
    if (data.channel_id !== currentChannelId) return;
    const pc = peers[data.from_user_id]?.pc;
    if (!pc) return;
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(data.payload));
    } catch (e) {
      console.warn('voice answer error:', e);
    }
  }

  // Incoming ICE candidate
  async function onIce(data) {
    if (data.channel_id !== currentChannelId) return;
    const pc = peers[data.from_user_id]?.pc;
    if (!pc || !data.payload) return;
    try {
      await pc.addIceCandidate(new RTCIceCandidate(data.payload));
    } catch {}
  }

  // ── Peer lifecycle ────────────────────────────────────────────────────────

  function createPeer(uid, initiator) {
    if (peers[uid]) return peers[uid];

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    peers[uid] = { pc };

    // Add our local tracks
    if (localStream) {
      localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
    }

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        WS.send('voice.ice', {
          channel_id: currentChannelId,
          target_user_id: uid,
          payload: e.candidate,
        });
      }
    };

    pc.ontrack = (e) => {
      upsertPeerTile(uid, e.streams[0]);
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        destroyPeer(uid);
        removePeerTile(uid);
      }
    };

    if (initiator) {
      pc.onnegotiationneeded = async () => {
        try {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          WS.send('voice.offer', {
            channel_id: currentChannelId,
            target_user_id: uid,
            payload: pc.localDescription,
          });
        } catch (e) {
          console.warn('voice offer create error:', e);
        }
      };
    }

    return peers[uid];
  }

  function destroyPeer(uid) {
    if (!peers[uid]) return;
    peers[uid].pc.close();
    delete peers[uid];
  }

  // ── UI ────────────────────────────────────────────────────────────────────

  function renderVoiceUI() {
    const panel = document.getElementById('voice-panel');
    if (!panel) return;
    panel.style.display = 'flex';

    const camIcon = videoTrackAvailable ? '📷' : '🚫';
    const camTitle = videoTrackAvailable ? 'Toggle Camera' : 'Camera unavailable (denied on join)';

    panel.innerHTML = `
      <div id="voice-grid"></div>
      <div id="voice-controls">
        <button id="vc-mic" class="vc-btn active" onclick="Voice.toggleMic()" title="Toggle Mic">
          <span class="vc-icon">🎙</span>
        </button>
        <button id="vc-cam" class="vc-btn${!videoTrackAvailable ? ' vc-disabled' : ''}"
          onclick="Voice.toggleCam()" title="${camTitle}">
          <span class="vc-icon">${camIcon}</span>
        </button>
        <button id="vc-leave" class="vc-btn vc-leave" onclick="Voice.leave()" title="Leave Voice">
          <span class="vc-icon">📵</span>
        </button>
      </div>
    `;

    upsertLocalTile();
    updateVoiceControls();
  }

  function hideVoiceUI() {
    const panel = document.getElementById('voice-panel');
    if (panel) {
      panel.style.display = 'none';
      panel.innerHTML = '';
    }
    document.getElementById('messages-container').style.display = '';
    document.getElementById('message-input-area').style.display = '';
    document.getElementById('typing-indicator').style.display = '';
    if (typeof renderChannelList === 'function') renderChannelList();
  }

  function attachLocalVideo() {
    const tile = document.getElementById('voice-tile-local');
    if (!tile || !localStream) return;

    const wrap = tile.querySelector('.vc-video-wrap');
    let vid = tile.querySelector('video');
    if (!vid && videoTrackAvailable) {
      vid = document.createElement('video');
      vid.autoplay = true;
      vid.muted = true; // always mute self to prevent echo
      vid.playsInline = true;
      wrap.appendChild(vid);
    }
    if (vid) {
      vid.srcObject = localStream;
      vid.style.display = camEnabled ? 'block' : 'none';
    }

    // Avatar visibility (inverse of video)
    const av = wrap.querySelector('.vc-avatar');
    if (av) av.style.display = camEnabled ? 'none' : 'flex';
  }

  function upsertLocalTile() {
    const grid = document.getElementById('voice-grid');
    if (!grid) return;
    let tile = document.getElementById('voice-tile-local');
    if (!tile) {
      tile = makeTile('local', App.user);
      grid.appendChild(tile);
    }
    attachLocalVideo();
  }

  function upsertPeerTile(uid, stream) {
    const grid = document.getElementById('voice-grid');
    if (!grid) return;

    let tile = document.getElementById(`voice-tile-${uid}`);
    if (!tile) {
      const member = App.members.find(m => m.id === uid) || { id: uid, username: uid.slice(0, 8) };
      tile = makeTile(uid, member);
      grid.appendChild(tile);
    }

    const wrap = tile.querySelector('.vc-video-wrap');
    let vid = tile.querySelector('video');
    if (!vid) {
      vid = document.createElement('video');
      vid.autoplay = true;
      vid.playsInline = true;
      wrap.appendChild(vid);
    }
    vid.srcObject = stream;

    // Show video when a video track is active, otherwise show avatar
    const av = wrap.querySelector('.vc-avatar');
    stream.onaddtrack = stream.onremovetrack = updateTileVideo;
    function updateTileVideo() {
      const hasVideo = stream.getVideoTracks().some(t => t.enabled && t.readyState === 'live');
      vid.style.display = hasVideo ? 'block' : 'none';
      if (av) av.style.display = hasVideo ? 'none' : 'flex';
    }
    updateTileVideo();
  }

  function removePeerTile(uid) {
    const tile = document.getElementById(`voice-tile-${uid}`);
    if (tile) tile.remove();
  }

  function makeTile(id, user) {
    const tile = document.createElement('div');
    tile.className = 'vc-tile';
    tile.id = `voice-tile-${id}`;

    const name = user?.username || '?';
    const initial = name[0].toUpperCase();
    const colors = ['#6c63ff', '#3fba7a', '#e05252', '#e0a030', '#3fa0e0', '#a052e0', '#e05290'];
    let hash = 0;
    for (const c of name) hash = c.charCodeAt(0) + ((hash << 5) - hash);
    const color = colors[Math.abs(hash) % colors.length];

    tile.innerHTML = `
      <div class="vc-video-wrap">
        <div class="vc-avatar" style="background:${color}">${initial}</div>
      </div>
      <div class="vc-name">${esc(name)}${id === 'local' ? ' (you)' : ''}</div>
    `;
    return tile;
  }

  function updateVoiceControls() {
    const micBtn = document.getElementById('vc-mic');
    const camBtn = document.getElementById('vc-cam');

    if (micBtn) {
      micBtn.classList.toggle('active', micEnabled);
      micBtn.classList.toggle('muted', !micEnabled);
      micBtn.title = micEnabled ? 'Mute Mic' : 'Unmute Mic';
      micBtn.querySelector('.vc-icon').textContent = micEnabled ? '🎙' : '🔇';
    }

    if (camBtn) {
      if (videoTrackAvailable) {
        camBtn.classList.toggle('active', camEnabled);
        camBtn.classList.remove('vc-disabled');
        camBtn.title = camEnabled ? 'Turn Off Camera' : 'Turn On Camera';
        camBtn.querySelector('.vc-icon').textContent = camEnabled ? '📷' : '📷';
      } else {
        camBtn.classList.remove('active');
        camBtn.classList.add('vc-disabled');
        camBtn.title = 'Camera unavailable — denied on join';
        camBtn.querySelector('.vc-icon').textContent = '🚫';
      }
    }
  }

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ── Register WS handlers ──────────────────────────────────────────────────

  function init() {
    WS.on('voice.room_state', onRoomState);
    WS.on('voice.joined', onUserJoined);
    WS.on('voice.left', onUserLeft);
    WS.on('voice.offer', onOffer);
    WS.on('voice.answer', onAnswer);
    WS.on('voice.ice', onIce);
  }

  function isInChannel(channelId) {
    return currentChannelId === channelId;
  }

  return { init, join, leave, toggleMic, toggleCam, isInChannel };
})();
