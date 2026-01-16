// apps/desktop/src/main.ts
import * as mediasoupClient from "mediasoup-client";
import { initRoomStatusPanel, setRoomStatus, statusPushLog } from "./room/roomstatus";

import {
  initRoomPeersPanel,
  peersSetRoom,
  peersSetSelf,
  peersUpsertProducer,
  peersRemoveProducer,
  peersMarkConsumed,
  peersSetSpeaking,
  peersReset,
  peersUpsertPeer,
} from "./room/roompeers";

initRoomStatusPanel();
statusPushLog("app start");
initRoomPeersPanel();

/** ===== UI ===== */
const roomInput = document.querySelector("input") as HTMLInputElement;
const joinBtn = document.querySelector("button") as HTMLButtonElement;
const pttBtn = document.getElementById("pttBtn") as HTMLButtonElement;
const vuEl = document.getElementById("vu") as HTMLDivElement | null;
const remoteAudio = document.getElementById("remote") as HTMLAudioElement | null;

/** ===== 常量 ===== */
const SFU_WS_URL = "ws://localhost:3001";

// 断线重连参数
const RECONNECT_MIN = 300;
const RECONNECT_MAX = 3000;
const RECONNECT_JITTER = 200;

// PTT 恢复策略
const AUTO_RESTORE_PTT = false;

/** ===== 稳定身份（localStorage） ===== */
const LS_SESSION = "voiceparty.sessionId";
const LS_ROOM = "voiceparty.roomId";
const LS_PTT = "voiceparty.pttOn";

function getOrCreateSessionId() {
  let s = localStorage.getItem(LS_SESSION);
  if (!s) {
    s = "s_" + Math.random().toString(16).slice(2) + Date.now().toString(16);
    localStorage.setItem(LS_SESSION, s);
  }
  return s;
}
const sessionId = getOrCreateSessionId();

/** ===== 状态 ===== */
let ws: WebSocket | null = null;
let wsUrl: string | null = null;

let roomId: string | null = null;
let peerId: string | null = null;

let routerRtpCapabilities: any = null;

let device: mediasoupClient.types.Device | null = null;
let sendTransport: mediasoupClient.types.Transport | null = null;
let recvTransport: mediasoupClient.types.Transport | null = null;

let micStream: MediaStream | null = null;
let micTrack: MediaStreamTrack | null = null;
let audioProducer: mediasoupClient.types.Producer | null = null;

const pendingConsumes = new Set<string>();
let consumedProducerIds = new Set<string>();

const speakingDetectorsStarted = new Set<string>();

let remoteStream = new MediaStream();
if (remoteAudio) remoteAudio.srcObject = remoteStream;

/** ===== requestId RPC ===== */
let reqSeq = 1;
const pending = new Map<number, { resolve: (d: any) => void; reject: (e: any) => void }>();

/** ===== AudioContext ===== */
let _vadCtx: AudioContext | null = null;
function getVadCtx() {
  const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
  if (!_vadCtx) _vadCtx = new AudioCtx();
  return _vadCtx;
}
async function unlockAudioContext() {
  try {
    const ctx = getVadCtx();
    if (ctx.state === "suspended") await ctx.resume();
  } catch {}
}

/** ===== 连接世代 ===== */
let connGen = 0;
let activeWs: WebSocket | null = null;

/** ===== 重连器 ===== */
let reconnectAttempt = 0;
let shouldReconnect = false;

function computeReconnectDelay(attempt: number) {
  const base = Math.min(RECONNECT_MAX, RECONNECT_MIN * Math.pow(2, attempt));
  const jitter = Math.floor(Math.random() * RECONNECT_JITTER);
  return base + jitter;
}

/** ===== UI helpers ===== */
function setPttUi(on: boolean) {
  pttBtn.textContent = on ? "PTT ON" : "PTT OFF";
  localStorage.setItem(LS_PTT, on ? "1" : "0");
}
function getSavedPttOn() {
  return localStorage.getItem(LS_PTT) === "1";
}

