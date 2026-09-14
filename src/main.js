/**
 * Freipen 主流程 —— Obsidian 风格界面 + 端到端加密、支持多工作区。
 *
 * 理念：
 *  1. 服务端维护“工作区注册表”（id/名称，仅元信息）；每个工作区独立加密。
 *  2. 解锁时输入主密钥 → 浏览器内 PBKDF2 派生 AES-256-GCM 密钥（不可导出）。
 *  3. 解密该工作区的“目录树索引”得到明文文件结构（文件夹 / 笔记名）。
 *  4. 打开笔记 → 拉取密文 → 浏览器内解密 → Milkdown 所见即所得编辑。
 *  5. 编辑 / 结构变更 → 自动加密回传；正文、文件名、目录结构始终只有密文。
 *  可部署为在线应用（FW_HOST=0.0.0.0 + HTTPS 反向代理），内容仍端到端加密。
 */
import './styles.css';
import * as C from './lib/crypto.js';
import { api, useWorkspace, ApiError } from './lib/api.js';
import * as T from './lib/tree.js';
import * as editor from './ui/editor.js';
import * as cmds from './ui/editor-cmds.js';
import { h, icon, toast, clearNode, confirmDialog, openModal, btn, showContextMenu, closeContextMenu, inputDialog } from './ui/ui.js';
import { svg } from './ui/icons.js';
import { initSelectionBar, refreshSelectionBar } from './ui/selectionbar.js';

const $ = (id) => document.getElementById(id);

/* ------------------------------------------------------------------ */
/* 状态                                                               */
/* ------------------------------------------------------------------ */

const S = {
  mode: 'boot', // boot | init | unlock | unlocked
  workspaces: [], // 服务端工作区注册表 [{id,name,createdAt}]
  wsId: null, // 当前工作区 id
  wsName: '', // 当前工作区名称
  key: null, // CryptoKey（仅内存）
  salt: null,
  iterations: C.KDF_ITERATIONS,
  root: null, // 明文目录树根节点
  openId: null,
  contents: new Map(), // noteId -> { text, savedText, dirty, saving, savedAt, timer }
  expanded: new Set(['root']),
  filter: '',
  busy: false,
  ops: Promise.resolve(), // 串行化打开/切换笔记等互斥操作
  // —— 新增（附件/剪贴板/引用标记）——
  clip: null, // { mode:'copy'|'cut', rootId }：被复制的子树（复制时克隆并携带新 id）
  clipNode: null, // 复制模式的待粘贴克隆 { node, noteMap, attachMap }
  refBadges: new Map(), // fileId -> Set<attachId> 该笔记正文中实际引用的附件
  badgePending: new Set(), // 正在异步扫描的文件 id
  imgMap: new Map(), // dataUri -> attachId（当前打开的图片附件，保存时反写为 token）
  attachPick: null, // { noteId, fileInput } 供“添加附件”使用的隐藏 input
  editMode: 'wysiwyg', // wysiwyg（即时渲染） | source（Markdown 源码）
  sourceId: null, // 源码模式下当前编辑的笔记 id
  sideCollapsed: false, // 侧边栏是否折叠（rail 模式）
  treeSort: { by: 'name', dir: 'asc' }, // 文件树排序：by=name|created, dir=asc|desc
  customKeys: {}, // 自定义快捷键：actionId -> 'mod+shift+8' 形式
};

function mkRec(text) {
  return { text, savedText: text, dirty: false, saving: false, savedAt: null, timer: null };
}

function enqueueOp(fn) {
  const p = S.ops.then(fn, fn);
  S.ops = p.catch(() => {});
  return p;
}

/* ------------------------------------------------------------------ */
/* 静态界面装配                                                       */
/* ------------------------------------------------------------------ */

const ICONS = {
  'btn-lock': 'lock',
  'btn-new-folder': 'folderPlus',
  'btn-change-key': 'key',
  'brand-logo': 'shieldLock',
};

function fillStaticIcons() {
  for (const [domId, ic] of Object.entries(ICONS)) {
    $(domId).innerHTML = svg(ic, domId === 'brand-logo' ? 20 : 16);
  }
  $('splash-logo').innerHTML = svg('shieldLock', 42);
  $('gate-logo').innerHTML = svg('shieldLock', 46);
  $('search-ic').innerHTML = svg('search', 15);
  $('empty-icon').innerHTML = svg('edit', 44);

  const newNoteBtn = $('btn-new-note');
  newNoteBtn.innerHTML = svg('filePlus', 16);
  newNoteBtn.title = '新建笔记（Ctrl+N）';

  $('btn-daily').innerHTML = svg('calendar', 16);
  $('btn-side-toggle').innerHTML = svg('panel', 16);
  $('rail-open').innerHTML = svg('panel', 16);
  $('rail-daily').innerHTML = svg('calendar', 16);
  $('rail-lock').innerHTML = svg('lock', 15);
  $('btn-settings').innerHTML = svg('settings', 16);
  $('rail-settings').innerHTML = svg('settings', 15);
  $('btn-sort').innerHTML = svg('sort', 15);

  $('btn-lock').title = '锁定工作区（Ctrl+Shift+L）';
}

/* ------------------------------------------------------------------ */
/* 启动与门禁                                                         */
/* ------------------------------------------------------------------ */

function setSplash(text, err = false) {
  $('splash-text').textContent = text;
  $('splash-text').classList.toggle('err', err);
  $('splash-retry').classList.toggle('hidden', !err);
}

async function boot() {
  S.mode = 'boot';
  $('gate').classList.add('hidden');
  $('workspace').classList.add('hidden');
  $('splash').classList.remove('hidden');
  setSplash('正在连接加密服务…');
  try {
    const r = await api.listWorkspaces();
    S.workspaces = Array.isArray(r.workspaces) ? r.workspaces : [];
    if (!S.workspaces.length) {
      showGate('init');
    } else {
      // 记住上次进入的工作区；无效则取第一个
      let lastId = null;
      try {
        lastId = localStorage.getItem('freipen.lastws');
      } catch {
        /* ignore */
      }
      const hit = S.workspaces.find((w) => w.id === lastId) || S.workspaces[0];
      S.wsId = hit.id;
      S.wsName = hit.name;
      useWorkspace(hit.id);
      showGate('unlock');
    }
  } catch (e) {
    setSplash(e.message, true);
    $('splash-retry').onclick = () => boot();
  }
}

function renderGateWsRow() {
  const row = $('gate-ws-row');
  clearNode(row);
  // 还没有任何工作区（首次创建）：不显示工作区选择
  if (!S.workspaces.length) {
    row.classList.add('hidden');
    return;
  }
  row.classList.remove('hidden');

  // 自绘下拉选择器（不使用原生 <select>）：点击弹出工作区菜单
  const label = h('span', { class: 'gate-ws-label', text: '工作区' });
  const pick = btn('', { onClick: null });
  pick.type = 'button';
  pick.className = 'gate-ws-pick';
  pick.title = '选择要解锁的工作区';
  const pickName = h('span', { class: 'gate-ws-pick-name', text: '' });
  const arrow = h('span', { class: 'gate-ws-pick-arrow' });
  arrow.innerHTML = svg('chevronDown', 14);
  pick.appendChild(pickName);
  pick.appendChild(arrow);

  const currentName = S.mode === 'init' ? '（正在新建…）' : S.wsName || (S.workspaces[0] && S.workspaces[0].name) || '选择工作区';
  pickName.textContent = currentName;

  pick.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const r = pick.getBoundingClientRect();
    const items = [];
    for (const w of S.workspaces) {
      const active = S.mode === 'unlock' && w.id === S.wsId;
      items.push({
        label: (active ? '✓ ' : '') + w.name,
        onClick: () => {
          S.wsId = w.id;
          S.wsName = w.name;
          useWorkspace(w.id);
          try {
            localStorage.setItem('freipen.lastws', w.id);
          } catch {
            /* ignore */
          }
          showGate('unlock');
        },
      });
    }
    items.push({ divider: true });
    items.push(
      S.mode === 'init'
        ? { label: '✓ 正在新建工作区…', disabled: true }
        : { label: '＋ 新建工作区', onClick: () => showGate('init') }
    );
    showContextMenu(r.left, r.bottom + 6, items, { maxHeight: 320 });
  });

  row.appendChild(label);
  row.appendChild(pick);
}

function showGate(mode) {
  S.mode = mode;
  $('splash').classList.add('hidden');
  $('workspace').classList.add('hidden');
  $('gate').classList.remove('hidden');
  const form = $('gate-form');
  form.reset();
  $('gate-error').textContent = '';
  $('gate-error').classList.add('hidden');
  $('gate-strength').classList.add('hidden');

  const nameRow = $('gate-name-row');
  if (mode === 'init') {
    $('gate-sub').textContent = S.workspaces.length
      ? '创建另一个独立加密的工作区（每个工作区各自使用独立主密钥）'
      : '创建一个加密写作空间，让灵感安全落地';
    $('gate-pw').placeholder = '设置主密钥（至少 6 位，建议更长）';
    $('gate-pw2-row').classList.remove('hidden');
    $('gate-submit').textContent = '创建并进入工作区';
    $('gate-meta-line').textContent = S.workspaces.length
      ? '可随时返回门禁页在多个工作区之间切换'
      : '首次使用 · 将生成一个全新的加密工作区';
    $('gate-footnote').textContent =
      '主密钥只用于在浏览器内派生密钥并解密，服务端只保存密文。密钥一旦忘记，内容将永久无法恢复。';
    nameRow.classList.remove('hidden');
  } else {
    $('gate-sub').textContent = S.workspaces.length > 1
      ? '选择一个工作区并输入主密钥'
      : '输入主密钥，解锁你的加密工作区';
    $('gate-pw').placeholder = '主密钥';
    $('gate-pw2-row').classList.add('hidden');
    $('gate-submit').textContent = '解锁';
    $('gate-meta-line').textContent = S.wsName
      ? '当前工作区：' + S.wsName
      : '已检测到加密工作区';
    $('gate-footnote').textContent =
      '解锁在浏览器内完成（PBKDF2 + AES-256-GCM），正文与文件结构始终只有密文。';
    nameRow.classList.add('hidden');
  }
  renderGateWsRow();
  $('gate-pw').focus();
  // 复位提交按钮（此前成功/失败路径可能遗留 disabled）
  const sub = $('gate-submit');
  sub.disabled = false;
  sub.textContent = mode === 'init' ? '创建并进入工作区' : '解锁';
}

function gateError(msg) {
  const el = $('gate-error');
  el.textContent = msg;
  el.classList.remove('hidden');
  el.classList.add('shake');
  setTimeout(() => el.classList.remove('shake'), 400);
}

function setGateBusy(busy, label) {
  const b = $('gate-submit');
  b.disabled = busy;
  if (label) b.textContent = label;
  else b.textContent = S.mode === 'init' ? '创建并进入工作区' : '解锁';
}

/* ---------- 创建 / 解锁 ---------- */

async function submitGate() {
  const pw = $('gate-pw').value;
  if (!pw) return gateError('请输入主密钥');
  if (S.mode === 'init') {
    if (pw.length < 6) return gateError('主密钥至少需要 6 位');
    const pw2 = $('gate-pw2').value;
    if (pw !== pw2) return gateError('两次输入的主密钥不一致');
    await createVault(pw);
  } else {
    if (!S.wsId) return gateError('请先选择工作区');
    await unlockVault(pw);
  }
}

async function createVault(pw) {
  setGateBusy(true, '正在创建加密工作区…');
  try {
    const rawName = ($('gate-name') && $('gate-name').value || '').trim();
    const name = rawName || '我的工作区' + (S.workspaces.length ? ' ' + (S.workspaces.length + 1) : '');
    // 1) 服务端注册工作区
    const ws = await api.createWorkspace(name);
    S.wsId = ws.id;
    S.wsName = ws.name;
    useWorkspace(ws.id);
    S.workspaces.push({ id: ws.id, name: ws.name, createdAt: new Date().toISOString() });
    try {
      localStorage.setItem('freipen.lastws', ws.id);
    } catch {
      /* ignore */
    }

    const salt = C.makeSaltB64();
    const key = await C.deriveKey(pw, salt, C.KDF_ITERATIONS);

    // 空树 + 一篇欢迎笔记
    const root = T.createRoot();
    const welcome = T.addNote(root, T.ROOT_ID, '欢迎使用 Freipen');
    const welcomeText = welcomeMarkdown();
    S.contents.set(welcome.id, mkRec(welcomeText));

    await api.saveNote(welcome.id, await C.encryptToString(key, welcomeText, C.aadForNote(welcome.id)));
    const indexEnc = await C.encryptToString(key, JSON.stringify({ v: 1, root }), C.AAD_TREE);
    await api.saveVault(indexEnc, { alg: C.KDF_ALG, salt, iterations: C.KDF_ITERATIONS });

    S.key = key;
    S.salt = salt;
    S.iterations = C.KDF_ITERATIONS;
    S.root = root;
    S.expanded = new Set(['root']);

    toast('加密工作区「' + ws.name + '」创建成功', 'success');
    enterWorkspace();
    await openNote(welcome.id);
  } catch (e) {
    console.error(e);
    setGateBusy(false);
    gateError('创建工作区失败：' + (e.message || e));
  }
}

async function unlockVault(pw) {
  setGateBusy(true, '正在派生密钥并解密…');
  try {
    const v = await api.getVault();
    if (!v || !v.initialized || !v.kdf) {
      setGateBusy(false);
      gateError('该工作区尚未初始化');
      return;
    }
    S.salt = v.kdf.salt;
    S.iterations = v.kdf.iterations;
    const key = await C.deriveKey(pw, S.salt, S.iterations);
    let plain;
    try {
      plain = await C.decryptFromString(key, v.index, C.AAD_TREE);
    } catch {
      setGateBusy(false);
      gateError('主密钥不正确，无法解密该工作区');
      return;
    }
    const data = JSON.parse(plain);
    if (!data || !data.root) throw new Error('vault 数据损坏');
    S.key = key;
    S.root = data.root;
    S.expanded = new Set(['root', ...allFolderIds(S.root)]);
    enterWorkspace();

    const first = findFirstNote(S.root);
    if (first) await openNote(first.id);
  } catch (e) {
    console.error(e);
    setGateBusy(false);
    gateError('解锁失败：' + (e.message || e));
  }
}

function enterWorkspace() {
  S.mode = 'unlocked';
  $('gate').classList.add('hidden');
  $('splash').classList.add('hidden');
  $('workspace').classList.remove('hidden');
  const wsEl = $('brand-ws');
  if (wsEl) {
    if (S.wsName) {
      wsEl.textContent = S.wsName;
      wsEl.classList.remove('hidden');
    } else {
      wsEl.classList.add('hidden');
    }
  }
  updateDailyButtons();
  renderTree();
  updateStats();
}

/* ------------------------------------------------------------------ */
/* 内容持久化                                                         */
/* ------------------------------------------------------------------ */

async function persistTree(immediate = false) {
  if (!S.key || !S.root) return;
  const doIt = async () => {
    try {
      const indexEnc = await C.encryptToString(S.key, JSON.stringify({ v: 1, root: S.root }), C.AAD_TREE);
      await api.saveVault(indexEnc);
    } catch (e) {
      console.error(e);
      toast('目录结构保存失败：' + (e.message || e), 'error', 4200);
    }
  };
  if (immediate) return doIt();
  clearTimeout(S._treeTimer);
  S._treeTimer = setTimeout(doIt, 350);
}

function scheduleNoteSave(id) {
  const rec = S.contents.get(id);
  if (!rec || rec.saving) return;
  clearTimeout(rec.timer);
  rec.timer = setTimeout(() => flushNote(id), 900);
}

