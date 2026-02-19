// voice.js — WebRTC voice/video room manager for Nexus
// Mesh P2P topology: each peer connects directly to every other peer.
// The server only relays signaling messages (offer/answer/ICE).

const Voice = (() => {
  // ── State ─────────────────────────────────────────────────────────────────
  let currentChannelId = null;
  let localStream = null;
  let micEnabled = true;
  let camEnabled = false;

  // peers: userId → { pc: RTCPeerConnection, stream: MediaStream|null }
  const peers = {};

  const ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ];

  // ── Public API ────────────────────────────────────────────────────────────

  async function join(channelId) {
    if (currentChannelId) await leave();

    currentChannelId = channelId;

    // Get local media (audio only by default; camera opt-in)
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    } catch (err) {
      toast('Microphone access denied', 'error');
      currentChannelId = null;
      return false;
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

    hideVoiceUI();
  }

  function toggleMic() {
    if (!localStream) return;
    micEnabled = !micEnabled;
    localStream.getAudioTracks().forEach(t => { t.enabled = micEnabled; });
    updateVoiceControls();
  }

  async function toggleCam() {
    if (!localStream) return;

    if (camEnabled) {
      // Turn camera off
      localStream.getVideoTracks().forEach(t => { t.stop(); localStream.removeTrack(t); });
      camEnabled = false;
      // Replace video track with null in all peers
      for (const uid of Object.keys(peers)) {
        const sender = peers[uid].pc.getSenders().find(s => s.track && s.track.kind === 'video');
        if (sender) sender.replaceTrack(null);
      }
    } else {
      // Turn camera on
      try {
        const camStream = await navigator.mediaDevices.getUserMedia({ video: true });
        const videoTrack = camStream.getVideoTracks()[0];
        localStream.addTrack(videoTrack);
        camEnabled = true;
        // Add/replace video track in all peers
        for (const uid of Object.keys(peers)) {
          const sender = peers[uid].pc.getSenders().find(s => s.track && s.track.kind === 'video');
          if (sender) {
            sender.replaceTrack(videoTrack);
          } else {
            peers[uid].pc.addTrack(videoTrack, localStream);
          }
        }
      } catch {
        toast('Camera access denied', 'error');
        return;
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
    // Initiate a connection to each existing participant
    for (const uid of participants) {
      if (uid !== App.user.id) {
        createPeer(uid, true); // polite=true means we make the offer
      }
    }
  }

  // A new user joined the room
  function onUserJoined(data) {
    if (data.channel_id !== currentChannelId) return;
    if (data.user_id === App.user.id) return;
    // They will initiate an offer to us, so we don't initiate
    createPeer(data.user_id, false);
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
    await pc.setRemoteDescription(new RTCSessionDescription(data.payload));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    WS.send('voice.answer', {
      channel_id: currentChannelId,
      target_user_id: uid,
      payload: pc.localDescription,
    });
  }

  // Incoming WebRTC answer
  async function onAnswer(data) {
    if (data.channel_id !== currentChannelId) return;
    const pc = peers[data.from_user_id]?.pc;
    if (!pc) return;
    await pc.setRemoteDescription(new RTCSessionDescription(data.payload));
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
    peers[uid] = { pc, stream: null };

    // Add our local tracks to the connection
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
      peers[uid].stream = e.streams[0];
      upsertPeerTile(uid, e.streams[0]);
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        destroyPeer(uid);
        removePeerTile(uid);
      }
    };

    if (initiator) {
      // Negotiation-needed fires after tracks are added
      pc.onnegotiationneeded = async () => {
        try {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          WS.send('voice.offer', {
            channel_id: currentChannelId,
            target_user_id: uid,
            payload: pc.localDescription,
          });
        } catch {}
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
    let panel = document.getElementById('voice-panel');
    if (!panel) return;
    panel.style.display = 'flex';
    panel.innerHTML = `
      <div id="voice-grid"></div>
      <div id="voice-controls">
        <button id="vc-mic" class="vc-btn active" onclick="Voice.toggleMic()" title="Toggle Mic">
          <span class="vc-icon">🎙</span>
        </button>
        <button id="vc-cam" class="vc-btn" onclick="Voice.toggleCam()" title="Toggle Camera">
          <span class="vc-icon">📷</span>
        </button>
        <button id="vc-leave" class="vc-btn vc-leave" onclick="Voice.leave()" title="Leave Voice">
          <span class="vc-icon">📵</span>
        </button>
      </div>
    `;

    // Add local tile
    upsertLocalTile();
    updateVoiceControls();
  }

  function hideVoiceUI() {
    const panel = document.getElementById('voice-panel');
    if (panel) {
      panel.style.display = 'none';
      panel.innerHTML = '';
    }
    // Show text chat UI back
    document.getElementById('messages-container').style.display = '';
    document.getElementById('message-input-area').style.display = '';
    document.getElementById('typing-indicator').style.display = '';
    // Update sidebar channel highlight
    if (typeof renderChannelList === 'function') renderChannelList();
  }

  function attachLocalVideo() {
    const tile = document.getElementById('voice-tile-local');
    if (!tile) return;
    let vid = tile.querySelector('video');
    if (!vid) {
      vid = document.createElement('video');
      vid.autoplay = true;
      vid.muted = true; // always mute local to prevent echo
      vid.playsInline = true;
      tile.querySelector('.vc-video-wrap').appendChild(vid);
    }
    vid.srcObject = localStream;
    // Show/hide video based on cam state
    vid.style.display = camEnabled ? 'block' : 'none';
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
      const member = App.members.find(m => m.id === uid) || { id: uid, username: uid.slice(0,8) };
      tile = makeTile(uid, member);
      grid.appendChild(tile);
    }

    let vid = tile.querySelector('video');
    if (!vid) {
      vid = document.createElement('video');
      vid.autoplay = true;
      vid.playsInline = true;
      tile.querySelector('.vc-video-wrap').appendChild(vid);
    }
    vid.srcObject = stream;

    const hasVideo = stream.getVideoTracks().some(t => t.enabled);
    vid.style.display = hasVideo ? 'block' : 'none';
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
    const colors = ['#6c63ff','#3fba7a','#e05252','#e0a030','#3fa0e0','#a052e0','#e05290'];
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
      camBtn.classList.toggle('active', camEnabled);
      camBtn.title = camEnabled ? 'Turn Off Camera' : 'Turn On Camera';
      camBtn.querySelector('.vc-icon').textContent = camEnabled ? '📷' : '🚫';
    }

    // Also update local tile to show/hide video
    attachLocalVideo();
  }

  function esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // ── Register WS handlers ──────────────────────────────────────────────────

  function init() {
    WS.on('voice.room_state', onRoomState);
    WS.on('voice.joined',     onUserJoined);
    WS.on('voice.left',       onUserLeft);
    WS.on('voice.offer',      onOffer);
    WS.on('voice.answer',     onAnswer);
    WS.on('voice.ice',        onIce);
  }

  function isInChannel(channelId) {
    return currentChannelId === channelId;
  }

  return { init, join, leave, toggleMic, toggleCam, isInChannel };
})();