/** ===== request ===== */
function sendRequest(type: string, payload: any): Promise<any> {
  const sock = activeWs;
  if (!sock || sock.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error("ws not ready"));
  }
  const requestId = reqSeq++;
  sock.send(JSON.stringify({ type, requestId, payload }));
  return new Promise((resolve, reject) => pending.set(requestId, { resolve, reject }));
}

function handleResponse(msg: any) {
  if (msg.type !== "response") return;
  const h = pending.get(msg.requestId);
  if (!h) return;
  pending.delete(msg.requestId);
  if (!msg.ok) h.reject(msg.data ?? msg);
  else h.resolve(msg.data);
}

/** ===== producer 清理 ===== */
function cleanupProducerLocal(producerId: string) {
  try {
    peersRemoveProducer(producerId);
  } catch {}
  consumedProducerIds.delete(producerId);
  pendingConsumes.delete(producerId);
  speakingDetectorsStarted.delete(producerId);
  setRoomStatus({ consumedProducerIds: Array.from(consumedProducerIds) });
}

/** ===== 重置 mediasoup / UI（重连前后都用） ===== */
function resetMediaStateForReconnect() {
  try {
    sendTransport?.close();
  } catch {}
  try {
    recvTransport?.close();
  } catch {}
  sendTransport = null;
  recvTransport = null;

  try {
    audioProducer?.close();
  } catch {}
  audioProducer = null;

  device = null;
  routerRtpCapabilities = null;

  try {
    for (const t of remoteStream.getTracks()) {
      try {
        t.stop();
      } catch {}
      remoteStream.removeTrack(t);
    }
  } catch {}
  remoteStream = new MediaStream();
  if (remoteAudio) remoteAudio.srcObject = remoteStream;

  consumedProducerIds = new Set<string>();
  pendingConsumes.clear();
  speakingDetectorsStarted.clear();
  pending.clear();

  setRoomStatus({
    deviceReady: false,
    sendTransportReady: false,
    recvTransportReady: false,
    sendTransportConnected: false,
    recvTransportConnected: false,
    localProducers: 0,
    remoteConsumers: 0,
    consumedProducerIds: [],
  });

  // ✅ 清面板（防残影）
  peersReset(false);
}

/** ===== 硬停旧连接 ===== */
function hardStopCurrentConnection(reason: string) {
  shouldReconnect = false;
  connGen++;
  try {
    activeWs?.close(1000, reason);
  } catch {}
  activeWs = null;
  ws = null;
  pending.clear();
}

