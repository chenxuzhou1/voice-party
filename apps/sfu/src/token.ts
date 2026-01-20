// apps/sfu/src/token.ts
import crypto from "node:crypto";

const SECRET = process.env.SFU_TOKEN_SECRET || "dev_secret_change_me";

function base64urlEncode(buf: Buffer) {
  return buf
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function base64urlDecodeToBuffer(s: string) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4;
  if (pad) s += "=".repeat(4 - pad);
  return Buffer.from(s, "base64");
}

// ===== M3-1.5 Token Payload =====
export type TokenPayload = {
  roomId: string;

  // 绑定 peerId（强制）
  peerId: string;

  // 绑定 sessionId（可选）
  sessionId?: string;

  // 一次性 token（强制）
  jti: string;

  // 时间（seconds）
  iat: number;
  exp: number;
};

// ===== 一次性 jti 防重放（内存）=====
const usedJti = new Map<string, number>(); // jti -> exp(sec)

function cleanupUsedJti(nowSec: number) {
  for (const [jti, exp] of usedJti.entries()) {
    if (exp <= nowSec) usedJti.delete(jti);
  }
}

export function verifyToken(
  token: string,
  opts?: {
    consumeJti?: boolean; // true = 一次性（连接时用）
    expectedRoomId?: string;
    expectedPeerId?: string;
    expectedSessionId?: string;
    nowSec?: number;
  }
): TokenPayload {
  const parts = token.split(".");
  if (parts.length !== 2) throw new Error("bad_format");

  const [payloadB64, sigB64] = parts;

  // 验签（与你 M3-1 一致）
  const expectedSig = crypto.createHmac("sha256", SECRET).update(payloadB64).digest();
  const gotSig = base64urlDecodeToBuffer(sigB64);

  if (gotSig.length !== expectedSig.length) throw new Error("bad_sig_len");
  if (!crypto.timingSafeEqual(gotSig, expectedSig)) throw new Error("bad_sig");

  // 解析 payload
  const payloadJson = base64urlDecodeToBuffer(payloadB64).toString("utf8");
  const payload = JSON.parse(payloadJson) as TokenPayload;

  // 字段校验
  if (!payload.roomId || typeof payload.roomId !== "string") throw new Error("no_roomId");
  if (!payload.peerId || typeof payload.peerId !== "string") throw new Error("no_peerId");
  if (!payload.jti || typeof payload.jti !== "string") throw new Error("no_jti");
  if (!payload.iat || typeof payload.iat !== "number") throw new Error("no_iat");
  if (!payload.exp || typeof payload.exp !== "number") throw new Error("no_exp");

  const now = opts?.nowSec ?? Math.floor(Date.now() / 1000);

  // exp
  if (payload.exp <= now) throw new Error("expired");
  // iat：允许 30 秒漂移（避免机器时间略偏导致拒绝）
  if (payload.iat > now + 30) throw new Error("iat_in_future");

  // 可选的绑定校验
  if (opts?.expectedRoomId && payload.roomId !== opts.expectedRoomId) throw new Error("roomId_mismatch");
  if (opts?.expectedPeerId && payload.peerId !== opts.expectedPeerId) throw new Error("peerId_mismatch");
  if (opts?.expectedSessionId) {
    const s = payload.sessionId || "";
    if (s !== opts.expectedSessionId) throw new Error("sessionId_mismatch");
  }

  // 一次性 jti（防重放）
  cleanupUsedJti(now);
  if (opts?.consumeJti) {
    if (usedJti.has(payload.jti)) throw new Error("replayed");
    usedJti.set(payload.jti, payload.exp);
  }

  return payload;
}

// 方便脚本生成 token（可选用，不强制）
// 仍然输出两段：payloadB64.sigB64
export function signToken(payload: TokenPayload) {
  const payloadB64 = base64urlEncode(Buffer.from(JSON.stringify(payload), "utf8"));
  const sig = crypto.createHmac("sha256", SECRET).update(payloadB64).digest();
  const sigB64 = base64urlEncode(sig);
  return `${payloadB64}.${sigB64}`;
}
