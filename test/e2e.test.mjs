/**
 * Freipen 端到端自检（无需浏览器）：
 *   1. 用 Node 内置 WebCrypto 复刻前端的 PBKDF2 + AES-GCM 加解密；
 *   2. 通过 HTTP 与运行中的服务端做“仅密文”往返；
 *   3. 校验服务端数据目录文件里不存在任何明文片段；
 *   4. 结束时重置工作区，恢复未初始化状态。
 *
 * 用法：先 node server.js，再执行 node test/e2e.test.mjs
 * （可用环境变量 FW_BASE 指定服务地址，默认 http://127.0.0.1:4100）
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.FW_BASE || 'http://127.0.0.1:4100';
const DATA_DIR = process.env.FW_DATA || path.join(__dirname, '..', 'data');
const PROJECT_ROOT = path.join(__dirname, '..');

let failed = 0;
function assert(cond, label) {
  if (cond) {
    console.log('  ✔ ' + label);
  } else {
    failed++;
    console.error('  ✘ ' + label);
  }
}

/* ---------- 浏览器端加解密复刻（与 src/lib/crypto.js 一致） ---------- */

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64FromBytes(buf) {
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < buf.length; i += CH) s += String.fromCharCode.apply(null, buf.subarray(i, i + CH));
  return btoa(s);
}
function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
async function deriveKey(password, saltB64, iterations) {
  const baseKey = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: b64ToBytes(saltB64), iterations },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}
async function encryptToString(key, text, aad) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(aad) }, key, enc.encode(text))
  );
  const out = new Uint8Array(12 + ct.length);
  out.set(iv, 0);
  out.set(ct, 12);
  return b64FromBytes(out);
}
async function decryptFromString(key, b64, aad) {
  const all = b64ToBytes(b64);
  const iv = all.slice(0, 12);
  const data = all.slice(12);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(aad) }, key, data);
  return dec.decode(pt);
}
const AAD_TREE = 'Freipen.tree.v1';
const aadForNote = (id) => 'Freipen.note.v1.' + id;
const uid = () => crypto.randomUUID();

async function req(method, p, body, headers = {}) {
  const res = await fetch(BASE + p, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {}
  return { status: res.status, json };
}

/* ---------- 检查数据目录不含明文 ---------- */

function scanForPlaintext(markers) {
  const hits = [];
  if (!fs.existsSync(DATA_DIR)) return hits;
  const walk = (dir) => {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, f.name);
      if (f.isDirectory()) walk(p);
      else {
        let raw;
        try {
          raw = fs.readFileSync(p, 'utf8');
        } catch {
          continue;
        }
        for (const m of markers) if (raw.includes(m)) hits.push({ file: p, marker: m });
      }
    }
  };
  walk(DATA_DIR);
  return hits;
}

/* ---------- 主流程 ---------- */

console.log('\n[1] 初始状态检查');
{
  const r = await req('GET', '/api/workspaces');
  assert(r.status === 200 && Array.isArray(r.json.workspaces) && r.json.workspaces.length === 0, '初始无任何工作区');
}

console.log('\n[2] 创建加密工作区');
const password = 'selftest-主密钥-π-123456';
const saltB64 = b64FromBytes(crypto.getRandomValues(new Uint8Array(16)));
const iterations = 120000; // 自检用较小迭代次数以提速
const key = await deriveKey(password, saltB64, iterations);

const noteId = uid();
const folderId = uid();
const PLAIN_TITLE = '机密项目计划-不要外泄';
const PLAIN_BODY =
  '你好，Freipen —— 这是端到端密文往返测试。\n第二行包含 **加粗** 与 `code`，还有中文与 emoji 🚀。';
const tree = {
  v: 1,
  root: {
    kind: 'folder',
    id: 'root',
    name: '',
    children: [
      { kind: 'folder', id: folderId, name: '机密目录', children: [{ kind: 'file', id: noteId, name: PLAIN_TITLE }] },
    ],
  },
};
const treeJson = JSON.stringify(tree);
const indexEnc = await encryptToString(key, treeJson, AAD_TREE);
const noteEnc = await encryptToString(key, PLAIN_BODY, aadForNote(noteId));

let r = await req('POST', '/api/workspaces', { name: 'E2E 自检工作区' });
assert(r.status === 200 && r.json.ok === true && /^[0-9a-f-]{36}$/.test(r.json.id), 'POST /api/workspaces 创建工作区成功');
const wsId = r.json.id;

r = await req('PUT', '/api/workspaces/' + wsId + '/vault', { kdf: { alg: 'pbkdf2-sha256', salt: saltB64, iterations }, index: indexEnc });
assert(r.status === 200 && r.json.ok === true, 'PUT /vault 写入加密索引成功');

