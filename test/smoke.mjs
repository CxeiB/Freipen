/**
 * Freipen 真实浏览器冒烟测试（无头 Chrome/Edge + playwright-core）
 *
 * 覆盖：首次初始化 → 打开欢迎笔记 → 所见即所得实时渲染（输入 Markdown 变标题）
 *      → 自动加密保存 → 刷新后重新解锁 → 内容仍在（密文持久化往返）
 *      → 新建笔记 → 快捷键锁定 → 重新解锁。
 *
 * 用法：node server.js 运行后，执行 node test/smoke.mjs
 * 环境变量：FW_BASE（默认 http://127.0.0.1:4100）、CHROME_PATH（默认取本机 Chrome）
 */
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const BASE = process.env.FW_BASE || 'http://127.0.0.1:4100';
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean);

const executablePath = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
if (!executablePath) {
  console.error('未找到 Chrome/Edge，请设置 CHROME_PATH');
  process.exit(1);
}

const PW = 'Smoke-冒烟-主密钥-2024!';
let failed = 0;
const consoleIssues = [];
const assert = (cond, label) => {
  if (cond) console.log('  ✔ ' + label);
  else {
    failed++;
    console.error('  ✘ ' + label);
  }
};

const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

page.on('console', (m) => {
  if (m.type() === 'error') consoleIssues.push('console.error: ' + m.text());
});
page.on('pageerror', (e) => consoleIssues.push('pageerror: ' + e.message));

async function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
async function waitFor(sel, timeout = 12000) {
  await page.waitForSelector(sel, { timeout, state: 'visible' });
}
async function waitForFn(fn, label, timeout = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      if (await fn()) {
        console.log('  ✔ ' + label);
        return;
      }
    } catch {
      /* ignore */
    }
    await wait(250);
  }
  failed++;
  console.error('  ✘ ' + label);
}

console.log('\n[1] 打开应用');
await page.goto(BASE, { waitUntil: 'networkidle' });
await waitFor('#gate');
assert((await page.title()).includes('Freipen'), '页面标题正确');
assert(await page.isVisible('#gate-pw2-row'), '未初始化 → 显示“创建加密工作区”表单（含确认密钥框）');

console.log('\n[2] 初始化加密工作区');
await page.fill('#gate-pw', PW);
await page.fill('#gate-pw2', PW);
await page.click('#gate-submit');
await waitFor('#workspace');
assert(await page.isVisible('#workspace'), '进入主工作区');
await waitFor('.editor-host .ProseMirror');
await wait(700); // 等编辑器完全就绪（真实用户操作天然晚于此时刻）
assert(true, '欢迎笔记已自动打开（编辑器挂载）');
const title1 = await page.textContent('.doc-title');
assert(title1.includes('欢迎使用 Freipen'), '打开的笔记标题正确：' + title1);
const milkdownText = await page.textContent('.ProseMirror');
assert(milkdownText.includes('Freipen'), '编辑器内可见欢迎内容');

console.log('\n[3] 所见即所得实时渲染');
await page.focus('.ProseMirror');
await page.keyboard.press('Control+End');
await page.keyboard.press('Enter');
await page.keyboard.type('#');
await wait(150);
await page.keyboard.press('Space');
await wait(120);
await page.keyboard.type('Smoke Live Title', { delay: 15 });
const headingOk = await new Promise((resolve) => {
  const t0 = Date.now();
  (async function poll() {
    const n = await page.locator('.ProseMirror h1').count();
    if (n >= 2) return resolve(true);
    if (Date.now() - t0 > 8000) return resolve(false);
    setTimeout(poll, 200);
  })();
});
if (!headingOk) {
  // 极少见的自动化竞态导致输入被吞：整段重输一次
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('# Smoke Live Title', { delay: 40 });
  await waitForFn(() => page.locator('.ProseMirror h1').count().then((n) => n >= 2), '（重试）输入 "# Smoke Live Title" 后即时渲染为 <h1>（WYSIWYG 生效）', 12000);
} else {
  console.log('  ✔ 输入 "# Smoke Live Title" 后即时渲染为 <h1>（WYSIWYG 生效）');
}
await page.keyboard.press('Enter');
await page.keyboard.type('这是一段 **加粗** 与 ~~删除线~~ 测试文字。');
await waitForFn(
  () =>
    page
      .evaluate(() => {
        const el = document.querySelector('.ProseMirror');
        return el ? el.textContent.includes('加粗') && el.querySelector('del') !== null && el.textContent.includes('删除线') : false;
      }),
  '加粗/删除线 Markdown 即时渲染生效'
);
await page.keyboard.press('Control+Home');

