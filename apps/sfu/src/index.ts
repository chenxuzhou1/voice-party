// apps/sfu/src/server.ts
import http from "node:http";
import { WebSocketServer } from "ws";
import mediasoup, { types as ms } from "mediasoup";

type Client = {
  sessionId: string; // 稳定身份：断线重连不变
  peerId: string; // 房间内身份：广播用
  ws: any;

  roomId?: string;

  send?: ms.WebRtcTransport;
  recv?: ms.WebRtcTransport;

  producers: Map<string, ms.Producer>;
  consumers: Map<string, ms.Consumer>;

  cleanupTimer?: NodeJS.Timeout;
  disconnectedAt?: number;
};

type Room = {
  id: string;
  router: ms.Router;

  // key = peerId
  peers: Map<string, Client>;

  // key = producerId
  producers: Map<string, { peerId: string; producer: ms.Producer }>;

  audioLevelObserver: ms.AudioLevelObserver;
  speaking: Set<string>; // producerId set
};

const PORT = Number(process.env.PORT || 3001);

const server = http.createServer();
const wss = new WebSocketServer({ server });

const rooms = new Map<string, Room>();
let worker: ms.Worker;

// sessionId -> Client（断线重连核心）
const sessions = new Map<string, Client>();

const rid = () => Math.random().toString(16).slice(2) + Date.now().toString(16);
const send = (ws: any, msg: any) => ws.send(JSON.stringify(msg));

const GRACE_MS = 25_000;

function roomProducerList(room: Room) {
  return [...room.producers.values()].map((v) => ({
    producerId: v.producer.id,
    peerId: v.peerId,
    kind: v.producer.kind,
  }));
}

function roomPeerList(room: Room) {
  return [...room.peers.values()].map((p) => ({ peerId: p.peerId }));
}

function broadcastRoom(room: Room, msg: any, excludePeerId?: string) {
  for (const p of room.peers.values()) {
    if (excludePeerId && p.peerId === excludePeerId) continue;
    try {
      send(p.ws, msg);
    } catch {}
  }
}

function broadcastPeerJoined(room: Room, peerId: string) {
  broadcastRoom(room, { type: "peerJoined", peerId }, peerId);
}

function broadcastPeerLeft(room: Room, peerId: string) {
  broadcastRoom(room, { type: "peerLeft", peerId }, peerId);
}

async function mkTransport(router: ms.Router) {
  const t = await router.createWebRtcTransport({
    listenIps: [{ ip: "0.0.0.0", announcedIp: undefined }],
    enableUdp: true,
    enableTcp: true,
    preferUdp: true,
  });
  t.on("dtlsstatechange", (s) => {
    if (s === "closed") t.close();
  });
  return t;
}

async function getRoom(id: string) {
  let r = rooms.get(id);
  if (r) return r;

  const router = await worker.createRouter({
    mediaCodecs: [{ kind: "audio", mimeType: "audio/opus", clockRate: 48000, channels: 2 }],
  });

  const audioLevelObserver = await router.createAudioLevelObserver({
    maxEntries: 10,
    threshold: -80,
    interval: 100,
  });

  const room: Room = {
    id,
    router,
    peers: new Map(),
    producers: new Map(),
    audioLevelObserver,
    speaking: new Set(),
  };

  // VAD：广播说话状态
  audioLevelObserver.on("volumes", (volumes: Array<{ producer: ms.Producer; volume: number }>) => {
    const active = new Set<string>();

    for (const { producer, volume } of volumes) {
      const pid = producer.id;
      active.add(pid);

      const info = room.producers.get(pid);
      broadcastRoom(room, {
        type: "producerSpeaking",
        producerId: pid,
        peerId: info?.peerId,
        speaking: true,
        volume,
      });
    }

    for (const pid of [...room.speaking]) {
      if (!active.has(pid)) {
        room.speaking.delete(pid);
        const info = room.producers.get(pid);
        broadcastRoom(room, {
          type: "producerSpeaking",
          producerId: pid,
          peerId: info?.peerId,
          speaking: false,
        });
      }
    }

    for (const pid of active) room.speaking.add(pid);
  });

  audioLevelObserver.on("silence", () => {
    for (const pid of [...room.speaking]) {
      room.speaking.delete(pid);
      const info = room.producers.get(pid);
      broadcastRoom(room, {
        type: "producerSpeaking",
        producerId: pid,
        peerId: info?.peerId,
        speaking: false,
      });
    }
  });

  rooms.set(id, room);
  console.log("[SFU] room created:", id);
  return room;
}

