/**
 * 纯内存目录树（明文形态，仅存在于解锁后的页面内存中）。
 *
 * 节点形状：
 *   folder: { kind:'folder', id, name, children:[...] }
 *   file:   { kind:'file',   id, name }
 *
 * 整棵树会被序列化 → 加密 → 交给后端保存；服务端永远见不到这些名字。
 */

export const ROOT_ID = 'root';

export function uid() {
  return crypto.randomUUID();
}

export function createRoot() {
  return { kind: 'folder', id: ROOT_ID, name: '', children: [] };
}

export function makeFolder(name) {
  return { kind: 'folder', id: uid(), name, children: [] };
}

export function makeFile(name) {
  return { kind: 'file', id: uid(), name };
}

/** 在整棵树中查找节点，返回 { container, index, node, parent }；找不到返回 null */
export function locate(root, id) {
  function walk(node, parent) {
    if (node.id === id) return { container: null, index: -1, node, parent };
    if (node.kind === 'folder') {
      const children = node.children || [];
      for (let i = 0; i < children.length; i++) {
        const child = children[i];
        if (child.id === id) return { container: children, index: i, node: child, parent: node };
        const hit = walk(child, node);
        if (hit) return hit;
      }
    }
    return null;
  }
  return walk(root, null);
}

function baseNameOf(folder) {
  return folder && folder.kind === 'folder' ? folder.name : null;
}

/** 生成父级内唯一的名字（中文序号风格：x、x 2、x 3 …） */
export function uniqueName(container, desired, isFolderName) {
  const used = new Set();
  for (const c of container) used.add(c.name);
  if (!used.has(desired)) return desired;
  let n = 2;
  while (used.has(`${desired} ${n}`)) n++;
  return `${desired} ${n}`;
}

/** 在 parentId 文件夹下新建笔记，返回新节点 */
export function addNote(root, parentId, preferredName) {
  const parent = parentId && parentId !== ROOT_ID ? locate(root, parentId)?.node : root;
  const folder = parent && parent.kind === 'folder' ? parent : root;
  const name = uniqueName(folder.children, preferredName || '未命名笔记', false);
  const file = makeFile(name);
  folder.children.push(file);
  return file;
}

/** 在 parentId 文件夹下新建子文件夹，返回新节点 */
export function addFolder(root, parentId, preferredName) {
  const parent = parentId && parentId !== ROOT_ID ? locate(root, parentId)?.node : root;
  const folder = parent && parent.kind === 'folder' ? parent : root;
  const name = uniqueName(folder.children, preferredName || '未命名文件夹', true);
  const f = makeFolder(name);
  folder.children.push(f);
  return f;
}

/** 重命名任意节点（父级内查重） */
export function renameNode(root, id, newName) {
  const hit = locate(root, id);
  if (!hit) return false;
  const name = (newName || '').trim();
  if (!name) return false;
  const container = hit.container;
  const siblings = container || [];
  if (siblings.some((c) => c.id !== id && c.name === name)) return false;
  hit.node.name = name;
  return true;
}

/** 删除节点；返回被删除子树中的所有笔记 id */
export function removeNode(root, id) {
  const hit = locate(root, id);
  if (!hit) return null;
  const removedFiles = [];
  (function collect(node) {
    if (node.kind === 'file') removedFiles.push(node.id);
    else (node.children || []).forEach(collect);
  })(hit.node);
  if (hit.container) hit.container.splice(hit.index, 1);
  return { node: hit.node, removedFiles, parent: hit.parent };
}

/** 收集树内所有笔记 id */
export function collectNoteIds(node) {
  const out = [];
  (function walk(n) {
    if (n.kind === 'file') out.push(n.id);
    else (n.children || []).forEach(walk);
  })(node);
  return out;
}

/** 统计文件夹内笔记总数 */
export function countNotes(node) {
  let n = 0;
  (function walk(x) {
    if (x.kind === 'file') n++;
    else (x.children || []).forEach(walk);
  })(node);
  return n;
}