console.log('\n[4] 自动加密保存');
await wait(2200);
const saveState = await page.textContent('#save-state');
assert(/已保存/.test(saveState || ''), '状态栏显示已保存（当前：' + (saveState || '空') + '）');

console.log('\n[5] 刷新后重新解锁 → 内容仍在（密文持久化往返）');
await page.reload({ waitUntil: 'networkidle' });
await waitFor('#gate');
assert(await page.isVisible('#gate-submit'), '刷新后回到解锁页（不再显示初始化表单）');
assert(!(await page.isVisible('#gate-pw2-row')), '已初始化 → 仅需主密钥');
await page.fill('#gate-pw', PW);
await page.click('#gate-submit');
await waitFor('#workspace');
await waitFor('.editor-host .ProseMirror');
const afterReload = await page.textContent('.ProseMirror');
assert(afterReload.includes('Smoke Live Title'), '解锁后先前输入的标题成功解密还原');
assert(afterReload.includes('加粗'), '格式化文字完整保留');

console.log('\n[6] 错误密钥应被拒绝');
await page.click('#btn-lock');
await waitFor('#gate');
await page.fill('#gate-pw', '错误的主密钥-000');
await page.click('#gate-submit');
await wait(1500);
const errVisible = await page.isVisible('#gate-error:not(.hidden)');
const errText = errVisible ? await page.textContent('#gate-error') : '';
assert(errVisible && errText.includes('不正确'), '错误密钥提示“主密钥不正确”：' + errText);
await page.fill('#gate-pw', PW);
await page.click('#gate-submit');
await waitFor('#workspace');
assert(true, '正确密钥重新解锁成功');

console.log('\n[7] 新建笔记（VS Code 式：先命名再打开）');
await page.click('#btn-new-note');
await waitFor('.tree-rename-input');
assert(true, '新建笔记后立即出现命名输入框');
await page.fill('.tree-rename-input', '未命名笔记');
await page.keyboard.press('Enter');
await waitFor('.editor-host .ProseMirror');
await wait(800);
const title2 = await page.textContent('.doc-title');
assert(title2.includes('未命名笔记'), '命名提交后自动打开新笔记：' + title2);
await page.focus('.editor-host .ProseMirror');
await page.keyboard.type('新笔记正文内容 ABC');
await wait(2000);

console.log('\n[8] 快捷键锁定（Ctrl+Shift+L）');
await page.keyboard.press('Control+Shift+L');
await waitFor('#gate');
assert(true, '快捷键锁定生效，回到门禁页');
await page.fill('#gate-pw', PW);
await page.click('#gate-submit');
await waitFor('#workspace');
const treeHasNew = await page.locator('.tree-row .tree-name', { hasText: '未命名笔记' }).count();
assert(treeHasNew >= 1, '解锁后文件树中可见新建笔记');
console.log('\n[9] 新建文件夹（VS Code 式：创建即命名）');
await page.click('#btn-new-folder');
await waitFor('.tree-rename-input');
assert(true, '新建文件夹后立即出现命名输入框');
await page.fill('.tree-rename-input', '写作素材');
await page.keyboard.press('Enter');
await wait(900);
assert((await page.locator('.tree-row .tree-name', { hasText: '写作素材' }).count()) === 1, '新建文件夹直接命名为「写作素材」');
assert((await page.locator('.tree-row .tree-name', { hasText: '未命名文件夹' }).count()) === 0, '不再出现默认名「未命名文件夹」');
await page.click('#btn-change-key');
await waitFor('.modal-overlay.show');
await page.fill('.modal-body input[type="password"] >> nth=0', 'New-主密钥-777!');
await page.fill('.modal-body input[type="password"] >> nth=1', 'New-主密钥-777!');
await page.click('.modal-actions .btn-primary');
await waitFor('.modal-actions .btn-primary', { state: 'hidden' });
await wait(500);
const changeOk = await page.locator('.toast-success').count();
assert(changeOk >= 1, '提示重新加密成功');

