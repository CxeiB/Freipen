/**
 * 编辑器命令层：所有“对文档做点什么”的操作都收口在这里，
 * 通过 withCtx 在 Milkdown 的 ProseMirror 上下文里执行。
 * 供：选中浮动工具栏、编辑器右键菜单、附件插入等复用。
 *
 * 块变换（标题/列表/引用）走 Milkdown 官方 commander；
 * “插入新块”（表格/任务/分割线/代码块）先确保光标处于空段落，
 * 再把该空段整体替换为新块，保证任何容器下都不会产生非法文档。
 */
import { commandsCtx, schemaCtx, editorViewCtx } from '@milkdown/core';
import {
  wrapInBulletListCommand,
  wrapInHeadingCommand,
  wrapInOrderedListCommand,
  wrapInBlockquoteCommand,
} from '@milkdown/preset-commonmark';
import { insertTableCommand } from '@milkdown/preset-gfm';
import { toggleMark, setBlockType } from '@milkdown/prose/commands';
import { Selection, TextSelection, NodeSelection } from '@milkdown/prose/state';
import {
  addRowAfter,
  addRowBefore,
  addColumnAfter,
  addColumnBefore,
  deleteRow,
  deleteColumn,
  deleteTable,
  toggleHeaderRow,
  selectedRect,
} from '@milkdown/prose/tables';
import { withCtx, withCtxRaw, focusEditor } from './editor.js';

function run(apply) {
  return withCtx((ctx) => {
    const view = ctx.get(editorViewCtx);
    if (!view) return false;
    const schema = ctx.get(schemaCtx);
    return apply({ view, schema, ctx }) !== false;
  });
}

function callCmd(ctx, key, payload) {
  try {
    const manager = ctx.get(commandsCtx);
    return payload === undefined ? manager.call(key) : manager.call(key, payload);
  } catch (e) {
    console.error('[callCmd]', key, e);
    return false;
  }
}

/** 光标是否位于一个空文本块（段落）中 */
function isCaretInEmptyTextblock(state) {
  if (!state.selection.empty) return false;
  const $from = state.selection.$from;
  return $from.parent.isTextblock && $from.parent.textContent.length === 0;
}

/**
 * 光标不在空段落时，在当前文本块之后插入一个空段落并把光标移进去。
 */
function ensureEmptyParaAtCaret(view, schema) {
  const { state, dispatch } = view;
  if (isCaretInEmptyTextblock(state)) return true;
  const $from = state.selection.$from;
  if ($from.depth === 0) return false;
  const at = $from.after($from.depth);
  if (at == null) return false;
  const tr = state.tr.insert(at, schema.nodes.paragraph.create());
  const sel = Selection.near(tr.doc.resolve(Math.min(at + 1, tr.doc.content.size)));
  if (sel) tr.setSelection(sel);
  dispatch(tr.scrollIntoView());
  return true;
}

/**
 * 空段落 → 整体替换为新块，并在其后补一个段落放光标。
 * 仅当光标位于空文本块中时执行；build() 返回要插入的块节点。
 * caretAfter: 是否把光标放在新块之后的新段落里（分割线用）。
 */
function insertBlockViaEmptyPara(view, schema, build, { caretAfter = false } = {}) {
  const { state, dispatch } = view;
  if (!isCaretInEmptyTextblock(state)) return false;
  const $from = state.selection.$from;
  const d = $from.depth;
  const before = $from.before(d);
  const after = $from.after(d);
  if (before == null || after == null) return false;
  const node = build();
  if (!node) return false;
  const tr = state.tr.replaceWith(before, after, node);
  const afterNodePos = before + node.nodeSize;
  tr.insert(afterNodePos, schema.nodes.paragraph.create());
  if (caretAfter) {
    const sel = Selection.near(tr.doc.resolve(Math.min(afterNodePos + 1, tr.doc.content.size)));
    if (sel) tr.setSelection(sel);
  } else {
    const sel = Selection.findFrom(tr.doc.resolve(Math.min(before + 1, tr.doc.content.size)), 1, true);
    if (sel) tr.setSelection(sel);
  }
  dispatch(tr.scrollIntoView());
  return true;
}

