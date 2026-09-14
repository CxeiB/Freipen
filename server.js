#!/usr/bin/env node
/**
 * Freipen — 加密写作空间（支持多工作区，可部署为在线服务）· 后端（零第三方运行时依赖）
 *
 * 设计要点：
 *  - 每个工作区相互独立：各自持有 KDF 参数 + 加密的目录树索引（AES-GCM 密文 Base64）。
 *  - 一篇笔记一个文件，同样只保存密文；服务端不理解正文、文件名、目录结构。
 *  - 服务端仅以明文保存“工作区注册表”（id + 名称 + 创建时间），用于登录页列出工作区；
 *    工作区内部的一切内容仍为端到端加密。
 *  - 默认只监听 127.0.0.1；部署为在线应用时可用 FW_HOST=0.0.0.0（配合反向代理/HTTPS）。
 *
 * 启动：node server.js   （默认端口 4100，可用环境变量 FW_PORT / FW_HOST / FW_DATA 覆盖）
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const HOST = process.env.FW_HOST || '127.0.0.1';
const PORT = Number(process.env.FW_PORT || process.env.PORT || 4100);
const DATA_DIR = process.env.FW_DATA ? path.resolve(process.env.FW_DATA) : path.join(__dirname, 'data');
const STATIC_DIR = path.join(__dirname, 'dist');

const REGISTRY_FILE = path.join(DATA_DIR, 'workspaces.json');
const WS_ROOT = path.join(DATA_DIR, 'workspaces');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BODY = 64 * 1024 * 1024; // 单请求体上限 64MB

/* ------------------------------------------------------------------ */
/* 存储                                                               */
/* ------------------------------------------------------------------ */

function ensureDirs() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(WS_ROOT, { recursive: true });
}

function atomicWriteJson(file, obj) {
  const tmp = file + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(obj), 'utf8');
  fs.renameSync(tmp, file);
}

function wsDir(id) {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) return null;
  const dir = path.join(WS_ROOT, id);
  return dir.startsWith(WS_ROOT + path.sep) ? dir : null;
}

function vaultFileOf(id) {
  const dir = wsDir(id);
  return dir ? path.join(dir, 'vault.json') : null;
}

function notesDirOf(id) {
  const dir = wsDir(id);
  return dir ? path.join(dir, 'notes') : null;
}

/** 读取工作区注册表：{ list: [{id, name, createdAt}] } */
function readRegistry() {
  try {
    const raw = fs.readFileSync(REGISTRY_FILE, 'utf8');
    const o = JSON.parse(raw);
    if (o && Array.isArray(o.list)) return o;
  } catch {
    /* ignore */
  }
  return { list: [] };
}

function writeRegistry(reg) {
  ensureDirs();
  atomicWriteJson(REGISTRY_FILE, reg);
}

function findWs(id) {
  const reg = readRegistry();
  return reg.list.find((w) => w.id === id) || null;
}

function readVault(id) {
  const vf = vaultFileOf(id);
  if (!vf) return null;
  try {
    const raw = fs.readFileSync(vf, 'utf8');
    const v = JSON.parse(raw);
    if (!v || typeof v !== 'object') return null;
    if (typeof v.index !== 'string' || !v.kdf || typeof v.kdf !== 'object') return null;
    return v;
  } catch {
    return null;
  }
}

function notePathOf(id, noteId) {
  if (!UUID_RE.test(noteId)) return null;
  const nd = notesDirOf(id);
  return nd ? path.join(nd, noteId + '.json') : null;
}

function readNote(id, noteId) {
  const p = notePathOf(id, noteId);
  if (!p) return null;
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const o = JSON.parse(raw);
    return o && typeof o.data === 'string' ? o.data : null;
  } catch {
    return null;
  }
}

function writeNote(id, noteId, data) {
  const p = notePathOf(id, noteId);
  if (!p) return false;
  atomicWriteJson(p, { id: noteId, data });
  return true;
}