function startWs(room: string, mode: "join" | "reconnect") {
  roomId = room;
  localStorage.setItem(LS_ROOM, roomId);

  wsUrl = `${SFU_WS_URL}?roomId=${encodeURIComponent(roomId)}`;
  setRoomStatus({ roomId, wsUrl, wsState: "CONNECTING" });
  statusPushLog(`ws connecting (${mode}) roomId=${roomId}`);

  const myGen = ++connGen;
  const sock = new WebSocket(wsUrl);

  ws = sock;
  activeWs = sock;

  sock.onopen = async () => {
    if (myGen !== connGen) return;

    setRoomStatus({ wsState: "CONNECTED" });
    statusPushLog("ws open");

    // ✅ open 先清一次面板
    peersReset(false);

    try {
      if (mode === "join") await rpcJoin(roomId!);
      else await rpcResume(roomId!);
    } catch (e: any) {
      statusPushLog(`join/resume failed: ${e?.message ?? e}`);
      try {
        sock.close(1005);
      } catch {}
    }
  };

  sock.onmessage = async (e) => {
    if (myGen !== connGen) return;

    const msg = JSON.parse(e.data);
    console.log("[WS<-]", msg.type, msg);

    // 1) RPC response
    handleResponse(msg);

    // 2) welcome（⚠️ SFU boot welcome 不带 sessionId：必须忽略，否则会产生 producers:0 幽灵 self）
    if (msg.type === "welcome") {
      const msgSid = msg.sessionId ? String(msg.sessionId) : "";
      if (!msgSid) {
        // boot welcome ignore
        return;
      }
      if (msgSid !== sessionId) return;

      // 正式 welcome
      peerId = msg.peerId ?? peerId ?? null;
      if (peerId) peersSetSelf(peerId);
      setRoomStatus({ peerId: peerId ?? undefined });

      // existingPeers
      const peers = Array.isArray(msg.existingPeers) ? msg.existingPeers : [];
      for (const p of peers) {
        const pid = typeof p === "string" ? p : p?.peerId;
        if (!pid) continue;
        if (peerId && pid === peerId) continue;
        peersUpsertPeer(pid);
      }

      // existingProducers
      const raw = msg.existingProducers ?? msg.existingProducerIds ?? [];
      const list = Array.isArray(raw) ? raw : [];
      for (const p of list) {
        const producerId = typeof p === "string" ? p : p?.producerId ?? p?.id;
        const ownerPeerId = typeof p === "string" ? undefined : p?.peerId;
        const kind = typeof p === "string" ? undefined : p?.kind;
        if (!producerId) continue;
        if (ownerPeerId && peerId && ownerPeerId === peerId) continue;
        peersUpsertProducer({ producerId, peerId: ownerPeerId, kind });
      }

      return;
    }

    // ✅ peerJoined：不依赖 producer（解决“Join 不显示对方”）
    if (msg.type === "peerJoined") {
      const pid = msg.peerId ?? msg.data?.peerId;
      if (!pid) return;
      if (peerId && pid === peerId) return;
      peersUpsertPeer(pid);
      statusPushLog(`peerJoined ${pid}`);
      return;
    }

    // ✅ peerLeft：离开房间（可选，但我给你补上了）
    if (msg.type === "peerLeft") {
      // 你现在 roompeers.ts 没有 removePeer API，我这里不强删 peer 卡片（避免误删）
      // 真正删 peer 卡片通常要考虑：是否还有 producer
      statusPushLog(`peerLeft ${msg.peerId ?? ""}`);
      return;
    }

    // newProducer
    if (msg.type === "newProducer") {
      const producerId = msg.producerId ?? msg.data?.producerId ?? msg.id ?? msg.data?.id;
      const ownerPeerId = msg.peerId ?? msg.data?.peerId;
      const kind = msg.kind ?? msg.data?.kind;
      if (!producerId) return;

      peersUpsertProducer({ producerId, peerId: ownerPeerId, kind });

      (async () => {
        try {
          await consumeAudio(producerId);
        } catch (err) {
          console.warn("[consume] newProducer failed", producerId, err);
          statusPushLog(`consume newProducer failed ${producerId}`);
        }
      })();

      return;
    }

    // server speaking
    if (msg.type === "producerSpeaking") {
      const producerId = msg.producerId ?? msg.data?.producerId;
      const speaking = !!(msg.speaking ?? msg.data?.speaking);
      if (!producerId) return;
      peersSetSpeaking(producerId, speaking);
      return;
    }

    // producerClosed
    if (msg.type === "producerClosed") {
      const producerId = msg.producerId ?? msg.data?.producerId;
      if (!producerId) return;
      cleanupProducerLocal(producerId);
      return;
    }
  };

  sock.onclose = (e) => {
    if (myGen !== connGen) return;

    setRoomStatus({ wsState: "DISCONNECTED" });
    statusPushLog(`ws close code=${e.code}`);

    ws = null;
    activeWs = null;

    if (!shouldReconnect) return;

    const delay = computeReconnectDelay(reconnectAttempt++);
    statusPushLog(`reconnect in ${delay}ms`);
    setRoomStatus({ wsState: "CONNECTING" });

    setTimeout(() => {
      if (!shouldReconnect) return;
      resetMediaStateForReconnect();
      startWs(roomId!, "reconnect");
    }, delay);
  };
}