/* ---------------- 行内标记 ---------------- */

export function cmdToggleBold() {
  return run(({ view, schema }) => toggleMark(schema.marks.strong)(view.state, view.dispatch));
}
export function cmdToggleItalic() {
  return run(({ view, schema }) => toggleMark(schema.marks.emphasis)(view.state, view.dispatch));
}
export function cmdToggleStrike() {
  return run(({ view, schema }) => toggleMark(schema.marks.strike_through)(view.state, view.dispatch));
}
export function cmdToggleCode() {
  return run(({ view, schema }) => toggleMark(schema.marks.inlineCode)(view.state, view.dispatch));
}
export function cmdToggleLink(href, title) {
  const url = href && href.trim();
  return run(({ view, schema }) => {
    const { state, dispatch } = view;
    const markType = schema.marks.link;
    if (!url) return toggleMark(markType)(state, dispatch);
    if (!state.selection.empty) {
      // 有选中文字：Obsidian 风格，把选中文字做成超链接
      return toggleMark(markType, { href: url, title: title || null })(state, dispatch);
    }
    // 空光标：插入真正的链接节点（文本即用户输入的 URL）。
    // 注意不能用 replaceSelectionWith —— 它会用光标处激活的 marks 重新标记文本，
    // 空段/普通文字处会把 link mark 剥掉，结果变成被转义成 https\://… 的纯文本。
    // 用 insert 保留文本节点自带的 link mark；Milkdown 序列化时因文本==href，
    // 会输出 <url> 自动链接（不转义），保存/回读/外部渲染都能识别为链接。
    const text = schema.text(url, [markType.create({ href: url, title: title || null })]);
    const $pos = state.selection.$from;
    const tr = state.tr.insert($pos.pos, text);
    const after = Math.min($pos.pos + text.nodeSize, tr.doc.content.size);
    const sel = TextSelection.near(tr.doc.resolve(after));
    if (sel) tr.setSelection(sel);
    dispatch(tr.scrollIntoView());
    return true;
  });
}

/* ---------------- 块级（官方 commander：安全变换现有块） ---------------- */

export function cmdSetHeading(level) {
  return run(({ ctx }) => callCmd(ctx, wrapInHeadingCommand.key, level));
}
export function cmdSetParagraph() {
  return cmdSetHeading(0);
}
export function cmdBulletList() {
  return run(({ ctx }) => callCmd(ctx, wrapInBulletListCommand.key));
}
export function cmdOrderedList() {
  return run(({ ctx }) => callCmd(ctx, wrapInOrderedListCommand.key));
}
export function cmdQuote() {
  return run(({ ctx }) => callCmd(ctx, wrapInBlockquoteCommand.key));
}

/* ---------------- 插入新块（表格/任务列表/代码块/分割线） ---------------- */

export function cmdCodeBlock() {
  return run(({ view, schema }) => {
    if (!ensureEmptyParaAtCaret(view, schema)) return false;
    return setBlockType(schema.nodes.code_block)(view.state, view.dispatch);
  });
}

export function cmdTable(rows = 2, cols = 3) {
  // 官方命令路径：对空段落直接替换（与 Milkdown 官方实现一致）
  if (run(({ ctx }) => callCmd(ctx, insertTableCommand.key, { row: rows, col: cols }))) return true;
  // 退回手动构建
  return run(({ view, schema }) =>
    insertBlockViaEmptyPara(view, schema, () => {
      try {
        const mk = (t) => t.createAndFill();
        const headerCells = Array.from({ length: cols }, () => mk(schema.nodes.table_header));
        const bodyCells = Array.from({ length: cols }, () => mk(schema.nodes.table_cell));
        const headerRow = schema.nodes.table_header_row.create(null, headerCells);
        const bodyRows = Array.from({ length: Math.max(rows - 1, 1) }, () =>
          schema.nodes.table_row.create(
            null,
            Array.from({ length: cols }, () => mk(schema.nodes.table_cell))
          )
        );
        const table = schema.nodes.table.create(null, [headerRow, ...bodyRows]);
        if (!table) console.error('[cmdTable] 手动构建表格失败');
        return table;
      } catch (e) {
        console.error('[cmdTable] 构建异常', e);
        return null;
      }
    })
  );
}