async function flushNote(id) {
  const rec = S.contents.get(id);
  if (!rec || !rec.dirty || rec.saving || !S.key) return;
  clearTimeout(rec.timer);
  rec.saving = true;
  updateSaveState();
  const md = rec.text;
  try {
    const enc = await C.encryptToString(S.key, md, C.aadForNote(id));
    await api.saveNote(id, enc);
    rec.savedText = md;
    rec.dirty = false;
    rec.savedAt = Date.now();
  } catch (e) {
    console.error(e);
    rec.dirty = true;
    toast('笔记保存失败（' + (e.message || e.code) + '）', 'error', 4200);
  } finally {
    rec.saving = false;
    updateSaveState();
  }
}

async function flushAllNow() {
  const ids = [...S.contents.keys()];
  for (const id of ids) await flushNote(id);
}

function flushBeacon() {
  for (const [id, rec] of S.contents) {
    if (rec.dirty && rec.text !== undefined) {
      try {
        C.encryptToString(S.key, rec.text, C.aadForNote(id)).then((enc) => {
          const blob = new Blob([JSON.stringify({ data: enc })], { type: 'application/json' });
          navigator.sendBeacon('/api/notes/' + encodeURIComponent(id), blob);
        });
      } catch {
        /* ignore */
      }
    }
  }
}

function updateSaveState() {
  const rec = S.openId ? S.contents.get(S.openId) : null;
  const el = $('save-state');
  if (!rec) {
    el.textContent = '';
    el.className = 'save-state';
    return;
  }
  if (rec.saving) {
    el.textContent = '保存中…';
    el.className = 'save-state saving';
  } else if (rec.dirty) {
    el.textContent = '● 未保存';
    el.className = 'save-state dirty';
  } else {
    el.textContent = rec.savedAt ? '已保存 ' + fmtTime(rec.savedAt) : '已保存';
    el.className = 'save-state saved';
  }
}

function fmtTime(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

/* ------------------------------------------------------------------ */
/* 笔记打开 / 编辑                                                    */
/* ------------------------------------------------------------------ */

async function openNote(id) {
  if (!S.root || S.mode !== 'unlocked') return;
  if (S.openId === id && !S.contents.get(id)?.needsReload) {
    editor.focusEditor();
    return;
  }
  return enqueueOp(() => openNoteInner(id));
}

async function openNoteInner(id) {
  if (!S.root) return;
  const hit = T.locate(S.root, id);
  if (!hit || hit.node.kind !== 'file') return;

  // 先落盘上一篇的修改
  if (S.openId && S.openId !== id) {
    const prev = S.openId;
    S.openId = null;
    await flushNote(prev);
    if (S.mode !== 'unlocked') return;
  }

  S.openId = id;
  let rec = S.contents.get(id);
  if (!rec) {
    let text = '';
    try {
      const r = await api.getNote(id);
      text = await C.decryptFromString(S.key, r.data, C.aadForNote(id));
    } catch (e) {
      if (e instanceof ApiError && e.code === 'note-not-found') {
        text = ''; // 服务端缺失 → 以空文档打开并在下次编辑时补建
      } else {
        console.error('读取笔记失败', e);
        toast('读取笔记失败：' + (e.message || e), 'error');
        text = '';
      }
    }
    rec = mkRec(text);
    S.contents.set(id, rec);
  }

  // 若内存里有未保存的修改，先补存一次
  if (rec.dirty && !rec.saving) await flushNote(id);
  if (S.mode !== 'unlocked') return;

  // 记录正文引用的附件（attachment:// 引用）
  rememberBadges(id, rec.text);
  if (S.mode !== 'unlocked' || S.openId !== id) return;

  renderDocHead(id);
  renderTree();
  await mountActiveEditor(id);
  if (S.mode !== 'unlocked') return;
  updateSaveState();
  updateStats();
}

async function closeOpenNote() {
  if (!S.openId) return;
  const id = S.openId;
  await flushNote(id);
  S.openId = null;
  await editor.unmountEditor();
  $('editor-host').hidden = true;
  const src = $('source-area');
  if (src) src.hidden = true;
  S.sourceId = null;
  $('empty-state').hidden = false;
  renderDocHead(null);
  renderTree();
  updateSaveState();
  updateStats();
}

/* ------------------------------------------------------------------ */
/* 新建 / 重命名 / 删除                                               */
/* ------------------------------------------------------------------ */

function parentForNew() {
  if (S.openId) {
    const hit = T.locate(S.root, S.openId);
    if (hit && hit.parent && hit.parent.id !== T.ROOT_ID) return hit.parent.id;
  }
  return T.ROOT_ID;
}

async function createNote(parentId, { autoOpen = true } = {}) {
  if (!S.root) return;
  const pid = parentId || parentForNew();
  if (S.filter) {
    S.filter = '';
    $('search-input').value = '';
  }
  const file = T.addNote(S.root, pid);
  const rec = mkRec('');
  S.contents.set(file.id, rec);
  try {
    await api.saveNote(file.id, await C.encryptToString(S.key, '', C.aadForNote(file.id)));
  } catch (e) {
    T.removeNode(S.root, file.id);
    S.contents.delete(file.id);
    toast('新建笔记失败：' + (e.message || e), 'error');
    return;
  }
  ensureExpandedTo(pid);
  await persistTree(true);
  renderTree();
  // VS Code 风格：新建后立即进入命名输入；回车/失焦提交后打开笔记
  if (autoOpen) {
    await inlineNameNewNode(file.id);
    if (S.mode === 'unlocked' && T.locate(S.root, file.id)) await openNote(file.id);
  }
}

async function createFolder(parentId) {
  if (!S.root) return;
  const pid = parentId || T.ROOT_ID;
  const folder = T.addFolder(S.root, pid);
  ensureExpandedTo(pid);
  S.expanded.add(folder.id);
  await persistTree(true);
  renderTree();
  // VS Code 风格：新建后立即进入命名输入
  await inlineNameNewNode(folder.id);
}

/** 对刚创建的节点做一次行内命名；返回最终名称 */
function inlineNameNewNode(id) {
  return new Promise((resolve) => {
    const hit = T.locate(S.root, id);
    if (!hit) {
      resolve(null);
      return;
    }
    renderTree();
    const row = document.querySelector('.tree-row[data-id="' + id + '"]');
    const nameEl = row && row.querySelector('.tree-name');
    if (!row || !nameEl) {
      resolve(hit.node.name);
      return;
    }
    startInlineRename(row, nameEl, hit.node, () => {
      const after = T.locate(S.root, id);
      resolve(after ? after.node.name : null);
    });
  });
}


async function renameNodeById(id, nextName) {
  if (!nextName || !nextName.trim()) return false;
  const name = nextName.trim();
  if (T.renameNode(S.root, id, name)) {
    await persistTree(true);
    renderTree();
    renderDocHead(S.openId);
    return true;
  }
  toast('重命名失败：该名称已存在', 'error');
  return false;
}

async function deleteNodeById(id) {
  const hit = T.locate(S.root, id);
  if (!hit) return;
  const node = hit.node;
  let message;
  let typeWord = null;
  if (node.kind === 'file') {
    const ac = T.attachListOf(node).length;
    message = ac ? '确定删除笔记「' + node.name + '」吗？其 ' + ac + ' 个附件会一并删除。此操作无法撤销。' : '确定删除笔记「' + node.name + '」吗？此操作无法撤销。';
  } else {
    const n = T.countNotes(node);
    message =
      '确定删除文件夹「' +
      node.name +
      '」吗？其中包含 ' +
      n +
      ' 篇笔记，将一并永久删除。此操作无法撤销。';
    typeWord = '删除';
  }
  const ok = await confirmDialog({
    title: node.kind === 'file' ? '删除笔记' : '删除文件夹',
    message,
    danger: true,
    confirmText: '删除',
    typeWord,
  });
  if (!ok) return;

  const removedAttachIds = collectAttachIdsIn(node);
  const { removedFiles } = T.removeNode(S.root, id);
  for (const fid of removedFiles) {
    S.contents.delete(fid);
    S.refBadges.delete(fid);
    S.expanded.delete(fid);
  }
  if (S.openId && removedFiles.includes(S.openId)) {
    await editor.unmountEditor();
    S.openId = null;
    $('editor-host').hidden = true;
    $('empty-state').hidden = false;
  }
  for (const fid of removedFiles) {
    try {
      await api.deleteNote(fid);
    } catch {
      /* 服务端无此密文也可接受 */
    }
  }
  for (const aid of removedAttachIds) {
    try {
      await api.deleteNote(aid);
    } catch {
      /* ignore */
    }
  }
  await persistTree(true);
  renderTree();
  renderDocHead(S.openId);
  updateStats();
  toast('已删除', 'success');
}

/* ------------------------------------------------------------------ */
/* 锁定 / 更改密钥 / 重置                                             */
/* ------------------------------------------------------------------ */

async function lock() {
  if (S.mode !== 'unlocked') return;
  await flushAllNow();
  await editor.unmountEditor();
  S.key = null;
  S.root = null;
  S.openId = null;
  S.contents.clear();
  S.expanded = new Set(['root']);
  S.filter = '';
  S.clip = null;
  S.clipNode = null;
  S.refBadges.clear();
  S.badgePending.clear();
  S.imgMap.clear();
  S.sourceId = null;
  const srcArea = $('source-area');
  if (srcArea) srcArea.hidden = true;
  $('search-input').value = '';
  $('editor-host').hidden = true;
  $('empty-state').hidden = false;
  toast('工作区「' + (S.wsName || '') + '」已锁定', 'success');
  showGate('unlock');
}

function changeKeyDialog() {
  if (S.mode !== 'unlocked') return;
  const noteCount = T.collectNoteIds(S.root).length;
  const body = h('div', { class: 'modal-body' });
  const title = h('h3', { class: 'modal-title', text: '更改主密钥' });

  body.appendChild(
    h('p', {
      class: 'modal-msg',
      text: '将使用新主密钥在浏览器本地重新加密 ' + noteCount + ' 篇笔记与整个目录树。请牢记新密钥，旧密钥将立即失效。',
    })
  );
  const pw = h('input', { type: 'password', placeholder: '新主密钥（至少 6 位）', autocomplete: 'new-password' });
  const pw2 = h('input', { type: 'password', placeholder: '再次输入新主密钥', autocomplete: 'new-password' });
  body.appendChild(h('label', { class: 'field-label', text: '新主密钥' }));
  body.appendChild(pw);
  body.appendChild(h('label', { class: 'field-label', text: '确认新主密钥' }));
  body.appendChild(pw2);
  const progress = h('p', { class: 'modal-progress hidden' });
  body.appendChild(progress);
  const err = h('p', { class: 'modal-error hidden' });
  body.appendChild(err);

  const okBtn = btn('开始重新加密', {
    kind: 'primary',
    onClick: async () => {
      const v = pw.value;
      if (v.length < 6) {
        err.textContent = '主密钥至少需要 6 位';
        err.classList.remove('hidden');
        return;
      }
      if (v !== pw2.value) {
        err.textContent = '两次输入不一致';
        err.classList.remove('hidden');
        return;
      }
      err.classList.add('hidden');
      okBtn.disabled = true;
      cancelBtn.disabled = true;
      pw.disabled = true;
      pw2.disabled = true;
      progress.classList.remove('hidden');
      try {
        await changeKey(v, progress, noteCount);
        toast('主密钥已更新，全部内容已重新加密', 'success');
        modal.close();
      } catch (e) {
        console.error(e);
        progress.textContent = '';
        okBtn.disabled = false;
        cancelBtn.disabled = false;
        pw.disabled = false;
        pw2.disabled = false;
        err.textContent = '重新加密失败：' + (e.message || e);
        err.classList.remove('hidden');
      }
    },
  });
  const cancelBtn = btn('取消', {
    onClick: () => modal.close(),
  });
  body.appendChild(h('div', { class: 'modal-actions' }, cancelBtn, okBtn));
  const modal = openModal(h('div', null, title, body));
  pw.focus();
}

async function changeKey(newPw, progressEl, noteCount) {
  const oldKey = S.key;
  // 笔记 + 附件都要重新加密
  const ids = allBlobIds(S.root);
  const newSalt = C.makeSaltB64();
  const newKey = await C.deriveKey(newPw, newSalt, C.KDF_ITERATIONS);

  const encrypted = []; // {id, enc} 便于失败回滚
  let i = 0;
  try {
    for (const id of ids) {
      progressEl.textContent = '正在重新加密…（' + ++i + ' / ' + ids.length + '）';
      const isAttach = id[0] === '@'; // 附件 id 带 @ 前缀区分
      const realId = isAttach ? id.slice(1) : id;
      let plain = null;
      const rec = isAttach ? null : S.contents.get(realId);
      if (rec) plain = rec.text;
      if (plain === null) {
        try {
          const r = await api.getNote(realId);
          if (isAttach) plain = await C.decryptBytesFromB64(oldKey, r.data, C.aadForAttachment(realId));
          else plain = await C.decryptFromString(oldKey, r.data, C.aadForNote(realId));
        } catch {
          plain = isAttach ? new Uint8Array(0) : ''; // 密文缺失按空处理
        }
      }
      const enc = isAttach
        ? await C.encryptBytesToB64(newKey, plain, C.aadForAttachment(realId))
        : await C.encryptToString(newKey, plain, C.aadForNote(realId));
      await api.saveNote(realId, enc);
      encrypted.push({ id: realId, isAttach });
    }
    progressEl.textContent = '正在加密目录树…';
    const indexEnc = await C.encryptToString(newKey, JSON.stringify({ v: 1, root: S.root }), C.AAD_TREE);
    // 索引与 KDF 参数一次性原子更新（否则重启后会用旧 salt 派生密钥，无法解锁）
    await api.saveVault(indexEnc, { alg: C.KDF_ALG, salt: newSalt, iterations: C.KDF_ITERATIONS });

    // 全部成功后切换内存中的密钥
    S.key = newKey;
    S.salt = newSalt;
    S.iterations = C.KDF_ITERATIONS;
    for (const rec of S.contents.values()) {
      rec.savedText = rec.text;
      rec.dirty = false;
    }
    progressEl.textContent = '';
  } catch (e) {
    // 回滚：把已写入的新密文用旧密钥重新加密覆盖（尽力而为）
    try {
      for (const { id, isAttach } of encrypted) {
        const r = await api.getNote(id);
        const plain = isAttach
          ? await C.decryptBytesFromB64(newKey, r.data, C.aadForAttachment(id))
          : await C.decryptFromString(newKey, r.data, C.aadForNote(id));
        const old = isAttach
          ? await C.encryptBytesToB64(oldKey, plain, C.aadForAttachment(id))
          : await C.encryptToString(oldKey, plain, C.aadForNote(id));
        await api.saveNote(id, old);
      }
    } catch {
      /* 回滚失败时保留现场，避免越改越乱 */
    }
    throw e;
  }
}

/* ------------------------------------------------------------------ */
/* 树渲染                                                             */
/* ------------------------------------------------------------------ */

function allFolderIds(node) {
  const out = [];
  (function walk(n) {
    if (n.kind === 'folder') {
      out.push(n.id);
      (n.children || []).forEach(walk);
    }
  })(node);
  return out;
}

function ensureExpandedTo(folderId) {
  // 把从根到 folderId 的祖先都展开
  let cur = folderId;
  while (cur && cur !== T.ROOT_ID) {
    S.expanded.add(cur);
    const hit = T.locate(S.root, cur);
    cur = hit && hit.parent ? hit.parent.id : T.ROOT_ID;
  }
}

function findFirstNote(root) {
  let found = null;
  (function walk(n) {
    if (found) return;
    if (n.kind === 'file') {
      found = n;
      return;
    }
    for (const c of T.sortedChildren(n)) walk(c);
  })(root);
  return found;
}

function renderTree() {
  const wrap = $('tree-wrap');
  clearNode(wrap);
  if (!S.root) return;

  const q = S.filter.trim().toLowerCase();
  if (q) {
    const results = T.searchTree(S.root, S.filter);
    if (results.length === 0) {
      wrap.appendChild(h('div', { class: 'tree-empty', text: '没有匹配「' + S.filter.trim() + '」的笔记' }));
      return;
    }
    const list = h('div', { class: 'search-results' });
    for (const { node, pathNames, isFolder } of results) {
      const ctx = pathNames.length ? pathNames.join(' / ') : '笔记库';
      if (isFolder) {
        list.appendChild(
          folderSearchRow(node, ctx, () => {
            S.filter = '';
            $('search-input').value = '';
            ensureExpandedTo(node.id);
            renderTree();
          })
        );
      } else {
        list.appendChild(
          fileSearchRow(node, ctx, () => openNote(node.id))
        );
      }
    }
    wrap.appendChild(list);
    return;
  }

  const totalNotes = T.collectNoteIds(S.root).length;
  if (totalNotes === 0) {
    wrap.appendChild(h('div', { class: 'tree-empty' }));
    const hint = h('div', { class: 'tree-empty-card' });
    hint.appendChild(icon('edit', 26));
    hint.appendChild(h('p', { text: '工作区还是空的' }));
    const b = btn('新建第一篇笔记', { kind: 'primary', onClick: () => createNote() });
    hint.appendChild(b);
    wrap.appendChild(hint);
    return;
  }

  const frag = document.createDocumentFragment();
  for (const node of sortedView(S.root.children)) {
    frag.appendChild(renderNode(node, 0));
  }
  wrap.appendChild(frag);
}

function renderNode(node, depth) {
  if (node.kind === 'folder') return renderFolder(node, depth);
  return renderFile(node, depth);
}

function makeRowBase(kind) {
  return h('div', { class: 'tree-row ' + kind, role: kind === 'file' ? 'treeitem' : undefined });
}

/** 笔记行（可展开显示其附件） */
function renderFile(file, depth) {
  const atts = T.attachListOf(file);
  const canExpand = atts.length > 0;
  const isOpen = S.expanded.has(file.id);
  const wrap = h('div', { class: 'tree-file-node' });

  const row = makeRowBase('file');
  row.dataset.id = file.id;
  row.classList.toggle('active', file.id === S.openId);
  row.style.paddingLeft = (canExpand ? 6 : 10) + depth * 14 + 'px';

  const chev = h('span', { class: 'chev' + (isOpen ? ' open' : '') + (canExpand ? '' : ' disabled') });
  chev.innerHTML = svg('chevronRight', 14);
  if (canExpand) {
    chev.title = isOpen ? '折叠附件' : '展开附件';
    chev.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleFileExpanded(file.id);
    });
  }

  const ic = icon('fileText', 15, 'tree-file-ic');
  const nameSpan = h('span', { class: 'tree-name', title: file.name, text: file.name });
  row.appendChild(chev);
  row.appendChild(ic);
  row.appendChild(nameSpan);

  if (atts.length) {
    const used = S.refBadges.get(file.id);
    const badge = h('span', {
      class: 'att-badge' + (used && used.size ? ' has-ref' : ''),
      title: atts.length + ' 个附件' + (used && used.size ? '，其中 ' + used.size + ' 个被正文引用' : ''),
    });
    badge.appendChild(icon('paperclip', 11));
    badge.appendChild(document.createTextNode(String(atts.length)));
    if (used && used.size) badge.appendChild(icon('check', 10));
    row.appendChild(badge);
  }

  const actions = h('span', { class: 'row-actions' });
  actions.appendChild(
    rowBtn('pencil', '重命名', (e) => {
      e.stopPropagation();
      startInlineRename(row, nameSpan, file);
    })
  );
  actions.appendChild(
    rowBtn('trash', '删除', (e) => {
      e.stopPropagation();
      deleteNodeById(file.id);
    })
  );
  row.appendChild(actions);

  row.addEventListener('click', (e) => {
    if (e.target.closest('.row-btn, .chev')) return;
    openNote(file.id);
  });
  makeDndRow(row, file);
  makeDropTarget(row, () => {
    const hit = T.locate(S.root, file.id);
    return hit && hit.parent ? hit.parent.id : T.ROOT_ID;
  });
  row.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    showNodeMenu(file.id, e.clientX, e.clientY);
  });
  wrap.appendChild(row);

  if (canExpand && isOpen) {
    const kids = h('div', { class: 'tree-children att-kids' });
    ensureRefBadges(file.id);
    const sorted = [...atts].sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
    for (const a of sorted) kids.appendChild(renderAttachmentRow(file, a, depth + 1));
    const addRow = h('button', { class: 'att-add', type: 'button' });
    addRow.appendChild(icon('plus', 12));
    addRow.appendChild(document.createTextNode(' 添加附件（也可粘贴 / 拖入图片）'));
    addRow.addEventListener('click', () => pickAttachmentFile(file.id));
    kids.appendChild(addRow);
    wrap.appendChild(kids);
  }
  return wrap;
}

