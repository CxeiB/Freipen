/** 通用 UI 小工具：DOM 构建、图标、toast、确认框、行内重命名 */

import { svg } from './icons.js';

/* ---------- DOM 构建 ---------- */

export function h(tag, attrs, ...children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined) continue;
      if (k === 'class') node.className = v;
      else if (k === 'dataset') Object.assign(node.dataset, v);
      else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'html') node.innerHTML = v;
      else if (k === 'text') node.textContent = v;
      else node.setAttribute(k, v);
    }
  }
  appendChildren(node, children);
  return node;
}

function appendChildren(node, children) {
  const flat = children.flat(Infinity);
  for (const c of flat) {
    if (c === null || c === undefined || c === false) continue;
    if (typeof c === 'string' || typeof c === 'number') node.appendChild(document.createTextNode(String(c)));
    else node.appendChild(c);
  }
}

/** 图标元素（span 包裹内联 SVG） */
export function icon(name, size = 16, cls = '') {
  const w = document.createElement('span');
  w.className = 'fw-ic' + (cls ? ' ' + cls : '');
  w.innerHTML = svg(name, size);
  return w;
}

export function clearNode(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/* ---------- Toast ---------- */

export function toast(message, type = 'info', ms = 3000) {
  let root = document.getElementById('toast-root');
  if (!root) {
    root = document.createElement('div');
    root.id = 'toast-root';
    document.body.appendChild(root);
  }
  const t = h('div', { class: 'toast toast-' + type });
  const icName = type === 'error' ? 'alert' : type === 'success' ? 'check' : 'shield';
  t.appendChild(icon(icName, 15));
  t.appendChild(h('span', { class: 'toast-msg', text: message }));
  root.appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => {
    t.classList.remove('show');
    setTimeout(() => t.remove(), 320);
  }, ms);
  return t;
}

/* ---------- 模态框 ---------- */

export function openModal(node, { onClose, cls } = {}) {
  const root = document.getElementById('modal-root');
  const overlay = h('div', { class: 'modal-overlay' });
  const box = h('div', { class: 'modal' + (cls ? ' ' + cls : '') });
  box.appendChild(node);
  overlay.appendChild(box);
  root.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('show'));

  function close() {
    overlay.classList.remove('show');
    setTimeout(() => overlay.remove(), 200);
    document.removeEventListener('keydown', onKey);
    if (onClose) onClose();
  }
  function onKey(e) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  }
  document.addEventListener('keydown', onKey);
  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) close();
  });
  return { close, overlay };
}

function modalTitle(text) {
  return h('h3', { class: 'modal-title', text });
}

function modalActions(...buttons) {
  const row = h('div', { class: 'modal-actions' });
  for (const b of buttons) row.appendChild(b);
  return row;
}

export function btn(text, { kind = '', onClick, autofocus = false, disabled } = {}) {
  const attrs = { class: 'btn' + (kind ? ' btn-' + kind : ''), type: 'button' };
  if (text !== null && text !== undefined) attrs.text = text;
  if (onClick) attrs.onClick = onClick;
  if (disabled) attrs.disabled = '';
  const b = h('button', attrs);
  if (autofocus) requestAnimationFrame(() => b.focus());
  return b;
}

/**
 * GitHub 风格确认框。
 * @param {object} o
 * @param {string} o.title
 * @param {string|Node} o.message
 * @param {boolean} o.danger       危险操作（确认按钮为红色实心）
 * @param {string} o.confirmText
 * @param {string} o.typeWord      需要输入的确认词（防止误删）
 * @returns {Promise<boolean>}
 */