function deleteNote(id, noteId) {
  const p = notePathOf(id, noteId);
  if (!p) return false;
  try {
    fs.unlinkSync(p);
    return true;
  } catch {
    return false;
  }
}

/** 迁移旧版单工作区布局（data/vault.json + data/notes/）到多工作区目录结构 */
function migrateLegacyIfNeeded() {
  ensureDirs();
  if (fs.existsSync(REGISTRY_FILE)) return;
  const legacyVault = path.join(DATA_DIR, 'vault.json');
  if (!fs.existsSync(legacyVault)) return;
  const id = crypto.randomUUID();
  const reg = { list: [{ id, name: '我的工作区', createdAt: new Date().toISOString() }] };
  writeRegistry(reg);
  const dir = wsDir(id);
  const notesFrom = path.join(DATA_DIR, 'notes');
  const notesTo = notesDirOf(id);
  fs.mkdirSync(dir, { recursive: true });
  fs.renameSync(legacyVault, path.join(dir, 'vault.json'));
  if (fs.existsSync(notesFrom)) {
    fs.mkdirSync(notesTo, { recursive: true });
    for (const f of fs.readdirSync(notesFrom)) {
      try {
        fs.renameSync(path.join(notesFrom, f), path.join(notesTo, f));
      } catch {
        /* ignore */
      }
    }
    try {
      fs.rmdirSync(notesFrom);
    } catch {
      /* ignore */
    }
  }
}

/* ------------------------------------------------------------------ */
/* HTTP 工具                                                          */
/* ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
};

function baseHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "connect-src 'self'",
      "worker-src 'self' blob:",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; ')
  );
}

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

/** 读取请求体（带大小上限） */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    const len = Number(req.headers['content-length'] || 0);
    if (len > MAX_BODY) {
      reject(new Error('payload-too-large'));
      return;
    }
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('payload-too-large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJSONBody(req) {
  const buf = await readBody(req);
  if (buf.length === 0) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw new Error('bad-json');
  }
}

/* ------------------------------------------------------------------ */
/* API 处理器                                                         */
/* ------------------------------------------------------------------ */

function validateKdf(kdf) {
  return (
    kdf &&
    typeof kdf === 'object' &&
    kdf.alg === 'pbkdf2-sha256' &&
    typeof kdf.salt === 'string' &&
    kdf.salt.length > 0 &&
    kdf.salt.length <= 1024 &&
    Number.isInteger(kdf.iterations) &&
    kdf.iterations >= 10000 &&
    kdf.iterations <= 10000000
  );
}

function validateIndex(index) {
  return typeof index === 'string' && index.length > 0 && index.length <= MAX_BODY - 1024;
}

function validateWsName(name) {
  if (typeof name !== 'string') return false;
  const n = name.trim();
  return n.length >= 1 && n.length <= 60;
}