function toggleFileExpanded(id) {
  if (S.expanded.has(id)) S.expanded.delete(id);
  else S.expanded.add(id);
  renderTree();
}

function renderAttachmentRow(file, a, depth) {
  const usedSet = S.refBadges.get(file.id);
  const isUsed = !!usedSet && usedSet.has(a.id);
  const row = makeRowBase('attach' + (isUsed ? ' used' : ''));
  row.dataset.attId = a.id;
  row.dataset.noteId = file.id;
  row.style.paddingLeft = 10 + depth * 14 + 'px';
  const ic = icon(C.isImageMime(a.mime) ? 'image' : 'paperclip', 13, 'tree-attach-ic');
  row.appendChild(ic);
  row.appendChild(h('span', { class: 'tree-name', title: a.name, text: a.name }));
  if (isUsed) {
    row.appendChild(h('span', { class: 'ref-chip', text: '已引用' }));
  }
  row.appendChild(h('span', { class: 'att-size', text: C.formatSize(a.size) }));
  row.addEventListener('click', () => openAttachment(file.id, a.id));
  row.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    showAttachmentMenu(file, a, e.clientX, e.clientY);
  });
  return row;
}

function fileSearchRow(node, ctx, onClick) {
  const row = makeRowBase('file search');
  row.dataset.id = node.id;
  const ic = icon('fileText', 15, 'tree-file-ic');
  row.appendChild(ic);
  row.appendChild(h('span', { class: 'tree-name', text: node.name }));
  row.appendChild(h('span', { class: 'row-context', text: ctx }));
  row.addEventListener('click', onClick);
  makeDndRow(row, node);
  row.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    showNodeMenu(node.id, e.clientX, e.clientY);
  });
  return row;
}

function renderFolder(folder, depth) {
  const wrap = h('div', { class: 'tree-folder' });
  const isOpen = S.expanded.has(folder.id);
  const row = makeRowBase('folder');
  row.dataset.id = folder.id;
  row.style.paddingLeft = 6 + depth * 14 + 'px';

  const chev = h('span', { class: 'chev' + (isOpen ? ' open' : ''), title: isOpen ? '折叠' : '展开' });
  chev.innerHTML = svg('chevronRight', 14);
  row.appendChild(chev);

  const ic = icon('folder', 15, 'tree-folder-ic');
  row.appendChild(ic);
  row.appendChild(h('span', { class: 'tree-name', text: folder.name }));

  const actions = h('span', { class: 'row-actions' });
  actions.appendChild(
    rowBtn('plus', '在此文件夹新建笔记', (e) => {
      e.stopPropagation();
      createNote(folder.id);
    })
  );
  actions.appendChild(
    rowBtn('pencil', '重命名', (e) => {
      e.stopPropagation();
      startInlineRename(row, row.querySelector('.tree-name'), folder);
    })
  );
  actions.appendChild(
    rowBtn('trash', '删除', (e) => {
      e.stopPropagation();
      deleteNodeById(folder.id);
    })
  );
  row.appendChild(actions);

  makeDndRow(row, folder);
  makeDropTarget(row, folder.id);
  row.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    showNodeMenu(folder.id, e.clientX, e.clientY);
  });
  row.addEventListener('click', () => {
    toggleFolder(folder.id);
  });
  wrap.appendChild(row);

  // Obsidian 式：空文件夹展开后不显示任何占位文字
  if (isOpen && (folder.children || []).length) {
    const kids = h('div', { class: 'tree-children' });
    for (const c of sortedView(folder.children)) {
      kids.appendChild(renderNode(c, depth + 1));
    }
    wrap.appendChild(kids);
  }
  return wrap;
}

function folderSearchRow(folder, ctx, onClick) {
  const row = makeRowBase('folder search');
  const ic = icon('folder', 15, 'tree-folder-ic');
  row.appendChild(ic);
  row.appendChild(h('span', { class: 'tree-name', text: folder.name }));
  row.appendChild(h('span', { class: 'row-context', text: ctx }));
  row.addEventListener('click', onClick);
  return row;
}

function rowBtn(icName, tip, onClick) {
  const b = h('button', { class: 'row-btn', title: tip, type: 'button' });
  b.innerHTML = svg(icName, 13);
  b.addEventListener('click', onClick);
  return b;
}

function toggleFolder(id) {
  if (S.expanded.has(id)) S.expanded.delete(id);
  else S.expanded.add(id);
  renderTree();
}
/** 行内重命名（把名字替换为输入框）；onDone 在提交/取消后触发 */
function startInlineRename(row, nameSpan, node, onDone) {
  const input = h('input', {
    class: 'tree-rename-input',
    type: 'text',
    value: node.name,
    spellcheck: 'false',
  });
  const oldName = node.name;
  nameSpan.replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  const doneCb = () => {
    if (typeof onDone === 'function') onDone();
  };
  const finish = async (commit) => {
    if (done) return;
    done = true;
    const val = input.value;
    if (commit) {
      if (val.trim() && val.trim() !== oldName) {
        const okName = val.trim();
        // renameNodeById 会整体重绘
        if (!(await renameNodeById(node.id, okName))) {
          renderTree();
        }
        doneCb();
        return;
      }
    }
    renderTree();
    doneCb();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      finish(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      finish(false);
    }
  });
  input.addEventListener('blur', () => finish(true));
}

/* ------------------------------------------------------------------ */
/* 顶部文档头 / 状态栏                                                */
/* ------------------------------------------------------------------ */

function renderDocHead(id) {
  const head = $('doc-head');
  clearNode(head);
  $('save-state').textContent = '';
  if (!id) return;
  const hit = T.locate(S.root, id);
  if (!hit || hit.node.kind !== 'file') return;
  const node = hit.node;
  const pathNames = T.pathTo(S.root, id);
  const pathLine = h('div', { class: 'doc-path' });
  if (pathNames.length) {
    pathLine.appendChild(icon('folder', 11));
    pathLine.appendChild(document.createTextNode(' ' + pathNames.join(' / ')));
  } else {
    pathLine.appendChild(document.createTextNode('笔记库'));
  }
  const titleWrap = h('div', { class: 'doc-title-line' });
  titleWrap.appendChild(h('span', { class: 'doc-title', text: node.name, title: node.name }));
  const titleBtn = btn(null, { onClick: () => editDocTitleInline(titleWrap, node) });
  titleBtn.appendChild(icon('pencil', 12));
  titleBtn.className = 'doc-rename-silent';
  titleBtn.title = '重命名（F2）';
  head.appendChild(pathLine);
  titleWrap.appendChild(titleBtn);
  head.appendChild(titleWrap);
  updateSaveState();
}

function editDocTitleInline(titleWrap, node) {
  const input = h('input', {
    class: 'doc-title-input',
    type: 'text',
    value: node.name,
    spellcheck: 'false',
  });
  const restore = () => {
    clearNode(titleWrap);
    titleWrap.appendChild(h('span', { class: 'doc-title', text: node.name, title: node.name }));
    const titleBtn = btn(null, { onClick: () => editDocTitleInline(titleWrap, node) });
    titleBtn.appendChild(icon('pencil', 12));
    titleBtn.className = 'doc-rename-silent';
    titleBtn.title = '重命名（F2）';
    titleWrap.appendChild(titleBtn);
  };
  clearNode(titleWrap);
  titleWrap.appendChild(input);
  input.focus();
  input.select();
  input.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const v = input.value.trim();
      restore();
      if (v && v !== node.name) await renameNodeById(node.id, v);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      restore();
    }
  });
  input.addEventListener('blur', () => {
    clearNode(titleWrap);
    titleWrap.appendChild(h('span', { class: 'doc-title', text: node.name, title: node.name }));
    const titleBtn = btn(null, { onClick: () => editDocTitleInline(titleWrap, node) });
    titleBtn.appendChild(icon('pencil', 12));
    titleBtn.className = 'doc-rename-silent';
    titleBtn.title = '重命名（F2）';
    titleWrap.appendChild(titleBtn);
  });
}

function renameCurrentDoc() {
  const btnSilent = document.querySelector('.doc-rename-silent');
  if (btnSilent) btnSilent.click();
}

function updateStats() {
  const left = $('stat-left');
  const right = $('stat-right');
  if (!S.root) {
    left.textContent = '就绪';
    right.textContent = '';
    return;
  }
  const notes = T.collectNoteIds(S.root).length;
  const folders = allFolderIds(S.root).filter((f) => f !== 'root').length;
  const totalAtt = countAllAttachments(S.root);
  right.textContent = notes + ' 篇笔记 · ' + folders + ' 个文件夹 · ' + totalAtt + ' 个附件';

  if (S.openId) {
    const hit = T.locate(S.root, S.openId);
    const rec = S.contents.get(S.openId);
    if (hit && rec) {
      const len = rec.text.length;
      const lines = rec.text.split('\n').length;
      const atts = T.attachListOf(hit.node);
      const used = S.refBadges.get(S.openId);
      let attText = ' · 附件 ' + atts.length;
      if (atts.length) {
        const usedN = used ? atts.filter((a) => used.has(a.id)).length : 0;
        attText += usedN > 0 ? '（' + usedN + ' 已引用）' : '（未引用）';
      }
      left.textContent = hit.node.name + ' · ' + len + ' 字 · ' + lines + ' 行' + attText;
      return;
    }
  }
  left.textContent = '就绪';
}

/* ================================================================ */
/* 编辑模式：即时渲染（WYSIWYG）⇄ Markdown 源码                     */
/* ================================================================ */

function updateModeUI() {
  document.querySelectorAll('.mode-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.mode === S.editMode);
  });
}

function hideSourceArea() {
  const el = $('source-area');
  if (el) el.hidden = true;
  S.sourceId = null;
}

function isSourceShown() {
  const el = $('source-area');
  return !!el && !el.hidden;
}

async function showSourceEditor(noteId) {
  const rec = S.contents.get(noteId);
  if (!rec) return;
  const el = $('source-area');
  // 先切 UI（立即可见可编辑），卸载 ProseMirror 放在后台执行，避免切换被阻塞
  el.value = rec.text;
  el.classList.remove('hidden'); // 同时去掉 hidden 类与属性
  el.hidden = false;
  $('editor-host').hidden = true;
  $('empty-state').hidden = true;
  S.sourceId = noteId;
  requestAnimationFrame(() => el.focus());
  if (editor.isMounted()) {
    editor.unmountEditor().catch(() => {});
  }
  updateSaveState();
  updateStats();
}