console.log('\n[11] 用新主密钥重新解锁');
await page.reload({ waitUntil: 'networkidle' });
await waitFor('#gate');
await page.fill('#gate-pw', 'New-主密钥-777!');
await page.click('#gate-submit');
await waitFor('#workspace');
await waitFor('.editor-host .ProseMirror');
const textNew = await page.textContent('.ProseMirror');
assert(textNew.includes('欢迎使用 Freipen'), '新密钥可解密并还原欢迎笔记');
const folderVisible = await page.locator('.tree-row .tree-name', { hasText: '写作素材' }).count();
assert(folderVisible === 1, '文件夹结构（写作素材）在新密钥下完整还原');

console.log('\n[12] 选中浮动工具栏（加粗）');
await page.evaluate(() => {
  const row = [...document.querySelectorAll('.tree-row.file')].find((r) => r.textContent.includes('欢迎使用 Freipen'));
  if (row) row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
});
await waitFor('.editor-host .ProseMirror');
await wait(500);
await page.focus('.ProseMirror');
await page.keyboard.press('Control+Home');
for (let i = 0; i < 8; i++) await page.keyboard.press('Shift+ArrowRight');
await waitForFn(() => page.isVisible('.selbar').then((v) => v), '选中文字后浮动工具栏出现');
const boldBefore = await page.locator('.ProseMirror strong').count();
await page.click('.selbar button[title="加粗"]');
await wait(400);
const boldAfter = await page.locator('.ProseMirror strong').count();
assert(boldAfter > boldBefore, '点击工具栏“加粗”后文字变粗（strong 数量 ' + boldBefore + ' → ' + boldAfter + '）');

console.log('\n[13] 编辑器右键菜单：插入表格 / 任务列表');
const tableBefore = await page.locator('.ProseMirror table').count();
const ctxAtDocEnd = `
  (() => {
    const pm = document.querySelector('.ProseMirror');
    const kids = [...pm.children];
    let el = kids[kids.length - 1] || pm;
    const r = el.getBoundingClientRect();
    const x = r.x + Math.min(r.width / 2, 700);
    let y = r.top + 8;
    y = Math.max(120, Math.min(y, window.innerHeight - 60));
    pm.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
  })();
`;
await page.keyboard.press('Control+End');
await page.keyboard.press('Enter');
await wait(250);
await page.evaluate(ctxAtDocEnd);
await waitForFn(() => page.locator('.ctx-menu').isVisible().then((v) => v), '编辑器右键菜单出现');
await page.click('.ctx-item:has-text("插入表格（3 列 × 2 行）")');
await waitForFn(() => page.locator('.ProseMirror table').count().then((n) => n > tableBefore), '右键插入表格成功（表格数量 ' + tableBefore + ' → 增加）');
await page.keyboard.press('Control+End');
await page.keyboard.press('Enter');
await wait(250);
await page.evaluate(ctxAtDocEnd);
await waitForFn(() => page.locator('.ctx-item:has-text("任务列表")').isVisible().then((v) => v), '再次弹出右键菜单');
await page.click('.ctx-item:has-text("任务列表（待办）")');
await waitForFn(
  () =>
    page
      .evaluate(() => {
        const li = document.querySelector('.ProseMirror li[data-item-type="task"]');
        const cb = document.querySelector('.ProseMirror li input[type="checkbox"]');
        return !!(li || cb);
      }),
  '右键插入任务列表（含勾选框）成功'
);

