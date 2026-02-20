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

  // ── Loading screen (shown immediately while getUserMedia prompt is up) ──────
  function showVoiceLoadingUI(channelId) {
    // Hide text-channel UI
    document.getElementById('messages-container').style.display = 'none';
    document.getElementById('message-input-area').style.display = 'none';
    document.getElementById('typing-indicator').style.display = 'none';

    const panel = document.getElementById('voice-panel');
    panel.style.display = 'flex';
    panel.style.flexDirection = 'column';

    const ch = typeof App !== 'undefined' && App.channels
      ? (App.channels.find(c => c.id === channelId) || null) : null;
    const name = ch ? ch.name : 'voice';

    panel.innerHTML = `
      <div id="voice-loading">
        <div class="voice-loading-spinner"></div>
        <div class="voice-loading-title">Joining #${esc(name)}</div>
        <div class="voice-loading-sub">Requesting permissions…</div>
      </div>
    `;
  }

  // ── Sidebar voice-status-bar ───────────────────────────────────────────────
  function renderVoiceStatusBar() {
    const bar = document.getElementById('voice-status-bar');
    if (!bar) return;

    if (!currentChannelId) {
      bar.style.display = 'none';
      return;
    }

    const ch = typeof App !== 'undefined' && App.channels
      ? (App.channels.find(c => c.id === currentChannelId) || null) : null;
    const name = ch ? ch.name : 'Voice';

    document.getElementById('vsb-channel-label').textContent = name;
    bar.style.display = 'block';

    updateVoiceStatusBar();
  }

  function updateVoiceStatusBar() {
    const micBtn  = document.getElementById('vsb-mic');
    const deafBtn = document.getElementById('vsb-deaf');
    const camBtn  = document.getElementById('vsb-cam');
    if (!micBtn) return;

    micBtn.classList.toggle('active', micEnabled && !deafened);
    micBtn.classList.toggle('muted',  !micEnabled || deafened);
    micBtn.querySelector('span').textContent = (micEnabled && !deafened) ? '🎙' : '🔇';
    micBtn.title = micEnabled ? 'Mute Mic' : 'Unmute Mic';

    deafBtn.classList.toggle('active', !deafened);
    deafBtn.classList.toggle('muted',  deafened);
    deafBtn.querySelector('span').textContent = deafened ? '🔇' : '🔈';
    deafBtn.title = deafened ? 'Undeafen' : 'Deafen';

    if (camBtn) {
      if (!videoTrackAvailable) {
        camBtn.classList.remove('active', 'muted');
        camBtn.classList.add('vc-disabled');
        camBtn.querySelector('span').textContent = '🚫';
        camBtn.title = 'Camera unavailable';
      } else {
        camBtn.classList.remove('vc-disabled');
        camBtn.classList.toggle('active', camEnabled);
        camBtn.querySelector('span').textContent = '📷';
        camBtn.title = camEnabled ? 'Disable Camera' : 'Enable Camera';
      }
    }
  }

  async function join(channelId) {
    if (currentChannelId) await leave();
    if (!checkSecureContext()) return false;

    currentChannelId = channelId;
    videoTrackAvailable = false;
    deafened = false;

    // Show loading screen immediately — before the browser permission prompt.
    showVoiceLoadingUI(channelId);

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

    // Update loading sub-text while WebRTC negotiation starts
    const subEl = document.querySelector('.voice-loading-sub');
    if (subEl) subEl.textContent = 'Establishing connection…';

    renderVoiceUI();
    attachLocalVideo();
    renderVoiceStatusBar();

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

    // Clear sidebar status bar
    const bar = document.getElementById('voice-status-bar');
    if (bar) bar.style.display = 'none';

    // Remove split-view class if present
    document.getElementById('main')?.classList.remove('split-voice');
  }

  function toggleMic() {
    if (!localStream) return;
    micEnabled = !micEnabled;
    localStream.getAudioTracks().forEach(t => { t.enabled = micEnabled; });
    updateVoiceControls();
    updateVoiceStatusBar();
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
    updateVoiceStatusBar();
  }

  function toggleDeafen() {
    deafened = !deafened;
    // Mute/unmute audio on all remote tiles
    document.querySelectorAll('#voice-grid .vc-tile:not(#voice-tile-local) video').forEach(v => {
      v.muted = deafened;
    });
    updateVoiceControls();
    updateVoiceStatusBar();
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
    panel.style.flexDirection = 'column';

    const ch = typeof App !== 'undefined' && App.channels
      ? (App.channels.find(c => c.id === currentChannelId) || null) : null;
    const name = ch ? ch.name : 'Voice';

    // Panel header is shown only in split-view mode (CSS controls visibility).
    // Controls live in the sidebar #voice-status-bar.
    panel.innerHTML = `
      <div id="voice-panel-header">
        <div class="vp-channel-name">&#x1F50A; ${esc(name)}</div>
        <div class="vp-header-actions">
          <button class="vp-hdr-btn vp-fullscreen-btn" onclick="Voice.showFullView()" title="Expand to full view">&#x2922;</button>
          <button class="vp-hdr-btn" id="vp-collapse-btn" onclick="Voice.collapsePanel()" title="Collapse voice panel">&#x25BC;</button>
        </div>
      </div>
      <div id="voice-grid"></div>
    `;

    upsertLocalTile();
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
    // Controls are now in the sidebar status bar — delegate there.
    updateVoiceStatusBar();
  }

  // ── collapsePanel / showFullView ──────────────────────────────────────────
  function collapsePanel() {
    const panel = document.getElementById('voice-panel');
    if (!panel) return;
    const collapsed = panel.classList.toggle('vc-panel-collapsed');
    const btn = document.getElementById('vp-collapse-btn');
    if (btn) btn.title = collapsed ? 'Expand voice panel' : 'Collapse voice panel';
    if (btn) btn.textContent = collapsed ? '▲' : '▼';
  }

  // Navigate back to the full-screen voice view from split mode.
  function showFullView() {
    if (!currentChannelId) return;
    const main = document.getElementById('main');
    main.classList.remove('split-voice');
    document.getElementById('messages-container').style.display = 'none';
    document.getElementById('message-input-area').style.display = 'none';
    document.getElementById('typing-indicator').style.display = 'none';
    const panel = document.getElementById('voice-panel');
    if (panel) {
      panel.classList.remove('vc-panel-collapsed');
      panel.style.flex = '';
    }
    // Update header to reflect voice channel
    const ch = typeof App !== 'undefined' && App.channels
      ? (App.channels.find(c => c.id === currentChannelId) || null) : null;
    if (ch) {
      document.getElementById('ch-title').textContent = ch.name;
      document.getElementById('ch-desc').textContent = ch.description || 'Voice Channel';
      document.querySelector('.ch-hash').textContent = '🔊';
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

  function inCall() { return currentChannelId !== null; }
  return { init, join, leave, toggleMic, toggleCam, toggleDeafen, isInChannel, collapsePanel, showFullView, inCall };
})();