async function handleApi(req, res, url) {
  const method = req.method;
  const seg = url.pathname.split('/').filter(Boolean); // e.g. ['api','workspaces','<id>','notes','<nid>']

  // ---------- 工作区注册表 ----------
  // GET /api/workspaces —— 列出所有工作区（元信息：id/name/createdAt）
  if (seg.length === 2 && seg[0] === 'api' && seg[1] === 'workspaces' && method === 'GET') {
    const reg = readRegistry();
    return sendJSON(res, 200, { ok: true, workspaces: reg.list });
  }

  // POST /api/workspaces —— 新建工作区（仅注册；加密索引随后 PUT /vault）
  if (seg.length === 2 && seg[0] === 'api' && seg[1] === 'workspaces' && method === 'POST') {
    const body = await readJSONBody(req);
    const name = (body && body.name !== undefined ? String(body.name) : '我的工作区').trim();
    if (!validateWsName(name)) return sendJSON(res, 400, { ok: false, error: 'bad-name' });
    const id = crypto.randomUUID();
    const reg = readRegistry();
    reg.list.push({ id, name, createdAt: new Date().toISOString() });
    writeRegistry(reg);
    fs.mkdirSync(notesDirOf(id), { recursive: true });
    return sendJSON(res, 200, { ok: true, id, name });
  }

  // DELETE /api/workspaces/:id —— 删除工作区（含其全部密文文件）
  if (seg.length === 3 && seg[0] === 'api' && seg[1] === 'workspaces' && method === 'DELETE') {
    const id = seg[2];
    if (!findWs(id)) return sendJSON(res, 404, { ok: false, error: 'ws-not-found' });
    const reg = readRegistry();
    reg.list = reg.list.filter((w) => w.id !== id);
    writeRegistry(reg);
    try {
      fs.rmSync(wsDir(id), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    return sendJSON(res, 200, { ok: true });
  }

  // PATCH /api/workspaces/:id —— 重命名工作区
  if (seg.length === 3 && seg[0] === 'api' && seg[1] === 'workspaces' && method === 'PATCH') {
    const id = seg[2];
    const reg = readRegistry();
    const w = reg.list.find((x) => x.id === id);
    if (!w) return sendJSON(res, 404, { ok: false, error: 'ws-not-found' });
    const body = await readJSONBody(req);
    const name = (body && body.name !== undefined ? String(body.name) : '').trim();
    if (!validateWsName(name)) return sendJSON(res, 400, { ok: false, error: 'bad-name' });
    w.name = name;
    writeRegistry(reg);
    return sendJSON(res, 200, { ok: true, name: w.name });
  }

  // ---------- 工作区密文：vault（加密目录树索引） ----------
  // GET /api/workspaces/:id/vault
  if (seg.length === 4 && seg[0] === 'api' && seg[1] === 'workspaces' && seg[3] === 'vault' && method === 'GET') {
    const id = seg[2];
    if (!findWs(id)) return sendJSON(res, 404, { ok: false, error: 'ws-not-found' });
    const v = readVault(id);
    if (!v) return sendJSON(res, 200, { ok: true, initialized: false, id });
    return sendJSON(res, 200, { ok: true, initialized: true, id, kdf: v.kdf, index: v.index });
  }

  // PUT /api/workspaces/:id/vault —— 保存/首次写入加密索引（可附随 KDF 用于初始化或改密）
  if (seg.length === 4 && seg[0] === 'api' && seg[1] === 'workspaces' && seg[3] === 'vault' && method === 'PUT') {
    const id = seg[2];
    if (!findWs(id)) return sendJSON(res, 404, { ok: false, error: 'ws-not-found' });
    const body = await readJSONBody(req);
    const hasIndex = body.index !== undefined;
    const hasKdf = body.kdf !== undefined;
    if (!hasIndex && !hasKdf) return sendJSON(res, 400, { ok: false, error: 'bad-body' });
    if (hasIndex && !validateIndex(body.index)) return sendJSON(res, 400, { ok: false, error: 'bad-index' });
    if (hasKdf && !validateKdf(body.kdf)) return sendJSON(res, 400, { ok: false, error: 'bad-kdf' });
    const dir = wsDir(id);
    fs.mkdirSync(dir, { recursive: true });
    const prev = readVault(id);
    const next = prev || { createdAt: new Date().toISOString() };
    if (hasIndex) next.index = body.index;
    if (hasKdf) next.kdf = body.kdf;
    next.updatedAt = new Date().toISOString();
    atomicWriteJson(path.join(dir, 'vault.json'), next);
    return sendJSON(res, 200, { ok: true });
  }

  // ---------- 工作区密文：notes ----------
  // /api/workspaces/:id/notes/:noteId
  if (seg.length === 5 && seg[0] === 'api' && seg[1] === 'workspaces' && seg[3] === 'notes') {
    const id = seg[2];
    const noteId = seg[4];
    if (!findWs(id)) return sendJSON(res, 404, { ok: false, error: 'ws-not-found' });
    if (!UUID_RE.test(noteId)) return sendJSON(res, 400, { ok: false, error: 'bad-id' });
    if (method === 'GET') {
      const data = readNote(id, noteId);
      if (data === null) return sendJSON(res, 404, { ok: false, error: 'note-not-found' });
      return sendJSON(res, 200, { ok: true, data });
    }
    if (method === 'PUT' || method === 'POST') {
      const body = await readJSONBody(req);
      if (typeof body.data !== 'string') return sendJSON(res, 400, { ok: false, error: 'bad-data' });
      if (body.data.length > MAX_BODY - 1024) return sendJSON(res, 413, { ok: false, error: 'payload-too-large' });
      fs.mkdirSync(notesDirOf(id), { recursive: true });
      writeNote(id, noteId, body.data);
      return sendJSON(res, 200, { ok: true });
    }
    if (method === 'DELETE') {
      deleteNote(id, noteId);
      return sendJSON(res, 200, { ok: true });
    }
  }

  return sendJSON(res, 404, { ok: false, error: 'not-found' });
}

/* ------------------------------------------------------------------ */
/* 静态资源（构建产物 dist/）                                          */
/* ------------------------------------------------------------------ */

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  // 规范化并防止目录穿越
  const file = path.normalize(path.join(STATIC_DIR, rel));
  if (!file.startsWith(STATIC_DIR + path.sep) && file !== path.join(STATIC_DIR, 'index.html')) {
    return sendJSON(res, 403, { ok: false, error: 'forbidden' });
  }
  fs.stat(file, (err, st) => {
    if (!err && st.isFile()) {
      const ext = path.extname(file).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
      });
      fs.createReadStream(file).pipe(res);
      return;
    }
    // SPA 兜底：任何非 API 的 GET 都回 index.html（本应用为单页）
    const idx = path.join(STATIC_DIR, 'index.html');
    fs.stat(idx, (e2) => {
      if (e2) return sendJSON(res, 404, { ok: false, error: 'not-found' });
      res.writeHead(200, { 'Content-Type': MIME['.html'] });
      fs.createReadStream(idx).pipe(res);
    });
  });
}