/** 展示用排序：文件夹在前、文件在后，各自按名字排序 */
export function sortedChildren(folder) {
  const folders = [];
  const files = [];
  for (const c of folder.children || []) {
    if (c.kind === 'folder') folders.push(c);
    else files.push(c);
  }
  const cmp = (a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN', { sensitivity: 'base' });
  folders.sort(cmp);
  files.sort(cmp);
  return [...folders, ...files];
}

/** 返回从根到 node 的祖先文件夹名列表（不含 root），用于面包屑/搜索上下文 */
export function pathTo(root, id) {
  function walk(node, acc) {
    if (node.id === id) return acc;
    if (node.kind === 'folder') {
      const childAcc = node.id === ROOT_ID ? acc : [...acc, node.name];
      for (const c of node.children || []) {
        const r = walk(c, childAcc);
        if (r) return r;
      }
    }
    return null;
  }
  return walk(root, []) || [];
}

/**
 * 按名字模糊搜索。返回匹配的文件与文件夹节点（扁平、带路径上下文）。
 * 不展开子级，仅名字匹配。
 */
export function searchTree(root, query) {
  const q = query.trim().toLowerCase();
  const out = [];
  if (!q) return out;
  (function walk(node, pathNames) {
    if (node.kind === 'file') {
      if (node.name.toLowerCase().includes(q)) {
        out.push({ node, pathNames: [...pathNames] });
      }
    } else {
      const isRoot = node.id === ROOT_ID;
      const childPath = isRoot ? pathNames : [...pathNames, node.name];
      if (!isRoot && node.name.toLowerCase().includes(q)) {
        out.push({ node, pathNames: [...pathNames], isFolder: true });
      }
      for (const c of node.children || []) walk(c, childPath);
    }
  })(root, []);
  return out;
}

/* ================================================================ */
/* 附件（每篇笔记一个附件集合，元数据随加密目录树保存）            */
/* ================================================================ */

/** 取某笔记的附件数组（旧数据自动补默认值） */
export function attachListOf(fileNode) {
  if (!fileNode.attachments) fileNode.attachments = [];
  return fileNode.attachments;
}

export function attachAdd(fileNode, meta) {
  const list = attachListOf(fileNode);
  list.push(meta);
  return meta;
}

/** 移除附件，返回被移除的元数据；不存在返回 null */
export function attachRemove(fileNode, id) {
  const list = attachListOf(fileNode);
  const i = list.findIndex((a) => a.id === id);
  if (i < 0) return null;
  return list.splice(i, 1)[0];
}

export function attachFind(fileNode, id) {
  return attachListOf(fileNode).find((a) => a.id === id) || null;
}

/* ================================================================ */
/* 移动 / 复制（拖拽与剪贴板用）                                    */
/* ================================================================ */

/** 判断 a 是否为 b 的祖先 */
export function isAncestor(root, aId, bId) {
  let cur = locate(root, bId);
  while (cur && cur.parent) {
    if (cur.parent.id === aId) return true;
    cur = locate(root, cur.parent.id);
  }
  return false;
}

/**
 * 把 id 节点移动到 targetFolderId 内。
 * 不能移动到自身或自己的后代中；目标名字冲突时自动加序号改名。
 * 返回 {ok, newName?}；失败返回 {ok:false, reason}
 */
export function moveNode(root, id, targetFolderId, { position } = {}) {
  if (id === targetFolderId) return { ok: false, reason: 'same' };
  const src = locate(root, id);
  if (!src) return { ok: false, reason: 'not-found' };
  const target =
    targetFolderId === ROOT_ID
      ? root
      : (() => {
          const t = locate(root, targetFolderId);
          return t && t.node.kind === 'folder' ? t.node : null;
        })();
  if (!target) return { ok: false, reason: 'bad-target' };
  if (src.parent && src.parent.id === targetFolderId) return { ok: false, reason: 'same-folder' };
  if (src.node.kind === 'folder' && isAncestor(root, src.node.id, targetFolderId)) {
    return { ok: false, reason: 'into-self' };
  }
  const name = uniqueName(target.children, src.node.name, src.node.kind === 'folder');
  const node = src.node;
  src.container.splice(src.index, 1);
  if (position === 'top') target.children.unshift(node);
  else target.children.push(node);
  const renamed = name !== node.name;
  if (renamed) node.name = name;
  return { ok: true, newName: renamed ? name : null };
}

/**
 * 深拷贝子树：文件夹/笔记/附件全部换新 id。
 * 返回 { node, noteMap: Map<oldNoteId,newNoteId>, attachMap: Map<oldAttachId,newAttachId> }
 * （正文密文与附件密文需要调用方按映射逐一复制到新 id）
 */
export function cloneNode(node) {
  const noteMap = new Map();
  const attachMap = new Map();
  function clone(n) {
    if (n.kind === 'file') {
      const id = uid();
      noteMap.set(n.id, id);
      const attachments = (n.attachments || []).map((a) => {
        const aid = uid();
        attachMap.set(a.id, aid);
        return { ...a, id: aid };
      });
      return { kind: 'file', id, name: n.name, attachments };
    }
    return {
      kind: 'folder',
      id: uid(),
      name: n.name,
      children: (n.children || []).map(clone),
    };
  }
  return { node: clone(node), noteMap, attachMap };
}