/** ===== RPC: join / resume / restore ===== */
async function rpcJoin(room: string) {
  const data = await sendRequest("join", {
    roomId: room,
    sessionId,
    peerId: peerId ?? undefined,
  });

  peerId = data.peerId ?? peerId;
  routerRtpCapabilities = data.rtpCapabilities;

  // ✅ join 成功后：先清一次面板，再 setSelf（彻底干掉 boot welcome 残影）
  peersReset(false);
  if (peerId) peersSetSelf(peerId);
  peersSetRoom(room);

  setRoomStatus({ peerId: peerId ?? undefined });
  statusPushLog(`join ok peerId=${peerId ?? "-"}`);

  // ✅ existingPeers：先画 peer（哪怕 producers=0）
  const peers = Array.isArray(data.existingPeers) ? data.existingPeers : [];
  for (const p of peers) {
    const pid = typeof p === "string" ? p : p?.peerId;
    if (!pid) continue;
    if (peerId && pid === peerId) continue;
    peersUpsertPeer(pid);
  }

  await restoreMediaAfterJoinOrResume(data.existingProducers ?? []);
}

async function rpcResume(room: string) {
  const data = await sendRequest("resumeSession", {
    roomId: room,
    sessionId,
    peerId: peerId ?? undefined,
  });

  peerId = data.peerId ?? peerId;
  routerRtpCapabilities = data.rtpCapabilities;

  peersReset(false);
  if (peerId) peersSetSelf(peerId);
  peersSetRoom(room);

  setRoomStatus({ peerId: peerId ?? undefined });
  statusPushLog(`resume ok peerId=${peerId ?? "-"}`);

  const peers = Array.isArray(data.existingPeers) ? data.existingPeers : [];
  for (const p of peers) {
    const pid = typeof p === "string" ? p : p?.peerId;
    if (!pid) continue;
    if (peerId && pid === peerId) continue;
    peersUpsertPeer(pid);
  }

  await restoreMediaAfterJoinOrResume(data.existingProducers ?? []);
}

async function restoreMediaAfterJoinOrResume(existing: any[]) {
  await ensureDevice();

  const sendT = await sendRequest("createTransport", { direction: "send", sessionId });
  await ensureSendTransport((sendT as any).transportOptions ?? sendT);

  const recvT = await sendRequest("createTransport", { direction: "recv", sessionId });
  await ensureRecvTransport((recvT as any).transportOptions ?? recvT);

  consumedProducerIds = new Set<string>();
  setRoomStatus({ consumedProducerIds: [] });

  const list = Array.isArray(existing) ? existing : [];
  for (const p of list) {
    const producerId = typeof p === "string" ? p : p?.producerId ?? p?.id;
    const ownerPeerId = typeof p === "string" ? undefined : p?.peerId;
    const kind = typeof p === "string" ? undefined : p?.kind;
    if (!producerId) continue;

    if (ownerPeerId && peerId && ownerPeerId === peerId) continue;

    peersUpsertProducer({ producerId, peerId: ownerPeerId, kind });

    (async () => {
      try {
        await consumeAudio(producerId);
      } catch {}
    })();
  }

  const savedPtt = getSavedPttOn();
  if (savedPtt) {
    setPttUi(false);
    if (AUTO_RESTORE_PTT) {
      try {
        await pttDown();
      } catch {}
    }
  } else {
    setPttUi(false);
  }
}

/** ===== mediasoup ===== */
async function ensureDevice() {
  if (device) return;
  if (!routerRtpCapabilities) throw new Error("routerRtpCapabilities not ready");

  device = new mediasoupClient.Device();
  await device.load({ routerRtpCapabilities });

  setRoomStatus({ deviceReady: true });
  statusPushLog("device ready");
}