// 真正清理一个 peer（超时或明确离开时调用）
function destroyPeer(peer: Client) {
  const roomId = peer.roomId;
  if (!roomId) {
    sessions.delete(peer.sessionId);
    return;
  }
  const room = rooms.get(roomId);
  if (!room) {
    sessions.delete(peer.sessionId);
    return;
  }

  // 广播 producerClosed + speaking=false
  for (const [pid, info] of room.producers.entries()) {
    if (info.peerId !== peer.peerId) continue;

    room.producers.delete(pid);

    if (room.speaking.has(pid)) {
      room.speaking.delete(pid);
      broadcastRoom(room, {
        type: "producerSpeaking",
        producerId: pid,
        peerId: peer.peerId,
        speaking: false,
      });
    }

    broadcastRoom(room, {
      type: "producerClosed",
      producerId: pid,
      peerId: peer.peerId,
      kind: info.producer.kind,
      reason: "left",
    });
  }

  // ✅ peerLeft（不依赖 producer）
  room.peers.delete(peer.peerId);
  broadcastPeerLeft(room, peer.peerId);

  // close mediasoup resources
  try {
    peer.producers.forEach((p) => p.close());
  } catch {}
  try {
    peer.consumers.forEach((c) => c.close());
  } catch {}
  try {
    peer.send?.close();
  } catch {}
  try {
    peer.recv?.close();
  } catch {}

  peer.producers.clear();
  peer.consumers.clear();
  peer.send = undefined;
  peer.recv = undefined;
  peer.roomId = undefined;

  sessions.delete(peer.sessionId);

  if (room.peers.size === 0) {
    try {
      room.audioLevelObserver.close();
    } catch {}
    try {
      room.router.close();
    } catch {}
    rooms.delete(room.id);
    console.log("[SFU] room destroyed:", room.id);
  }
}

// 断线后进入 grace：允许 resume
function scheduleGraceCleanup(peer: Client) {
  if (peer.cleanupTimer) clearTimeout(peer.cleanupTimer);
  peer.disconnectedAt = Date.now();

  peer.cleanupTimer = setTimeout(() => {
    console.log("[SFU] grace expired, cleanup peer:", peer.peerId, "session:", peer.sessionId);
    destroyPeer(peer);
  }, GRACE_MS);
}

function resetPeerMedia(peer: Client) {
  // 1) 从 room 里移除该 peer 的所有 producers（避免 old producer 堆积）
  if (peer.roomId) {
    const room = rooms.get(peer.roomId);
    if (room) {
      for (const [pid, info] of room.producers.entries()) {
        if (info.peerId !== peer.peerId) continue;

        room.producers.delete(pid);

        if (room.speaking.has(pid)) {
          room.speaking.delete(pid);
          broadcastRoom(room, {
            type: "producerSpeaking",
            producerId: pid,
            peerId: peer.peerId,
            speaking: false,
          });
        }

        // ✅ 不广播 producerClosed（重连不打扰别人）
        // ✅ 但可以给别人一个“reconnect closed”也行，这里保持你原设定：静默
        try {
          info.producer.close();
        } catch {}
      }
    }
  }

  // 2) 关闭该 peer 自己持有的媒体对象
  try {
    peer.producers.forEach((p) => p.close());
  } catch {}
  try {
    peer.consumers.forEach((c) => c.close());
  } catch {}
  try {
    peer.send?.close();
  } catch {}
  try {
    peer.recv?.close();
  } catch {}

  peer.producers.clear();
  peer.consumers.clear();
  peer.send = undefined;
  peer.recv = undefined;
}

