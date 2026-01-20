const crypto = require("crypto");

const SECRET = process.env.SFU_TOKEN_SECRET || "dev_secret_123";

function b64u(buf){
  return buf.toString("base64").replace(/=/g,"").replace(/\+/g,"-").replace(/\//g,"_");
}

const payload = {
  roomId: "test",
  exp: Math.floor(Date.now()/1000) + 60, // 1 分钟有效
};

const payloadB64 = b64u(Buffer.from(JSON.stringify(payload)));
const sig = crypto.createHmac("sha256", SECRET).update(payloadB64).digest();
const token = payloadB64 + "." + b64u(sig);

console.log(token);