async function ensureSendTransport(transportOptions: any) {
  if (!device) throw new Error("device not ready");
  if (sendTransport) return;

  sendTransport = device.createSendTransport(transportOptions);

  sendTransport.on("connect", async ({ dtlsParameters }, callback, errback) => {
    try {
      await sendRequest("connectTransport", {
        direction: "send",
        dtlsParameters,
        sessionId,
      });
      setRoomStatus({ sendTransportConnected: true });
      callback();
    } catch (e) {
      setRoomStatus({ sendTransportConnected: false });
      errback(e as any);
    }
  });

  sendTransport.on("produce", async ({ kind, rtpParameters, appData }, callback, errback) => {
    try {
      const data = await sendRequest("produce", {
        kind,
        rtpParameters,
        appData,
        sessionId,
      });
      setRoomStatus({ localProducers: 1 });
      callback({ id: (data as any).producerId || (data as any).id });
    } catch (e) {
      errback(e as any);
    }
  });

  setRoomStatus({ sendTransportReady: true });
}

async function ensureRecvTransport(transportOptions: any) {
  if (!device) throw new Error("device not ready");
  if (recvTransport) return;

  recvTransport = device.createRecvTransport(transportOptions);

  recvTransport.on("connect", async ({ dtlsParameters }, callback, errback) => {
    try {
      await sendRequest("connectTransport", {
        direction: "recv",
        dtlsParameters,
        sessionId,
      });
      setRoomStatus({ recvTransportConnected: true });
      callback();
    } catch (e) {
      setRoomStatus({ recvTransportConnected: false });
      errback(e as any);
    }
  });

  setRoomStatus({ recvTransportReady: true });

  for (const pid of pendingConsumes) {
    try {
      await consumeAudio(pid);
    } catch {}
  }
  pendingConsumes.clear();
}

/** ===== consume ===== */
async function consumeAudio(producerId: string) {
  if (consumedProducerIds.has(producerId)) return;

  if (!device || !recvTransport) {
    pendingConsumes.add(producerId);
    return;
  }

  consumedProducerIds.add(producerId);
  setRoomStatus({ consumedProducerIds: Array.from(consumedProducerIds) });

  const data = await sendRequest("consume", {
    producerId,
    rtpCapabilities: device.rtpCapabilities,
    sessionId,
  });

  const consumer = await recvTransport.consume({
    id: (data as any).id,
    producerId: (data as any).producerId,
    kind: (data as any).kind,
    rtpParameters: (data as any).rtpParameters,
  });

  remoteStream.addTrack(consumer.track);

  if (!speakingDetectorsStarted.has(producerId)) {
    speakingDetectorsStarted.add(producerId);
    startSpeakingDetector(consumer.track, producerId);
  }

  peersMarkConsumed(producerId, true);
  setRoomStatus({ remoteConsumers: remoteStream.getTracks().length });

  if (remoteAudio) {
    (remoteAudio as any).playsInline = true;
    remoteAudio.autoplay = true;
    remoteAudio.muted = false;
    try {
      await remoteAudio.play();
    } catch {}
  }

  try {
    await sendRequest("resumeConsumer", { consumerId: consumer.id, sessionId });
  } catch {}
}

/** ===== mic / producer ===== */
async function ensureMic() {
  if (micTrack && micTrack.readyState !== "ended") return;

  try {
    micTrack?.stop();
  } catch {}
  micTrack = null;
  micStream = null;

  micStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
    video: false,
  });

  micTrack = micStream.getAudioTracks()[0];
  startVuMeter(micStream);
}

async function ensureAudioProducer() {
  if (audioProducer) return;
  if (!sendTransport) throw new Error("sendTransport not ready");

  await ensureMic();
  audioProducer = await sendTransport.produce({
    track: micTrack!,
    appData: { mediaTag: "ptt-audio" },
  });

  peersUpsertProducer({ producerId: audioProducer.id, peerId: peerId ?? undefined, kind: "audio" });

  if (!speakingDetectorsStarted.has(audioProducer.id)) {
    speakingDetectorsStarted.add(audioProducer.id);
    startSpeakingDetector(micTrack!, audioProducer.id);
  }
}

/** ===== PTT ===== */
let pttPressed = false;

async function pttDown() {
  if (pttPressed) return;
  pttPressed = true;
  await unlockAudioContext();

  await ensureAudioProducer();
  await audioProducer!.resume();

  try {
    await sendRequest("resumeProducer", {
      producerId: audioProducer!.id,
      sessionId,
    });
  } catch {}

  setPttUi(true);
}