export function cmdTaskList() {
  return run(({ view, schema }) => {
    if (!ensureEmptyParaAtCaret(view, schema)) return false;
    return insertBlockViaEmptyPara(view, schema, () => {
      const liType = schema.nodes.list_item;
      const hasTask = liType.attrs && liType.attrs.checked;
      const liAttrs = hasTask ? { checked: false, label: '•', listType: 'bullet', spread: true } : {};
      const para = schema.nodes.paragraph.create();
      const li = liType.createAndFill(liAttrs, para) || liType.create(liAttrs);
      return schema.nodes.bullet_list.create(null, li);
    });
  });
}

/** 点击任务复选框：切换所在任务项的 checked */
export function toggleTaskAtPoint(clientX, clientY) {
  return run(({ view }) => {
    const hit = view.posAtCoords({ left: clientX, top: clientY });
    if (!hit) return false;
    const $p = view.state.doc.resolve(hit.pos);
    for (let d = $p.depth; d >= 0; d--) {
      const node = $p.node(d);
      if (node && node.type.name === 'list_item' && node.attrs && node.attrs.checked != null) {
        const pos = $p.before(d);
        if (pos == null) return false;
        view.dispatch(
          view.state.tr.setNodeMarkup(pos, null, { ...node.attrs, checked: !node.attrs.checked })
        );
        return true;
      }
    }
    return false;
  });
}

export function cmdHr() {
  return run(({ view, schema }) =>
    insertBlockViaEmptyPara(
      view,
      schema,
      () => schema.nodes.hr.create(),
      { caretAfter: true }
    )
  );
}

/* ---------------- 图片 / 文本插入 ---------------- */

export function cmdInsertImage(src, alt = '') {
  return run(({ view, schema }) => {
    const { state, dispatch } = view;
    const img = schema.nodes.image.create({ src, alt: alt || '' });
    const tr = state.tr.replaceSelectionWith(img);
    dispatch(tr.scrollIntoView());
    return true;
  });
}

export function cmdInsertText(text) {
  return run(({ view }) => {
    const { state, dispatch } = view;
    dispatch(state.tr.insertText(text));
    return true;
  });
}

export function cmdInsertLinkMarkdown(name, id) {
  return cmdInsertText('[' + name + '](attachment://' + id + ') ');
}

/** 编辑器里当前是否有可见的非空选择（供浮动工具栏） */
export function editorSelectionInfo() {
  return withCtx((ctx) => {
    const view = ctx.get(editorViewCtx);
    if (!view || view.state.selection.empty) return null;
    return { from: view.state.selection.from, to: view.state.selection.to };
  });
}

/* ================================================================ */
/* 情境操作：命中测试、表格增删行列、图片节点删除                   */
/* ================================================================ */

/** 把光标移动到屏幕坐标 (clientX, clientY) 对应的文档位置（右键菜单定位用） */
export function caretAtScreenPoint(x, y) {
  return run(({ view }) => {
    const hit = view.posAtCoords({ left: x, top: y });
    if (!hit) return false;
    const $p = view.state.doc.resolve(hit.pos);
    const tr = view.state.tr.setSelection(TextSelection.near($p));
    view.dispatch(tr);
    view.focus();
    return true;
  });
}

/** 编辑器当前是否存在非空选区（供右键菜单判断是否移动光标） */
export function hasTextSelection() {
  return withCtxRaw((ctx) => {
    const view = ctx.get(editorViewCtx);
    if (!view) return false;
    return !view.state.selection.empty;
  }) === true;
}

/** 删除坐标处的图片节点（在文档中移除，不删除附件文件） */
export function deleteImageAtScreenPoint(x, y) {
  return run(({ view }) => {
    const hit = view.posAtCoords({ left: x, top: y });
    if (!hit) return false;
    let at = -1;
    for (let i = hit.pos - 4; i <= hit.pos + 4; i++) {
      const n = view.state.doc.nodeAt(i);
      if (n && n.type.name === 'image') {
        at = i;
        break;
      }
    }
    if (at < 0) return false;
    const tr = view.state.tr;
    const sel = NodeSelection.create(view.state.doc, at);
    tr.setSelection(sel);
    tr.deleteSelection();
    view.dispatch(tr.scrollIntoView());
    view.focus();
    return true;
  });
}

