/**
 * API 客户端 —— 与后端之间只传密文字符串（Base64）。
 * 后端只理解：工作区注册表（id/name）、每个工作区的 KDF 参数、加密索引、加密笔记。
 *
 * 多工作区：所有请求都落在“当前工作区”上。进入/新建工作区后调用 api.useWorkspace(id)
 * 设定上下文；之后的 getVault / saveVault / getNote / saveNote … 自动作用于该工作区。
 */

export class ApiError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

let currentWs = null; // 当前工作区 id（null = 未选择）

/** 设定后续请求作用的工作区 */
export function useWorkspace(id) {
  currentWs = id || null;
}

async function request(method, path, body, headers = {}) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError('network', '无法连接服务，请确认服务已启动');
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* ignore */
  }
  if (!res.ok || !data || data.ok !== true) {
    const code = (data && data.error) || `http-${res.status}`;
    throw new ApiError(code, messageFor(code));
  }
  return data;
}

function messageFor(code) {
  switch (code) {
    case 'network':
      return '无法连接服务，请确认服务已启动';
    case 'note-not-found':
      return 'note-not-found';
    case 'ws-not-found':
      return '工作区不存在（可能已被删除）';
    case 'vault-not-found':
      return '工作区尚未初始化';
    case 'vault-exists':
      return '工作区已存在';
    case 'bad-name':
      return '工作区名称无效';
    case 'payload-too-large':
      return '内容过大，超出服务端限制';
    default:
      return '请求失败（' + code + '）';
  }
}

function wsUrl(suffix) {
  return '/api/workspaces/' + encodeURIComponent(currentWs) + (suffix || '');
}

export const api = {
  /** 列出所有工作区（元信息，不含密文） */
  listWorkspaces: () => request('GET', '/api/workspaces'),
  /** 新建工作区（仅注册），返回 {ok,id,name} */
  createWorkspace: (name) => request('POST', '/api/workspaces', { name }),
  /** 重命名工作区 */
  renameWorkspace: (id, name) => request('PATCH', '/api/workspaces/' + encodeURIComponent(id), { name }),
  /** 删除工作区及其全部密文文件 */
  deleteWorkspace: (id) => request('DELETE', '/api/workspaces/' + encodeURIComponent(id)),

  /** 读取当前工作区状态：{ok, initialized, kdf?, index?} */
  getVault: () => request('GET', wsUrl('/vault')),
  /** 保存加密后的目录树索引（首次初始化或更新；可选附随新 KDF 用于更改主密钥） */
  saveVault: (index, kdf) => request('PUT', wsUrl('/vault'), { index, kdf }),
  /** 读取某篇笔记（或附件密文） */
  getNote: (id) => request('GET', wsUrl('/notes/' + encodeURIComponent(id))),
  /** 保存某篇笔记（或附件密文） */
  saveNote: (id, data) => request('PUT', wsUrl('/notes/' + encodeURIComponent(id)), { data }),
  /** 删除某篇笔记（或附件密文） */
  deleteNote: (id) => request('DELETE', wsUrl('/notes/' + encodeURIComponent(id))),
};
