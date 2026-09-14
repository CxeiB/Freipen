/**
 * 加密模块 —— 全部在浏览器内完成。
 *
 *  - 密钥派生：PBKDF2-HMAC-SHA256（salt 随机 16 字节，迭代次数记录在工作区元数据里）
 *  - 加密算法：AES-256-GCM（随机 12 字节 IV，可选的附加认证数据 AAD 绑定用途/笔记 ID）
 *  - 密文格式：Base64( IV(12B) ‖ Ciphertext ) —— 单一字符串，方便仅以密文在前后端之间传输
 *
 * 密钥为 non-extractable CryptoKey，仅存在于内存；明文从不离开本页。
 */

const enc = new TextEncoder();
const dec = new TextDecoder();
const IV_LEN = 12;

/** Uint8Array → Base64 */
export function b64FromBytes(buf) {
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < buf.length; i += CH) {
    s += String.fromCharCode.apply(null, buf.subarray(i, i + CH));
  }
  return btoa(s);
}

/** Base64 → Uint8Array */
export function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function randomBytes(n) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

export const KDF_ALG = 'pbkdf2-sha256';
/** PBKDF2 迭代次数（OWASP 2023 建议值） */
export const KDF_ITERATIONS = 600000;

export function makeSaltB64() {
  return b64FromBytes(randomBytes(16));
}

/** 由主密钥派生 AES-GCM 密钥（不可导出，仅存内存） */
export async function deriveKey(password, saltB64, iterations) {
  const baseKey = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: b64ToBytes(saltB64), iterations },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/** 加密一段文本 → 返回密文 Base64 字符串 */
export async function encryptToString(key, text, aad) {
  return encryptBytesToB64(key, enc.encode(text), aad);
}

/** 加密原始字节 → 返回密文 Base64 字符串（用于附件等二进制内容） */
export async function encryptBytesToB64(key, bytes, aad) {
  const iv = randomBytes(IV_LEN);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: enc.encode(aad) },
      key,
      bytes
    )
  );
  const out = new Uint8Array(IV_LEN + ct.length);
  out.set(iv, 0);
  out.set(ct, IV_LEN);
  return b64FromBytes(out);
}

/** 解密 Base64 密文字符串。密钥错误/数据损坏 → 抛错（带统一错误消息） */
export async function decryptFromString(key, b64, aad) {
  const pt = await decryptBytesFromB64(key, b64, aad);
  return dec.decode(pt);
}

/** 解密 Base64 密文为原始字节（附件读取用） */
export async function decryptBytesFromB64(key, b64, aad) {
  const all = b64ToBytes(b64);
  if (all.length < IV_LEN + 1) throw new Error('BAD_KEY_OR_DATA');
  const iv = all.slice(0, IV_LEN);
  const data = all.slice(IV_LEN);
  try {
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: enc.encode(aad) },
      key,
      data
    );
    return new Uint8Array(pt);
  } catch {
    throw new Error('BAD_KEY_OR_DATA');
  }
}

/** 附件 / 图片工具 */
export function mimeOf(name, mime) {
  if (mime) return mime;
  const ext = (name.split('.').pop() || '').toLowerCase();
  const map = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
    svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif',
    pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', json: 'application/json',
    mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', mp4: 'video/mp4', webm: 'video/webm',
    zip: 'application/zip', csv: 'text/csv',
  };
  return map[ext] || 'application/octet-stream';
}

export function isImageMime(mime) {
  return /^image\//.test(mime || '');
}

/** 字节 → DataURL（图片在编辑器中直接展示） */
export function bytesToDataURL(bytes, mime) {
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return 'data:' + mime + ';base64,' + btoa(s);
}

/** DataURL → 原始字节（用于把编辑器里的 data: URI 还原为文件） */
export function dataURLToBytes(dataUrl) {
  const comma = dataUrl.indexOf(',');
  const b64 = dataUrl.slice(comma + 1);
  return b64ToBytes(b64);
}

export function formatSize(n) {
  if (n == null) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

/** 附加认证数据命名空间 */
export const AAD_TREE = 'Freipen.tree.v1';
export const aadForNote = (id) => 'Freipen.note.v1.' + id;
export const aadForAttachment = (id) => 'Freipen.attach.v1.' + id;