export function confirmDialog({ title, message, danger, confirmText = '确认', typeWord }) {
  return new Promise((resolve) => {
    const root = h('div', { class: 'cg' });

    // 标题区（含告警图标）
    const head = h('div', { class: 'cg-head' });
    if (danger) {
      const mark = h('span', { class: 'cg-mark' });
      mark.innerHTML = svg('alert', 15);
      head.appendChild(mark);
    }
    head.appendChild(h('div', { class: 'cg-title', text: title }));
    root.appendChild(head);

    // 正文
    const body = h('div', { class: 'cg-body' });
    if (danger) {
      const note = h('div', { class: 'cg-danger-note' });
      const warn = h('div', { class: 'cg-danger-title' });
      warn.appendChild(icon('alert', 13));
      warn.appendChild(h('span', { text: '此操作不可撤销。' }));
      note.appendChild(warn);
      const msgEl = typeof message === 'string' ? h('p', { class: 'cg-danger-msg', text: message }) : h('div', { class: 'cg-danger-msg' }, message);
      note.appendChild(msgEl);
      body.appendChild(note);
    } else {
      const msgEl = typeof message === 'string' ? h('p', { class: 'cg-msg', text: message }) : h('div', { class: 'cg-msg' }, message);
      body.appendChild(msgEl);
    }

    let input = null;
    let okBtn = null;
    if (typeWord) {
      const label = h('label', { class: 'cg-label' });
      label.appendChild(h('span', { text: '请输入 ' }));
      label.appendChild(h('code', { text: typeWord }));
      label.appendChild(h('span', { text: ' 以确认删除' }));
      body.appendChild(label);
      input = h('input', {
        type: 'text',
        class: 'cg-input',
        placeholder: '输入 ' + typeWord + ' 确认',
        autocomplete: 'off',
        spellcheck: 'false',
      });
      input.addEventListener('input', () => {
        okBtn.disabled = input.value.trim() !== typeWord;
      });
      body.appendChild(input);
    }
    root.appendChild(body);

    // 底部按钮：取消居左前、主按钮居右（GitHub 布局）
    const actions = h('div', { class: 'cg-actions' });
    const cancelBtn = btn('取消', {
      onClick: () => {
        modal.close();
        resolve(false);
      },
    });
    okBtn = btn(confirmText, {
      kind: danger ? 'danger' : 'primary',
      disabled: Boolean(typeWord),
      autofocus: !typeWord,
      onClick: () => {
        modal.close();
        resolve(true);
      },
    });
    actions.appendChild(cancelBtn);
    actions.appendChild(okBtn);
    root.appendChild(actions);

    const modal = openModal(root, { cls: 'confirm-gh' });
    if (typeWord && input) requestAnimationFrame(() => input.focus());
  });
}

/** 单行文本输入弹窗 */
export function inputDialog({ title, label, initial, placeholder, confirmText = '确定', password = false }) {
  return new Promise((resolve) => {
    const body = h('div', { class: 'modal-body' });
    const head = modalTitle(title);
    const input = h('input', {
      type: password ? 'password' : 'text',
      value: initial || '',
      placeholder: placeholder || '',
      autocomplete: password ? 'new-password' : 'off',
      spellcheck: 'false',
    });
    if (label) body.appendChild(h('label', { class: 'field-label', text: label }));
    body.appendChild(input);
    const okBtn = btn(confirmText, {
      kind: 'primary',
      onClick: () => {
        modal.close();
        resolve(input.value);
      },
    });
    body.appendChild(
      modalActions(
        btn('取消', {
          onClick: () => {
            modal.close();
            resolve(null);
          },
        }),
        okBtn
      )
    );
    const modal = openModal(h('div', null, head, body));
    requestAnimationFrame(() => {
      input.focus();
      input.select();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        modal.close();
        resolve(input.value);
      }
    });
  });
}

/* ================================================================ */
/* 右键 / 浮出菜单                                                   */
/* ================================================================ */

/**
 * 在 (x, y)（视口坐标）显示菜单。
 * @param {Array} items 菜单项：
 *   { label?, icon?, danger?, disabled?, shortcut?, divider?, onClick?,
 *     children?: Array<item> }   // children = 鼠标悬停弹出的子菜单
 * 点击空白 / Esc / 再次调用会关闭。返回 { close }。
 */