export const cmdTableRowAbove = () =>
  run(({ view }) => {
    try {
      const rect = selectedRect(view.state);
      if (rect && rect.top === 0) return false; // 表头行上方无法插行（防止重复表头）
    } catch {
      /* ignore */
    }
    return addRowBefore(view.state, view.dispatch);
  });
export const cmdTableRowBelow = () => run(({ view }) => addRowAfter(view.state, view.dispatch));
export const cmdTableColLeft = () => run(({ view }) => addColumnBefore(view.state, view.dispatch));
export const cmdTableColRight = () => run(({ view }) => addColumnAfter(view.state, view.dispatch));
export const cmdTableDeleteRow = () =>
  run(({ view }) => {
    try {
      const rect = selectedRect(view.state);
      if (rect && rect.top === 0) return false; // 不要直接删除表头行（表结构要求首个表头行）
    } catch {
      /* ignore */
    }
    return deleteRow(view.state, view.dispatch);
  });
export const cmdTableDeleteCol = () => run(({ view }) => deleteColumn(view.state, view.dispatch));
export const cmdTableDeleteTable = () => run(({ view }) => deleteTable(view.state, view.dispatch));
export const cmdTableToggleHeaderRow = () => run(({ view }) => toggleHeaderRow(view.state, view.dispatch));

/** 光标所在表格信息：{ top, bottom, rows, cols } 或 null（不在表格中/出错） */
export function tableCaretInfo() {
  return withCtxRaw((ctx) => {
    const view = ctx.get(editorViewCtx);
    if (!view) return null;
    try {
      const rect = selectedRect(view.state);
      if (!rect) return null;
      return { top: rect.top, bottom: rect.bottom, rows: rect.height, cols: rect.width };
    } catch {
      return null;
    }
  });
}

/** 设置光标所在代码块的语言（null = 清除）；不在代码块中返回 false */
export function setCodeBlockLanguageAtCursor(lang) {
  return run(({ view }) => {
    const { state, dispatch } = view;
    const $from = state.selection.$from;
    for (let d = $from.depth; d >= 0; d--) {
      const node = $from.node(d);
      if (node && node.type.name === 'code_block') {
        const pos = $from.before(d);
        if (pos == null) return false;
        dispatch(state.tr.setNodeMarkup(pos, null, { language: lang || null }));
        return true;
      }
    }
    return false;
  });
}

/** Ctrl+Enter：切换光标所在行的任务状态（无任务则转为未勾选任务） */
export function toggleTaskLine() {
  return run(({ view }) => {
    const { state, dispatch } = view;
    const $from = state.selection.$from;
    for (let d = $from.depth; d >= 0; d--) {
      const node = $from.node(d);
      if (node && node.type.name === 'list_item' && node.attrs) {
        const pos = $from.before(d);
        if (pos == null) return false;
        const isTask = node.attrs.checked != null;
        const next = isTask
          ? { ...node.attrs, checked: !node.attrs.checked }
          : { ...node.attrs, checked: false, label: node.attrs.label != null ? node.attrs.label : '•', listType: node.attrs.listType != null ? node.attrs.listType : 'bullet' };
        dispatch(state.tr.setNodeMarkup(pos, null, next));
        return true;
      }
    }
    return false;
  });
}

/** 返回当前选区（或光标处）的标记激活状态，供悬浮栏高亮 */
export function markActiveStates() {
  return withCtxRaw((ctx) => {
    const view = ctx.get(editorViewCtx);
    if (!view) return null;
    const { state } = view;
    const { from, to } = state.selection;
    const has = (t) => (t ? state.doc.rangeHasMark(from, to, t) : false);
    const s = state.schema.marks;
    return {
      bold: has(s.strong),
      italic: has(s.emphasis),
      strike: has(s.strike_through),
      code: has(s.inlineCode),
    };
  });
}
