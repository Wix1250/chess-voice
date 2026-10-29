// Peer-to-peer voice between the two players of a game, using WebRTC.
// The server only relays signaling messages; audio goes directly between browsers
// (or through a TURN relay when a direct path isn't possible).

export function createVoice({ socket, gameId, iceServers, audioEl, onChange }) {
  let localStream = null;
  let audioCtx = null;
  let analyser = null;
  let levelData = null;
  let pc = null;
  let pendingCandidates = [];
  const info = { status: 'off', muted: false, deafened: false, peerName: null, peerMuted: false, error: null };

  function update(patch) {
    Object.assign(info, patch);
    onChange({ ...info });
  }

  function emitJoin() {
    socket.emit('voice:join', gameId, (res) => {
      if (res?.error) {
        teardown();
        update({ status: 'off', error: res.error });
      } else if (info.status === 'joining') {
        update({ status: 'waiting' });
      }
    });
  }

  const handlers = {
    'voice:ready': ({ initiator, peer }) => {
      update({ peerName: peer, peerMuted: false });
      startPeer(initiator);
    },
    'voice:signal': (data) => onSignal(data).catch((e) => console.warn('voice signal', e)),
    'voice:peer-left': () => {
      closePeer();
      update({ status: 'waiting', peerName: null, peerMuted: false });
    },
    'voice:peer-status': ({ muted }) => update({ peerMuted: muted }),
    'voice:kicked': () => {
      teardown();
      update({ status: 'off', error: 'Voice was opened in another tab.' });
    },
    // The server forgets room membership when the socket reconnects, so rejoin.
    connect: () => {
      closePeer();
      update({ status: 'joining' });
      emitJoin();
    },
  };

  async function join() {
    if (localStream) return;
    update({ status: 'joining', error: null });
    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch {
      update({ status: 'off', error: 'Mic blocked. Allow it in the address bar, then click the mic.' });
      return;
    }
    for (const track of localStream.getAudioTracks()) track.enabled = !info.muted;
    // Measures how loud the mic is, so the UI can show it's picking up sound.
    audioCtx = new AudioContext();
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    audioCtx.createMediaStreamSource(localStream).connect(analyser);
    levelData = new Uint8Array(analyser.fftSize);
    for (const [event, fn] of Object.entries(handlers)) socket.on(event, fn);
    emitJoin();
  }

  function startPeer(initiator) {
    closePeer();
    const conn = new RTCPeerConnection({ iceServers });
    pc = conn;
    for (const track of localStream.getTracks()) conn.addTrack(track, localStream);
    conn.onicecandidate = (e) => {
      if (e.candidate) socket.emit('voice:signal', { candidate: e.candidate.toJSON() });
    };
    conn.ontrack = (e) => {
      audioEl.srcObject = e.streams[0];
      audioEl.play().catch(() => {});
    };
    conn.onconnectionstatechange = () => {
      if (pc !== conn) return;
      const state = conn.connectionState;
      if (state === 'connected') update({ status: 'connected' });
      else if (state === 'failed') update({ status: 'failed' });
      else if (state === 'disconnected' || state === 'connecting') update({ status: 'connecting' });
    };
    update({ status: 'connecting' });
    socket.emit('voice:status', { muted: info.muted });

    if (initiator) {
      conn
        .setLocalDescription()
        .then(() => socket.emit('voice:signal', { description: conn.localDescription.toJSON() }))
        .catch((e) => console.warn('voice offer', e));
    }
  }

  async function onSignal({ description, candidate }) {
    const conn = pc;
    if (!conn) return;
    if (description) {
      await conn.setRemoteDescription(description);
      if (description.type === 'offer') {
        await conn.setLocalDescription();
        socket.emit('voice:signal', { description: conn.localDescription.toJSON() });
      }
      for (const c of pendingCandidates.splice(0)) await conn.addIceCandidate(c);
    } else if (candidate) {
      if (conn.remoteDescription) await conn.addIceCandidate(candidate);
      else pendingCandidates.push(candidate);
    }
  }

  function closePeer() {
    pc?.close();
    pc = null;
    pendingCandidates = [];
    audioEl.srcObject = null;
  }

  function teardown() {
    closePeer();
    for (const track of localStream?.getTracks() ?? []) track.stop();
    localStream = null;
    audioCtx?.close();
    audioCtx = analyser = levelData = null;
    for (const [event, fn] of Object.entries(handlers)) socket.off(event, fn);
  }

  return {
    join,
    // Mic loudness from 0 to 1 (0 while muted).
    level() {
      if (!analyser || info.muted) return 0;
      analyser.getByteTimeDomainData(levelData);
      let sum = 0;
      for (const v of levelData) sum += ((v - 128) / 128) ** 2;
      return Math.min(1, Math.sqrt(sum / levelData.length) * 4);
    },
    leave() {
      if (localStream) socket.emit('voice:leave');
      teardown();
      update({ status: 'off', peerName: null, peerMuted: false });
    },
    setMuted(muted) {
      for (const track of localStream?.getAudioTracks() ?? []) track.enabled = !muted;
      update({ muted });
      socket.emit('voice:status', { muted });
    },
    setDeafened(deafened) {
      audioEl.muted = deafened;
      update({ deafened });
    },
  };
}