console.log('\n[14] 粘贴图片 → 自动成为该笔记的附件');
const pastePng = `
  const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const file = new File([bytes], 'pixel.png', { type: 'image/png' });
  const dt = new DataTransfer();
  dt.items.add(file);
  const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
  document.querySelector('#editor-host').dispatchEvent(ev);
`;
await page.evaluate(pastePng);
await waitForFn(() => page.locator('.ProseMirror img').count().then((n) => n >= 1), '粘贴的图片已在正文中显示');
await waitForFn(
  () =>
    page
      .evaluate(() => {
        const rows = [...document.querySelectorAll('.tree-row.file')];
        const row = rows.find((r) => r.textContent.includes('欢迎使用 Freipen'));
        if (!row) return false;
        const badge = row.querySelector('.att-badge');
        return badge && badge.textContent.includes('1');
      }),
  '笔记行出现附件计数徽标（1）'
);
await page.evaluate(() => {
  const rows = [...document.querySelectorAll('.tree-row.file')];
  const row = rows.find((r) => r.textContent.includes('欢迎使用 Freipen'));
  const chev = row && row.querySelector('.chev');
  if (chev) chev.dispatchEvent(new MouseEvent('click', { bubbles: true }));
});
await waitForFn(
  () =>
    page
      .evaluate(() => {
        const attach = [...document.querySelectorAll('.tree-row.attach')].find((r) => r.textContent.includes('pixel.png'));
        return attach && attach.textContent.includes('已引用');
      }),
  '附件列表以目录形式展开，且被正文引用的附件带“已引用”标记'
);
const statLeft = await page.textContent('#stat-left');
assert(/附件 1/.test(statLeft || ''), '状态栏显示当前文章附件数（' + (statLeft || '').slice(0, 80) + '…）');

console.log('\n[15] 拖拽移动文件到文件夹');
await page.evaluate(() => {
  const src = [...document.querySelectorAll('.tree-row.file')].find((r) => r.textContent.includes('未命名笔记'));
  const folder = [...document.querySelectorAll('.tree-row.folder')].find((r) => r.textContent.includes('写作素材'));
  const dt = new DataTransfer();
  src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
  folder.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
  folder.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
});
await wait(700);
await page.evaluate(() => {
  const folder = [...document.querySelectorAll('.tree-row.folder')].find((r) => r.textContent.includes('写作素材'));
  const chev = folder && folder.querySelector('.chev');
  if (chev && !chev.classList.contains('open')) chev.dispatchEvent(new MouseEvent('click', { bubbles: true }));
});
await waitForFn(
  () =>
    page
      .evaluate(() => {
        const folder = [...document.querySelectorAll('.tree-row.folder')].find((r) => r.textContent.includes('写作素材'));
        if (!folder) return false;
        const wrap = folder.closest('.tree-folder');
        const note = wrap && [...wrap.querySelectorAll('.tree-row .tree-name')].some((s) => s.textContent.includes('未命名笔记'));
        return !!note;
      }),
  '「未命名笔记」被拖入「写作素材」文件夹'
);

console.log('\n[16] 右键菜单复制 → 空白处粘贴');
await page.evaluate(() => {
  const row = [...document.querySelectorAll('.tree-row.file')].find((r) => r.textContent.includes('未命名笔记'));
  row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 180, clientY: 300 }));
});
await waitForFn(() => page.locator('.ctx-item:has-text("复制")').isVisible().then((v) => v), '文件右键菜单出现');
await page.click('.ctx-item:has-text("复制")');
await wait(300);
await page.evaluate(() => {
  document
    .querySelector('#tree-wrap')
    .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 130, clientY: 420 }));
});
await waitForFn(() => page.locator('.ctx-item:has-text("粘贴")').isVisible().then((v) => v), '空白处右键菜单出现（含粘贴）');
await page.click('.ctx-item:has-text("粘贴")');
await waitForFn(
  () =>
    page
      .evaluate(() => [...document.querySelectorAll('.tree-row.file .tree-name')].filter((s) => s.textContent.includes('未命名笔记')).length >= 2),
  '复制后粘贴出副本（根目录出现同名笔记）'
);

