// =======================
// M1-0 房间状态面板
// =======================
type WSState = "DISCONNECTED" | "CONNECTING" | "CONNECTED" | "ERROR"  | "RECONNECTING";

type RoomStatus = {
  roomId?: string;
  peerId?: string;

  wsState: WSState;
  wsUrl?: string;

  deviceReady: boolean;

  sendTransportReady: boolean;
  sendTransportConnected: boolean;
  recvTransportReady: boolean;
  recvTransportConnected: boolean;

  localProducers: number;     // 你本地生产的 track（audio producer）
  remoteConsumers: number;    // 你消费到的 track（audio consumer）

  consumedProducerIds: string[]; // 已消费的 producerId 列表（防重复）
};

const __roomStatus: RoomStatus = {
  wsState: "DISCONNECTED",
  deviceReady: false,

  sendTransportReady: false,
  sendTransportConnected: false,
  recvTransportReady: false,
  recvTransportConnected: false,

  localProducers: 0,
  remoteConsumers: 0,

  consumedProducerIds: [],
};

const __roomLogs: string[] = [];
const __roomLogMax = 80;

function initRoomStatusPanel() {
  const styleId = "m1-room-status-style";
  if (!document.getElementById(styleId)) {
    const s = document.createElement("style");
    s.id = styleId;
    s.textContent = `
      #m1-room-status {
        position: fixed;
        right: 12px;
        bottom: 12px;
        width: 360px;
        max-width: calc(100vw - 24px);
        background: rgba(20,20,20,0.92);
        color: #eaeaea;
        border: 1px solid rgba(255,255,255,0.12);
        border-radius: 12px;
        padding: 10px 12px;
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
        z-index: 99999;
        backdrop-filter: blur(6px);
      }
      #m1-room-status .row { display:flex; justify-content:space-between; gap: 12px; padding: 3px 0; }
      #m1-room-status .k { opacity: .75; }
      #m1-room-status .v { text-align: right; overflow:hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 220px; }
      #m1-room-status .title { font-weight: 700; margin-bottom: 6px; display:flex; justify-content:space-between; align-items:center;}
      #m1-room-status .pill { font-size: 12px; padding: 2px 8px; border-radius: 999px; border: 1px solid rgba(255,255,255,0.12); opacity: .95; }
      #m1-room-status .sep { height: 1px; background: rgba(255,255,255,0.10); margin: 8px 0; }
      #m1-room-status pre {
        margin: 0;
        background: rgba(255,255,255,0.06);
        border: 1px solid rgba(255,255,255,0.08);
        border-radius: 10px;
        padding: 8px;
        max-height: 180px;
        overflow: auto;
        font-size: 12px;
        line-height: 1.25;
        white-space: pre-wrap;
        word-break: break-word;
      }
      #m1-room-status button {
        background: rgba(255,255,255,0.08);
        color: #eaeaea;
        border: 1px solid rgba(255,255,255,0.12);
        border-radius: 10px;
        padding: 6px 10px;
        cursor: pointer;
      }
      #m1-room-status button:hover { background: rgba(255,255,255,0.12); }
    `;
    document.head.appendChild(s);
  }

  if (document.getElementById("m1-room-status")) return;

  const el = document.createElement("div");
  el.id = "m1-room-status";
  el.innerHTML = `
    <div class="title">
      <div>Room Status (M1-0)</div>
      <div style="display:flex; gap:8px; align-items:center;">
        <span id="m1-pill-ws" class="pill">WS: DISCONNECTED</span>
        <button id="m1-btn-clearlog" type="button">清日志</button>
      </div>
    </div>

    <div class="row"><div class="k">roomId</div><div class="v" id="m1-v-roomId">-</div></div>
    <div class="row"><div class="k">peerId</div><div class="v" id="m1-v-peerId">-</div></div>
    <div class="row"><div class="k">wsUrl</div><div class="v" id="m1-v-wsUrl">-</div></div>

    <div class="sep"></div>

    <div class="row"><div class="k">device</div><div class="v" id="m1-v-device">-</div></div>
    <div class="row"><div class="k">sendTransport</div><div class="v" id="m1-v-sendT">-</div></div>
    <div class="row"><div class="k">recvTransport</div><div class="v" id="m1-v-recvT">-</div></div>

    <div class="sep"></div>

    <div class="row"><div class="k">localProducers</div><div class="v" id="m1-v-producers">0</div></div>
    <div class="row"><div class="k">remoteConsumers</div><div class="v" id="m1-v-consumers">0</div></div>
    <div class="row"><div class="k">consumedProducerIds</div><div class="v" id="m1-v-consumed">0</div></div>

    <div class="sep"></div>

    <pre id="m1-pre-log"></pre>
  `;
  document.body.appendChild(el);

  document.getElementById("m1-btn-clearlog")?.addEventListener("click", () => {
    __roomLogs.length = 0;
    renderRoomStatus();
  });

  renderRoomStatus();
}

