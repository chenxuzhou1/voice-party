// apps/sfu/src/server.ts
import http from "node:http";
import { WebSocketServer } from "ws";
import mediasoup, { types as ms } from "mediasoup";
import { URL } from "node:url";
import { verifyToken } from "./token";


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

wss.on("connection", (ws, req) => {
  // =========================================================
  // M3-1.5: token gate 加固
  // token = base64url(payloadJSON) + "." + base64url(hmacSha256(payloadB64, SECRET))
  // payload: { roomId, peerId, sessionId?, jti, iat, exp }
  // =========================================================
  const u = new URL(req.url || "/", "http://localhost");
  const token = u.searchParams.get("token") || "";

  if (!token) {
    try {
      ws.close(1008, "missing token");
    } catch {}
    return;
  }

  let tokenPayload: any;
  try {
    // ✅ consumeJti=true：一次性 token（同 token 第二次连必死）
    tokenPayload = verifyToken(token, { consumeJti: true });

    if (!tokenPayload.roomId) throw new Error("no_roomId");
    if (!tokenPayload.peerId) throw new Error("no_peerId");
  } catch (e: any) {
    try {
      ws.close(1008, `invalid token: ${e?.message || "unknown"}`);
    } catch {}
    return;
  }

  const tokenRoomId = String(tokenPayload.roomId || "").trim();
  const tokenPeerId = String(tokenPayload.peerId || "").trim();
  const tokenSessionId = tokenPayload.sessionId ? String(tokenPayload.sessionId).trim() : "";

  if (!tokenRoomId) {
    try {
      ws.close(1008, "invalid token: no_roomId");
    } catch {}
    return;
  }
  if (!tokenPeerId) {
    try {
      ws.close(1008, "invalid token: no_peerId");
    } catch {}
    return;
  }

  // 挂到 ws 上：后面 join / resumeSession 全部强校验
  (ws as any)._tokenRoomId = tokenRoomId;
  (ws as any)._tokenPeerId = tokenPeerId;
  (ws as any)._tokenSessionId = tokenSessionId; // 可能为空
  (ws as any)._tokenPayload = tokenPayload;

  // ✅ welcome：直接用 token peerId（绑定生效）
  send(ws, {
    type: "welcome",
    peerId: tokenPeerId,
    sessionId: tokenSessionId || undefined,
    hint: "Send join/resumeSession with payload.sessionId (persist it in localStorage). Token peerId is authoritative.",
  });

  ws.on("message", async (raw) => {
    const msg = JSON.parse(raw.toString());
    const { type, requestId, payload } = msg;

    const ok = (data?: any) => send(ws, { type: "response", requestId, ok: true, data });
    const fail = (e: any) =>
      send(ws, { type: "response", requestId, ok: false, data: { error: e?.message ?? String(e) } });

    // 小工具：强制 roomId 与 token 绑定一致
    const requireRoomIdMatch = (roomIdFromMsg?: string) => {
      const authedRoomId = String((ws as any)._tokenRoomId || "").trim();
      if (!authedRoomId) throw new Error("not_authed");

      const r = String(roomIdFromMsg || "").trim();
      if (!r) throw new Error("roomId required");
      if (r !== authedRoomId) throw new Error("roomId mismatch");
      return r;
    };

    // 小工具：强制 sessionId/peerId 与 token 绑定一致（tokenSessionId 可选）
    const requireBoundIdentity = (msgSessionId?: string) => {
      const authedPeerId = String((ws as any)._tokenPeerId || "").trim();
      const authedSessionId = String((ws as any)._tokenSessionId || "").trim(); // 可能为空

      if (!authedPeerId) throw new Error("not_authed");

      const s = String(msgSessionId || "").trim();

      // token 带 sessionId => 必须匹配；不带 => 允许由消息/服务端生成
      if (authedSessionId) {
        if (!s) throw new Error("sessionId required (token-bound)");
        if (s !== authedSessionId) throw new Error("sessionId mismatch (token-bound)");
        return { peerId: authedPeerId, sessionId: authedSessionId };
      }

      // token 不带 sessionId：允许沿用/生成
      return { peerId: authedPeerId, sessionId: s || ("s_" + rid()) };
    };

    try {
      // =========================================================
      // resumeSession
      // =========================================================
      if (type === "resumeSession") {
        const roomId = requireRoomIdMatch(payload?.roomId ? String(payload.roomId) : "");
        const bound = requireBoundIdentity(String(payload?.sessionId || ""));
        const sessionId = bound.sessionId;
        const peerId = bound.peerId;

        let peer = sessions.get(sessionId);

        if (!peer) {
          peer = {
            sessionId,
            peerId,
            ws,
            producers: new Map(),
            consumers: new Map(),
          };
          sessions.set(sessionId, peer);
        } else {
          if (peer.peerId !== peerId) throw new Error("peerId mismatch (session bound)");

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

        if (peer.roomId && peer.roomId !== roomId) throw new Error("roomId mismatch");
        if (!peer.roomId) {
          peer.roomId = roomId;
          const room = await getRoom(roomId);
          room.peers.set(peer.peerId, peer);
          broadcastPeerJoined(room, peer.peerId);
        }

        const room = rooms.get(peer.roomId!);

        ok({
          sessionId: peer.sessionId,
          peerId: peer.peerId,
          roomId: peer.roomId,
          rtpCapabilities: room?.router.rtpCapabilities,
          existingPeers: room ? roomPeerList(room) : [],
          existingProducers: room ? roomProducerList(room) : [],
        });

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
        const roomId = requireRoomIdMatch(String(payload?.roomId || ""));
        const bound = requireBoundIdentity(String(payload?.sessionId || ""));
        const sessionId = bound.sessionId;
        const peerId = bound.peerId;

        let peer = sessions.get(sessionId);

        if (!peer) {
          peer = {
            sessionId,
            peerId,
            ws,
            producers: new Map(),
            consumers: new Map(),
          };
          sessions.set(sessionId, peer);
        } else {
          if (peer.peerId !== peerId) throw new Error("peerId mismatch (session bound)");

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

        if (peer.roomId && peer.roomId !== roomId) throw new Error("roomId mismatch");

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

        send(ws, {
          type: "welcome",
          sessionId: peer.sessionId,
          peerId: peer.peerId,
          existingPeers: roomPeerList(room),
          existingProducers: roomProducerList(room),
        });

        broadcastPeerJoined(room, peer.peerId);
        return;
      }

      // =========================================================
      // listProducers / getRoomProducers
      // =========================================================
      if (type === "listProducers" || type === "getRoomProducers") {
        const sessionId = String(payload?.sessionId || "").trim();
        const peer = sessionId ? sessions.get(sessionId) : undefined;

        const roomIdFromMsg = payload?.roomId ? String(payload.roomId) : undefined;
        const roomId = roomIdFromMsg
          ? requireRoomIdMatch(roomIdFromMsg)
          : peer?.roomId
          ? requireRoomIdMatch(peer.roomId)
          : "";

        if (!roomId) throw new Error("room not found");
        const room = rooms.get(roomId);
        if (!room) throw new Error("room not found");

        ok({ list: roomProducerList(room) });
        return;
      }

      // =========================================================
      // 后续：必须用 sessionId 定位 peer
      // =========================================================
      const sessionId = String(payload?.sessionId || "").trim();
      const peer = sessionId ? sessions.get(sessionId) : undefined;
      if (!peer) throw new Error("invalid sessionId (peer not found)");

      // ✅ 所有后续消息都必须落在 token 绑定 roomId
      if (peer.roomId) requireRoomIdMatch(peer.roomId);

      // =========================================================
      // createTransport
      // payload: { sessionId, direction: "send"|"recv" }
      // =========================================================
      if (type === "createTransport") {
        const direction = String(payload?.direction || "").trim();
        if (direction !== "send" && direction !== "recv") throw new Error("invalid direction");

        const roomId = peer.roomId;
        if (!roomId) throw new Error("room not joined");

        const room = rooms.get(roomId);
        if (!room) throw new Error("room not found");

        const transport = await room.router.createWebRtcTransport({
          listenIps: [{ ip: "0.0.0.0", announcedIp: undefined }],
          enableUdp: true,
          enableTcp: true,
          preferUdp: true,
        });

        if (direction === "send") peer.send = transport;
        else peer.recv = transport;

        transport.on("dtlsstatechange", (state) => {
          if (state === "closed") {
            try {
              transport.close();
            } catch {}
          }
        });

        ok({
          id: transport.id,
          iceParameters: transport.iceParameters,
          iceCandidates: transport.iceCandidates,
          dtlsParameters: transport.dtlsParameters,
        });
        return;
      }

      // =========================================================
      // connectTransport
      // payload: { sessionId, direction: "send"|"recv", dtlsParameters }
      // =========================================================
      if (type === "connectTransport") {
        const direction = String(payload?.direction || "").trim();
        const dtlsParameters = payload?.dtlsParameters;
        if (!dtlsParameters) throw new Error("missing dtlsParameters");

        const t =
          direction === "send"
            ? peer.send
            : direction === "recv"
            ? peer.recv
            : undefined;

        if (!t) throw new Error(`${direction} transport not created`);

        await t.connect({ dtlsParameters });
        ok({ connected: true });
        return;
      }
            // =========================================================
      // produce
      // payload: { sessionId, kind, rtpParameters, appData? }
      // =========================================================
      if (type === "produce") {
        const kind = String(payload?.kind || "").trim();
        if (kind !== "audio" && kind !== "video") throw new Error("invalid kind");

        if (!peer.send) throw new Error("send transport not ready");

        const rtpParameters = payload?.rtpParameters;
        if (!rtpParameters) throw new Error("missing rtpParameters");

        const appData = payload?.appData ?? {};

        const producer = await peer.send.produce({
          kind: kind as any,
          rtpParameters,
          appData,
        });

        peer.producers.set(producer.id, producer);

        // room 全局 producers 索引（如果你工程里有 room.producers / roomProducerList 之类，按你原结构来）
        if (peer.roomId) {
          const room = rooms.get(peer.roomId);
          if (room) {
            // 兼容：你原来可能是 room.producers: Map<string,{peerId,producer}>
            (room as any).producers?.set?.(producer.id, { peerId: peer.peerId, producer });
          }
        }

        producer.on("transportclose", () => {
          try {
            peer.producers.delete(producer.id);
          } catch {}
          try {
            producer.close();
          } catch {}
        });

        // ✅ 返回 producerId 给前端
        ok({ id: producer.id });
        return;
      }

            // =========================================================
      // pauseProducer
      // payload: { sessionId, producerId }
      // =========================================================
      if (type === "pauseProducer") {
        const producerId = String(payload?.producerId || "").trim();
        if (!producerId) throw new Error("missing producerId");

        const producer = peer.producers.get(producerId);
        if (!producer) throw new Error("producer not found");

        await producer.pause();
        ok({ paused: true });
        return;
      }

      // =========================================================
      // resumeProducer
      // payload: { sessionId, producerId }
      // =========================================================
      if (type === "resumeProducer") {
        const producerId = String(payload?.producerId || "").trim();
        if (!producerId) throw new Error("missing producerId");

        const producer = peer.producers.get(producerId);
        if (!producer) throw new Error("producer not found");

        await producer.resume();
        ok({ paused: false });
        return;
      }

      // =========================================================
      // consume
      // payload: { sessionId, producerId, rtpCapabilities }
      // return: { id, producerId, kind, rtpParameters }
      // =========================================================
      if (type === "consume") {
        const producerId = String(payload?.producerId || "").trim();
        if (!producerId) throw new Error("missing producerId");

        if (!peer.recv) throw new Error("recv transport not ready");

        const roomId = peer.roomId;
        if (!roomId) throw new Error("room not joined");
        const room = rooms.get(roomId);
        if (!room) throw new Error("room not found");

        const rtpCapabilities = payload?.rtpCapabilities;
        if (!rtpCapabilities) throw new Error("missing rtpCapabilities");

        // 你项目里通常是：
        // room.producers: Map<string, { peerId: string; producer: ms.Producer }>
        const rec = room.producers.get(producerId);
        if (!rec?.producer) throw new Error("producer not found");

        // 禁止 consume 自己（可选但建议）
        if (rec.peerId === peer.peerId) throw new Error("cannot consume self");

        if (!room.router.canConsume({ producerId, rtpCapabilities })) {
          throw new Error("cannot consume (rtpCapabilities)");
        }

        const consumer = await peer.recv.consume({
          producerId,
          rtpCapabilities,
          paused: false,
        });

        peer.consumers.set(consumer.id, consumer);

        consumer.on("transportclose", () => {
          try { peer.consumers.delete(consumer.id); } catch {}
        });
        consumer.on("producerclose", () => {
          try { peer.consumers.delete(consumer.id); } catch {}
          try { consumer.close(); } catch {}
        });

        ok({
          id: consumer.id,
          producerId,
          kind: consumer.kind,
          rtpParameters: consumer.rtpParameters,
        });
        return;
      }

      // =========================================================
      // pauseConsumer / resumeConsumer（可选，但做了更完整）
      // payload: { sessionId, consumerId }
      // =========================================================
      if (type === "pauseConsumer") {
        const consumerId = String(payload?.consumerId || "").trim();
        if (!consumerId) throw new Error("missing consumerId");
        const c = peer.consumers.get(consumerId);
        if (!c) throw new Error("consumer not found");
        await c.pause();
        ok({});
        return;
      }

      if (type === "resumeConsumer") {
        const consumerId = String(payload?.consumerId || "").trim();
        if (!consumerId) throw new Error("missing consumerId");
        const c = peer.consumers.get(consumerId);
        if (!c) throw new Error("consumer not found");
        await c.resume();
        ok({});
        return;
      }


      console.warn("[SFU] unknown type:", type, payload);
      fail("unknown type");
    } catch (e) {
      fail(e);
    }
  });

  ws.on("close", () => {
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
