// apps/desktop/src/room/roompeers.ts

type ProducerInfo = {
  producerId: string;
  peerId?: string;
  kind?: string;
  consumed?: boolean;
  speaking?: boolean;
};

type PeerInfo = {
  peerId: string;
  producers: Map<string, ProducerInfo>;
};

const state = {
  roomId: "-" as string,
  selfPeerId: "" as string,
  peers: new Map<string, PeerInfo>(),
  producerToPeer: new Map<string, string>(), // producerId -> peerId
};

let root: HTMLDivElement | null = null;
let listEl: HTMLDivElement | null = null;
let titleEl: HTMLSpanElement | null = null;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}

function ensurePeer(peerId: string) {
  let p = state.peers.get(peerId);
  if (!p) {
    p = { peerId, producers: new Map() };
    state.peers.set(peerId, p);
  }
  return p;
}

function shortId(id: string, n = 10) {
  if (!id) return "-";
  return id.length > n ? id.slice(0, n) + "…" : id;
}

/** ===== speaking UI patch（避免全量 render）===== */
function findProducerRowEl(producerId: string): HTMLDivElement | null {
  if (!listEl) return null;
  return listEl.querySelector(`div[data-producer-row="${producerId}"]`) as HTMLDivElement | null;
}

function applySpeakingToRow(row: HTMLDivElement, speaking: boolean) {
  if (speaking) row.classList.add("speaking");
  else row.classList.remove("speaking");

  const right2 = row.querySelector(`[data-producer-right]`) as HTMLDivElement | null;
  const consumed = row.getAttribute("data-consumed") === "1";

  if (right2) {
    if (!consumed) {
      right2.textContent = "not consumed";
      right2.style.opacity = "0.6";
    } else if (speaking) {
      right2.textContent = "SPEAKING 🔊";
      right2.style.opacity = "1";
    } else {
      right2.textContent = "consumed";
      right2.style.opacity = "0.75";
    }
  }
}

function applyConsumedToRow(row: HTMLDivElement, consumed: boolean) {
  row.setAttribute("data-consumed", consumed ? "1" : "0");
  const speaking = row.classList.contains("speaking");
  applySpeakingToRow(row, speaking);
}

/** ===== Style 注入 ===== */
function injectStyleOnce() {
  if (document.getElementById("roompeers-speaking-style")) return;

  const style = document.createElement("style");
  style.id = "roompeers-speaking-style";
  style.textContent = `
    .producer-row {
      position: relative;
      display: flex;
      justify-content: space-between;
      gap: 8px;
      padding: 6px 8px;
      border-radius: 10px;
      transition: background 160ms ease, box-shadow 160ms ease, transform 160ms ease;
      border: 1px solid rgba(255,255,255,0.08);
      background: rgba(255,255,255,0.02);
    }
    .producer-left {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
      flex: 1;
    }
    .producer-dot {
      width: 10px;
      height: 10px;
      border-radius: 999px;
      background: rgba(255,255,255,0.35);
      opacity: 0.8;
      flex: 0 0 auto;
      transition: transform 160ms ease, opacity 160ms ease, box-shadow 160ms ease, background 160ms ease;
    }
    .producer-text {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .producer-right {
      flex: 0 0 auto;
      font-size: 12px;
      opacity: 0.75;
      transition: opacity 160ms ease;
    }
    .producer-row.speaking {
      background: rgba(46, 204, 113, 0.14);
      border-color: rgba(46, 204, 113, 0.28);
      box-shadow:
        0 0 0 1px rgba(46, 204, 113, 0.18) inset,
        0 0 18px rgba(46, 204, 113, 0.22);
      animation: producerPulse 900ms ease-in-out infinite;
    }
    .producer-row.speaking .producer-dot {
      background: rgba(46, 204, 113, 0.95);
      opacity: 1;
      transform: scale(1.15);
      box-shadow: 0 0 10px rgba(46, 204, 113, 0.8);
      animation: dotPulse 900ms ease-in-out infinite;
    }
    .producer-row.speaking .producer-right {
      opacity: 1;
      font-weight: 700;
    }
    @keyframes producerPulse {
      0% { transform: scale(1); }
      50% { transform: scale(1.01); }
      100% { transform: scale(1); }
    }
    @keyframes dotPulse {
      0% { transform: scale(1.05); }
      50% { transform: scale(1.25); }
      100% { transform: scale(1.05); }
    }
  `;
  document.head.appendChild(style);
}

