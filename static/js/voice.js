// voice.js — WebRTC voice/video room manager for Nexus
// Mesh P2P topology. Server relays signaling only.

const Voice = (() => {
  // ── State ─────────────────────────────────────────────────────────────────
  let currentChannelId = null;
  let localStream = null;
  let micEnabled = true;
  let camEnabled = false;
  let deafened = false;
  let videoTrackAvailable = false;

  // peers: userId → { pc: RTCPeerConnection }
  const peers = {};

  // camStateByPeer: userId → bool — tracks whether each remote has cam on.
  // Maintained via voice.media_state signaling so we never rely on
  // WebRTC track.enabled (which reflects local state, not remote intent).
  const camStateByPeer = {};

  const ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ];

  // ── Secure context guard ──────────────────────────────────────────────────
  function checkSecureContext() {
    if (window.isSecureContext) return true;
    const host = location.hostname;
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true;
    const httpsUrl = 'https://' + location.hostname + ':8443' + location.pathname;
    toast(
      '🔒 Voice requires HTTPS. Open ' + httpsUrl + ' (accept the cert warning), then try again.',
      'error'
    );
    return false;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  async function join(channelId) {
    if (currentChannelId) await leave();
    if (!checkSecureContext()) return false;

    currentChannelId = channelId;
    videoTrackAvailable = false;
    deafened = false;

    // Request audio + video together — one browser prompt covers both.
    // If video is denied, fall back gracefully to audio-only.
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
      videoTrackAvailable = true;
      // Camera OFF by default — track stays in stream but disabled.
      // Peers will receive no video until user explicitly enables it.
      localStream.getVideoTracks().forEach(t => { t.enabled = false; });
    } catch {
      try {
        localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      } catch (aErr) {
        const msg = aErr.name === 'NotAllowedError'
          ? 'Microphone access denied. Allow microphone in browser/system settings.'
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

    WS.send('voice.join', { channel_id: channelId });
    return true;
  }

  async function leave() {
    if (!currentChannelId) return;
    const chId = currentChannelId;
    currentChannelId = null;

    WS.send('voice.leave', { channel_id: chId });

    for (const uid of Object.keys(peers)) destroyPeer(uid);
    for (const uid of Object.keys(camStateByPeer)) delete camStateByPeer[uid];

    if (localStream) {
      localStream.getTracks().forEach(t => t.stop());
      localStream = null;
    }

    videoTrackAvailable = false;
    camEnabled = false;
    deafened = false;

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

    // Renegotiate video track for existing peers if turning on
    if (camEnabled) {
      const videoTrack = localStream.getVideoTracks()[0];
      if (videoTrack) {
        for (const uid of Object.keys(peers)) {
          const sender = peers[uid].pc.getSenders().find(s => s.track?.kind === 'video');
          if (sender) sender.replaceTrack(videoTrack).catch(() => {});
        }
      }
    }

    // Announce new cam state to all room members
    sendMediaState();
    attachLocalVideo();
    updateVoiceControls();
  }

  function toggleDeafen() {
    deafened = !deafened;
    // Mute/unmute audio on all remote tiles
    document.querySelectorAll('#voice-grid .vc-tile:not(#voice-tile-local) video').forEach(v => {
      v.muted = deafened;
    });
    updateVoiceControls();
  }

  // Broadcast our current cam state to everyone else in the room
  function sendMediaState() {
    if (!currentChannelId) return;
    WS.send('voice.media_state', {
      channel_id: currentChannelId,
      cam_enabled: camEnabled,
    });
  }

  // ── WebSocket event handlers ──────────────────────────────────────────────

  function onRoomState(data) {
    if (data.channel_id !== currentChannelId) return;
    const participants = data.participants || [];
    for (const uid of participants) {
      if (uid !== App.user.id) createPeer(uid, true);
    }
    // Announce our cam state to existing participants
    if (participants.length > 0) sendMediaState();
  }

  function onUserJoined(data) {
    if (data.channel_id !== currentChannelId) return;
    if (data.user_id === App.user.id) return;
    createPeer(data.user_id, false);
    // Announce our cam state to the new arrival
    sendMediaState();
  }

  function onUserLeft(data) {
    if (data.user_id === App.user.id) return;
    destroyPeer(data.user_id);
    removePeerTile(data.user_id);
    delete camStateByPeer[data.user_id];
  }

  function onMediaState(data) {
    if (data.channel_id !== currentChannelId) return;
    const uid = data.from_user_id;
    camStateByPeer[uid] = data.cam_enabled;
    // Update that peer's tile to show video or avatar
    const tile = document.getElementById(`voice-tile-${uid}`);
    if (tile) applyVideoVisibility(tile, data.cam_enabled);
  }

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
    } catch (e) { console.warn('voice offer error:', e); }
  }

  async function onAnswer(data) {
    if (data.channel_id !== currentChannelId) return;
    const pc = peers[data.from_user_id]?.pc;
    if (!pc) return;
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(data.payload));
    } catch (e) { console.warn('voice answer error:', e); }
  }

  async function onIce(data) {
    if (data.channel_id !== currentChannelId) return;
    const pc = peers[data.from_user_id]?.pc;
    if (!pc || !data.payload) return;
    try { await pc.addIceCandidate(new RTCIceCandidate(data.payload)); } catch {}
  }

  // ── Peer lifecycle ────────────────────────────────────────────────────────

  function createPeer(uid, initiator) {
    if (peers[uid]) return peers[uid];

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    peers[uid] = { pc };

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
        } catch (e) { console.warn('voice offer create error:', e); }
      };
    }

    return peers[uid];
  }

  function destroyPeer(uid) {
    if (!peers[uid]) return;
    peers[uid].pc.close();
    delete peers[uid];
  }

  // ── UI helpers ────────────────────────────────────────────────────────────

  // Show video element and hide avatar, or vice versa
  function applyVideoVisibility(tile, showVideo) {
    const vid = tile.querySelector('video');
    const av = tile.querySelector('.vc-avatar');
    if (vid) vid.style.display = showVideo ? 'block' : 'none';
    if (av) av.style.display = showVideo ? 'none' : 'flex';
  }

  function renderVoiceUI() {
    const panel = document.getElementById('voice-panel');
    if (!panel) return;
    panel.style.display = 'flex';

    const camUnavailable = !videoTrackAvailable;
    panel.innerHTML = `
      <div id="voice-grid"></div>
      <div id="voice-controls">
        <button id="vc-mic"   class="vc-btn active"  onclick="Voice.toggleMic()"   title="Mute Mic"><span class="vc-icon">🎙</span></button>
        <button id="vc-deaf"  class="vc-btn"          onclick="Voice.toggleDeafen()" title="Deafen"><span class="vc-icon">🔈</span></button>
        <button id="vc-cam"   class="vc-btn${camUnavailable ? ' vc-disabled' : ''}"
          onclick="Voice.toggleCam()"
          title="${camUnavailable ? 'Camera unavailable' : 'Toggle Camera'}">
          <span class="vc-icon">${camUnavailable ? '🚫' : '📷'}</span>
        </button>
        <button id="vc-leave" class="vc-btn vc-leave" onclick="Voice.leave()"      title="Leave Voice"><span class="vc-icon">📵</span></button>
      </div>
    `;

    upsertLocalTile();
    updateVoiceControls();
  }

  function hideVoiceUI() {
    const panel = document.getElementById('voice-panel');
    if (panel) { panel.style.display = 'none'; panel.innerHTML = ''; }
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
    }

    // Visibility driven by camEnabled, not track state
    applyVideoVisibility(tile, camEnabled && videoTrackAvailable);
  }

  function upsertLocalTile() {
    const grid = document.getElementById('voice-grid');
    if (!grid) return;
    if (!document.getElementById('voice-tile-local')) {
      grid.appendChild(makeTile('local', App.user));
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

    // Attach the media stream to the video element, creating it if needed
    const wrap = tile.querySelector('.vc-video-wrap');
    let vid = tile.querySelector('video');
    if (!vid) {
      vid = document.createElement('video');
      vid.autoplay = true;
      vid.playsInline = true;
      vid.muted = deafened;
      wrap.appendChild(vid);
    }
    vid.srcObject = stream;

    // Initial visibility: show avatar until we get a media_state saying cam is on
    applyVideoVisibility(tile, camStateByPeer[uid] === true);
  }

  function removePeerTile(uid) {
    document.getElementById(`voice-tile-${uid}`)?.remove();
  }

  function makeTile(id, user) {
    const tile = document.createElement('div');
    tile.className = 'vc-tile';
    tile.id = `voice-tile-${id}`;

    const name = user?.username || '?';
    const initial = name[0].toUpperCase();

    // Use avatar image if available, else coloured initial
    let avatarInner;
    if (user?.avatar) {
      avatarInner = `<img src="${esc(user.avatar)}" alt="${esc(initial)}" class="vc-avatar-img">`;
    } else {
      const colors = ['#6c63ff', '#3fba7a', '#e05252', '#e0a030', '#3fa0e0', '#a052e0', '#e05290'];
      let hash = 0;
      for (const c of name) hash = c.charCodeAt(0) + ((hash << 5) - hash);
      const color = colors[Math.abs(hash) % colors.length];
      avatarInner = `<span class="vc-avatar-initial" style="background:${color}">${initial}</span>`;
    }

    tile.innerHTML = `
      <div class="vc-video-wrap">
        <div class="vc-avatar">${avatarInner}</div>
      </div>
      <div class="vc-name">${esc(name)}${id === 'local' ? ' <span class="vc-you">(you)</span>' : ''}</div>
    `;
    return tile;
  }

  function updateVoiceControls() {
    const micBtn  = document.getElementById('vc-mic');
    const deafBtn = document.getElementById('vc-deaf');
    const camBtn  = document.getElementById('vc-cam');

    if (micBtn) {
      micBtn.classList.toggle('active', micEnabled && !deafened);
      micBtn.classList.toggle('muted', !micEnabled || deafened);
      micBtn.title = micEnabled ? 'Mute Mic' : 'Unmute Mic';
      micBtn.querySelector('.vc-icon').textContent = (micEnabled && !deafened) ? '🎙' : '🔇';
    }

    if (deafBtn) {
      deafBtn.classList.toggle('active', !deafened);
      deafBtn.classList.toggle('muted', deafened);
      deafBtn.title = deafened ? 'Undeafen' : 'Deafen';
      deafBtn.querySelector('.vc-icon').textContent = deafened ? '🔇' : '🔈';
    }

    if (camBtn) {
      if (!videoTrackAvailable) {
        camBtn.classList.remove('active');
        camBtn.classList.add('vc-disabled');
        camBtn.querySelector('.vc-icon').textContent = '🚫';
      } else {
        camBtn.classList.remove('vc-disabled');
        camBtn.classList.toggle('active', camEnabled);
        camBtn.querySelector('.vc-icon').textContent = '📷';
      }
    }
  }

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ── Init ──────────────────────────────────────────────────────────────────

  function init() {
    WS.on('voice.room_state',  onRoomState);
    WS.on('voice.joined',      onUserJoined);
    WS.on('voice.left',        onUserLeft);
    WS.on('voice.media_state', onMediaState);
    WS.on('voice.offer',       onOffer);
    WS.on('voice.answer',      onAnswer);
    WS.on('voice.ice',         onIce);
  }

  function isInChannel(channelId) {
    return currentChannelId === channelId;
  }

  return { init, join, leave, toggleMic, toggleCam, toggleDeafen, isInChannel };
})();