(async () => {
  worker = await mediasoup.createWorker({ rtcMinPort: 40000, rtcMaxPort: 49999 });
  worker.on("died", () => process.exit(1));

  wss.on("connection", (ws) => {
    // ⚠️ boot welcome（临时 peerId）：前端会忽略（不带 sessionId）
    const tempPeerId = "p_" + rid();
    send(ws, {
      type: "welcome",
      peerId: tempPeerId,
      hint: "Please send join/resumeSession with payload.sessionId (persist it in localStorage).",
    });

    ws.on("message", async (raw) => {
      const { type, requestId, payload } = JSON.parse(raw.toString());
      const ok = (data?: any) => send(ws, { type: "response", requestId, ok: true, data });
      const fail = (e: any) =>
        send(ws, { type: "response", requestId, ok: false, data: { error: e?.message ?? String(e) } });

      try {
        // =========================================================
        // resumeSession
        // =========================================================
        if (type === "resumeSession") {
          const sessionId = String(payload?.sessionId || "").trim() || "s_" + rid();
          const roomId = payload?.roomId ? String(payload.roomId) : undefined;

          let peer = sessions.get(sessionId);

          if (!peer) {
            peer = {
              sessionId,
              peerId: payload?.peerId ? String(payload.peerId) : "p_" + rid(),
              ws,
              producers: new Map(),
              consumers: new Map(),
            };
            sessions.set(sessionId, peer);
          } else {
            if (peer.cleanupTimer) {
              clearTimeout(peer.cleanupTimer);
              peer.cleanupTimer = undefined;
            }
            peer.disconnectedAt = undefined;

            resetPeerMedia(peer);

            try {
              if (peer.ws && peer.ws !== ws) peer.ws.close();
            } catch {}
            peer.ws = ws;
          }

          // 断线后重连但 peer.roomId 为空：允许 payload.roomId 填回
          if (roomId && !peer.roomId) {
            peer.roomId = roomId;
            const room = await getRoom(roomId);
            room.peers.set(peer.peerId, peer);

            // ✅ peerJoined（让别人立即看到你出现）
            broadcastPeerJoined(room, peer.peerId);
          }

          const room = peer.roomId ? rooms.get(peer.roomId) : undefined;

          ok({
            sessionId: peer.sessionId,
            peerId: peer.peerId,
            roomId: peer.roomId,
            rtpCapabilities: room?.router.rtpCapabilities,
            existingPeers: room ? roomPeerList(room) : [],
            existingProducers: room ? roomProducerList(room) : [],
          });

          // ✅ join/resume 后的 welcome（带 sessionId，前端会接受）
          send(ws, {
            type: "welcome",
            sessionId: peer.sessionId,
            peerId: peer.peerId,
            existingPeers: room ? roomPeerList(room) : [],
            existingProducers: room ? roomProducerList(room) : [],
          });

          return;
        }

        // =========================================================
        // join
        // =========================================================
        if (type === "join") {
          const roomId = String(payload?.roomId || "").trim();
          if (!roomId) throw new Error("roomId required");

          const sessionId = String(payload?.sessionId || "").trim() || "s_" + rid();

          let peer = sessions.get(sessionId);
          if (!peer) {
            peer = {
              sessionId,
              peerId: payload?.peerId ? String(payload.peerId) : "p_" + rid(),
              ws,
              producers: new Map(),
              consumers: new Map(),
            };
            sessions.set(sessionId, peer);
          } else {
            if (peer.cleanupTimer) {
              clearTimeout(peer.cleanupTimer);
              peer.cleanupTimer = undefined;
            }
            peer.disconnectedAt = undefined;

            resetPeerMedia(peer);

            try {
              if (peer.ws && peer.ws !== ws) peer.ws.close();
            } catch {}
            peer.ws = ws;
          }

          peer.roomId = roomId;
          const room = await getRoom(roomId);
          room.peers.set(peer.peerId, peer);

          ok({
            roomId: room.id,
            sessionId: peer.sessionId,
            peerId: peer.peerId,
            rtpCapabilities: room.router.rtpCapabilities,
            existingPeers: roomPeerList(room),
            existingProducers: roomProducerList(room),
          });

          // ✅ join 后 welcome（带 sessionId）
          send(ws, {
            type: "welcome",
            sessionId: peer.sessionId,
            peerId: peer.peerId,
            existingPeers: roomPeerList(room),
            existingProducers: roomProducerList(room),
          });

          // ✅ 广播 peerJoined（不依赖 producer）
          broadcastPeerJoined(room, peer.peerId);

          return;
        }

        // =========================================================
        // listProducers / getRoomProducers
        // =========================================================
        if (type === "listProducers" || type === "getRoomProducers") {
          const sessionId = String(payload?.sessionId || "").trim();
          const peer = sessionId ? sessions.get(sessionId) : undefined;
          const roomId = payload?.roomId ? String(payload.roomId) : peer?.roomId;

          if (!roomId) throw new Error("room not found");
          const room = rooms.get(roomId);
          if (!room) throw new Error("room not found");

          ok({ list: roomProducerList(room) });
          return;
        }

        // =========================================================
        // 下面这些：要求 payload.sessionId 定位 peer
        // =========================================================
        const sessionId = String(payload?.sessionId || "").trim();
        const peer = sessionId ? sessions.get(sessionId) : undefined;
        if (!peer) throw new Error("invalid sessionId (peer not found)");

        if (type === "createTransport") {
          const room = rooms.get(peer.roomId!);
          if (!room) throw new Error("room not found");

          const dir: "send" | "recv" = payload.direction;

          if (dir === "send" && peer.send) {
            try {
              peer.send.close();
            } catch {}
            peer.send = undefined;
          }
          if (dir === "recv" && peer.recv) {
            try {
              peer.recv.close();
            } catch {}
            peer.recv = undefined;
          }

          const t = await mkTransport(room.router);
          dir === "send" ? (peer.send = t) : (peer.recv = t);

          ok({
            id: t.id,
            iceParameters: t.iceParameters,
            iceCandidates: t.iceCandidates,
            dtlsParameters: t.dtlsParameters,
          });
          return;
        }

        if (type === "connectTransport") {
          const dir: "send" | "recv" = payload.direction;
          const t = dir === "send" ? peer.send : peer.recv;
          if (!t) throw new Error("transport not found");

          await t.connect({ dtlsParameters: payload.dtlsParameters });
          ok({ connected: true });
          return;
        }

        if (type === "produce") {
          const room = rooms.get(peer.roomId!);
          if (!room) throw new Error("room not found");
          if (!peer.send) throw new Error("send transport not ready");

          const p = await peer.send.produce({
            kind: payload.kind,
            rtpParameters: payload.rtpParameters,
          });

          peer.producers.set(p.id, p);
          room.producers.set(p.id, { peerId: peer.peerId, producer: p });

          if (p.kind === "audio") {
            try {
              room.audioLevelObserver.addProducer({ producerId: p.id });
            } catch {}
          }

          ok({ producerId: p.id });

          broadcastRoom(
            room,
            {
              type: "newProducer",
              producerId: p.id,
              peerId: peer.peerId,
              kind: p.kind,
            },
            peer.peerId
          );

          return;
        }

        if (type === "consume") {
          const room = rooms.get(peer.roomId!);
          if (!room) throw new Error("room not found");
          if (!peer.recv) throw new Error("recv transport not ready");

          if (
            !room.router.canConsume({
              producerId: payload.producerId,
              rtpCapabilities: payload.rtpCapabilities,
            })
          ) {
            throw new Error("cannot consume");
          }

          const c = await peer.recv.consume({
            producerId: payload.producerId,
            rtpCapabilities: payload.rtpCapabilities,
            paused: false,
          });

          peer.consumers.set(c.id, c);

          ok({
            id: c.id,
            producerId: payload.producerId,
            kind: c.kind,
            rtpParameters: c.rtpParameters,
          });

          return;
        }

        if (type === "resumeConsumer") {
          const consumerId = payload.consumerId;
          const c = peer.consumers.get(consumerId);
          if (c) await c.resume();
          ok({ resumed: true });
          return;
        }

        if (type === "pauseProducer") {
          const producerId = payload.producerId;
          const p = peer.producers.get(producerId);
          if (!p) throw new Error("producer not found");
          await p.pause();
          ok({ paused: true });
          return;
        }

        if (type === "resumeProducer") {
          const producerId = payload.producerId;
          const p = peer.producers.get(producerId);
          if (!p) throw new Error("producer not found");
          await p.resume();
          ok({ resumed: true });
          return;
        }

        fail("unknown type");
      } catch (e) {
        fail(e);
      }
    });

    ws.on("close", () => {
      // 找到这个 ws 对应的 peer
      let peer: Client | undefined;
      for (const p of sessions.values()) {
        if (p.ws === ws) {
          peer = p;
          break;
        }
      }
      if (!peer) return;

      console.log("[SFU] ws closed -> grace start:", peer.peerId, "session:", peer.sessionId);
      scheduleGraceCleanup(peer);
    });
  });

  server.listen(PORT, "0.0.0.0", () => console.log(`[SFU] listening on 0.0.0.0:${PORT}`));

})();