export function showContextMenu(x, y, items, { maxHeight = 460 } = {}) {
  closeContextMenu();

  const layer = document.getElementById('ctx-layer') || (() => {
    const el = document.createElement('div');
    el.id = 'ctx-layer';
    document.body.appendChild(el);
    return el;
  })();

  let openSub = null;

  function renderItem(item) {
    if (item === null || item === undefined) return null;
    const li = h('li', { class: 'ctx-item' + (item.danger ? ' danger' : '') + (item.disabled ? ' disabled' : '') });
    const inner = h('div', { class: 'ctx-inner' });
    const iconBox = h('span', { class: 'ctx-ic' });
    if (item.icon) iconBox.innerHTML = svg(item.icon, 15);
    inner.appendChild(iconBox);
    inner.appendChild(h('span', { class: 'ctx-label', text: item.label || '' }));
    if (item.children) {
      const arrow = h('span', { class: 'ctx-arrow' });
      arrow.innerHTML = svg('chevronRight', 13);
      inner.appendChild(arrow);
    } else if (item.shortcut) {
      inner.appendChild(h('span', { class: 'ctx-shortcut', text: item.shortcut }));
    }
    li.appendChild(inner);

    li.addEventListener('mouseenter', () => {
      if (item.disabled || !item.children) return;
      openSubItems(li, item.children);
    });
    li.addEventListener('click', () => {
      if (item.disabled) return;
      if (item.children) {
        if (openSub && openSub.parent === li) return;
        openSubItems(li, item.children);
        return;
      }
      if (item.onClick) item.onClick();
      closeContextMenu();
    });
    return li;
  }

  function closeSub() {
    if (openSub) {
      openSub.el.remove();
      openSub = null;
    }
  }

  function openSubItems(parentLi, children) {
    closeSub();
    const sub = h('ul', { class: 'ctx-menu ctx-sub' });
    for (const c of children) {
      if (c && c.divider) sub.appendChild(h('li', { class: 'ctx-divider' }));
      else {
        const li = renderItem(c);
        if (li) sub.appendChild(li);
      }
    }
    layer.appendChild(sub);
    const pr = parentLi.getBoundingClientRect();
    let sx = pr.right + 4;
    let sy = pr.top;
    const sw = sub.offsetWidth || 190;
    const sh = sub.offsetHeight || 100;
    if (sx + sw > window.innerWidth - 6) sx = pr.left - sw - 4;
    if (sy + sh > window.innerHeight - 8) sy = Math.max(4, window.innerHeight - sh - 8);
    sub.style.left = sx + 'px';
    sub.style.top = sy + 'px';
    openSub = { el: sub, parent: parentLi };
  }

  const menu = h('ul', { class: 'ctx-menu' });
  for (const it of items) {
    if (it && it.divider) menu.appendChild(h('li', { class: 'ctx-divider' }));
    else {
      const li = renderItem(it);
      if (li) menu.appendChild(li);
    }
  }
  layer.appendChild(menu);

  const mw = menu.offsetWidth || 220;
  const mh = menu.offsetHeight || 160;
  let left = Math.min(x, window.innerWidth - mw - 8);
  let top = Math.min(y, window.innerHeight - Math.min(mh, maxHeight) - 8);
  left = Math.max(4, left);
  top = Math.max(4, top);
  menu.style.left = left + 'px';
  menu.style.top = top + 'px';
  menu.classList.add('show');

  const onDocDown = (e) => {
    if (!layer.contains(e.target)) closeContextMenu();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') closeContextMenu();
  };
  const onScroll = () => closeContextMenu();

  document.addEventListener('mousedown', onDocDown, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('scroll', onScroll, true);
  window.addEventListener('resize', onScroll);
  document.addEventListener('contextmenu', onScroll, true);

  ctxCleanup = () => {
    document.removeEventListener('mousedown', onDocDown, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('resize', onScroll);
    document.removeEventListener('contextmenu', onScroll, true);
    ctxCleanup = null;
  };
  return { close: closeContextMenu };
}

let ctxCleanup = null;

/** 关闭当前打开的菜单 */
export function closeContextMenu() {
  const layer = document.getElementById('ctx-layer');
  if (layer) layer.innerHTML = '';
  if (ctxCleanup) {
    const fn = ctxCleanup;
    ctxCleanup = null;
    fn();
  }
}