function render() {
  if (!root || !listEl || !titleEl) return;

  titleEl.textContent = `Room Peers (M1-1)  room=${state.roomId}`;
  listEl.innerHTML = "";

  const peers = [...state.peers.values()].sort(
    (a, b) =>
      (a.peerId === state.selfPeerId ? -1 : 0) - (b.peerId === state.selfPeerId ? -1 : 0)
  );

  if (peers.length === 0) {
    const empty = el("div");
    empty.style.opacity = "0.7";
    empty.textContent = "no peers";
    listEl.appendChild(empty);
    return;
  }

  for (const p of peers) {
    const card = el("div");
    card.style.border = "1px solid rgba(255,255,255,0.12)";
    card.style.borderRadius = "10px";
    card.style.padding = "10px";
    card.style.marginBottom = "10px";
    card.style.background = "rgba(255,255,255,0.04)";

    const head = el("div");
    head.style.display = "flex";
    head.style.alignItems = "center";
    head.style.justifyContent = "space-between";
    head.style.gap = "8px";

    const left = el("div");
    left.style.display = "flex";
    left.style.alignItems = "center";
    left.style.gap = "8px";

    const name = el("div");
    name.style.fontWeight = "700";
    name.textContent = `${p.peerId === state.selfPeerId ? "🟢 (me) " : ""}${shortId(p.peerId, 16)}`;

    const badge = el("div");
    badge.style.fontSize = "12px";
    badge.style.opacity = "0.85";
    badge.textContent = `producers: ${p.producers.size}`;

    left.appendChild(name);
    left.appendChild(badge);

    const right = el("div");
    right.style.fontSize = "12px";
    right.style.opacity = "0.75";
    right.textContent = p.peerId;

    head.appendChild(left);
    head.appendChild(right);
    card.appendChild(head);

    const ul = el("div");
    ul.style.marginTop = "8px";
    ul.style.display = "flex";
    ul.style.flexDirection = "column";
    ul.style.gap = "6px";

    if (p.producers.size === 0) {
      const row = el("div");
      row.style.opacity = "0.7";
      row.textContent = "no producers";
      ul.appendChild(row);
    } else {
      for (const prod of p.producers.values()) {
        const row = el("div") as HTMLDivElement;
        row.className = "producer-row";
        row.setAttribute("data-producer-row", prod.producerId);
        row.setAttribute("data-consumed", prod.consumed ? "1" : "0");

        row.style.fontFamily =
          "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace";
        row.style.fontSize = "12px";

        const left2 = el("div") as HTMLDivElement;
        left2.className = "producer-left";

        const dot = el("div") as HTMLDivElement;
        dot.className = "producer-dot";

        const text = el("div") as HTMLDivElement;
        text.className = "producer-text";
        text.textContent = `${prod.kind ?? "?"}  ${shortId(prod.producerId, 16)}`;

        left2.appendChild(dot);
        left2.appendChild(text);

        const right2 = el("div") as HTMLDivElement;
        right2.className = "producer-right";
        right2.setAttribute("data-producer-right", "1");

        if (!prod.consumed) {
          right2.textContent = "not consumed";
          right2.style.opacity = "0.6";
        } else if (prod.speaking) {
          right2.textContent = "SPEAKING 🔊";
          right2.style.opacity = "1";
        } else {
          right2.textContent = "consumed";
          right2.style.opacity = "0.75";
        }

        row.appendChild(left2);
        row.appendChild(right2);

        if (prod.speaking) row.classList.add("speaking");

        ul.appendChild(row);
      }
    }

    card.appendChild(ul);
    listEl.appendChild(card);
  }
}