/**
 * 按当前模式把笔记“挂载”到编辑区：
 *  - wysiwyg：解密附件引用为可显示图片后交给 Milkdown
 *  - source：直接显示 Markdown 源码文本域
 */
async function mountActiveEditor(noteId) {
  if (S.editMode === 'source') {
    await showSourceEditor(noteId);
    return true;
  }
  hideSourceArea();
  const rec = S.contents.get(noteId);
  if (!rec) return false;
  const host = $('editor-host');
  $('empty-state').hidden = true;
  let viewText = rec.text;
  if (viewText.includes('attachment://') || viewText.includes('fw-att://')) {
    viewText = await decorateAttachmentsForView(viewText);
  }
  if (S.mode !== 'unlocked' || S.openId !== noteId) return false;
  host.hidden = false;
  await editor.mountEditor(host, viewText, {
    onChange: (md) => {
      const r = S.contents.get(noteId);
      if (!r) return;
      const clean = revertAttachmentRefs(md); // data: URI → attachment:// token 后落盘
      r.text = clean;
      r.dirty = clean !== r.savedText;
      rememberBadges(noteId, clean);
      updateSaveState();
      scheduleNoteSave(noteId);
      updateStats();
    },
    onBlur: () => flushNote(noteId),
  });
  editor.focusEditor();
  return true;
}

/** 切换编辑模式；即使重复点击同一模式也保证 UI 落到该模式（修复偶发“点了没反应”） */
async function setEditMode(mode) {
  if (mode !== 'wysiwyg' && mode !== 'source') return;
  S.editMode = mode;
  updateModeUI();
  const id = S.openId;
  if (!id || S.mode !== 'unlocked') return;
  const rec = S.contents.get(id);
  if (!rec) return;
  if (mode === 'source') {
    await showSourceEditor(id);
    const el = $('source-area');
    if (el && !el.hidden) el.focus();
    // 若有未保存内容，后台补存（不阻塞切换）
    if (rec.dirty && !rec.saving) flushNote(id).catch(() => {});
  } else {
    if (isSourceShown()) hideSourceArea();
    await mountActiveEditor(id);
  }
  updateStats();
}

/* ------------------------------------------------------------------ */
/* 事件绑定                                                           */
/* ------------------------------------------------------------------ */

function welcomeMarkdown() {
  const F = '```';
  return [
    '# 欢迎使用 Freipen ✒️',
    '',
    '**Freipen** 是一个支持**多工作区**的端到端加密写作空间。每个工作区相互独立、使用各自的主密钥加密；正文、文件名与目录结构始终只以 **AES-256-GCM** 密文保存，主密钥只存在于你的浏览器内存中。既可以跑在本地，也可以部署为在线服务（局域网 / 云端），内容同样只有你能解开。',
    '',
    '## 快速上手',
    '',
    '- 左侧边栏管理笔记：新建、重命名、删除，支持文件夹整理',
    '- 锁定后可回到门禁页，在多个工作区之间切换',
    '- 点击笔记即可打开；输入 Markdown 语法会**即时渲染**（所见即所得）',
    '- 编辑自动加密保存；也可按 `Ctrl/Cmd + S` 立即保存',
    '',
    '## 常用快捷键',
    '',
    '| 操作 | 快捷键 |',
    '| --- | --- |',
    '| 打开设置 | `Ctrl/Cmd + ,` |',
    '| 新建笔记 | `Ctrl/Cmd + N` |',
    '| 立即保存 | `Ctrl/Cmd + S` |',
    '| 锁定并切换工作区 | `Ctrl/Cmd + Shift + L` |',
    '',
    '## 支持的 Markdown',
    '',
    '# 标题一',
    '## 标题二',
    '### 标题三',
    '',
    '**加粗**、*斜体*、~~删除线~~、`行内代码`、[链接](https://example.com)、> 引用',
    '',
    '- [x] 已完成的任务',
    '- [ ] 待办事项',
    '',
    '1. 有序列表一',
    '2. 有序列表二',
    '',
    F + '',
    'const greeting = "Hello, Freipen!";',
    F,
    '',
    '> 提示：主密钥一旦忘记将**无法找回**任何内容 —— 这正是端到端加密的意义所在。',
    '',
    '祝你写作愉快。',
    '',
  ].join('\n');
}

function bindEvents() {
  $('gate-form').addEventListener('submit', (e) => {
    e.preventDefault();
    submitGate();
  });
  $('splash-retry').addEventListener('click', () => boot());

  $('btn-lock').addEventListener('click', lock);
  $('btn-new-note').addEventListener('click', () => createNote());
  $('btn-new-folder').addEventListener('click', () => createFolder());
  $('btn-change-key').addEventListener('click', changeKeyDialog);
  $('btn-empty-new').addEventListener('click', () => createNote());

  // 编辑模式切换（委托监听，绑定到 mode-switch 容器，避免重复绑定）
  const modeSwitchEl = document.querySelector('.mode-switch');
  if (modeSwitchEl) {
    modeSwitchEl.addEventListener('click', (e) => {
      const b = e.target && e.target.closest ? e.target.closest('.mode-btn') : null;
      if (!b || !b.dataset || !b.dataset.mode) return;
      if (S.mode !== 'unlocked') return;
      e.preventDefault();
      setEditMode(b.dataset.mode);
    });
  }

  // 日记：左键 = 今日日记；右键 = 日历视图；设置按钮进设置页
  const dailyBtns = [$('btn-daily'), $('rail-daily')];
  for (const b of dailyBtns) {
    if (!b) continue;
    b.addEventListener('click', () => dailyQuickToday());
    b.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openCalendarModal();
    });
  }
  $('rail-lock').addEventListener('click', () => lock());
  $('btn-settings').addEventListener('click', () => openSettingsPage('appearance'));
  $('rail-settings').addEventListener('click', () => openSettingsPage('appearance'));
  bindCollapseUI();
  document.addEventListener('keydown', (e) => {
    if (handleCustomHotkey(e)) e.stopImmediatePropagation();
  }, true);
  $('btn-sort').addEventListener('click', () => showSortMenu($('btn-sort')));
  initSidebarResize();
  const srcArea = $('source-area');
  srcArea.addEventListener('input', () => {
    const id = S.sourceId;
    if (!id) return;
    const r = S.contents.get(id);
    if (!r) return;
    const v = srcArea.value;
    r.text = v;
    r.dirty = v !== r.savedText;
    rememberBadges(id, v);
    updateSaveState();
    scheduleNoteSave(id);
    updateStats();
  });

  $('search-input').addEventListener('input', () => {
    S.filter = $('search-input').value;
    renderTree();
  });
  $('search-input').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      $('search-input').value = '';
      S.filter = '';
      renderTree();
    }
  });

  $('gate-pw').addEventListener('input', () => {
    const el = $('gate-strength');
    el.classList.remove('hidden');
    const v = $('gate-pw').value;
    if (!v) {
      el.classList.add('hidden');
      return;
    }
    let score = 0;
    if (v.length >= 8) score++;
    if (v.length >= 12) score++;
    if (/[A-Z]/.test(v) && /[a-z]/.test(v)) score++;
    if (/\d/.test(v)) score++;
    if (/[^A-Za-z0-9]/.test(v)) score++;
    const label = ['极弱', '弱', '一般', '较强', '强', '极强'][score];
    el.textContent = '密钥强度：' + label;
    el.className = 'gate-strength ' + ['w0', 'w1', 'w1', 'w2', 'w3', 'w4'][score];
  });

  window.addEventListener('keydown', (e) => {
    if (S.mode !== 'unlocked') return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (mod && !e.shiftKey && k === 's') {
      e.preventDefault();
      flushAllNow().then(() => toast('已保存全部更改', 'success'));
    } else if (mod && !e.shiftKey && k === 'e') {
      e.preventDefault();
      setEditMode(S.editMode === 'wysiwyg' ? 'source' : 'wysiwyg');
    } else if (mod && e.shiftKey && k === 'l') {
      e.preventDefault();
      lock();
    } else if (e.key === 'F2' && S.openId) {
      e.preventDefault();
      renameCurrentDoc();
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && S.mode === 'unlocked') {
      flushAllNow();
    }
  });
  window.addEventListener('beforeunload', () => {
    if (S.mode === 'unlocked') flushBeacon();
  });
  window.addEventListener('pagehide', () => {
    if (S.mode === 'unlocked') flushBeacon();
  });

  /* —— 新增：浮动选择工具栏 / 编辑器右键菜单 / 附件粘贴拖放 / 树右键与拖拽 —— */
  initSelectionBar();

  const editorScroll = $('editor-scroll');
  editorScroll.addEventListener('contextmenu', (e) => {
    if (S.mode !== 'unlocked' || !S.openId) return;
    if (e.target.closest('.selbar, .ctx-menu, .ctx-layer, .toast, .modal-overlay')) return;
    if (!e.target.closest('.ProseMirror, .milkdown, .editor-host')) return;
    e.preventDefault();
    showEditorContextMenu(e.clientX, e.clientY);
  });

  const editorHost = $('editor-host');
  // 粘贴图片/文件 → 作为附件保存到当前笔记
  editorHost.addEventListener('paste', (e) => {
    if (S.mode !== 'unlocked' || !S.openId) return;
    const files = [...(e.clipboardData?.files || [])];
    if (files.length && files.some((f) => f.size > 0)) {
      e.preventDefault();
      e.stopPropagation();
      handleAttachmentFiles(S.openId, files);
    }
  });
  // 拖放文件到编辑器 → 附件
  editorHost.addEventListener('dragover', (e) => {
    if (S.mode !== 'unlocked' || !S.openId) return;
    if ([...e.dataTransfer?.types || []].some((t) => t === 'Files')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    }
  });
  editorHost.addEventListener('drop', (e) => {
    if (S.mode !== 'unlocked' || !S.openId) return;
    const files = [...(e.dataTransfer?.files || [])];
    if (files.length) {
      e.preventDefault();
      e.stopPropagation();
      handleAttachmentFiles(S.openId, files);
    }
  });

  // 点击任务列表复选框 → 切换勾选
  const editorHostEl = $('editor-host');
  editorHostEl.addEventListener('click', (e) => {
    if (S.mode !== 'unlocked' || !S.openId || S.editMode !== 'wysiwyg') return;
    // 点击 / Ctrl+点击 链接：用新标签页打开
    const linkEl = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (linkEl && linkEl.getAttribute('href')) {
      const url = linkEl.getAttribute('href');
      if (/^(https?:|mailto:)/.test(url)) {
        e.preventDefault();
        e.stopPropagation();
        window.open(url, '_blank', 'noopener,noreferrer');
        return;
      }
    }
    const li = e.target && e.target.closest ? e.target.closest('li[data-item-type="task"]') : null;
    if (!li) return;
    const r = li.getBoundingClientRect();
    if (e.clientX - r.left > 30) return; // 只点左侧方框区域
    e.preventDefault();
    cmds.toggleTaskAtPoint(e.clientX, e.clientY);
  });
  $('tree-wrap').addEventListener('contextmenu', (e) => {
    if (S.mode !== 'unlocked') return;
    if (e.target.closest('.tree-row')) return; // 行级菜单自行处理
    e.preventDefault();
    showTreeBlankMenu(e.clientX, e.clientY);
  });
  $('tree-wrap').addEventListener('dragover', (e) => {
    e.preventDefault(); // 允许整棵树作为放置区 → 放入根目录
    const dt = e.dataTransfer;
    if (dt && dt.types.includes(DND_MIME)) dt.dropEffect = 'move';
  });
  $('tree-wrap').addEventListener('drop', (e) => {
    const dt = e.dataTransfer;
    if (!dt || !dt.types.includes(DND_MIME)) return;
    e.preventDefault();
    e.stopPropagation();
    const payload = safeDndPayload(dt);
    if (payload) moveNodeViaDrag(payload.id, T.ROOT_ID);
  });
}

/* ------------------------------------------------------------------ */
/* 启动                                                               */
/* ------------------------------------------------------------------ */

fillStaticIcons();
bindEvents();
boot();

/* ================================================================ */
/*  第二期：右键菜单 / 附件体系 / 拖拽与剪贴板 相关实现              */
/* ================================================================ */

const DND_MIME = 'application/x-freipen-node';
const MAX_ATTACH = 24 * 1024 * 1024; // 单附件上限 24MB（受服务端 64MB 请求体约束）
const TOKEN_RE = /(!?)\[([^\]]*)\]\(((?:attachment|fw-att):\/\/([0-9a-fA-F-]{36}))\)/g;

function moveReasonText(reason) {
  const m = {
    'not-found': '节点不存在',
    'bad-target': '目标位置不是文件夹',
    'same-folder': '已经在该文件夹中',
    'into-self': '不能移动到自身或自己的子文件夹里',
    same: '不能移动到自己',
  };
  return m[reason] || reason;
}

function allFolderIdSet() {
  const out = new Set(['root']);
  (function walk(n) {
    if (n.kind === 'folder') {
      out.add(n.id);
      (n.children || []).forEach(walk);
    }
  })(S.root);
  return out;
}

/** 树内所有需要存储的 blob：笔记真实 id；附件 id 用 '@'+id 区分 */
function allBlobIds(node) {
  const out = [];
  (function walk(n) {
    if (n.kind === 'file') {
      out.push(n.id);
      for (const a of n.attachments || []) out.push('@' + a.id);
    } else (n.children || []).forEach(walk);
  })(node);
  return out;
}

function countAllAttachments(node) {
  let n = 0;
  (function walk(x) {
    if (x.kind === 'file') n += T.attachListOf(x).length;
    else (x.children || []).forEach(walk);
  })(node);
  return n;
}

function collectAttachIdsIn(node) {
  const out = [];
  (function walk(n) {
    if (n.kind === 'file') for (const a of n.attachments || []) out.push(a.id);
    else (n.children || []).forEach(walk);
  })(node);
  return out;
}

/** 从 markdown 提取所有引用的附件 id */
function extractRefIds(text) {
  const ids = new Set();
  if (!text) return ids;
  let m;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(text))) ids.add(m[4]);
  return ids;
}

/** 记录某笔记正文里实际引用了哪些附件 */
function rememberBadges(fileId, text) {
  if (!S.root) return;
  const file = T.locate(S.root, fileId)?.node;
  if (!file || file.kind !== 'file') return;
  if (!T.attachListOf(file).length) return;
  S.refBadges.set(fileId, extractRefIds(text));
}

/** 全局查找某个附件属于哪篇笔记（含元数据） */
function findAttachmentGlobal(attachId) {
  if (!S.root) return null;
  let found = null;
  (function walk(n) {
    if (found || n.kind !== 'file') {
      if (n.kind === 'folder') (n.children || []).forEach(walk);
      return;
    }
    const meta = T.attachFind(n, attachId);
    if (meta) found = { file: n, meta };
    else if (n.kind === 'folder') (n.children || []).forEach(walk);
  })(S.root);
  return found;
}

async function fetchAttachmentBytes(attachId) {
  const r = await api.getNote(attachId);
  if (!r || !r.data) throw new Error('attachment-missing');
  return C.decryptBytesFromB64(S.key, r.data, C.aadForAttachment(attachId));
}

/**
 * 打开笔记正文时：把 ![](attachment://id) 图片 token 替换为 data: URI 以便显示。
 * 同步维护 S.imgMap（dataUri -> attachId），保存时反写为 token。
 */