console.log('\n[17] 刷新重解锁：附件、图片、表格、结构完整还原');
await page.reload({ waitUntil: 'networkidle' });
await waitFor('#gate');
await page.fill('#gate-pw', 'New-主密钥-777!');
await page.click('#gate-submit');
await waitFor('#workspace');
await waitFor('.editor-host .ProseMirror');
await wait(600);
// 打开欢迎笔记
await page.evaluate(() => {
  const row = [...document.querySelectorAll('.tree-row.file')].find((r) => r.textContent.includes('欢迎使用 Freipen'));
  if (row) row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
});
await waitFor('.editor-host .ProseMirror');
await wait(1200);
const imgCount = await page.locator('.editor-host .ProseMirror img').count();
assert(imgCount >= 1, '解锁后附件图片重新解密并在文中显示（img=' + imgCount + '）');
const tabOk = await page
  .evaluate(() => {
    const rows = [...document.querySelectorAll('.tree-row.file')];
    const row = rows.find((r) => r.textContent.includes('欢迎使用 Freipen'));
    return row && row.querySelector('.att-badge');
  });
assert(!!tabOk, '附件徽标仍存在');
const copyOk = await page
  .evaluate(() => [...document.querySelectorAll('.tree-row.file .tree-name')].filter((s) => s.textContent.includes('未命名笔记')).length >= 2);
assert(copyOk, '复制产生的笔记副本跨会话保留（密文持久化）');

console.log('\n[18] 编辑模式切换：即时渲染 ⇄ Markdown 源码');
assert((await page.locator('.mode-btn[data-mode="source"]').count()) === 1, '顶栏存在“源码”模式按钮');
const sourceActive = () =>
  page.evaluate(() => {
    const btn = document.querySelector('.mode-btn[data-mode="source"]');
    const ta = document.getElementById('source-area');
    return !!btn && btn.classList.contains('active') && ta && !ta.hasAttribute('hidden');
  });
for (let i = 0; i < 3 && !(await sourceActive()); i++) {
  await page.click('.mode-btn[data-mode="source"]');
  await wait(800);
}
assert(await sourceActive(), '切到源码模式后显示 Markdown 源码编辑区');
await page.evaluate(() => {
  const ta = document.getElementById('source-area');
  ta.value = ta.value + '\n## Source Mode Added';
  ta.dispatchEvent(new Event('input', { bubbles: true })); // 走真实 input 数据管线
});
await wait(1600);
const typedOk = await page.evaluate(() => document.getElementById('source-area').value.includes('Source Mode Added'));
assert(typedOk, '源码输入进入编辑区');
// 真实键盘输入也应在源码模式可用
await page.evaluate(() => {
  const ta = document.getElementById('source-area');
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
});
await wait(150);
await page.keyboard.type(' KBD-OK');
await wait(400);
const kbdOk = await page.evaluate(() => document.getElementById('source-area').value.includes('KBD-OK'));
assert(kbdOk, '键盘输入可直接编辑源码（修复源码模式）');
for (let i = 0; i < 3 && !(await page.isVisible('.editor-host .ProseMirror').catch(() => false)); i++) {
  await page.click('.mode-btn[data-mode="wysiwyg"]');
  await wait(800);
}
await waitForFn(
  () => page.evaluate(() => document.querySelector('.editor-host .ProseMirror')?.textContent.includes('Source Mode Added')).then(Boolean),
  '切回即时渲染后源码改动完整呈现（双向可编辑）'
);

