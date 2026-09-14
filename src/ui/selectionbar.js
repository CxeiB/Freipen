/**
 * 选中文字后的浮动工具栏（Obsidian 风格）。
 * 仅当光标位于编辑器中且存在非空选择时显示；支持激活状态高亮（加粗/斜体/删除线/行内代码）。
 */
import * as cmds from './editor-cmds.js';
import { isEditable, focusEditor } from './editor.js';
import { inputDialog } from './ui.js';

let bar = null;
let hidden = true;
const stateButtons = {}; // key -> button（用于激活态）

function makeBtn(html, title, onClick, stateKey) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'selbar-btn';
  b.title = title;
  b.innerHTML = html;
  if (stateKey) {
    b.dataset.mark = stateKey;
    stateButtons[stateKey] = b;
  }
  b.addEventListener('mousedown', (e) => e.preventDefault()); // 防止失焦丢选区
  b.addEventListener('click', (e) => {
    e.preventDefault();
    onClick();
    focusEditor();
    requestAnimationFrame(() => update());
  });
  return b;
}

function build() {
  bar = document.createElement('div');
  bar.className = 'selbar hidden';
  bar.setAttribute('role', 'toolbar');

  const grp1 = document.createElement('div');
  grp1.className = 'selbar-group';
  grp1.appendChild(makeBtn('<b>B</b>', '加粗', () => cmds.cmdToggleBold(), 'bold'));
  grp1.appendChild(makeBtn('<i>I</i>', '斜体', () => cmds.cmdToggleItalic(), 'italic'));
  grp1.appendChild(makeBtn('<s>S</s>', '删除线', () => cmds.cmdToggleStrike(), 'strike'));
  grp1.appendChild(makeBtn('<code>&lt;/&gt;</code>', '行内代码', () => cmds.cmdToggleCode(), 'code'));

  const grp2 = document.createElement('div');
  grp2.className = 'selbar-group';
  grp2.appendChild(makeBtn('H1', '一级标题', () => cmds.cmdSetHeading(1)));
  grp2.appendChild(makeBtn('H2', '二级标题', () => cmds.cmdSetHeading(2)));
  grp2.appendChild(makeBtn('H3', '三级标题', () => cmds.cmdSetHeading(3)));
  grp2.appendChild(makeBtn('❝', '引用', () => cmds.cmdQuote()));
  grp2.appendChild(
    makeBtn('🔗', '插入链接', async () => {
      const url = await inputDialog({ title: '插入链接', placeholder: 'https://…', confirmText: '确定' });
      if (url && url.trim()) {
        cmds.cmdToggleLink(url.trim());
        requestAnimationFrame(() => update());
      }
    })
  );

  bar.appendChild(grp1);
  bar.appendChild(grp2);
  document.body.appendChild(bar);
}

function refreshActiveStates() {
  const st = cmds.markActiveStates();
  if (!st) return;
  for (const [k, on] of Object.entries({ bold: st.bold, italic: st.italic, strike: st.strike, code: st.code })) {
    const b = stateButtons[k];
    if (b) b.classList.toggle('active', !!on);
  }
}

function selectionRect() {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  const rects = range.getClientRects();
  if (rects.length === 0) {
    const r = range.getBoundingClientRect();
    return r.width || r.height ? r : null;
  }
  return rects[rects.length - 1];
}

function isSelectionInEditor() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return false;
  const node = sel.anchorNode;
  if (!node) return false;
  const el = node.nodeType === 1 ? node : node.parentElement;
  return !!el && !!el.closest('.ProseMirror');
}

function update() {
  if (!bar) return;
  const editable = isEditable();
  if (!editable || !isSelectionInEditor()) {
    hide(false);
    return;
  }
  const rect = selectionRect();
  if (!rect) {
    hide(false);
    return;
  }
  bar.classList.remove('hidden');
  hidden = false;
  refreshActiveStates();
  const bh = bar.offsetHeight || 38;
  const bw = bar.offsetWidth || 260;
  let left = rect.left + rect.width / 2 - bw / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - bw - 8));
  let top = rect.bottom + 10 + bh > window.innerHeight - 40 ? rect.top - bh - 10 : rect.bottom + 10;
  top = Math.max(8, top);
  bar.style.left = left + 'px';
  bar.style.top = top + 'px';
}

function hide(force) {
  if (!bar) return;
  if (force || !hidden) {
    bar.classList.add('hidden');
    hidden = true;
  }
}

export function initSelectionBar() {
  build();
  document.addEventListener('selectionchange', () => update());
  document.addEventListener('scroll', () => update(), true);
  window.addEventListener('resize', () => update());
  document.addEventListener('mousedown', (e) => {
    if (!bar) return;
    if (!bar.contains(e.target) && !e.target.closest('.ProseMirror')) hide(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hide(true);
  });
}

export function refreshSelectionBar() {
  update();
}
