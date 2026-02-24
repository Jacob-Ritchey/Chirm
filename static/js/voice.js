// voice.js — WebRTC voice/video room manager for Chirm
// Mesh P2P topology. Server relays signaling only.
// V14: Opus codec tuning, per-user controls, focus mode, speaking indicators, screen sharing.

const Voice = (() => {
  // ── State ─────────────────────────────────────────────────────────────────
  let currentChannelId = null;
  let localStream = null;
  let micEnabled = true;
  let camEnabled = false;
  let deafened = false;
  let videoTrackAvailable = false;

  // Screen-share state
  let screenStream = null;
  let screenSharing = false;

  // Focus / spotlight state
  let focusedTileId = null;       // user-id or 'local' or 'screen-local' / 'screen-<uid>'
  let autoFocusSpeaker = false;   // auto-focus whoever is speaking

  // peers: userId → { pc, initiator }
  const peers = {};

  // camStateByPeer: userId → bool
  const camStateByPeer = {};
  // screenStateByPeer: userId → bool
  const screenStateByPeer = {};

  // Per-user local settings stored in localStorage
  const PEER_PREFS_KEY = 'chirm_voice_peer_prefs';

  // Audio analysers for speaking detection
  const audioAnalysers = {};
  let speakingCheckInterval = null;
  const SPEAKING_THRESHOLD = 25;

  const ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ];

  // ── Opus codec tuning ───────────────────────────────────────────────────
  // Prefer Opus and set higher bitrate for richer, less "tinny" audio.
  function preferOpusHighQuality(sdp) {
    const lines = sdp.split('\r\n');
    const result = [];

    // Collect Opus payload types
    const opusPTs = [];
    for (const l of lines) {
      const m = l.match(/^a=rtpmap:(\d+)\s+opus\//i);
      if (m) opusPTs.push(m[1]);
    }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Reorder audio m-line to put Opus first
      if (line.startsWith('m=audio')) {
        const parts = line.split(' ');
        const header = parts.slice(0, 3);
        const payloads = parts.slice(3);
        const reordered = [
          ...opusPTs.filter(pt => payloads.includes(pt)),
          ...payloads.filter(pt => !opusPTs.includes(pt)),
        ];
        result.push([...header, ...reordered].join(' '));
        continue;
      }

      // Enhance Opus fmtp with high-quality params
      if (line.startsWith('a=fmtp:')) {
        const fm = line.match(/^a=fmtp:(\d+)\s+(.*)/);
        if (fm && opusPTs.includes(fm[1])) {
          let params = fm[2];
          const hq = {
            'maxaveragebitrate': '128000',
            'stereo': '1',
            'sprop-stereo': '1',
            'useinbandfec': '1',
            'usedtx': '0',
            'maxplaybackrate': '48000',
          };
          for (const [k, v] of Object.entries(hq)) {
            const re = new RegExp(`${k}=\\d+`);
            if (re.test(params)) params = params.replace(re, `${k}=${v}`);
            else params += `;${k}=${v}`;
          }
          result.push(`a=fmtp:${fm[1]} ${params}`);
          continue;
        }
      }

      result.push(line);
    }
    return result.join('\r\n');
  }

  // ── Per-user preferences (localStorage) ─────────────────────────────────
  function loadPeerPrefs() {
    try { return JSON.parse(localStorage.getItem(PEER_PREFS_KEY) || '{}'); }
    catch { return {}; }
  }
  function savePeerPrefs(p) {
    try { localStorage.setItem(PEER_PREFS_KEY, JSON.stringify(p)); } catch {}
  }
  function getPeerPref(uid) {
    return loadPeerPrefs()[uid] || { volume: 100, muted: false, videoHidden: false };
  }
  function setPeerPref(uid, partial) {
    const all = loadPeerPrefs();
    all[uid] = { ...getPeerPref(uid), ...partial };
    savePeerPrefs(all);
  }

  function applyPeerAudioPrefs(uid) {
    const pref = getPeerPref(uid);
    const tile = document.getElementById(`voice-tile-${uid}`);
    if (!tile) return;
    const aud = tile.querySelector('audio');
    if (!aud) return;
    aud.volume = pref.muted ? 0 : Math.min(pref.volume / 100, 2.0);
    aud.muted = deafened || pref.muted;
  }

  function applyPeerVideoHiddenPref(uid) {
    const pref = getPeerPref(uid);
    const tile = document.getElementById(`voice-tile-${uid}`);
    if (!tile) return;
    applyVideoVisibility(tile, pref.videoHidden ? false : (camStateByPeer[uid] === true));
  }

  // ── Secure context guard ────────────────────────────────────────────────
  function checkSecureContext() {
    if (window.isSecureContext) return true;
    const host = location.hostname;
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true;
    toast('🔒 Voice requires HTTPS. Open https://' + location.hostname + ':8443' + location.pathname + ' (accept the cert warning), then try again.', 'error');
    return false;
  }

  // ── Loading screen ──────────────────────────────────────────────────────
  function showVoiceLoadingUI(channelId) {
    document.getElementById('messages-container').style.display = 'none';
    document.getElementById('message-input-area').style.display = 'none';
    document.getElementById('typing-indicator').style.display = 'none';
    const panel = document.getElementById('voice-panel');
    panel.style.display = 'flex';
    panel.style.flexDirection = 'column';
    const ch = typeof App !== 'undefined' && App.channels
      ? (App.channels.find(c => c.id === channelId) || null) : null;
    panel.innerHTML = `
      <div id="voice-loading">
        <div class="voice-loading-spinner"></div>
        <div class="voice-loading-title">Joining #${esc(ch ? ch.name : 'voice')}</div>
        <div class="voice-loading-sub">Requesting permissions…</div>
      </div>`;
  }

  // ── Sidebar voice-status-bar ────────────────────────────────────────────
  function renderVoiceStatusBar() {
    const bar = document.getElementById('voice-status-bar');
    if (!bar) return;
    if (!currentChannelId) { bar.style.display = 'none'; return; }
    const ch = typeof App !== 'undefined' && App.channels
      ? (App.channels.find(c => c.id === currentChannelId) || null) : null;
    document.getElementById('vsb-channel-label').textContent = ch ? ch.name : 'Voice';
    bar.style.display = 'block';
    updateVoiceStatusBar();
  }

  function updateVoiceStatusBar() {
    const micBtn  = document.getElementById('vsb-mic');
    const deafBtn = document.getElementById('vsb-deaf');
    const camBtn  = document.getElementById('vsb-cam');
    const scrBtn  = document.getElementById('vsb-screen');
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

    if (scrBtn) {
      // Hide entirely if getDisplayMedia is not supported (mobile, older browsers)
      if (!navigator.mediaDevices?.getDisplayMedia) {
        scrBtn.style.display = 'none';
      } else {
        scrBtn.style.display = '';
        scrBtn.classList.toggle('active', screenSharing);
        scrBtn.querySelector('span').textContent = '🖥';
        scrBtn.title = screenSharing ? 'Stop Sharing' : 'Share Screen';
      }
    }
  }

  // ── Join / Leave ────────────────────────────────────────────────────────
  async function join(channelId) {
    if (currentChannelId) await leave();
    if (!checkSecureContext()) return false;

    currentChannelId = channelId;
    videoTrackAvailable = false;
    deafened = false;
    focusedTileId = null;
    autoFocusSpeaker = false;

    showVoiceLoadingUI(channelId);

    try {
      localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
      videoTrackAvailable = true;
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

    const subEl = document.querySelector('.voice-loading-sub');
    if (subEl) subEl.textContent = 'Establishing connection…';

    renderVoiceUI();
    attachLocalVideo();
    renderVoiceStatusBar();
    startSpeakingDetection();

    WS.send('voice.join', { channel_id: channelId });
    return true;
  }

  async function leave() {
    if (!currentChannelId) return;
    const chId = currentChannelId;
    currentChannelId = null;

    if (screenSharing) stopScreenShare();

    WS.send('voice.leave', { channel_id: chId });

    for (const uid of Object.keys(peers)) destroyPeer(uid);
    for (const uid of Object.keys(camStateByPeer)) delete camStateByPeer[uid];
    for (const uid of Object.keys(screenStateByPeer)) delete screenStateByPeer[uid];

    if (localStream) {
      localStream.getTracks().forEach(t => t.stop());
      localStream = null;
    }

    videoTrackAvailable = false;
    camEnabled = false;
    deafened = false;
    focusedTileId = null;

    stopSpeakingDetection();
    hideVoiceUI();

    const bar = document.getElementById('voice-status-bar');
    if (bar) bar.style.display = 'none';
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
    if (camEnabled) {
      const vt = localStream.getVideoTracks()[0];
      if (vt) {
        for (const uid of Object.keys(peers)) {
          const s = peers[uid].pc.getSenders().find(s => s.track?.kind === 'video');
          if (s) s.replaceTrack(vt).catch(() => {});
        }
      }
    }
    sendMediaState();
    attachLocalVideo();
    updateVoiceControls();
    updateVoiceStatusBar();
  }

  function toggleDeafen() {
    deafened = !deafened;
    document.querySelectorAll('#voice-grid .vc-tile:not(#voice-tile-local) audio').forEach(a => {
      const uid = a.closest('.vc-tile')?.id?.replace('voice-tile-', '');
      if (uid) {
        const pref = getPeerPref(uid);
        a.muted = deafened || pref.muted;
      } else {
        a.muted = deafened;
      }
    });
    updateVoiceControls();
    updateVoiceStatusBar();
  }

  function sendMediaState() {
    if (!currentChannelId) return;
    WS.send('voice.media_state', {
      channel_id: currentChannelId,
      cam_enabled: camEnabled,
      screen_sharing: screenSharing,
    });
  }

  // ── Screen Sharing ──────────────────────────────────────────────────────
  async function toggleScreenShare() {
    if (screenSharing) stopScreenShare();
    else await startScreenShare();
  }

  async function startScreenShare() {
    if (!currentChannelId || screenSharing) return;
    if (!navigator.mediaDevices?.getDisplayMedia) {
      toast('Screen sharing is not supported on this device or browser.', 'error');
      return;
    }
    try {
      screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: { cursor: 'always' },
        audio: true,
      });
    } catch (err) {
      if (err.name !== 'NotAllowedError') toast('Could not start screen share: ' + err.message, 'error');
      return;
    }

    screenSharing = true;

    // Browser stop-sharing button
    screenStream.getVideoTracks()[0].addEventListener('ended', () => stopScreenShare());

    // Add screen tracks to all peer connections
    for (const uid of Object.keys(peers)) {
      const pc = peers[uid].pc;
      for (const track of screenStream.getTracks()) pc.addTrack(track, screenStream);
    }

    // Local screen tile
    upsertScreenTile('local', App.user, screenStream);
    sendMediaState();
    updateVoiceStatusBar();

    // Force renegotiation with non-initiator peers — onnegotiationneeded only fires
    // for initiator PCs, so non-initiator peers would never receive the
    // new screen share tracks without an explicit offer.
    for (const uid of Object.keys(peers)) {
      if (!peers[uid].initiator) triggerRenegotiation(uid);
    }
  }

  function stopScreenShare() {
    if (!screenSharing) return;
    screenSharing = false;

    if (screenStream) {
      // Collect track IDs before stopping so we can match senders
      const screenTrackIds = new Set(screenStream.getTracks().map(t => t.id));

      // Remove senders from peer connections BEFORE stopping tracks
      for (const uid of Object.keys(peers)) {
        const pc = peers[uid].pc;
        for (const sender of pc.getSenders()) {
          if (sender.track && screenTrackIds.has(sender.track.id)) {
            try { pc.removeTrack(sender); } catch {}
          }
        }
      }

      // Now stop the tracks
      screenStream.getTracks().forEach(t => t.stop());
      screenStream = null;
    }

    // Use removeScreenTile for proper focus cleanup
    removeScreenTile('local');
    sendMediaState();
    updateVoiceStatusBar();

    // Renegotiate with non-initiator peers so they receive the updated
    // track list. Initiators will auto-fire onnegotiationneeded.
    for (const uid of Object.keys(peers)) {
      if (!peers[uid].initiator) triggerRenegotiation(uid);
    }
  }

  function triggerRenegotiation(uid) {
    const pc = peers[uid]?.pc;
    if (!pc) return;
    // Avoid glare: only send offer if signaling state is stable
    if (pc.signalingState !== 'stable') {
      console.log(`[voice] Skipping renegotiation with ${uid} — state is ${pc.signalingState}`);
      return;
    }
    pc.createOffer().then(o => {
      const sdp = preferOpusHighQuality(o.sdp);
      return pc.setLocalDescription({ type: o.type, sdp });
    }).then(() => {
      WS.send('voice.offer', {
        channel_id: currentChannelId,
        target_user_id: uid,
        payload: { type: pc.localDescription.type, sdp: pc.localDescription.sdp },
      });
    }).catch(e => console.warn('renegotiation error:', e));
  }

  // ── WebSocket event handlers ──────────────────────────────────────────

  function onRoomState(data) {
    if (data.channel_id !== currentChannelId) return;
    const participants = data.participants || [];
    for (const uid of participants) {
      if (uid !== App.user.id) createPeer(uid, true);
    }
    if (participants.length > 0) sendMediaState();
  }

  function onUserJoined(data) {
    if (data.channel_id !== currentChannelId) return;
    if (data.user_id === App.user.id) return;
    createPeer(data.user_id, false);
    sendMediaState();
  }

  function onUserLeft(data) {
    if (data.user_id === App.user.id) return;
    destroyPeer(data.user_id);
    removePeerTile(data.user_id);
    removeScreenTile(data.user_id);
    delete camStateByPeer[data.user_id];
    delete screenStateByPeer[data.user_id];
    destroyAudioAnalyser(data.user_id);
  }

  function onMediaState(data) {
    if (data.channel_id !== currentChannelId) return;
    const uid = data.from_user_id;
    camStateByPeer[uid] = data.cam_enabled;
    const wasScreenSharing = screenStateByPeer[uid];
    screenStateByPeer[uid] = data.screen_sharing || false;

    const tile = document.getElementById(`voice-tile-${uid}`);
    if (tile) {
      const pref = getPeerPref(uid);
      applyVideoVisibility(tile, pref.videoHidden ? false : data.cam_enabled);
    }

    // Remote screen share ended
    if (wasScreenSharing && !data.screen_sharing) removeScreenTile(uid);
  }

  async function onOffer(data) {
    if (data.channel_id !== currentChannelId) return;
    const uid = data.from_user_id;
    if (!peers[uid]) createPeer(uid, false);
    const pc = peers[uid].pc;
    try {
      await pc.setRemoteDescription(new RTCSessionDescription({
        type: data.payload.type,
        sdp: preferOpusHighQuality(data.payload.sdp),
      }));
      const answer = await pc.createAnswer();
      const sdp = preferOpusHighQuality(answer.sdp);
      await pc.setLocalDescription({ type: answer.type, sdp });
      WS.send('voice.answer', {
        channel_id: currentChannelId,
        target_user_id: uid,
        payload: { type: pc.localDescription.type, sdp: pc.localDescription.sdp },
      });
    } catch (e) { console.warn('voice offer error:', e); }
  }

  async function onAnswer(data) {
    if (data.channel_id !== currentChannelId) return;
    const pc = peers[data.from_user_id]?.pc;
    if (!pc) return;
    try {
      await pc.setRemoteDescription(new RTCSessionDescription({
        type: data.payload.type,
        sdp: preferOpusHighQuality(data.payload.sdp),
      }));
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
    peers[uid] = { pc, initiator };

    if (localStream) {
      localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
    }

    // Also add screen share tracks if currently sharing
    if (screenSharing && screenStream) {
      screenStream.getTracks().forEach(track => pc.addTrack(track, screenStream));
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

    // Track incoming media — distinguish camera from screen share
    // We store the original stream ID on elements so we can reliably
    // detect when a second, different stream arrives.
    pc.ontrack = (e) => {
      const incomingStreamId = e.streams[0]?.id || null;

      if (e.track.kind === 'audio') {
        const existingTile = document.getElementById(`voice-tile-${uid}`);
        const existingAud = existingTile?.querySelector('audio');
        const origStreamId = existingAud?.dataset?.origStreamId;

        if (origStreamId && incomingStreamId && incomingStreamId !== origStreamId) {
          // Second audio stream → screen share audio
          upsertScreenAudio(uid, e.track);
        } else {
          upsertPeerAudio(uid, e.track);
          // Tag the audio element with the original stream ID
          const tile = document.getElementById(`voice-tile-${uid}`);
          const aud = tile?.querySelector('audio');
          if (aud && incomingStreamId) aud.dataset.origStreamId = incomingStreamId;
          setupAudioAnalyser(uid, e.track);
        }
      } else {
        const existingTile = document.getElementById(`voice-tile-${uid}`);
        const existingVid = existingTile?.querySelector('video');
        const origStreamId = existingVid?.dataset?.origStreamId;

        if (origStreamId && incomingStreamId && incomingStreamId !== origStreamId) {
          // Second video stream → screen share
          screenStateByPeer[uid] = true;
          upsertScreenTile(uid, null, e.streams[0]);
        } else {
          upsertPeerTile(uid, e.streams[0]);
          // Tag the video element with the original stream ID
          const tile = document.getElementById(`voice-tile-${uid}`);
          const vid = tile?.querySelector('video');
          if (vid && incomingStreamId) vid.dataset.origStreamId = incomingStreamId;
        }
      }
    };

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      if (state === 'failed') {
        console.warn(`[voice] ICE failed for peer ${uid} — scheduling reconnect`);
        const wasInit = peers[uid]?.initiator;
        destroyPeer(uid);
        if (currentChannelId) {
          setTimeout(() => {
            if (currentChannelId) createPeer(uid, wasInit);
          }, 1500);
        }
      } else if (state === 'closed') {
        destroyPeer(uid);
        removePeerTile(uid);
      }
    };

    if (initiator) {
      pc.onnegotiationneeded = async () => {
        try {
          const offer = await pc.createOffer();
          const sdp = preferOpusHighQuality(offer.sdp);
          await pc.setLocalDescription({ type: offer.type, sdp });
          WS.send('voice.offer', {
            channel_id: currentChannelId,
            target_user_id: uid,
            payload: { type: pc.localDescription.type, sdp: pc.localDescription.sdp },
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
    destroyAudioAnalyser(uid);

    // Clear stream ID tags on the tile so reconnection doesn't
    // mistake the new camera stream for a screen share
    const tile = document.getElementById(`voice-tile-${uid}`);
    if (tile) {
      const vid = tile.querySelector('video');
      const aud = tile.querySelector('audio');
      if (vid) delete vid.dataset.origStreamId;
      if (aud) delete aud.dataset.origStreamId;
    }
  }

  // ── Speaking Detection ──────────────────────────────────────────────────
  function setupAudioAnalyser(uid, audioTrack) {
    destroyAudioAnalyser(uid);
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const src = ctx.createMediaStreamSource(new MediaStream([audioTrack]));
      const an = ctx.createAnalyser();
      an.fftSize = 256;
      an.smoothingTimeConstant = 0.5;
      src.connect(an);
      audioAnalysers[uid] = { analyser: an, dataArray: new Uint8Array(an.frequencyBinCount), audioCtx: ctx, source: src };
    } catch {}
  }

  function setupLocalAudioAnalyser() {
    destroyAudioAnalyser('local');
    if (!localStream) return;
    const at = localStream.getAudioTracks()[0];
    if (!at) return;
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const src = ctx.createMediaStreamSource(new MediaStream([at]));
      const an = ctx.createAnalyser();
      an.fftSize = 256;
      an.smoothingTimeConstant = 0.5;
      src.connect(an);
      audioAnalysers['local'] = { analyser: an, dataArray: new Uint8Array(an.frequencyBinCount), audioCtx: ctx, source: src };
    } catch {}
  }

  function destroyAudioAnalyser(uid) {
    const a = audioAnalysers[uid];
    if (!a) return;
    try { a.source.disconnect(); } catch {}
    try { a.audioCtx.close(); } catch {}
    delete audioAnalysers[uid];
  }

  function startSpeakingDetection() {
    setupLocalAudioAnalyser();
    if (speakingCheckInterval) clearInterval(speakingCheckInterval);
    speakingCheckInterval = setInterval(checkSpeaking, 150);
  }

  function stopSpeakingDetection() {
    if (speakingCheckInterval) { clearInterval(speakingCheckInterval); speakingCheckInterval = null; }
    for (const uid of Object.keys(audioAnalysers)) destroyAudioAnalyser(uid);
    document.querySelectorAll('.vc-tile.vc-speaking').forEach(t => t.classList.remove('vc-speaking'));
  }

  function checkSpeaking() {
    let loudestUid = null, loudestLevel = 0;

    for (const [uid, a] of Object.entries(audioAnalysers)) {
      a.analyser.getByteFrequencyData(a.dataArray);
      let sum = 0;
      for (let i = 0; i < a.dataArray.length; i++) sum += a.dataArray[i];
      const avg = sum / a.dataArray.length;

      const tile = document.getElementById(`voice-tile-${uid}`);
      if (tile) {
        const speaking = avg > SPEAKING_THRESHOLD;
        if (uid === 'local' && (!micEnabled || deafened)) {
          tile.classList.remove('vc-speaking');
        } else {
          tile.classList.toggle('vc-speaking', speaking);
        }
        if (speaking && avg > loudestLevel) {
          loudestLevel = avg;
          loudestUid = uid;
        }
      }
    }

    if (autoFocusSpeaker && loudestUid && loudestLevel > SPEAKING_THRESHOLD * 1.5) {
      if (focusedTileId !== loudestUid) setFocus(loudestUid);
    }
  }

  // ── Focus / Spotlight ───────────────────────────────────────────────────
  function setFocus(tileId) {
    const grid = document.getElementById('voice-grid');
    if (!grid) return;

    if (focusedTileId === tileId) {
      // Unfocus
      focusedTileId = null;
      grid.classList.remove('vc-focus-mode');
      grid.querySelectorAll('.vc-tile').forEach(t => t.classList.remove('vc-focused', 'vc-unfocused'));
      return;
    }

    focusedTileId = tileId;
    grid.classList.add('vc-focus-mode');
    grid.querySelectorAll('.vc-tile').forEach(t => {
      const id = t.id.replace('voice-tile-', '');
      t.classList.toggle('vc-focused', id === tileId);
      t.classList.toggle('vc-unfocused', id !== tileId);
    });
  }

  function toggleAutoFocus() {
    autoFocusSpeaker = !autoFocusSpeaker;
    const btn = document.getElementById('vp-autofocus-btn');
    if (btn) {
      btn.classList.toggle('active', autoFocusSpeaker);
      btn.title = autoFocusSpeaker ? 'Auto-focus: ON' : 'Auto-focus: OFF';
    }
    if (!autoFocusSpeaker && focusedTileId) setFocus(focusedTileId); // toggle off = unfocus
  }

  // ── UI helpers ────────────────────────────────────────────────────────

  function applyVideoVisibility(tile, show) {
    const vid = tile.querySelector('video');
    const av  = tile.querySelector('.vc-avatar');
    if (vid) vid.style.display = show ? 'block' : 'none';
    if (av)  av.style.display  = show ? 'none'  : 'flex';
  }

  function renderVoiceUI() {
    const panel = document.getElementById('voice-panel');
    if (!panel) return;
    panel.style.display = 'flex';
    panel.style.flexDirection = 'column';

    const ch = typeof App !== 'undefined' && App.channels
      ? (App.channels.find(c => c.id === currentChannelId) || null) : null;
    const name = ch ? ch.name : 'Voice';

    panel.innerHTML = `
      <div id="voice-panel-header">
        <div class="vp-channel-name">&#x1F50A; ${esc(name)}</div>
        <div class="vp-header-actions">
          <button class="vp-hdr-btn" id="vp-autofocus-btn" onclick="Voice.toggleAutoFocus()" title="Auto-focus: OFF">&#x1F50D;</button>
          <button class="vp-hdr-btn vp-fullscreen-btn" onclick="Voice.showFullView()" title="Expand to full view">&#x2922;</button>
          <button class="vp-hdr-btn" id="vp-collapse-btn" onclick="Voice.collapsePanel()" title="Collapse voice panel">&#x25BC;</button>
        </div>
      </div>
      <div id="voice-grid"></div>`;

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
      vid.muted = true;
      vid.playsInline = true;
      wrap.appendChild(vid);
    }
    if (vid) {
      vid.srcObject = localStream;
      vid.play().catch(() => {});
    }
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
      if (focusedTileId) {
        tile.classList.add(uid === focusedTileId ? 'vc-focused' : 'vc-unfocused');
      }
    }

    const wrap = tile.querySelector('.vc-video-wrap');
    let vid = tile.querySelector('video');
    if (!vid) {
      vid = document.createElement('video');
      vid.autoplay = true; vid.playsInline = true; vid.muted = true;
      wrap.appendChild(vid);
    }
    if (stream) {
      const vt = stream.getVideoTracks();
      if (vt.length > 0) {
        vid.srcObject = new MediaStream(vt);
        vid.play().catch(() => {});
      }
    }

    const pref = getPeerPref(uid);
    applyVideoVisibility(tile, pref.videoHidden ? false : (camStateByPeer[uid] === true));
  }

  function upsertPeerAudio(uid, audioTrack) {
    let tile = document.getElementById(`voice-tile-${uid}`);
    if (!tile) {
      const member = App.members.find(m => m.id === uid) || { id: uid, username: uid.slice(0, 8) };
      tile = makeTile(uid, member);
      const grid = document.getElementById('voice-grid');
      if (grid) grid.appendChild(tile);
      const pref = getPeerPref(uid);
      applyVideoVisibility(tile, pref.videoHidden ? false : (camStateByPeer[uid] === true));
    }

    let aud = tile.querySelector('audio');
    if (!aud) {
      aud = document.createElement('audio');
      aud.autoplay = true;
      aud.playsInline = true;
      tile.appendChild(aud);
    }

    const pref = getPeerPref(uid);
    aud.muted = deafened || pref.muted;
    aud.volume = pref.muted ? 0 : Math.min(pref.volume / 100, 2.0);

    aud.pause();
    aud.srcObject = new MediaStream([audioTrack]);
    aud.play().catch(() => {});
  }

  function removePeerTile(uid) {
    document.getElementById(`voice-tile-${uid}`)?.remove();
    if (focusedTileId === uid) {
      focusedTileId = null;
      const grid = document.getElementById('voice-grid');
      if (grid) {
        grid.classList.remove('vc-focus-mode');
        grid.querySelectorAll('.vc-tile').forEach(t => t.classList.remove('vc-focused', 'vc-unfocused'));
      }
    }
  }

  // ── Screen share tiles ──────────────────────────────────────────────────
  function upsertScreenTile(uid, user, stream) {
    const grid = document.getElementById('voice-grid');
    if (!grid) return;
    const tileId = `screen-${uid}`;
    let tile = document.getElementById(`voice-tile-${tileId}`);
    if (!tile) {
      const member = user || App.members.find(m => m.id === uid) || { id: uid, username: uid.slice(0, 8) };
      tile = document.createElement('div');
      tile.className = 'vc-tile vc-screen-tile';
      tile.id = `voice-tile-${tileId}`;
      tile.addEventListener('click', () => setFocus(tileId));
      tile.innerHTML = `
        <div class="vc-video-wrap">
          <div class="vc-avatar"><span class="vc-avatar-initial" style="background:#5865F2">🖥</span></div>
        </div>
        <div class="vc-name">🖥 ${esc(member?.username || '?')}'s Screen</div>`;
      grid.insertBefore(tile, grid.firstChild);
    }
    if (stream) {
      const wrap = tile.querySelector('.vc-video-wrap');
      let vid = tile.querySelector('video');
      if (!vid) {
        vid = document.createElement('video');
        vid.autoplay = true; vid.playsInline = true;
        vid.muted = (uid === 'local');
        wrap.appendChild(vid);
      }
      vid.srcObject = stream;
      vid.play().catch(() => {});
      applyVideoVisibility(tile, true);
    }
    // Auto-focus screen share
    if (!focusedTileId) setFocus(tileId);
  }

  function upsertScreenAudio(uid, audioTrack) {
    const tile = document.getElementById(`voice-tile-screen-${uid}`);
    if (!tile) return;
    let aud = tile.querySelector('audio');
    if (!aud) {
      aud = document.createElement('audio');
      aud.autoplay = true; aud.playsInline = true;
      tile.appendChild(aud);
    }
    aud.pause();
    aud.srcObject = new MediaStream([audioTrack]);
    aud.play().catch(() => {});
  }

  function removeScreenTile(uid) {
    const tileId = `screen-${uid}`;
    document.getElementById(`voice-tile-${tileId}`)?.remove();
    if (focusedTileId === tileId) {
      focusedTileId = null;
      const grid = document.getElementById('voice-grid');
      if (grid) {
        grid.classList.remove('vc-focus-mode');
        grid.querySelectorAll('.vc-tile').forEach(t => t.classList.remove('vc-focused', 'vc-unfocused'));
      }
    }
  }

  // ── Tile creation ─────────────────────────────────────────────────────
  function makeTile(id, user) {
    const tile = document.createElement('div');
    tile.className = 'vc-tile';
    tile.id = `voice-tile-${id}`;

    const name = user?.username || '?';
    const initial = name[0].toUpperCase();

    let avatarInner;
    if (user?.avatar) {
      avatarInner = `<img src="${esc(user.avatar)}" alt="${esc(initial)}" class="vc-avatar-img">`;
    } else {
      const colors = ['#6c63ff', '#3fba7a', '#e05252', '#e0a030', '#3fa0e0', '#a052e0', '#e05290'];
      let hash = 0;
      for (const c of name) hash = c.charCodeAt(0) + ((hash << 5) - hash);
      avatarInner = `<span class="vc-avatar-initial" style="background:${colors[Math.abs(hash) % colors.length]}">${initial}</span>`;
    }

    const isLocal = id === 'local';
    const peerControls = isLocal ? '' : `
      <div class="vc-peer-controls" data-uid="${esc(id)}">
        <button class="vc-peer-btn vc-peer-vol-btn" onclick="event.stopPropagation(); Voice.showPeerVolume('${esc(id)}')" title="Volume">🔊</button>
        <button class="vc-peer-btn vc-peer-vidhide-btn" onclick="event.stopPropagation(); Voice.togglePeerVideoHide('${esc(id)}')" title="Hide Video">📹</button>
      </div>`;

    tile.innerHTML = `
      <div class="vc-video-wrap">
        <div class="vc-avatar">${avatarInner}</div>
        ${peerControls}
      </div>
      <div class="vc-name">${esc(name)}${isLocal ? ' <span class="vc-you">(you)</span>' : ''}</div>`;

    tile.addEventListener('click', () => setFocus(id));

    if (!isLocal) updatePeerControlState(tile, id);

    return tile;
  }

  function updatePeerControlState(tile, uid) {
    const pref = getPeerPref(uid);
    const vb = tile.querySelector('.vc-peer-vidhide-btn');
    if (vb) {
      vb.classList.toggle('vc-peer-btn-active', pref.videoHidden);
      vb.title = pref.videoHidden ? 'Show Video' : 'Hide Video';
    }
  }

  // ── Per-user volume popup ─────────────────────────────────────────────
  function showPeerVolume(uid) {
    document.querySelector('.vc-vol-popup')?.remove();
    const tile = document.getElementById(`voice-tile-${uid}`);
    if (!tile) return;

    const pref = getPeerPref(uid);
    const member = App.members.find(m => m.id === uid) || { username: uid.slice(0, 8) };

    const popup = document.createElement('div');
    popup.className = 'vc-vol-popup';
    popup.onclick = (e) => e.stopPropagation();
    popup.innerHTML = `
      <div class="vc-vol-header">
        <span>${esc(member.username)}</span>
        <button class="vc-vol-close" onclick="document.querySelector('.vc-vol-popup')?.remove()">✕</button>
      </div>
      <div class="vc-vol-row">
        <button class="vc-vol-mute-btn ${pref.muted ? 'vc-vol-muted' : ''}" onclick="Voice.togglePeerMute('${esc(uid)}')" title="${pref.muted ? 'Unmute' : 'Mute'}">
          ${pref.muted ? '🔇' : '🔊'}
        </button>
        <input type="range" class="vc-vol-slider" min="0" max="200" value="${pref.muted ? 0 : pref.volume}"
               oninput="Voice.setPeerVolume('${esc(uid)}', this.value)">
        <span class="vc-vol-label">${pref.muted ? '0' : pref.volume}%</span>
      </div>`;

    tile.querySelector('.vc-video-wrap').appendChild(popup);

    const close = (e) => {
      if (!popup.contains(e.target)) { popup.remove(); document.removeEventListener('click', close); }
    };
    setTimeout(() => document.addEventListener('click', close), 10);
  }

  function setPeerVolume(uid, value) {
    const vol = parseInt(value, 10);
    const muted = vol === 0;
    setPeerPref(uid, { volume: vol || 0, muted });
    const popup = document.querySelector('.vc-vol-popup');
    if (popup) {
      const l = popup.querySelector('.vc-vol-label');
      if (l) l.textContent = vol + '%';
      const mb = popup.querySelector('.vc-vol-mute-btn');
      if (mb) { mb.classList.toggle('vc-vol-muted', muted); mb.textContent = muted ? '🔇' : '🔊'; }
    }
    applyPeerAudioPrefs(uid);
  }

  function togglePeerMute(uid) {
    const pref = getPeerPref(uid);
    const m = !pref.muted;
    setPeerPref(uid, { muted: m });
    const popup = document.querySelector('.vc-vol-popup');
    if (popup) {
      const s = popup.querySelector('.vc-vol-slider');
      const l = popup.querySelector('.vc-vol-label');
      const b = popup.querySelector('.vc-vol-mute-btn');
      if (s) s.value = m ? 0 : pref.volume;
      if (l) l.textContent = (m ? 0 : pref.volume) + '%';
      if (b) { b.classList.toggle('vc-vol-muted', m); b.textContent = m ? '🔇' : '🔊'; }
    }
    applyPeerAudioPrefs(uid);
  }

  function togglePeerVideoHide(uid) {
    const pref = getPeerPref(uid);
    setPeerPref(uid, { videoHidden: !pref.videoHidden });
    applyPeerVideoHiddenPref(uid);
    const tile = document.getElementById(`voice-tile-${uid}`);
    if (tile) updatePeerControlState(tile, uid);
  }

  function updateVoiceControls() { updateVoiceStatusBar(); }

  // ── collapsePanel / showFullView ──────────────────────────────────────
  function collapsePanel() {
    const panel = document.getElementById('voice-panel');
    if (!panel) return;
    const collapsed = panel.classList.toggle('vc-panel-collapsed');
    const btn = document.getElementById('vp-collapse-btn');
    if (btn) { btn.title = collapsed ? 'Expand voice panel' : 'Collapse voice panel'; btn.textContent = collapsed ? '▲' : '▼'; }
  }

  function showFullView() {
    if (!currentChannelId) return;
    const main = document.getElementById('main');
    main.classList.remove('split-voice');
    document.getElementById('messages-container').style.display = 'none';
    document.getElementById('message-input-area').style.display = 'none';
    document.getElementById('typing-indicator').style.display = 'none';
    const panel = document.getElementById('voice-panel');
    if (panel) { panel.classList.remove('vc-panel-collapsed'); panel.style.flex = ''; }
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

  // ── Init ──────────────────────────────────────────────────────────────

  function init() {
    WS.on('voice.room_state',  onRoomState);
    WS.on('voice.joined',      onUserJoined);
    WS.on('voice.left',        onUserLeft);
    WS.on('voice.media_state', onMediaState);
    WS.on('voice.offer',       onOffer);
    WS.on('voice.answer',      onAnswer);
    WS.on('voice.ice',         onIce);

    WS.on('ws.connected', () => {
      if (!currentChannelId) return;
      console.log('[voice] WS reconnected — rejoining voice channel', currentChannelId);
      for (const uid of Object.keys(peers)) destroyPeer(uid);
      setTimeout(() => {
        if (currentChannelId) WS.send('voice.join', { channel_id: currentChannelId });
      }, 300);
    });
  }

  function isInChannel(channelId) { return currentChannelId === channelId; }
  function inCall() { return currentChannelId !== null; }

  return {
    init, join, leave, toggleMic, toggleCam, toggleDeafen,
    toggleScreenShare, isInChannel, collapsePanel, showFullView, inCall,
    showPeerVolume, setPeerVolume, togglePeerMute, togglePeerVideoHide,
    setFocus, toggleAutoFocus,
  };
})();