async function decorateAttachmentsForView(text) {
  if (!text || (!text.includes('attachment://') && !text.includes('fw-att://'))) return text;
  S.imgMap.clear(); // 单文档会话：切笔记时先清空反向映射
  const hits = [];
  let m;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(text))) {
    const [, bang, alt, uri, id] = m;
    if (bang) hits.push({ uri, id, alt });
  }
  if (!hits.length) return text;
  let view = text;
  for (const hit of hits) {
    let dataUri = null;
    try {
      const bytes = await fetchAttachmentBytes(hit.id);
      const owner = findAttachmentGlobal(hit.id);
      const mime = owner ? C.mimeOf(owner.meta.name, owner.meta.mime) : 'application/octet-stream';
      if (C.isImageMime(mime)) dataUri = C.bytesToDataURL(bytes, mime);
    } catch {
      /* 附件缺失或解密失败：保留原 token */
    }
    if (dataUri) {
      S.imgMap.set(dataUri, hit.id);
      view = view.split(hit.uri).join(dataUri);
    }
  }
  return view;
}

/** 保存 / 比较前：把编辑器里 data: URI 形式的图片引用还原为 attachment:// token */
function revertAttachmentRefs(md) {
  if (!md || S.imgMap.size === 0 || !md.includes('data:')) return md;
  let out = md;
  for (const [dataUri, id] of S.imgMap) {
    if (out.includes(dataUri)) out = out.split(dataUri).join('attachment://' + id);
  }
  return out;
}

/** 懒扫描：某笔记附件是否被引用（未打开时异步取正文） */
function ensureRefBadges(fileId) {
  if (S.badgePending.has(fileId) || S.refBadges.has(fileId)) return;
  const file = T.locate(S.root, fileId)?.node;
  if (!file || file.kind !== 'file' || !T.attachListOf(file).length) return;
  const rec = S.contents.get(fileId);
  if (rec) {
    rememberBadges(fileId, rec.text);
    return;
  }
  S.badgePending.add(fileId);
  (async () => {
    try {
      const r = await api.getNote(fileId);
      const text = r ? await C.decryptFromString(S.key, r.data, C.aadForNote(fileId)) : '';
      rememberBadges(fileId, text);
    } catch {
      S.refBadges.set(fileId, new Set());
    } finally {
      S.badgePending.delete(fileId);
      renderTree();
    }
  })();
}

/* ---------------- 附件：上传 / 选择 / 打开 ---------------- */

async function handleAttachmentFiles(noteId, files) {
  const file = T.locate(S.root, noteId)?.node;
  if (!file || file.kind !== 'file') return;
  if (!files.length) return;
  const added = [];
  let firstImage = null;
  for (const f of files) {
    if (f.size > MAX_ATTACH) {
      toast('附件过大（>24MB）：' + f.name, 'error');
      continue;
    }
    try {
      const bytes = new Uint8Array(await f.arrayBuffer());
      if (!bytes.length) continue;
      const id = T.uid();
      const meta = { id, name: f.name, size: bytes.length, mime: C.mimeOf(f.name, f.type), addedAt: Date.now() };
      await api.saveNote(id, await C.encryptBytesToB64(S.key, bytes, C.aadForAttachment(id)));
      T.attachAdd(file, meta);
      added.push({ id, name: f.name, mime: meta.mime, bytes });
      if (C.isImageMime(meta.mime) && !firstImage) firstImage = { id, name: f.name, mime: meta.mime, bytes };
    } catch (e) {
      console.error('附件保存失败', e);
      toast('附件保存失败：' + f.name, 'error');
    }
  }
  if (!added.length) return;
  await persistTree(true);
  renderTree();
  updateStats();

  // 当前正打开这篇笔记时，直接插入引用（图片显示为内嵌图）
  if (S.openId === noteId && S.mode === 'unlocked') {
    for (const a of added) {
      const dataUri = C.isImageMime(a.mime) ? C.bytesToDataURL(a.bytes, a.mime) : null;
      if (dataUri) {
        S.imgMap.set(dataUri, a.id);
        cmds.cmdInsertImage(dataUri, a.name);
      } else {
        cmds.cmdInsertLinkMarkdown(a.name, a.id);
      }
    }
    editor.focusEditor();
  }
  toast('已添加 ' + added.length + ' 个附件' + (firstImage ? '' : '（非图片以链接形式插入）'), 'success');
}

function pickAttachmentFile(fileId) {
  if (!S.root || S.mode !== 'unlocked') return;
  const input = h('input', { type: 'file', multiple: true, style: { display: 'none' } });
  document.body.appendChild(input);
  input.addEventListener('change', () => {
    handleAttachmentFiles(fileId, [...input.files]);
    input.remove();
  });
  input.click();
}

function openAttachment(fileId, attachId) {
  const file = T.locate(S.root, fileId)?.node;
  if (!file || file.kind !== 'file') return;
  const meta = T.attachFind(file, attachId);
  if (!meta) return;
  const body = h('div', { class: 'modal-body' });
  const title = h('h3', { class: 'modal-title', text: '附件：' + meta.name });
  const usedSet = S.refBadges.get(fileId);
  const used = usedSet ? usedSet.has(attachId) : false;

  (async () => {
    try {
      const bytes = await fetchAttachmentBytes(attachId);
      const dataUrl = C.bytesToDataURL(bytes, meta.mime);
      const info = h('p', {
        class: 'modal-msg',
        text: (used ? '✓ 正文已引用 · ' : '正文中未引用 · ') + meta.name + ' · ' + C.formatSize(bytes.length),
      });
      body.appendChild(info);
      if (C.isImageMime(meta.mime)) {
        const imgWrap = h('div', { class: 'att-preview' });
        const img = h('img', { src: dataUrl, alt: meta.name });
        imgWrap.appendChild(img);
        body.appendChild(imgWrap);
      } else {
        const tip = h('p', { class: 'modal-msg', text: '（该类型无法预览，可下载查看）' });
        body.appendChild(tip);
      }
      const row = h('div', { class: 'modal-actions' });
      const dl = btn('下载', {
        onClick: () => {
          const a = document.createElement('a');
          a.href = dataUrl;
          a.download = meta.name;
          document.body.appendChild(a);
          a.click();
          a.remove();
        },
      });
      row.appendChild(dl);
      if (S.openId === fileId) {
        const ins = btn('插入到文中', {
          kind: 'primary',
          onClick: () => {
            modal.close();
            insertAttachmentRef(fileId, attachId);
          },
        });
        row.appendChild(ins);
      }
      const cp = btn('复制引用', {
        onClick: async () => {
          try {
            await navigator.clipboard.writeText('[' + meta.name + '](attachment://' + attachId + ')');
            toast('引用已复制到剪贴板', 'success');
          } catch {
            toast('复制失败', 'error');
          }
        },
      });
      row.appendChild(cp);
      const cancel = btn('关闭', { onClick: () => modal.close() });
      row.appendChild(cancel);
      body.appendChild(row);
    } catch (e) {
      console.error(e);
      body.appendChild(h('p', { class: 'modal-error', text: '无法读取附件（密文缺失或密钥不符）' }));
    }
  })();

  const modal = openModal(h('div', null, title, body));
  if (used) {
    body.prepend(h('p', { class: 'modal-msg', text: '' }));
  }
}

/** 把附件引用插到当前打开的文章光标处 */
async function insertAttachmentRef(fileId, attachId) {
  if (S.openId !== fileId) {
    toast('请先打开对应的笔记', 'error');
    return;
  }
  const file = T.locate(S.root, fileId)?.node;
  const meta = file ? T.attachFind(file, attachId) : null;
  if (!meta) return;
  if (C.isImageMime(meta.mime)) {
    try {
      const bytes = await fetchAttachmentBytes(attachId);
      const dataUri = C.bytesToDataURL(bytes, meta.mime);
      S.imgMap.set(dataUri, attachId);
      cmds.cmdInsertImage(dataUri, meta.name);
    } catch {
      cmds.cmdInsertText('![' + meta.name + '](attachment://' + attachId + ') ');
    }
  } else {
    cmds.cmdInsertLinkMarkdown(meta.name, attachId);
  }
  editor.focusEditor();
}

async function removeAttachment(fileId, attachId) {
  const file = T.locate(S.root, fileId)?.node;
  if (!file || file.kind !== 'file') return;
  const meta = T.attachFind(file, attachId);
  if (!meta) return;
  const usedSet = S.refBadges.get(fileId);
  const used = usedSet ? usedSet.has(attachId) : false;
  const ok = await confirmDialog({
    title: '移除附件',
    message: used
      ? '「' + meta.name + '」正被正文引用。移除后文中图片/链接将失效（可稍后重新插入）。确定移除该附件文件吗？'
      : '确定从笔记中移除附件「' + meta.name + '」吗？文件将被永久删除。',
    danger: true,
    confirmText: '移除',
  });
  if (!ok) return;
  try {
    await api.deleteNote(attachId);
  } catch {
    /* ignore */
  }
  T.attachRemove(file, attachId);
  const st = S.refBadges.get(fileId);
  if (st) st.delete(attachId);
  await persistTree(true);
  renderTree();
  updateStats();
  toast('附件已移除', 'success');
}

/* ---------------- 复制 / 剪切 / 粘贴 ---------------- */

function clipCopy(nodeId) {
  const hit = T.locate(S.root, nodeId);
  if (!hit) return;
  S.clip = { mode: 'copy', ids: [nodeId], label: hit.node.name };
  S.clipNode = null;
  toast('已复制「' + hit.node.name + '」', 'success');
}

function clipCut(nodeId) {
  const hit = T.locate(S.root, nodeId);
  if (!hit) return;
  S.clip = { mode: 'cut', ids: [nodeId], label: hit.node.name };
  S.clipNode = null;
  toast('已剪切「' + hit.node.name + '」（在目标处粘贴）', 'success');
}

function clipLabel() {
  if (!S.clip) return null;
  return (S.clip.mode === 'copy' ? '复制' : '剪切') + '：' + S.clip.label;
}

async function pasteClipboard(targetFolderId) {
  if (!S.clip || !S.root || S.mode !== 'unlocked') return;
  const targetFolder =
    targetFolderId === T.ROOT_ID
      ? S.root
      : (T.locate(S.root, targetFolderId)?.node?.kind === 'folder' ? T.locate(S.root, targetFolderId).node : null);
  if (!targetFolder) {
    toast('目标位置不是文件夹', 'error');
    return;
  }
  try {
    if (S.clip.mode === 'cut') {
      for (const id of S.clip.ids) {
        if (id === targetFolderId) continue;
        const res = T.moveNode(S.root, id, targetFolderId);
        if (!res.ok && res.reason !== 'same-folder') {
          toast('移动失败：' + moveReasonText(res.reason), 'error');
        }
      }
      toast('已移动', 'success');
    } else {
      const sourceNode = T.locate(S.root, S.clip.ids[0])?.node;
      if (!sourceNode) {
        toast('源节点已不存在', 'error');
        return;
      }
      const clone = T.cloneNode(sourceNode);
      const name = T.uniqueName(targetFolder.children, clone.node.name, clone.node.kind === 'folder');
      clone.node.name = name;
      targetFolder.children.push(clone.node);
      await duplicateBlobs(clone);
      toast('已复制为「' + name + '」', 'success');
    }
  } catch (e) {
    console.error(e);
    toast('粘贴失败：' + (e.message || e), 'error');
    return;
  } finally {
    S.clip = null;
    S.clipNode = null;
  }
  await persistTree(true);
  renderTree();
  updateStats();
}

/** 深拷贝的正文/附件密文：附件 blob 直接透传复制；正文解密后把附件引用改到新 id 再加密 */
async function duplicateBlobs(clone) {
  for (const [oldId, newId] of clone.noteMap) {
    try {
      const r = await api.getNote(oldId);
      let text = r ? await C.decryptFromString(S.key, r.data, C.aadForNote(oldId)) : '';
      if (clone.attachMap.size) {
        for (const [oldA, newA] of clone.attachMap) {
          text = text.split('attachment://' + oldA).join('attachment://' + newA);
        }
      }
      await api.saveNote(newId, await C.encryptToString(S.key, text, C.aadForNote(newId)));
    } catch (e) {
      console.error('复制正文失败', oldId, e);
      await api.saveNote(newId, await C.encryptToString(S.key, '', C.aadForNote(newId)));
    }
  }
  for (const [oldA, newA] of clone.attachMap) {
    try {
      const r = await api.getNote(oldA);
      if (r && r.data) await api.saveNote(newA, r.data); // 密文透传复制
    } catch {
      /* 缺失则跳过 */
    }
  }
}

/* ---------------- 拖拽 ---------------- */

function hasDndType(dt) {
  return !!dt && dt.types && [...dt.types].includes(DND_MIME);
}

function safeDndPayload(dt) {
  try {
    const raw = dt.getData(DND_MIME);
    if (!raw) return null;
    const o = JSON.parse(raw);
    if (o && typeof o.id === 'string') return o;
  } catch {
    /* ignore */
  }
  return null;
}

function makeDndRow(row, node) {
  row.draggable = true;
  row.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData(DND_MIME, JSON.stringify({ id: node.id, kind: node.kind }));
    e.dataTransfer.effectAllowed = 'move';
    row.classList.add('dragging');
  });
  row.addEventListener('dragend', () => row.classList.remove('dragging'));
}