console.log('\n[19] 表格右键：插入 / 删除行');
const rowsBefore = await page.locator('.ProseMirror table tr').count();
await page.evaluate(() => {
  const td = document.querySelector('.ProseMirror table td');
  if (!td) return;
  const r = td.getBoundingClientRect();
  td.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 }));
});
await waitForFn(() => page.locator('.ctx-item:has-text("在下方插入行")').isVisible().then((v) => v), '表格上右键出现“表格菜单”');
await page.click('.ctx-item:has-text("在下方插入行")');
await waitForFn(
  () => page.locator('.ProseMirror table tr').count().then((n) => n > rowsBefore),
  '右键“在下方插入行”生效（行数 ' + rowsBefore + ' → 增加）'
);
await page.evaluate(() => {
  const td = document.querySelector('.ProseMirror table td');
  if (!td) return;
  const r = td.getBoundingClientRect();
  td.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 }));
});
await waitForFn(() => page.locator('.ctx-item:has-text("删除当前行")').isVisible().then((v) => v), '表格菜单再次出现');
await page.click('.ctx-item:has-text("删除当前行")');
await wait(400);
const rowsAfterDel = await page.locator('.ProseMirror table tr').count();
assert(rowsAfterDel === rowsBefore, '右键“删除当前行”生效（行数回到 ' + rowsBefore + '）');

console.log('\n[20] 附件右键：缩放预览 / 移除');
await page.evaluate(() => {
  const row = [...document.querySelectorAll('.tree-row.file')].find((r) => r.textContent.includes('欢迎使用 Freipen'));
  const chev = row && row.querySelector('.chev');
  if (chev) chev.dispatchEvent(new MouseEvent('click', { bubbles: true }));
});
await waitForFn(
  () => page.evaluate(() => !!document.querySelector('.tree-row.attach')).then(Boolean),
  '展开附件目录'
);
await page.evaluate(() => {
  const att = document.querySelector('.tree-row.attach');
  if (!att) return;
  const r = att.getBoundingClientRect();
  att.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.x + 80, clientY: r.y + r.height / 2 }));
});
await waitForFn(() => page.locator('.ctx-item:has-text("预览 / 缩放")').isVisible().then((v) => v), '附件右键出现“预览 / 缩放”');
await page.click('.ctx-item:has-text("预览 / 缩放")');
await waitForFn(() => page.locator('.zoom-stage').isVisible().then((v) => v), '图片缩放预览窗口打开（含放大/缩小控件）');
await page.click('.zoom-actions .btn:has-text("100%")');
await wait(200);
await page.click('.zoom-actions .btn:has-text("关闭")');
await wait(400);
await page.evaluate(() => {
  const att = document.querySelector('.tree-row.attach');
  if (!att) return;
  const r = att.getBoundingClientRect();
  att.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.x + 80, clientY: r.y + r.height / 2 }));
});
await waitForFn(() => page.locator('.ctx-item:has-text("从笔记移除")').isVisible().then((v) => v), '附件右键包含“移除”');
await page.click('.ctx-item:has-text("从笔记移除")');
await waitFor('.confirm-gh');
await page.click('.confirm-gh .cg-actions .btn:has-text("移除")');
await waitForFn(
  () => page.evaluate(() => !document.querySelector('.tree-row.attach')).then(Boolean),
  '移除附件后附件列表清空'
);

