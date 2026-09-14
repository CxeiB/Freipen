/**
 * Milkdown 所见即所得编辑器封装（ProseMirror 内核）。
 * 输入 Markdown 语法即时渲染；文档变化时通过 onChange 回调返回 Markdown 文本。
 */
import { Editor, rootCtx, defaultValueCtx, editorViewCtx, schemaCtx, nodeViewCtx, prosePluginsCtx } from '@milkdown/core';
import { commonmark } from '@milkdown/preset-commonmark';
import { gfm } from '@milkdown/preset-gfm';
import { prism } from '@milkdown/plugin-prism';
import { math } from '@milkdown/plugin-math';
import { history } from '@milkdown/plugin-history';
import { clipboard } from '@milkdown/plugin-clipboard';
import { listener, listenerCtx } from '@milkdown/plugin-listener';
import { Plugin, TextSelection } from '@milkdown/prose/state';
import { selectedRect, addRowAfter, goToNextCell, TableMap } from '@milkdown/prose/tables';
import 'katex/dist/katex.min.css';

/** 表格按键行为（Obsidian 风格） */
function tableKeysPlugin() {
  const rectOf = (state) => {
    try { return selectedRect(state); } catch { return null; }
  };
  const tableInfoOf = (view) => {
    const $s = view.state.selection.$from;
    for (let d = $s.depth; d >= 0; d--) {
      const n = $s.node(d);
      if (n && n.type.name === 'table') {
        const map = TableMap.get(n);
        return { node: n, start: $s.before(d), map };
      }
    }
    return null;
  };
  const moveCursorInTable = (view, rowIndex, colIndex) => {
    const t = tableInfoOf(view);
    if (!t) return false;
    const { state, dispatch } = view;
    const idx = Math.max(0, Math.min(rowIndex, t.map.height - 1)) * t.map.width + Math.max(0, Math.min(colIndex, t.map.width - 1));
    const pos = t.start + t.map.map[idx] + 1;
    const $pos = state.doc.resolve(Math.max(1, Math.min(pos, state.doc.content.size - 1)));
    dispatch(state.tr.setSelection(TextSelection.near($pos)));
    return true;
  };
  const moveToPrevCell = (view) => {
    const r = rectOf(view.state);
    const t = tableInfoOf(view);
    if (!r || !t) return false;
    if (r.left > 0) return moveCursorInTable(view, r.top, r.left - 1);
    if (r.top > 0) return moveCursorInTable(view, r.top - 1, t.map.width - 1);
    return false;
  };
  return new Plugin({
    props: {
      handleKeyDown(view, event) {
        const r = rectOf(view.state);
        const t = tableInfoOf(view);
        if (!r || !t) return false;
        const lastRow = r.top >= t.map.height - 1;
        const lastCol = r.left >= t.map.width - 1;
        if (event.key === 'Tab') {
          event.preventDefault();
          if (event.shiftKey) {
            moveToPrevCell(view);
            return true;
          }
          if (lastRow && lastCol) {
            if (addRowAfter(view.state, view.dispatch)) moveCursorInTable(view, r.top + 1, 0);
            return true;
          }
          return goToNextCell(view.state, view.dispatch) || true;
        }
        if (event.key === 'Enter') {
          if (event.shiftKey) {
            event.preventDefault();
            const tr = view.state.tr.replaceSelectionWith(view.state.schema.nodes.hardbreak.create());
            view.dispatch(tr.scrollIntoView());
            return true;
          }
          if (lastRow) {
            event.preventDefault();
            if (addRowAfter(view.state, view.dispatch)) moveCursorInTable(view, r.top + 1, r.left);
            return true;
          }
          return false;
        }
        return false;
      },
    },
  });
}
/** 代码块 NodeView：顶部“语言 + 复制”条 */
function codeBlockView(node, view, getPos) {
  const wrap = document.createElement('div');
  wrap.className = 'fw-code';
  const bar = document.createElement('div');
  bar.className = 'fw-code-bar';
  const langEl = document.createElement('span');
  langEl.className = 'fw-code-lang';
  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = 'fw-code-copy';
  copyBtn.textContent = '复制';
  bar.appendChild(copyBtn); // 复制在左
  bar.appendChild(langEl); // 语言在右
  const pre = document.createElement('pre');
  const code = document.createElement('code');
  pre.appendChild(code);
  wrap.appendChild(bar);
  wrap.appendChild(pre);

  const renderLang = () => {
    const l = (node.attrs && node.attrs.language) || '';
    langEl.textContent = l || 'plaintext';
    wrap.dataset.lang = l;
  };

  copyBtn.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const text = (code.textContent || '').replace(/\n$/, '');
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      copyBtn.textContent = '✓ 已复制';
    } catch {
      copyBtn.textContent = '复制失败';
    }
    setTimeout(() => {
      copyBtn.textContent = '复制';
    }, 1400);
  });

  const viewObj = {
    dom: wrap,
    contentDOM: code,
    update(next) {
      if (next.type !== node.type) return false;
      node = next;
      renderLang();
      return true;
    },
    ignoreMutation(mutation) {
      return mutation.type === 'attributes' && (mutation.target === wrap || mutation.target === bar);
    },
  };
  renderLang();
  return viewObj;
}