function makeDropTarget(el, targetOrFn) {
  el.addEventListener('dragenter', (e) => {
    if (!hasDndType(e.dataTransfer)) return;
    e.preventDefault();
    el.classList.add('drop-target');
  });
  el.addEventListener('dragover', (e) => {
    if (!hasDndType(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    el.classList.add('drop-target');
  });
  el.addEventListener('dragleave', (e) => {
    if (!el.contains(e.relatedTarget)) el.classList.remove('drop-target');
  });
  el.addEventListener('drop', (e) => {
    el.classList.remove('drop-target');
    if (!hasDndType(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    const payload = safeDndPayload(e.dataTransfer);
    if (!payload) return;
    const targetId = typeof targetOrFn === 'function' ? targetOrFn() : targetOrFn;
    if (!targetId || payload.id === targetId) return;
    moveNodeViaDrag(payload.id, targetId);
  });
}

async function moveNodeViaDrag(id, folderId) {
  if (!S.root || S.mode !== 'unlocked') return;
  if (id === folderId) return;
  const res = T.moveNode(S.root, id, folderId);
  if (!res.ok) {
    if (res.reason !== 'same-folder') toast('无法移动：' + moveReasonText(res.reason), 'error', 4200);
    return;
  }
  if (res.newName) toast('已移动（重名自动改名：' + res.newName + '）', 'info');
  await persistTree(true);
  renderTree();
}

/* ---------------- 编辑器右键菜单 ---------------- */

/** 情境感知的编辑器右键菜单：表格 / 图片 / 普通文本各自不同 */
function showEditorContextMenu(x, y) {
  const el = document.elementFromPoint(x, y);
  if (!el) return;
  if (el.closest('pre')) { cmds.caretAtScreenPoint(x, y); showCodeMenu(x, y); return; }
  const tablePart = el.closest('td, th, table');
  if (tablePart) {
    cmds.caretAtScreenPoint(x, y); // 让后续行列操作作用于点击的单元格
    showTableMenu(x, y);
    return;
  }
  const imgEl = el.closest('img');
  if (imgEl) {
    cmds.caretAtScreenPoint(x, y);
    showImageMenu(x, y, imgEl);
    return;
  }
  // 普通文本 / 空白区域：若当前没有选中文字，先把光标移到右键位置，
  // 保证“插入链接/格式”等操作作用于用户点击处而不是上一次的旧光标。
  if (!cmds.hasTextSelection()) cmds.caretAtScreenPoint(x, y);
  showTextMenu(x, y);
}

/** 普通文本 / 空区域上的编辑器右键菜单 */
function showTextMenu(x, y) {
  const items = [
    { label: '加粗', shortcut: 'Ctrl+B', onClick: () => cmds.cmdToggleBold() },
    { label: '斜体', shortcut: 'Ctrl+I', onClick: () => cmds.cmdToggleItalic() },
    { label: '删除线', onClick: () => cmds.cmdToggleStrike() },
    { label: '行内代码', onClick: () => cmds.cmdToggleCode() },
    {
      label: '链接…',
      onClick: async () => {
        const url = await inputDialog({ title: '插入链接', placeholder: 'https://…', confirmText: '确定' });
        if (url && url.trim()) cmds.cmdToggleLink(url.trim());
      },
    },
    { divider: true },
    {
      label: '标题',
      icon: 'heading1',
      children: [
        { label: 'H1 一级标题', onClick: () => cmds.cmdSetHeading(1) },
        { label: 'H2 二级标题', onClick: () => cmds.cmdSetHeading(2) },
        { label: 'H3 三级标题', onClick: () => cmds.cmdSetHeading(3) },
        { divider: true },
        { label: '正文段落', onClick: () => cmds.cmdSetParagraph() },
      ],
    },
    { label: '引用', icon: 'quote', onClick: () => cmds.cmdQuote() },
    { divider: true },
    { label: '无序列表', icon: 'list', onClick: () => cmds.cmdBulletList() },
    { label: '有序列表', icon: 'listOrdered', onClick: () => cmds.cmdOrderedList() },
    { label: '任务列表（待办）', icon: 'tasks', onClick: () => cmds.cmdTaskList() },
    { divider: true },
    { label: '代码块', icon: 'code', onClick: () => cmds.cmdCodeBlock() },
    { label: '分割线', icon: 'hr', onClick: () => cmds.cmdHr() },
    { label: '插入表格（3 列 × 2 行）', icon: 'table', onClick: () => cmds.cmdTable(2, 3) },
  ];
  showContextMenu(x, y, items);
}

function showTableMenu(x, y) {
  const info = cmds.tableCaretInfo(); // caretAtScreenPoint 已在右键时设置
  const inHeader = !!(info && info.top === 0);
  const items = [
    {
      label: '在上方插入行',
      icon: 'fileUp',
      disabled: inHeader, // 表头行上方无法插入（避免产生重复表头）
      onClick: () => cmds.cmdTableRowAbove(),
    },
    { label: '在下方插入行', onClick: () => cmds.cmdTableRowBelow() },
    { divider: true },
    { label: '在左侧插入列', onClick: () => cmds.cmdTableColLeft() },
    { label: '在右侧插入列', onClick: () => cmds.cmdTableColRight() },
    { divider: true },
    {
      label: '删除当前行',
      icon: 'trash',
      danger: true,
      disabled: inHeader, // 表结构要求保留表头行
      onClick: () => cmds.cmdTableDeleteRow(),
    },
    { label: '删除当前列', icon: 'trash', danger: true, onClick: () => cmds.cmdTableDeleteCol() },
    { label: '切换表头行', onClick: () => cmds.cmdTableToggleHeaderRow() },
    { divider: true },
    { label: '删除整张表格', icon: 'trash', danger: true, onClick: () => cmds.cmdTableDeleteTable() },
  ];
  showContextMenu(x, y, items);
}

/** 图片上的右键：预览缩放 / 复制引用 / 从文中删除 */
function showImageMenu(x, y, imgEl) {
  const src = imgEl.getAttribute('src') || '';
  const attachId = S.imgMap.get(src) || null;
  const attachName = imgEl.getAttribute('alt') || '图片';
  const items = [
    {
      label: '预览 / 缩放…',
      icon: 'eye',
      onClick: async () => {
        if (attachId) {
          const owner = findAttachmentGlobal(attachId);
          if (owner) {
            openAttachmentZoom(owner.file.id, attachId);
            return;
          }
        }
        if (/^data:/.test(src)) zoomImagePreview(src, attachName);
        else toast('无法预览非本地图片', 'error');
      },
    },
  ];
  if (attachId) {
    items.push({
      label: '复制引用标记',
      icon: 'copy',
      onClick: async () => {
        try {
          await navigator.clipboard.writeText('![' + attachName + '](attachment://' + attachId + ')');
          toast('引用已复制', 'success');
        } catch {
          toast('复制失败', 'error');
        }
      },
    });
  }
  items.push({ divider: true });
  items.push({
    label: '从文中删除这张图片',
    icon: 'trash',
    danger: true,
    onClick: () => cmds.deleteImageAtScreenPoint(x, y),
  });
  showContextMenu(x, y, items);
}

/** 图片缩放预览弹窗 */
function zoomImagePreview(dataUrl, name) {
  const title = h('h3', { class: 'modal-title', text: '预览：' + (name || '图片') });
  const body = h('div', { class: 'modal-body' });
  const stage = h('div', { class: 'zoom-stage' });
  const img = h('img', { src: dataUrl, alt: name || '', class: 'zoom-img' });
  stage.appendChild(img);
  body.appendChild(stage);

  let scale = 1;
  const apply = () => {
    img.style.transform = 'scale(' + scale + ')';
  };
  const mkCtrl = (label, title, fn) =>
    btn(label, {
      title,
      onClick: () => {
        fn();
        apply();
      },
    });
  const row = h('div', { class: 'modal-actions zoom-actions' });
  row.appendChild(mkCtrl('−', '缩小', () => (scale = Math.max(0.2, +(scale - 0.4).toFixed(2)))));
  row.appendChild(mkCtrl('+', '放大', () => (scale = Math.min(6, +(scale + 0.4).toFixed(2)))));
  row.appendChild(mkCtrl('100%', '实际大小', () => (scale = 1)));
  row.appendChild(
    btn('适应窗口', {
      onClick: () => {
        scale = 1;
        img.style.transform = '';
        stage.scrollLeft = 0;
        stage.scrollTop = 0;
      },
    })
  );
  row.appendChild(h('span', { class: 'spacer' }));
  row.appendChild(btn('下载', { onClick: () => downloadDataUrl(dataUrl, name || 'image') }));
  row.appendChild(btn('关闭', { kind: 'primary', onClick: () => modal.close() }));
  body.appendChild(row);

  const modal = openModal(h('div', null, title, body));
}

function downloadDataUrl(dataUrl, filename) {
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** 附件级“预览 / 缩放”（图片可用） */
async function openAttachmentZoom(fileId, attachId) {
  try {
    const bytes = await fetchAttachmentBytes(attachId);
    const file = T.locate(S.root, fileId)?.node;
    const meta = file ? T.attachFind(file, attachId) : null;
    const mime = meta ? C.mimeOf(meta.name, meta.mime) : 'application/octet-stream';
    if (C.isImageMime(mime)) {
      zoomImagePreview(C.bytesToDataURL(bytes, mime), meta ? meta.name : '');
      return;
    }
    toast('该附件不是图片，无法缩放预览', 'info');
  } catch {
    toast('无法读取附件（密文缺失或密钥不符）', 'error');
  }
}

/* ---------------- 文件树右键菜单 ---------------- */

function showNodeMenu(id, x, y) {
  const hit = T.locate(S.root, id);
  if (!hit) return;
  const node = hit.node;
  const isFile = node.kind === 'file';
  const items = [];

  if (isFile) {
    items.push({ label: '打开笔记', icon: 'fileText', onClick: () => openNote(id) });
    items.push({ divider: true });

    const atts = T.attachListOf(node);
    const usedSet = S.refBadges.get(id);
    const attachItems = atts.map((a) => ({
      label: a.name + (usedSet && usedSet.has(a.id) ? '（已引用）' : ''),
      icon: C.isImageMime(a.mime) ? 'image' : 'paperclip',
      onClick: () => openAttachment(id, a.id),
    }));
    if (!attachItems.length) attachItems.push({ label: '（暂无附件）', disabled: true });
    items.push({
      label: '附件列表 (' + atts.length + ')',
      icon: 'paperclip',
      children: [
        ...attachItems,
        { divider: true },
        { label: '展开 / 收起附件目录', onClick: () => toggleFileExpanded(id) },
        { label: '添加附件…', icon: 'upload', onClick: () => pickAttachmentFile(id) },
      ],
    });
  } else {
    items.push({ label: '新建笔记', icon: 'filePlus', onClick: () => createNote(id) });
    items.push({ label: '新建文件夹', icon: 'folderPlus', onClick: () => createFolder(id) });
    items.push({ divider: true });
  }

  items.push(
    { label: '复制', icon: 'copy', onClick: () => clipCopy(id) },
    { label: '剪切', icon: 'scissors', onClick: () => clipCut(id) },
    {
      label: S.clip ? '粘贴 ' + (S.clip.mode === 'copy' ? '“' + S.clip.label + '”' : '“' + S.clip.label + '”') : '粘贴',
      icon: 'clipboard',
      disabled: !S.clip,
      onClick: () => pasteClipboard(isFile ? (hit.parent ? hit.parent.id : T.ROOT_ID) : id),
    },
    { divider: true },
    { label: '重命名', icon: 'pencil', onClick: () => renameViaRow(id) },
    { label: '删除', icon: 'trash', danger: true, onClick: () => deleteNodeById(id) }
  );

  // 文件节点：粘贴目的地应为当前所在文件夹
  showContextMenu(x, y, items);
}

function showTreeBlankMenu(x, y) {
  const items = [
    { label: '新建笔记', icon: 'filePlus', onClick: () => createNote(T.ROOT_ID) },
    { label: '新建文件夹', icon: 'folderPlus', onClick: () => createFolder(T.ROOT_ID) },
    { divider: true },
    {
      label: '粘贴',
      icon: 'clipboard',
      disabled: !S.clip,
      onClick: () => pasteClipboard(T.ROOT_ID),
    },
  ];
  showContextMenu(x, y, items);
}

function renameViaRow(id) {
  const hit = T.locate(S.root, id);
  if (!hit) return;
  // 统一走行内重命名：先确保其所在文件夹链展开、行可见
  let p = hit.parent;
  const guard = 0;
  while (p && p.id !== T.ROOT_ID) {
    S.expanded.add(p.id);
    const lp = T.locate(S.root, p.id);
    p = lp ? lp.parent : null;
  }
  renderTree();
  const rowEl = document.querySelector('.tree-row[data-id="' + id + '"] .tree-name');
  const row = document.querySelector('.tree-row[data-id="' + id + '"]');
  if (rowEl && row) startInlineRename(row, rowEl, hit.node);
  else toast('无法定位该条目，请展开目录后重试', 'error');
}

function showAttachmentMenu(file, a, x, y) {
  const usedSet = S.refBadges.get(file.id);
  const used = !!usedSet && usedSet.has(a.id);
  const items = [
    { label: '预览 / 缩放…', icon: 'image', onClick: () => openAttachmentZoom(file.id, a.id) },
    { label: '打开详情', icon: 'eye', onClick: () => openAttachment(file.id, a.id) },
    {
      label: '插入到文中（光标处）',
      icon: 'fileUp',
      disabled: S.openId !== file.id,
      onClick: () => insertAttachmentRef(file.id, a.id),
    },
    {
      label: '下载',
      icon: 'download',
      onClick: () => {
        openAttachment(file.id, a.id); // 在预览弹窗里点击下载
      },
    },
    { divider: true },
    { label: used ? '从笔记移除（已引用）' : '从笔记移除', icon: 'trash', danger: true, onClick: () => removeAttachment(file.id, a.id) },
  ];
  showContextMenu(x, y, items);
}

/* ================================================================ */
/*  日记功能（Obsidian 风格：开关 / 目标文件夹 / 模板 / 日历定位）   */
/* ================================================================ */

function dailyCfg() {
  if (!S.root) return null;
  if (!S.root.daily) S.root.daily = { enabled: false, folderId: null, template: '' };
  return S.root.daily;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

export function dateStrOf(d) {
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

function todayDateStr() {
  return dateStrOf(new Date());
}

function weekdayZh(d) {
  return '星期' + '日一二三四五六'[d.getDay()];
}

function dailyFolderNode() {
  const cfg = dailyCfg();
  if (!cfg) return null;
  if (cfg.folderId) {
    const hit = T.locate(S.root, cfg.folderId);
    if (hit && hit.node.kind === 'folder') return hit.node;
  }
  // 按名字找“日记”文件夹，找不到则在根目录建一个
  const existing = (S.root.children || []).find((c) => c.kind === 'folder' && c.name === '日记');
  if (existing) {
    cfg.folderId = existing.id;
    return existing;
  }
  const folder = T.addFolder(S.root, T.ROOT_ID, '日记');
  cfg.folderId = folder.id;
  return folder;
}

function dailyNoteNames(folderNode) {
  const out = new Set();
  for (const c of folderNode.children || []) if (c.kind === 'file') out.add(c.name);
  return out;
}

function renderDailyTemplate(tpl, dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  if (Number.isNaN(d.getTime())) return '';
  const map = {
    date: dateStr,
    year: String(d.getFullYear()),
    month: pad2(d.getMonth() + 1),
    day: pad2(d.getDate()),
    weekday: weekdayZh(d),
    time: pad2(new Date().getHours()) + ':' + pad2(new Date().getMinutes()),
    iso: dateStr + ' ' + pad2(new Date().getHours()) + ':' + pad2(new Date().getMinutes()),
  };
  return (tpl || '').replace(/\{\{\s*([a-zA-Z]+)\s*\}\}/g, (m, key) => (key in map ? map[key] : m));
}

function DEFAULT_DAILY_TEMPLATE() {
  return ['# {{date}} {{weekday}}', '', '## 📌 今日计划', '', '- [ ] ', '', '## ✍️ 随记', '', ''].join('\n');
}

/** 打开某一天的日记；不存在则按模板创建 */
async function openDailyByDate(dateStr, { createIfMissing = true } = {}) {
  if (!S.root || S.mode !== 'unlocked') return;
  const folder = dailyFolderNode();
  if (!folder) {
    toast('日记文件夹不可用', 'error');
    return;
  }
  const file = (folder.children || []).find((c) => c.kind === 'file' && c.name === dateStr);
  if (file) {
    await openNote(file.id);
    return;
  }
  if (!createIfMissing) return;
  const cfg = dailyCfg();
  const node = T.addNote(S.root, folder.id, dateStr);
  const tpl = cfg && cfg.template ? cfg.template : DEFAULT_DAILY_TEMPLATE();
  const text = renderDailyTemplate(tpl, dateStr);
  S.contents.set(node.id, mkRec(text));
  try {
    await api.saveNote(node.id, await C.encryptToString(S.key, text, C.aadForNote(node.id)));
  } catch (e) {
    T.removeNode(S.root, node.id);
    S.contents.delete(node.id);
    toast('创建日记失败：' + (e.message || e), 'error');
    return;
  }
  await persistTree(true);
  ensureExpandedTo(folder.id);
  renderTree();
  await openNote(node.id);
}

function dailyMenuAnchor(btn) {
  const r = btn.getBoundingClientRect();
  return { x: r.left, y: r.bottom + 6 };
}

function showDailyMenu(btn) {
  const cfg = dailyCfg();
  const enabled = !!(cfg && cfg.enabled);
  const items = [];
  const date = todayDateStr();
  items.push({
    label: '打开今日日记（' + date + '）',
    icon: 'edit',
    disabled: !enabled,
    onClick: () => {
      if (enabled) openDailyByDate(date);
    },
  });
  items.push({ label: '日历视图…', icon: 'calendar', onClick: () => openCalendarModal() });
  items.push({ divider: true });
  if (!enabled) items.push({ label: '日记功能未开启（在设置中打开）', disabled: true });
  items.push({ label: '日记设置…', icon: 'settings', onClick: () => openDailySettings() });
  const p = dailyMenuAnchor(btn);
  showContextMenu(p.x, p.y, items);
}

function openCalendarModal() {
  const cfg = dailyCfg();
  const enabled = !!(cfg && cfg.enabled);
  const folder = enabled ? findDailyFolderExisting() : null;
  const names = folder ? dailyNoteNames(folder) : new Set();

  let viewDate = new Date();
  const title = h('h3', { class: 'modal-title' });
  const grid = h('div', { class: 'cal-grid' });
  const head = h('div', { class: 'cal-head' });
  const prev = btn('‹', { onClick: () => changeMonth(-1) });
  const next = btn('›', { onClick: () => changeMonth(1) });
  const titleSpan = h('span', { class: 'cal-title' });
  const today = btn('今天', { kind: 'primary', onClick: () => { viewDate = new Date(); render(); } });
  head.appendChild(prev);
  head.appendChild(titleSpan);
  head.appendChild(next);
  head.appendChild(today);
  head.appendChild(btn('设置', { onClick: () => openSettingsPage('daily') }));

  const body = h('div', { class: 'modal-body' });
  body.appendChild(head);
  body.appendChild(grid);
  body.appendChild(
    h('p', {
      class: 'modal-msg cal-tip',
      text: '带圆点的日期表示已有日记；点击日期即可打开（不存在会自动按模板创建）。',
    })
  );
  const modal = openModal(h('div', null, title, body));

  function render() {
    const y = viewDate.getFullYear();
    const m = viewDate.getMonth();
    title.textContent = '日历 · ' + y + ' 年 ' + (m + 1) + ' 月';
    titleSpan.textContent = y + '年' + (m + 1) + '月';
    grid.innerHTML = '';
    const weeks = ['日', '一', '二', '三', '四', '五', '六'];
    for (const w of weeks) grid.appendChild(h('div', { class: 'cal-cell cal-dow', text: w }));
    const first = new Date(y, m, 1);
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    const lead = first.getDay();
    const todayStr = todayDateStr();
    for (let i = 0; i < lead; i++) grid.appendChild(h('div', { class: 'cal-cell' }));
    for (let d = 1; d <= daysInMonth; d++) {
      const ds = y + '-' + pad2(m + 1) + '-' + pad2(d);
      const cell = h('button', {
        class: 'cal-cell cal-day' + (ds === todayStr ? ' today' : '') + (names.has(ds) ? ' has-note' : ''),
        type: 'button',
        title: ds + (names.has(ds) ? '（已有日记）' : ''),
      });
      cell.appendChild(document.createTextNode(String(d)));
      if (names.has(ds)) {
        const dot = h('span', { class: 'cal-dot' });
        cell.appendChild(dot);
      }
      cell.addEventListener('click', () => {
        modal.close();
        if (!enabled) {
          toast('请先在设置中开启日记功能', 'info');
          openSettingsPage('daily');
          return;
        }
        openDailyByDate(ds);
      });
      grid.appendChild(cell);
    }
  }
  function changeMonth(delta) {
    viewDate = new Date(viewDate.getFullYear(), viewDate.getMonth() + delta, 1);
    // 重新拉取有日记的日期（可能刚创建过）
    const f2 = findDailyFolderExisting();
    names.clear();
    if (f2) for (const n of dailyNoteNames(f2)) names.add(n);
    render();
  }
  render();
}

function folderOptionsList() {
  const opts = [];
  (function walk(folder, prefix) {
    for (const c of sortedView(folder.children)) {
      if (c.kind === 'folder') {
        const label = prefix ? prefix + ' / ' + c.name : c.name;
        opts.push({ id: c.id, label });
        walk(c, label);
      }
    }
  })(S.root, '');
  return opts;
}

function openDailySettings() {
  const cfg = dailyCfg();
  if (!cfg) return;
  const body = h('div', { class: 'modal-body' });
  const title = h('h3', { class: 'modal-title', text: '日记设置' });
  body.appendChild(
    h('p', { class: 'modal-msg', text: '像 Obsidian 一样按天记录：开启后可在日历中快速定位每天，名称形如 2025-06-22。' })
  );

  const enableRow = h('label', { class: 'switch-row' });
  const enableBox = h('input', { type: 'checkbox' });
  enableBox.checked = !!cfg.enabled;
  enableRow.appendChild(enableBox);
  enableRow.appendChild(h('span', { text: '启用日记功能' }));
  body.appendChild(enableRow);

  body.appendChild(h('label', { class: 'field-label', text: '日记存放文件夹' }));
  const opts = folderOptionsList();
  const sel = h('select', { class: 'cal-select' });
  const autoOpt = h('option', { value: '', text: '（自动：使用 / 创建“日记”文件夹）' });
  sel.appendChild(autoOpt);
  let matched = !cfg.folderId;
  for (const o of opts) {
    const opt = h('option', { value: o.id, text: o.label });
    if (o.id === cfg.folderId) {
      opt.selected = true;
      matched = true;
    }
    sel.appendChild(opt);
  }
  if (!cfg.folderId) autoOpt.selected = true;
  body.appendChild(sel);

  body.appendChild(h('label', { class: 'field-label', text: '日记模板（支持 {{date}} {{time}} {{weekday}} {{year}} {{month}} {{day}}）' }));
  const tpl = h('textarea', { class: 'cal-tpl' });
  tpl.value = cfg.template || DEFAULT_DAILY_TEMPLATE();
  body.appendChild(tpl);

  const err = h('p', { class: 'modal-error hidden' });
  body.appendChild(err);

  const okBtn = btn('保存', {
    kind: 'primary',
    onClick: async () => {
      cfg.enabled = enableBox.checked;
      cfg.template = tpl.value;
      const fid = sel.value;
      let folder = null;
      if (fid) {
        const hit = T.locate(S.root, fid);
        if (hit && hit.node.kind === 'folder') {
          folder = hit.node;
          cfg.folderId = fid;
        }
      }
      if (!folder) cfg.folderId = null; // 交给 dailyFolderNode 自动建“日记”
      folder = dailyFolderNode(); // 确保存在并落定
      if (!folder) {
        err.textContent = '无法创建日记文件夹';
        err.classList.remove('hidden');
        return;
      }
      cfg.folderId = folder.id;
      await persistTree(true);
      toast(cfg.enabled ? '日记功能已开启，文件夹：' + folder.name : '日记功能已关闭', 'success');
      modal.close();
      if (cfg.enabled) renderTree();
    },
  });
  const cancel = btn('取消', { onClick: () => modal.close() });
  body.appendChild(h('div', { class: 'modal-actions' }, cancel, okBtn));
  const modal = openModal(h('div', null, title, body));
}

/* ================================================================ */
/*  侧边栏折叠 + 顶部/底部栏悬停显示                                  */
/* ================================================================ */

function setSideCollapsed(collapsed) {
  S.sideCollapsed = collapsed;
  const ws = $('workspace');
  ws.classList.toggle('side-collapsed', collapsed);
  ws.classList.remove('ui-reveal');
  const rail = $('side-rail');
  const toggle = $('btn-side-toggle');
  const railOpen = $('rail-open');
  if (collapsed) {
    rail.classList.remove('hidden');
    toggle.innerHTML = svg('panel', 16);
    railOpen.innerHTML = svg('panel', 16);
  } else {
    rail.classList.add('hidden');
    toggle.innerHTML = svg('panel', 16);
  }
  toggle.classList.toggle('rotated', collapsed);
  railOpen.title = '展开侧边栏';
}

function bindCollapseUI() {
  $('btn-side-toggle').addEventListener('click', () => setSideCollapsed(!S.sideCollapsed));
  $('rail-open').addEventListener('click', () => setSideCollapsed(false));

  // 折叠时：鼠标贴近顶部/底部才显示顶栏/底栏（其余时间完全透明不可点）
  let revealTimer = null;
  document.addEventListener(
    'mousemove',
    (e) => {
      if (!S.sideCollapsed || S.mode !== 'unlocked') return;
      const zone = e.clientY <= 36 || e.clientY >= window.innerHeight - 32;
      const ws = $('workspace');
      if (zone) {
        ws.classList.add('ui-reveal');
        clearTimeout(revealTimer);
        revealTimer = setTimeout(() => ws.classList.remove('ui-reveal'), 2500);
      } else {
        ws.classList.remove('ui-reveal');
      }
    },
    { passive: true }
  );
}

/* ================================================================ */
/*  主题 + 独立设置页 + 日历按钮左右键 相关实现                        */
/* ================================================================ */

const THEME_OPTIONS = [
  { key: 'dark', name: '石墨深色', desc: '紫色深色（默认）', swatch: 'linear-gradient(135deg,#191920 0%,#2a243f 60%,#191920 100%)', chip: '#7d5cff' },
  { key: 'light', name: '明亮浅色', desc: '清爽亮色', swatch: 'linear-gradient(135deg,#ffffff 0%,#ecebf6 70%,#e3dffa 100%)', chip: '#6a4df5' },
  { key: 'midnight', name: '午夜蓝', desc: '蓝调深色', swatch: 'linear-gradient(135deg,#0d131e 0%,#1b2b47 70%,#0d131e 100%)', chip: '#5f9cf6' },
  { key: 'paper', name: '暖纸', desc: '温暖浅色', swatch: 'linear-gradient(135deg,#faf6ef 0%,#e9ddc6 80%,#f2e7d2 100%)', chip: '#a7652c' },
];

function themeKey() {
  try {
    return localStorage.getItem('freipen.theme') || 'dark';
  } catch {
    return 'dark';
  }
}

function applyTheme(key) {
  document.documentElement.dataset.theme = THEME_OPTIONS.some((t) => t.key === key) ? key : 'dark';
  try {
    localStorage.setItem('freipen.theme', document.documentElement.dataset.theme);
  } catch {
    /* ignore */
  }
}

function initLocalPrefs() {
  applyTheme(themeKey());
  try {
    const em = localStorage.getItem('freipen.editmode');
    if (em === 'source' || em === 'wysiwyg') S.editMode = em;
  } catch {
    /* ignore */
  }
  try {
    const ts = JSON.parse(localStorage.getItem('freipen.treesort') || 'null');
    if (ts && ['name', 'created'].includes(ts.by) && ['asc', 'desc'].includes(ts.dir)) S.treeSort = ts;
  } catch {
    /* ignore */
  }
  try {
    S.customKeys = JSON.parse(localStorage.getItem('freipen.keys') || '{}') || {};
    // 清理历史脏数据：自定义键若撞到其他动作的默认键，则还原为默认（防止 Ctrl+L 被抢）
    let changed = false;
    for (const d of KEY_DEFS) {
      const c = S.customKeys[d.id];
      if (!c) continue;
      const other = KEY_DEFS.find((o) => o.id !== d.id && o.def === c);
      if (other) {
        delete S.customKeys[d.id];
        changed = true;
      }
    }
    if (changed) localStorage.setItem('freipen.keys', JSON.stringify(S.customKeys));
  } catch {
    S.customKeys = {};
  }
}
function findDailyFolderExisting() {
  const cfg = dailyCfg();
  if (!cfg) return null;
  if (cfg.folderId) {
    const hit = T.locate(S.root, cfg.folderId);
    if (hit && hit.node.kind === 'folder') return hit.node;
  }
  const existing = (S.root.children || []).find((c) => c.kind === 'folder' && c.name === '日记');
  return existing || null;
}

function dailyQuickToday() {
  const cfg = dailyCfg();
  if (!cfg || !cfg.enabled) {
    toast('日记功能尚未开启，请到设置页开启', 'info');
    openSettingsPage('daily');
    return;
  }
  openDailyByDate(todayDateStr());
}

/** 日记/设置页面里“存放文件夹”的自定义选择器（不用原生 select） */
function folderPicker(selectedId) {
  const wrap = h('div', { class: 'folder-pick' });
  let value = selectedId || '';
  const rows = new Map();
  const opts = [{ id: '', label: '（自动：使用 / 创建“日记”文件夹）', icon: 'calendar' }, ...folderOptionsList().map((o) => ({ id: o.id, label: o.label, icon: 'folder' }))];
  for (const o of opts) {
    const row = h('button', { type: 'button', class: 'folder-pick-row' + (o.id === value ? ' active' : '') });
    const ic = icon(o.icon === 'calendar' ? 'calendar' : 'folder', 14, 'tree-folder-ic');
    row.appendChild(ic);
    row.appendChild(h('span', { text: o.label }));
    row.addEventListener('click', () => {
      value = o.id;
      for (const [k, el] of rows) el.classList.toggle('active', k === o.id);
    });
    rows.set(o.id, row);
    wrap.appendChild(row);
  }
  return { el: wrap, get: () => value };
}

/** 独立设置页：外观（主题/默认编辑模式）+ 日记（开关/文件夹/模板） */
function openSettingsPage(initialTab) {
  const cfg = dailyCfg();
  const root = h('div', { class: 'setpg' });
  const modal = openModal(root, { cls: 'setpg-modal' });
  const msg = h('span', { class: 'setpg-msg' });

  /* ---------- 头部 ---------- */
  const head = h('div', { class: 'setpg-head' });
  head.appendChild(h('div', { class: 'setpg-title', text: '设置' }));
  head.appendChild(h('div', { class: 'setpg-sub', text: '外观与主题 · 日记 · 默认编辑模式 · 快捷键' }));
  const closeX = btn('✕', { onClick: () => { cancelKeyCaptures(); modal.close(); } });
  closeX.className = 'setpg-x';
  closeX.title = '关闭';
  head.appendChild(closeX);

  /* ---------- 标签 ---------- */
  const tabBar = h('div', { class: 'setpg-tabs' });
  const tabDefs = [
    ['appearance', '外观与主题'],
    ['daily', '日记'],
    ['keys', '快捷键'],
  ];
  const tabBtns = {};
  const panes = {};
  function show(key) {
    for (const [k] of tabDefs) {
      tabBtns[k].classList.toggle('on', k === key);
      panes[k].classList.toggle('on', k === key);
    }
  }
  for (const [key, label] of tabDefs) {
    const b = btn(label, { onClick: () => show(key) });
    b.className = 'setpg-tab';
    tabBtns[key] = b;
    tabBar.appendChild(b);
  }

  /* ---------- 外观面板 ---------- */
  const paneA = h('div', { class: 'setpg-pane' });
  paneA.appendChild(h('div', { class: 'setpg-sec-h', text: '主题样式' }));
  const cards = h('div', { class: 'setpg-cards' });
  for (const t of THEME_OPTIONS) {
    const card = btn(t.name, { onClick: () => applyTheme(t.key) });
    card.className = 'setpg-card' + (themeKey() === t.key ? ' on' : '');
    const sw = h('span', { class: 'setpg-swatch' });
    sw.style.background = t.swatch;
    card.prepend(sw);
    card.appendChild(h('span', { class: 'setpg-card-name', text: t.name }));
    card.appendChild(h('span', { class: 'setpg-card-desc', text: t.desc }));
    card.addEventListener('click', () => {
      cards.querySelectorAll('.setpg-card').forEach((c) => c.classList.remove('on'));
      card.classList.add('on');
      msg.textContent = '主题已切换为「' + t.name + '」';
    });
    cards.appendChild(card);
  }
  paneA.appendChild(cards);

  paneA.appendChild(h('div', { class: 'setpg-sec-h', text: '默认编辑模式' }));
  const chips = h('div', { class: 'setpg-chips' });
  const chipDefs = [['wysiwyg', '即时渲染'], ['source', 'Markdown 源码']];
  for (const [mk, ml] of chipDefs) {
    const chip = btn(ml, {
      onClick: () => {
        try { localStorage.setItem('freipen.editmode', mk); } catch {}
        chips.querySelectorAll('.setpg-chip').forEach((c) => c.classList.remove('on'));
        chip.classList.add('on');
        if (S.openId && S.mode === 'unlocked') setEditMode(mk);
        else S.editMode = mk;
        msg.textContent = '编辑模式已设为「' + ml + '」（新打开的笔记会沿用）';
      },
    });
    chip.className = 'setpg-chip' + ((S.editMode === mk) ? ' on' : '');
    chips.appendChild(chip);
  }
  paneA.appendChild(chips);
  // 快捷键面板（独立页签）
  const paneK = h('div', { class: 'setpg-pane' });
  paneK.appendChild(h('div', { class: 'setpg-sec-h', text: '编辑快捷键' }));
  buildShortcutRows(paneK, msg);
  paneK.appendChild(h('div', { class: 'setpg-hint', text: '点击右侧按键即可重新录制；默认快捷键见各条目（打开设置 = Ctrl+,）。冲突的浏览器快捷键（如 Ctrl+N / Ctrl+L / Ctrl+,）会被本应用拦截，不会触发浏览器默认行为。' }));

  /* ---------- 日记面板 ---------- */
  const paneD = h('div', { class: 'setpg-pane' });

  const swRow = h('div', { class: 'setpg-swrow' });
  const swBox = h('input', { type: 'checkbox' });
  swBox.checked = !!(cfg && cfg.enabled);
  swRow.appendChild(swBox);
  swRow.appendChild(h('span', { class: 'setpg-swlabel', text: '启用日记功能' }));
  paneD.appendChild(swRow);
  paneD.appendChild(h('div', { class: 'setpg-hint', text: '侧边栏 📅：左键打开今日日记，右键打开日历视图。' }));

  paneD.appendChild(h('div', { class: 'setpg-lab', text: '存放文件夹' }));
  const folderList = h('div', { class: 'setpg-pick' });
  const folderOpts = [{ id: '', label: '自动（使用 / 创建“日记”文件夹）' }, ...folderOptionsList().map((o) => ({ id: o.id, label: o.label }))];
  let folderVal = (cfg && cfg.folderId) || '';
  const optRows = [];
  for (const o of folderOpts) {
    const opt = btn(o.label, {
      onClick: () => {
        folderVal = o.id;
        for (const r of optRows) r.classList.toggle('on', r.dataset.fid === o.id);
      },
    });
    opt.className = 'setpg-opt' + (o.id === folderVal ? ' on' : '');
    opt.dataset.fid = o.id;
    optRows.push(opt);
    folderList.appendChild(opt);
  }
  paneD.appendChild(folderList);
  paneD.appendChild(h('div', { class: 'setpg-hint', text: '选择现有文件夹，或留空自动使用“日记”文件夹。' }));

  paneD.appendChild(h('div', { class: 'setpg-lab', text: '日记模板' }));
  const tpl = h('textarea', { class: 'setpg-area' });
  if (cfg) tpl.value = cfg.template || DEFAULT_DAILY_TEMPLATE();
  paneD.appendChild(tpl);
  paneD.appendChild(h('div', { class: 'setpg-hint', text: '可用变量：{{date}} {{year}} {{month}} {{day}} {{weekday}} {{time}} {{iso}}' }));
  const dailyErr = h('div', { class: 'setpg-err hidden', text: '' });
  paneD.appendChild(dailyErr);

  // 自动保存（无保存按钮）
  const saveDailyAuto = async (focusMsg) => {
    const c = dailyCfg();
    if (!c) return;
    c.enabled = swBox.checked;
    c.template = tpl.value;
    if (folderVal) {
      const hit = T.locate(S.root, folderVal);
      if (hit && hit.node.kind === 'folder') c.folderId = folderVal;
    } else {
      c.folderId = null;
    }
    const folder = dailyFolderNode();
    if (!folder) {
      dailyErr.textContent = '无法创建日记文件夹';
      dailyErr.classList.remove('hidden');
      return;
    }
    c.folderId = folder.id;
    await persistTree(true);
    dailyErr.classList.add('hidden');
    msg.textContent = (focusMsg || '') + (c.enabled ? '日记设置已自动保存 · 文件夹：' + folder.name : '日记功能已关闭（设置已保存）');
    updateDailyButtons();
    if (c.enabled) renderTree();
  };
  swBox.addEventListener('change', () => saveDailyAuto());
  let tplTimer = null;
  tpl.addEventListener('input', () => {
    clearTimeout(tplTimer);
    tplTimer = setTimeout(() => saveDailyAuto(), 600);
  });

  /* ---------- 底部 ---------- */
  const foot = h('div', { class: 'setpg-foot' });
  foot.appendChild(msg);
  foot.appendChild(h('span', { class: 'spacer' }));
  foot.appendChild(btn('关闭', { kind: 'primary', onClick: () => { cancelKeyCaptures(); modal.close(); } }));

  panes.appearance = paneA;
  panes.daily = paneD;
  panes.keys = paneK;
  root.appendChild(head);
  root.appendChild(tabBar);
  const content = h('div', { class: 'setpg-content' });
  content.appendChild(paneA);
  content.appendChild(paneD);
  content.appendChild(paneK);
  root.appendChild(content);
  root.appendChild(foot);
  show(initialTab === 'daily' ? 'daily' : 'appearance');
}
initLocalPrefs();

/* ================================================================ */
/*  批量新增：文件树排序 / 侧栏缩放 / 日记入口显隐 / 自定义快捷键    */
/* ================================================================ */

/** 按当前配置排序一份子节点（文件夹在前，随后文件） */
function sortedView(list) {
  if (!list || !list.length) return [];
  const s = S.treeSort || { by: 'name', dir: 'asc' };
  const dir = s.dir === 'desc' ? -1 : 1;
  const cmpName = (a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN', { sensitivity: 'base' });
  const cmp = (a, b) => {
    if (s.by === 'created') {
      const da = a.createdAt || 0;
      const db = b.createdAt || 0;
      if (da !== db) return da < db ? -dir : dir;
    }
    return cmpName(a, b);
  };
  const folders = [];
  const files = [];
  for (const c of list) (c.kind === 'folder' ? folders : files).push(c);
  folders.sort((a, b) => cmp(a, b));
  files.sort((a, b) => cmp(a, b));
  return [...folders, ...files];
}

function saveTreeSortPref() {
  try {
    localStorage.setItem('freipen.treesort', JSON.stringify(S.treeSort));
  } catch {}
  renderTree();
}

function showSortMenu(btn) {
  const s = S.treeSort || { by: 'name', dir: 'asc' };
  const items = [
    {
      label: (s.by === 'name' ? '✓ ' : '') + '按名称排序',
      onClick: () => {
        S.treeSort.by = 'name';
        saveTreeSortPref();
      },
    },
    {
      label: (s.by === 'created' ? '✓ ' : '') + '按创建时间排序',
      onClick: () => {
        S.treeSort.by = 'created';
        saveTreeSortPref();
      },
    },
    { divider: true },
    {
      label: (s.dir !== 'desc' ? '✓ ' : '') + '正序（A→Z / 旧→新）',
      onClick: () => {
        S.treeSort.dir = 'asc';
        saveTreeSortPref();
      },
    },
    {
      label: (s.dir === 'desc' ? '✓ ' : '') + '倒序（Z→A / 新→旧）',
      onClick: () => {
        S.treeSort.dir = 'desc';
        saveTreeSortPref();
      },
    },
  ];
  const p = btn.getBoundingClientRect();
  showContextMenu(p.left, p.bottom + 6, items);
}

/** 日记功能关闭时不显示日记按钮（左键今日/右键日历的入口） */
function updateDailyButtons() {
  const cfg = dailyCfg();
  const on = S.mode === 'unlocked' && !!(cfg && cfg.enabled);
  const btnDaily = $('btn-daily');
  const railDaily = $('rail-daily');
  if (btnDaily) btnDaily.classList.toggle('hidden', !on);
  if (railDaily) railDaily.classList.toggle('hidden', !on);
}

/** 侧边栏拖拽调宽 */
function initSidebarResize() {
  const sb = document.querySelector('.sidebar');
  if (!sb) return;
  const saved = (() => {
    try {
      return parseInt(localStorage.getItem('freipen.sidebarw'), 10);
    } catch {
      return 0;
    }
  })();
  if (saved >= 180 && saved <= 480) sb.style.width = saved + 'px';
  const resizer = h('div', { class: 'side-resizer' });
  sb.appendChild(resizer);
  let dragging = false;
  const clamp = (w) => Math.round(Math.max(180, Math.min(480, w)));
  resizer.addEventListener('mousedown', (e) => {
    dragging = true;
    e.preventDefault();
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  });
  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    sb.style.width = clamp(e.clientX) + 'px';
  });
  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    try {
      localStorage.setItem('freipen.sidebarw', sb.style.width);
    } catch {}
  });
}

/* ---------- 自定义快捷键 ---------- */
const KEY_DEFS = [
  { id: 'note', label: '新建笔记', def: 'mod+n', requireEditor: false, run: () => createNote() },
  { id: 'bullet', label: '无序列表', def: 'mod+shift+8', requireEditor: true, run: () => cmds.cmdBulletList() },
  { id: 'ordered', label: '有序列表', def: 'mod+shift+7', requireEditor: true, run: () => cmds.cmdOrderedList() },
  { id: 'task', label: '任务列表（待办）', def: 'mod+l', requireEditor: true, run: () => cmds.cmdTaskList() },
  { id: 'taskToggle', label: '切换本行任务状态', def: 'mod+enter', requireEditor: true, run: () => cmds.toggleTaskLine() },
  { id: 'settings', label: '打开设置', def: 'mod+,', requireEditor: false, run: () => openSettingsPage('appearance') },
];

function keyComboLabel(combo) {
  if (!combo) return '';
  return combo
    .split('+')
    .map((p) => (p === 'mod' ? 'Ctrl' : p === 'ctrl' ? 'Ctrl' : p === 'shift' ? 'Shift' : p === 'alt' ? 'Alt' : p === 'space' ? 'Space' : p === 'enter' ? 'Enter' : p.length === 1 ? p.toUpperCase() : p))
    .join('+');
}

let activeKeyCapture = null; // 正在录制的动作（含取消函数）

function mainKeyPart(e) {
  const code = e.code || '';
  // 标点键：code → 实际字符（用于 Ctrl+, / Ctrl+. 等）
  const PUNCT = {
    Comma: ',',
    Period: '.',
    Slash: '/',
    Backslash: '\\',
    Semicolon: ';',
    Quote: "'",
    BracketLeft: '[',
    BracketRight: ']',
    Backquote: '`',
    Minus: '-',
    Equal: '=',
    IntlBackslash: '\\',
  };
  if (code === 'Enter') return 'enter';
  if (code in PUNCT) return PUNCT[code];
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^F(?:[1-9]|1[0-2])$/.test(code)) return code.toLowerCase();
  if (e.key === ' ') return 'space';
  const k = e.key.toLowerCase();
  if (/^[a-z0-9]$/.test(k)) return k;
  return null;
}

function comboFromEvent(e) {
  const parts = [];
  if (e.ctrlKey || e.metaKey) parts.push('mod');
  if (e.shiftKey) parts.push('shift');
  if (e.altKey) parts.push('alt');
  const k = mainKeyPart(e);
  if (!k) return null;
  parts.push(k);
  return parts.join('+');
}

/** 取消进行中的快捷键录制（设置弹窗关闭时调用，避免残留监听吞掉按键） */
function cancelKeyCaptures() {
  if (activeKeyCapture) {
    activeKeyCapture.cancel();
    activeKeyCapture = null;
  }
}

function effectiveCombo(d) {
  return S.customKeys[d.id] || d.def;
}

function findHotkeyForCombo(combo) {
  const matches = KEY_DEFS.filter((d) => effectiveCombo(d) === combo);
  if (!matches.length) return null;
  // 撞键时优先未自定义（用默认键）的动作，避免历史脏数据把默认键抢走
  const withDefault = matches.find((d) => !S.customKeys[d.id]);
  return withDefault || matches[0];
}

function handleCustomHotkey(e) {
  if (S.mode !== 'unlocked') return false;
  const t = e.target;
  if (t && t.closest && t.closest('input, textarea, select, .ctx-menu, .modal-overlay, .setpg')) return false;
  const combo = comboFromEvent(e);
  if (!combo) return false;
  const key = findHotkeyForCombo(combo);
  if (!key) return false;
  // 命中已配置快捷键：即使当前不能执行动作，也吞掉事件，避免浏览器默认行为（如 Ctrl+N/Ctrl+L）
  e.preventDefault();
  e.stopPropagation();
  if (e.repeat) return true;
  const canRun = key.requireEditor ? S.editMode === 'wysiwyg' && !!S.openId : true;
  if (canRun) key.run();
  return true;
}
function buildShortcutRows(container, msg) {
  container.appendChild(h('div', { class: 'setpg-sec-h', text: '快捷键' }));
  for (const d of KEY_DEFS) {
    const row = h('div', { class: 'keyrow' });
    row.appendChild(h('span', { class: 'keyrow-label', text: d.label }));
    const combo = S.customKeys[d.id] || d.def;
    const badge = btn(keyComboLabel(combo), { onClick: (e) => captureKey(d, badge, msg) });
    badge.className = 'keycombo';
    row.appendChild(badge);
    container.appendChild(row);
  }
}

async function captureKey(def, badge, msg) {
  const old = S.customKeys[def.id] || def.def;
  cancelKeyCaptures(); // 同一时间只允许录制一个动作
  badge.textContent = '按下新快捷键…';
  badge.classList.add('capturing');
  function done(combo) {
    document.removeEventListener('keydown', onKey, true);
    badge.classList.remove('capturing');
    badge.textContent = keyComboLabel(combo);
    if (activeKeyCapture && activeKeyCapture.defId === def.id) activeKeyCapture = null;
  }
  function onKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      done(old);
      return;
    }
    const combo = comboFromEvent(e);
    if (!combo) return;
    e.preventDefault();
    e.stopPropagation();
    S.customKeys[def.id] = combo;
    // 清理历史脏数据：把同样键位的其他动作还原为默认键
    for (const o of KEY_DEFS) {
      if (o.id !== def.id && (S.customKeys[o.id] || o.def) === combo && o.def !== combo) {
        delete S.customKeys[o.id];
      }
    }
    try {
      localStorage.setItem('freipen.keys', JSON.stringify(S.customKeys));
    } catch {}
    done(combo);
    msg.textContent = '「' + def.label + '」快捷键已设为 ' + keyComboLabel(combo);
  }
  activeKeyCapture = {
    defId: def.id,
    cancel: () => {
      document.removeEventListener('keydown', onKey, true);
      badge.classList.remove('capturing');
      badge.textContent = keyComboLabel(old);
      activeKeyCapture = null;
    },
  };
  document.addEventListener('keydown', onKey, true);
}
/* ---------- 代码语言（编辑器内右键设置） ---------- */
const CODE_LANGS = [
  'javascript', 'typescript', 'python', 'go', 'rust', 'java', 'c', 'cpp', 'csharp',
  'ruby', 'php', 'html', 'css', 'json', 'yaml', 'xml', 'sql', 'bash', 'markdown',
];

function showCodeMenu(x, y) {
  const items = [
    {
      label: '设置代码语言…',
      icon: 'code',
      children: [
        { label: '（无语言）', onClick: () => cmds.setCodeBlockLanguageAtCursor(null) },
        { divider: true },
        ...CODE_LANGS.map((l) => ({
          label: l,
          onClick: () => cmds.setCodeBlockLanguageAtCursor(l),
        })),
      ],
    },
  ];
  showContextMenu(x, y, items);
}
initLocalPrefs();