function setRoomStatus(patch: Partial<RoomStatus>) {
  Object.assign(__roomStatus, patch);
  renderRoomStatus();
}

function statusPushLog(msg: string) {
  const t = new Date();
  const hh = String(t.getHours()).padStart(2, "0");
  const mm = String(t.getMinutes()).padStart(2, "0");
  const ss = String(t.getSeconds()).padStart(2, "0");
  __roomLogs.push(`[${hh}:${mm}:${ss}] ${msg}`);
  if (__roomLogs.length > __roomLogMax) __roomLogs.splice(0, __roomLogs.length - __roomLogMax);
  renderRoomStatus();
}

function renderRoomStatus() {
  const pill = document.getElementById("m1-pill-ws");
  const vRoomId = document.getElementById("m1-v-roomId");
  const vPeerId = document.getElementById("m1-v-peerId");
  const vWsUrl = document.getElementById("m1-v-wsUrl");

  const vDevice = document.getElementById("m1-v-device");
  const vSendT = document.getElementById("m1-v-sendT");
  const vRecvT = document.getElementById("m1-v-recvT");

  const vProducers = document.getElementById("m1-v-producers");
  const vConsumers = document.getElementById("m1-v-consumers");
  const vConsumed = document.getElementById("m1-v-consumed");

  const pre = document.getElementById("m1-pre-log");

  if (pill) pill.textContent = `WS: ${__roomStatus.wsState}`;
  if (vRoomId) vRoomId.textContent = __roomStatus.roomId || "-";
  if (vPeerId) vPeerId.textContent = __roomStatus.peerId || "-";
  if (vWsUrl) vWsUrl.textContent = __roomStatus.wsUrl || "-";

  if (vDevice) vDevice.textContent = __roomStatus.deviceReady ? "READY" : "NOT READY";

  const sendStr = `${__roomStatus.sendTransportReady ? "READY" : "NOT READY"} / ${__roomStatus.sendTransportConnected ? "CONNECTED" : "NOT CONNECTED"}`;
  const recvStr = `${__roomStatus.recvTransportReady ? "READY" : "NOT READY"} / ${__roomStatus.recvTransportConnected ? "CONNECTED" : "NOT CONNECTED"}`;
  if (vSendT) vSendT.textContent = sendStr;
  if (vRecvT) vRecvT.textContent = recvStr;

  if (vProducers) vProducers.textContent = String(__roomStatus.localProducers ?? 0);
  if (vConsumers) vConsumers.textContent = String(__roomStatus.remoteConsumers ?? 0);
  if (vConsumed) vConsumed.textContent = String(__roomStatus.consumedProducerIds?.length ?? 0);

  if (pre) pre.textContent = __roomLogs.join("\n");
}

export {
  initRoomStatusPanel,
  setRoomStatus,
  statusPushLog,
};