async function pttUp() {
  if (!pttPressed) return;
  pttPressed = false;

  if (!audioProducer) return;
  await audioProducer.pause();

  try {
    await sendRequest("pauseProducer", {
      producerId: audioProducer!.id,
      sessionId,
    });
  } catch {}

  setPttUi(false);
}

/** ===== Space PTT ===== */
function bindSpacePTT() {
  window.addEventListener("keydown", (e) => {
    if (e.code !== "Space") return;
    e.preventDefault();
    pttDown();
  });
  window.addEventListener("keyup", (e) => {
    if (e.code !== "Space") return;
    e.preventDefault();
    pttUp();
  });
}

/** ===== vu meter ===== */
let vuStarted = false;
function startVuMeter(stream: MediaStream) {
  if (vuStarted) return;
  vuStarted = true;
  if (!vuEl) return;

  const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
  const ctx = new AudioCtx();
  const src = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  src.connect(analyser);

  const data = new Uint8Array(analyser.fftSize);

  const loop = () => {
    analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      const v = (data[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / data.length);

    const w = Math.min(1, rms * 4);
    vuEl.style.width = `${Math.floor(w * 200)}px`;
    vuEl.style.height = "10px";
    vuEl.style.border = "1px solid #999";
    vuEl.style.background = "#4caf50";

    requestAnimationFrame(loop);
  };
  loop();
}

/** ===== per-producer speaking detector（本地） ===== */
function startSpeakingDetector(track: MediaStreamTrack, producerId: string) {
  const ctx = getVadCtx();
  if (ctx.state === "suspended") ctx.resume().catch(() => {});

  const stream = new MediaStream([track]);
  const src = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();

  analyser.fftSize = 512;
  src.connect(analyser);

  const data = new Uint8Array(analyser.fftSize);

  let speaking = false;
  let lastLoudAt = 0;

  const THRESHOLD = 0.01;
  const HOLD_MS = 250;

  const loop = () => {
    analyser.getByteTimeDomainData(data);

    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      const v = (data[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / data.length);

    const now = performance.now();

    if (rms > THRESHOLD) {
      lastLoudAt = now;
      if (!speaking) {
        speaking = true;
        peersSetSpeaking(producerId, true);
      }
    } else if (speaking && now - lastLoudAt > HOLD_MS) {
      speaking = false;
      peersSetSpeaking(producerId, false);
    }

    requestAnimationFrame(loop);
  };
  loop();
}

/** ===== Connect ===== */
function connect() {
  hardStopCurrentConnection("join by user");

  const input = roomInput.value.trim();
  roomId = input || localStorage.getItem(LS_ROOM) || "test";

  setRoomStatus({ roomId });
  statusPushLog(`connect start roomId=${roomId}`);

  peersSetRoom(roomId);

  shouldReconnect = true;
  reconnectAttempt = 0;

  resetMediaStateForReconnect();
  startWs(roomId, "join");
}

/** ===== 绑定事件 ===== */
joinBtn.addEventListener("click", async () => {
  await unlockAudioContext();
  connect();
});

setPttUi(false);

pttBtn.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  (e.target as HTMLElement).setPointerCapture(e.pointerId);
  pttDown();
});
pttBtn.addEventListener("pointerup", (e) => {
  e.preventDefault();
  pttUp();
});
pttBtn.addEventListener("pointercancel", () => pttUp());

bindSpacePTT();

/** ===== DEBUG ===== */
(window as any).__DEBUG = {
  dropWs() {
    try {
      activeWs?.close(4000, "debug drop");
    } catch {}
  },
  resetMedia() {
    resetMediaStateForReconnect();
  },
};

/** ===== Vite HMR ===== */
if ((import.meta as any).hot) {
  (import.meta as any).hot.dispose(() => {
    try {
      shouldReconnect = false;
      connGen++;
      activeWs?.close(1000, "hmr dispose");
    } catch {}
  });
}