console.log('\n[21] 拖拽移动（HTML5 DnD）');
// 先尝试真实鼠标拖拽；无头浏览器偶发不派发 HTML5 drag 事件时，回退为合成 DnD 事件
let nativeDrag = false;
try {
  await page.hover('.tree-row.folder:has-text("写作素材")');
  const src = page.locator('.tree-row.file:not( .tree-folder *)').filter({ hasText: '未命名笔记' }).first();
  const dst = page.locator('.tree-row.folder:has-text("写作素材")').first();
  await page.dragAndDrop(src, dst, { timeout: 5000 });
  await wait(900);
  nativeDrag = true;
} catch {
  nativeDrag = false;
}
let rootCopyLeft = await page.evaluate(() =>
  [...document.querySelectorAll('.tree-row.file')].filter((r) => r.textContent.includes('未命名笔记') && !r.closest('.tree-folder')).length
);
if (rootCopyLeft > 0) {
  await page.evaluate(() => {
    const src = [...document.querySelectorAll('.tree-row.file')].find((r) => r.textContent.includes('未命名笔记') && !r.closest('.tree-folder'));
    const folder = [...document.querySelectorAll('.tree-row.folder')].find((r) => r.textContent.includes('写作素材'));
    if (!src || !folder) return;
    const dt = new DataTransfer();
    src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
    folder.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
    folder.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  });
  await wait(900);
}
const movedFinal = await page.evaluate(() => {
  const rootCopy = [...document.querySelectorAll('.tree-row.file')].filter((r) => r.textContent.includes('未命名笔记') && !r.closest('.tree-folder'));
  const inFolder = [...document.querySelectorAll('.tree-folder .tree-row.file .tree-name')].filter((s) => s.textContent.includes('未命名笔记')).length;
  return { root: rootCopy.length, folder: inFolder };
});
assert(movedFinal.root === 0 && movedFinal.folder >= 1, '拖拽移动生效：' + (nativeDrag ? '（真实鼠标）' : '（合成事件）') + JSON.stringify(movedFinal));