console.log('\n[3] 保存与读取笔记（仅密文传输）');
r = await req('PUT', '/api/workspaces/' + wsId + '/notes/' + noteId, { data: noteEnc });
assert(r.status === 200 && r.json.ok === true, 'PUT notes/:id 保存成功');

r = await req('GET', '/api/workspaces/' + wsId + '/notes/' + noteId);
assert(r.status === 200 && r.json.data === noteEnc, 'GET 返回的密文与上传一致（字节级）');
const decryptedBody = await decryptFromString(key, r.json.data, aadForNote(noteId));
assert(decryptedBody === PLAIN_BODY, '解密后正文与原文一致');

console.log('\n[4] 读取目录树密文并解密');
r = await req('GET', '/api/workspaces/' + wsId + '/vault');
assert(r.status === 200 && r.json.initialized === true, 'GET vault 报告已初始化');
assert(r.json.kdf.alg === 'pbkdf2-sha256' && r.json.kdf.salt === saltB64 && r.json.kdf.iterations === iterations, 'KDF 参数回传一致');
const decryptedTree = JSON.parse(await decryptFromString(key, r.json.index, AAD_TREE));
assert(
  JSON.stringify(decryptedTree) === treeJson &&
    decryptedTree.root.children[0].name === '机密目录' &&
    decryptedTree.root.children[0].children[0].name === PLAIN_TITLE,
  '目录树解密后结构与文件名一致（服务端不识明文）'
);

console.log('\n[5] 错误密钥必须解密失败');
const wrongKey = await deriveKey('wrong-password', saltB64, iterations);
let wrongOk = true;
try {
  await decryptFromString(wrongKey, r.json.index, AAD_TREE);
} catch {
  wrongOk = false;
}
assert(wrongOk === false, '错误密钥无法解密（GCM 认证失败）');

console.log('\n[6] 更新目录树（重命名）');
tree.root.children[0].name = '已改名目录';
const indexEnc2 = await encryptToString(key, JSON.stringify(tree), AAD_TREE);
r = await req('PUT', '/api/workspaces/' + wsId + '/vault', { index: indexEnc2 });
assert(r.status === 200, 'PUT vault 更新成功');
r = await req('GET', '/api/workspaces/' + wsId + '/vault');
const tree2 = JSON.parse(await decryptFromString(key, r.json.index, AAD_TREE));
assert(tree2.root.children[0].name === '已改名目录', '再次解密确认结构已更新');

console.log('\n[7] 删除笔记');
r = await req('DELETE', '/api/workspaces/' + wsId + '/notes/' + noteId);
assert(r.status === 200, 'DELETE 成功');
r = await req('GET', '/api/workspaces/' + wsId + '/notes/' + noteId);
assert(r.status === 404, '删除后 GET 返回 404');

console.log('\n[8] 磁盘密文检查（不得出现正文/文件名明文）');
const markers = [PLAIN_TITLE, PLAIN_BODY, '机密目录', '不要外泄'];
const hits = scanForPlaintext(markers);
assert(hits.length === 0, hits.length === 0 ? '数据目录文件中未发现任何明文片段' : '发现明文: ' + JSON.stringify(hits));

console.log('\n[9] 工作区隔离与清理');
r = await req('POST', '/api/workspaces', { name: '第二个工作区' });
assert(r.status === 200, '可创建第二个工作区');
const ws2 = r.json.id;
r = await req('GET', '/api/workspaces');
assert(Array.isArray(r.json.workspaces) && r.json.workspaces.length === 2, '工作区列表包含两个工作区');
r = await req('GET', '/api/workspaces/' + ws2 + '/vault');
assert(r.status === 200 && r.json.initialized === false, '新工作区独立且未初始化');
r = await req('GET', '/api/workspaces/' + wsId + '/vault');
assert(r.status === 200 && r.json.initialized === true, '原工作区数据不受影响');
r = await req('DELETE', '/api/workspaces/' + wsId);
assert(r.status === 200, '删除工作区成功');
r = await req('DELETE', '/api/workspaces/' + ws2);
assert(r.status === 200, '清理第二个工作区成功');
r = await req('GET', '/api/workspaces');
assert(r.json.workspaces.length === 0, '清理后工作区列表为空（可重复运行）');

console.log('\n[10] 静态页面');
r = await req('GET', '/');
assert(r.status === 200, '首页可访问（HTTP 200）');
const html = await (await fetch(BASE + '/')).text();
assert(html.includes('Freipen') && html.includes('assets/'), '首页包含应用与构建资源引用');

console.log('');
if (failed) {
  console.error('自检失败项：' + failed);
  process.exit(1);
}
console.log('全部自检通过 ✔\n');
process.exit(0);