let currentEditor = null;

/** 在 host 元素上挂载新编辑器（自动卸载旧编辑器） */
export async function mountEditor(host, markdown, handlers = {}) {
  await unmountEditor();
  host.innerHTML = '';
  const editor = await Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, host);
      ctx.set(defaultValueCtx, markdown);
      ctx.update(nodeViewCtx, (prev) => [...prev, ['code_block', codeBlockView]]);
      ctx.update(prosePluginsCtx, (prev) => [...prev, tableKeysPlugin()]);
      const lm = ctx.get(listenerCtx);
      if (handlers.onChange) {
        lm.markdownUpdated((_ctx, md) => {
          try {
            handlers.onChange(md);
          } catch (e) {
            console.error('[editor.onChange]', e);
          }
        });
      }
      if (handlers.onBlur) lm.blur(() => handlers.onBlur());
    })
    .use(commonmark)
    .use(gfm)
    .use(prism)
    .use(math)
    .use(history)
    .use(clipboard)
    .use(listener)
    .create();
  currentEditor = editor;
  return editor;
}

/** 卸载当前编辑器并清理 DOM */
export async function unmountEditor() {
  if (currentEditor) {
    const e = currentEditor;
    currentEditor = null;
    try {
      await e.destroy();
    } catch {
      /* ignore */
    }
  }
}

export function isMounted() {
  return currentEditor !== null;
}

export function focusEditor() {
  if (!currentEditor) return;
  try {
    currentEditor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      if (view) view.focus();
    });
  } catch {
    /* ignore */
  }
}

/** 当前文档字数（粗略，含中文按字计） */
export function currentTextLength() {
  if (!currentEditor) return 0;
  try {
    return currentEditor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      if (!view) return 0;
      return view.state.doc.textContent.length;
    });
  } catch {
    return 0;
  }
}

/** 在编辑器上下文里执行 fn(ctx)；未挂载/出错返回 false */
export function withCtx(fn) {
  if (!currentEditor) return false;
  try {
    const ret = currentEditor.action((ctx) => fn(ctx));
    return ret !== false;
  } catch (e) {
    console.error('[withCtx]', e);
    return false;
  }
}

/** 同 withCtx，但原样返回 action 结果（供需要取值的只读查询用） */
export function withCtxRaw(fn) {
  if (!currentEditor) return null;
  try {
    return currentEditor.action((ctx) => fn(ctx));
  } catch (e) {
    console.error('[withCtxRaw]', e);
    return null;
  }
}

/** 是否处于“打开笔记”的可编辑状态（供浮动栏/菜单判断） */
export function isEditable() {
  return currentEditor !== null;
}

export function editorRootEl() {
  if (!currentEditor) return null;
  try {
    return currentEditor.action((ctx) => ctx.get(editorViewCtx)?.dom?.parentElement ?? null) ?? null;
  } catch {
    return null;
  }
}