console.log('\n[22] 表头行右键：禁止向上插行 / 删表头（防 bug）');
await page.focus('.ProseMirror'); // 无头环境：先聚焦编辑器，确保右键事件被可靠处理
await wait(200);
const headerRect = await page.evaluate(() => {
  const th = document.querySelector('.ProseMirror table th');
  if (!th) return null;
  th.scrollIntoView({ block: 'center' });
  const r = th.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
if (headerRect) {
  await page.mouse.move(headerRect.x, headerRect.y);
  await page.mouse.click(headerRect.x, headerRect.y, { button: 'right' });
}
await waitForFn(() => page.locator('.ctx-item').count().then((n) => n > 0), '表头右键菜单出现');
const headerGuard = await page.evaluate(() => {
  const items = [...document.querySelectorAll('.ctx-item')];
  const find = (txt) => items.find((i) => i.textContent.includes(txt));
  const up = find('在上方插入行');
  const del = find('删除当前行');
  return {
    upDisabled: up ? up.classList.contains('disabled') : null,
    delDisabled: del ? del.classList.contains('disabled') : null,
  };
});
assert(headerGuard.upDisabled === true && headerGuard.delDisabled === true, '表头上方插入/删除表头行被禁用（' + JSON.stringify(headerGuard) + '）');
await page.keyboard.press('Escape');
await wait(300);

console.log('\n[23] 设置页：开启日记 + 主题切换（含亮色）');
await page.click('#btn-settings');
await waitFor('.setpg');
const nativeSelects = await page.evaluate(() => document.querySelectorAll('.setpg select').length);
assert(nativeSelects === 0, '设置页不再使用原生下拉框');
await page.click('.setpg-tab:has-text("日记")');
await waitFor('.setpg input[type="checkbox"]');
await page.check('.setpg input[type="checkbox"]');
await wait(1400); // 自动保存
await wait(800);
await page.click('.setpg .btn:has-text("关闭")');
await wait(400);

// 主题（外观）
await page.click('#btn-settings');
await waitFor('.setpg');
await page.click('.setpg-card:has-text("明亮浅色")');
await wait(300);
assert(
  (await page.evaluate(() => document.documentElement.dataset.theme)) === 'light',
  '切换到“明亮浅色”主题'
);
await page.click('.setpg-card:has-text("石墨深色")');
await wait(200);
assert(
  (await page.evaluate(() => document.documentElement.dataset.theme)) === 'dark',
  '切回“石墨深色”主题'
);
await page.click('.setpg .btn:has-text("关闭")');
await wait(400);

console.log('\n[24] 日记：左键今日 / 右键日历');
const todayStr2 = await page.evaluate(() => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
});
await page.click('#btn-daily'); // 左键 = 打开今日日记
await waitFor('.editor-host .ProseMirror');
await wait(1200);
const dailyTitle2 = (await page.textContent('.doc-title')) || '';
assert(dailyTitle2.trim() === todayStr2, '左键日历按钮直接打开/创建今日日记「' + todayStr2 + '」');
await page.click('#btn-daily', { button: 'right' }); // 右键 = 日历视图
await waitFor('.cal-grid');
const calToday2 = await page.evaluate(() => !!document.querySelector('.cal-day.today'));
assert(calToday2, '右键日历按钮打开日历视图并高亮今天');
await page.keyboard.press('Escape');
await wait(400);
const treeHasDate2 = await page.evaluate((t) => [...document.querySelectorAll('.tree-row.file .tree-name')].some((s) => s.textContent === t), todayStr2);
assert(treeHasDate2, '「日记」文件夹中已出现 ' + todayStr2);

console.log('\n[25] 侧边栏折叠 + 确认框排版');
await page.click('#btn-side-toggle');
await wait(350);
const collapsed2 = await page.evaluate(() => document.getElementById('workspace').classList.contains('side-collapsed'));
assert(collapsed2, '侧边栏折叠（rail 模式）');
assert(await page.isVisible('#side-rail'), '折叠后显示图标栏');
const brandHidden = await page.evaluate(() => getComputedStyle(document.querySelector('.side-brand')).display === 'none');
assert(brandHidden, '折叠后顶部品牌按钮整体隐藏（不再错位）');
const topOpacity2 = await page.evaluate(() => getComputedStyle(document.querySelector('.topbar')).opacity);
assert(topOpacity2 === '0', '折叠后顶栏透明（鼠标贴近边缘才显示）');
await page.click('#rail-open');
await wait(350);
assert(
  !(await page.evaluate(() => document.getElementById('workspace').classList.contains('side-collapsed'))),
  '点击图标栏按钮重新展开侧边栏'
);
await page.evaluate(() => {
  const folder = [...document.querySelectorAll('.tree-row.folder')].find((r) => r.textContent.includes('日记'));
  if (!folder) return;
  const r = folder.getBoundingClientRect();
  folder.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.x + 60, clientY: r.y + 8 }));
});
await waitForFn(() => page.locator('.ctx-item:has-text("删除")').isVisible().then((v) => v), '文件夹右键菜单出现');
await page.click('.ctx-item:has-text("删除")');
await waitFor('.confirm-gh');
const confirmLayout2 = await page.evaluate(() => {
  const root = document.querySelector('.confirm-gh .cg');
  const ok = [...document.querySelectorAll('.confirm-gh button')].find((b) => b.textContent.includes('删除'));
  return {
    hasInput: !!(root && root.querySelector('.cg-input')),
    hasCode: !!(root && root.querySelector('.cg-label code')),
    hasActions: !!document.querySelector('.confirm-gh .cg-actions'),
    okDisabled: ok ? ok.disabled : null,
  };
});
assert(
  confirmLayout2.hasInput && confirmLayout2.hasCode && confirmLayout2.hasActions && confirmLayout2.okDisabled === true,
  'GitHub 风格确认框：输入确认词 + 红色删除按钮（未输入禁用）' + JSON.stringify(confirmLayout2)
);
await page.keyboard.press('Escape');
await wait(300);
console.log('\n[26] 收集页面控制台错误');
const fatal = consoleIssues.filter((x) => !x.includes('favicon'));
if (fatal.length === 0) console.log('  ✔ 无页面错误');
else {
  failed++;
  console.error('  ✘ 页面错误：\n' + fatal.join('\n'));
}

console.log('');
await browser.close();
if (failed) {
  console.error('冒烟测试失败项：' + failed);
  process.exit(1);
}
console.log('浏览器冒烟测试全部通过 ✔\n');
process.exit(0);