/* ------------------------------------------------------------------ */
/* 启动                                                               */
/* ------------------------------------------------------------------ */

const server = http.createServer((req, res) => {
  baseHeaders(res);
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url).catch((e) => {
      const msg = e && e.message;
      if (msg === 'payload-too-large') return sendJSON(res, 413, { ok: false, error: 'payload-too-large' });
      if (msg === 'bad-json') return sendJSON(res, 400, { ok: false, error: 'bad-json' });
      console.error('[api-error]', e);
      sendJSON(res, 500, { ok: false, error: 'internal' });
    });
    return;
  }
  serveStatic(req, res, url.pathname);
});

ensureDirs();
migrateLegacyIfNeeded();
if (!fs.existsSync(path.join(STATIC_DIR, 'index.html'))) {
  console.warn('[warn] 未找到前端构建产物 ' + STATIC_DIR + '，请先运行 npm run build');
}

server.listen(PORT, HOST, () => {
  const reg = readRegistry();
  console.log('');
  console.log('  ███████╗ ██████╗  ');
  console.log('  ██╔════╝ ██╔══██╗   Freipen · 加密写作空间（多工作区）');
  console.log('  █████╗   ██████╔╝   ');
  console.log('  ██╔══╝   ██╔═══╝    ');
  console.log('  ██║      ██║        ');
  console.log('  ╚═╝      ╚═╝        ');
  console.log('');
  console.log('  ➜ 访问地址:      http://' + HOST + ':' + PORT);
  console.log('  ➜ 数据目录:      ' + DATA_DIR);
  console.log('  ➜ 工作区数量:    ' + reg.list.length + (reg.list.length ? '（' + reg.list.map((w) => w.name).join('、') + '）' : '（尚未创建）'));
  console.log('  ➜ 默认监听 ' + HOST + '；部署为在线服务时可用 FW_HOST=0.0.0.0 开放访问（建议经 HTTPS 反向代理）');
  console.log('');
});