/** ===== public API ===== */
export function initRoomPeersPanel() {
  if (root) return;

  injectStyleOnce();

  root = el("div");
  root.style.position = "fixed";
  root.style.right = "20px";
  root.style.bottom = "340px";
  root.style.width = "520px";
  root.style.maxWidth = "92vw";
  root.style.maxHeight = "44vh";
  root.style.overflow = "auto";
  root.style.padding = "14px";
  root.style.borderRadius = "14px";
  root.style.background = "rgba(20,20,20,0.92)";
  root.style.border = "1px solid rgba(255,255,255,0.12)";
  root.style.boxShadow = "0 10px 30px rgba(0,0,0,0.35)";
  root.style.color = "#fff";
  root.style.zIndex = "9999";

  const header = el("div");
  header.style.display = "flex";
  header.style.justifyContent = "space-between";
  header.style.alignItems = "center";
  header.style.marginBottom = "10px";

  titleEl = el("span");
  titleEl.style.fontSize = "16px";
  titleEl.style.fontWeight = "800";
  titleEl.textContent = `Room Peers (M1-1)`;

  const btn = el("button");
  btn.textContent = "清空";
  btn.style.padding = "6px 10px";
  btn.style.borderRadius = "10px";
  btn.style.border = "1px solid rgba(255,255,255,0.18)";
  btn.style.background = "rgba(255,255,255,0.06)";
  btn.style.color = "#fff";
  btn.style.cursor = "pointer";
  btn.onclick = () => {
    state.peers.clear();
    state.producerToPeer.clear();
    if (state.selfPeerId) ensurePeer(state.selfPeerId);
    render();
  };

  header.appendChild(titleEl);
  header.appendChild(btn);

  listEl = el("div");

  root.appendChild(header);
  root.appendChild(listEl);

  document.body.appendChild(root);
  render();
}

export function peersReset(keepSelf = true) {
  const keepId = keepSelf ? state.selfPeerId : "";
  state.peers.clear();
  state.producerToPeer.clear();
  if (keepSelf && keepId) ensurePeer(keepId);
  render();
}

export function peersSetRoom(roomId: string) {
  state.roomId = roomId || "-";
  render();
}

export function peersSetSelf(peerId: string) {
  state.selfPeerId = peerId || "";
  if (peerId) ensurePeer(peerId);
  render();
}

// ✅ 让“没有 producer 的 peer”也能显示出来（解决 Join 不显示对方的问题）
export function peersUpsertPeer(peerId: string) {
  if (!peerId) return;
  ensurePeer(peerId);
  render();
}

export function peersUpsertProducer(info: ProducerInfo) {
  if (!info.producerId) return;

  const producerId = info.producerId;

  // peerId：优先用 info.peerId；否则用历史映射；否则 unknown
  const knownPeer = state.producerToPeer.get(producerId);
  const peerId = info.peerId || knownPeer || "unknown";

  // ✅ 如果 producer 之前在别的 peer 下：移过去（关键！）
  if (knownPeer && knownPeer !== peerId) {
    const oldPeer = state.peers.get(knownPeer);
    if (oldPeer) oldPeer.producers.delete(producerId);
  }

  const p = ensurePeer(peerId);
  const prev = p.producers.get(producerId);

  const merged: ProducerInfo = {
    producerId,
    peerId,
    kind: info.kind ?? prev?.kind,
    consumed: info.consumed ?? prev?.consumed ?? false,
    speaking: info.speaking ?? prev?.speaking ?? false,
  };

  p.producers.set(producerId, merged);
  state.producerToPeer.set(producerId, peerId);
  render();
}

export function peersMarkConsumed(producerId: string, consumed = true) {
  const peerId = state.producerToPeer.get(producerId);
  if (!peerId) return;

  const p = state.peers.get(peerId);
  if (!p) return;

  const prod = p.producers.get(producerId);
  if (!prod) return;

  prod.consumed = consumed;

  const row = findProducerRowEl(producerId);
  if (row) applyConsumedToRow(row, consumed);
  else render();
}

export function peersRemoveProducer(producerId: string) {
  const peerId = state.producerToPeer.get(producerId);
  if (!peerId) return;

  const p = state.peers.get(peerId);
  if (p) p.producers.delete(producerId);

  state.producerToPeer.delete(producerId);
  render();
}

export function peersSetSpeaking(producerId: string, speaking: boolean) {
  const peerId = state.producerToPeer.get(producerId);
  if (!peerId) return;

  const p = state.peers.get(peerId);
  if (!p) return;

  const prod = p.producers.get(producerId);
  if (!prod) return;

  if (prod.speaking === speaking) return;
  prod.speaking = speaking;

  const row = findProducerRowEl(producerId);
  if (row) applySpeakingToRow(row, speaking);
  else render();
}
