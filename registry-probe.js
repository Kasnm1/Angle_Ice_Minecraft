/**
 * 诊断：服务端到底有没有把「方块注册表」发给我们？
 *
 * 背景（这是本包最根本的一条认知限制）：
 *   1.13 之后，方块名**不在**网络流里。服务端在 `chunk_data` 里只发**全局调色板数字 ID**，
 *   名字靠**客户端本地的注册表**翻译。原版客户端装了模组，所以它认识
 *   `upgrade_aquatic:glass_trapdoor`；我们只有原版 `minecraft-data`，
 *   于是任何模组方块查出来都是空名字 + `boundingBox='empty'`（当空气）。
 *
 *   这就是"她能看见方块却认不出它"的根，而不是任何一层的代码 bug。
 *
 * 那还有没有办法拿到？1.19+ 的 `declare_commands` 包**理论上带一个 registries 段**
 * （`minecraft:block` → name/id）。本模块就是去确认这件事：
 *   1. 这个包来没来、多少字节；
 *   2. `tags` 包来没来（tag → 一堆 id，可以用来判"是不是活板门/门/可攀爬"）；
 *   3. 我们能不能从 `declare_commands` 的原始字节里挖出方块名。
 *
 * 做法：把 `packet_declare_commands` 的解析改成 `restBuffer`（原样收字节）。
 *   这样 protodef 不会在"模组自定义命令参数类型"上崩掉（现在的
 *   `PartialReadError: Unexpected buffer end while reading VarInt` 就是它），
 *   我们拿到原始 Buffer 自己看。**顺带这也是那个报错的根治办法。**
 */
const mcData = require('minecraft-data');

/**
 * 把 `declare_commands` 的解析换成"原样收字节"。
 * ⚠️ 必须在 `createClient` **之前**调用 —— minecraft-protocol 在建客户端时就把
 * 协议编成 serializer 了，晚了不生效。
 */
/**
 * 标记"已经 patch 过"。
 * ⚠️ 绝不能把这个标记塞进 `types` 里（我第一版就是 `types.__declareCommandsAsRaw = true`）——
 *    protodef 会**遍历 `types` 的每一个键当类型定义去编译**，遇到 `true` 就
 *    `compileType` 返回 undefined，然后在 `functions[type].startsWith` 上崩掉：
 *      TypeError: Cannot read properties of undefined (reading 'startsWith')
 *    现象是：握手全对、注册表全收到、**切到 PLAY 状态那一刻整个进程死掉**，
 *    而且堆栈在 protodef 内部，看起来完全不像自己写的 bug。标记必须放在 types 外面。
 */
let __patched = false;

function patchProtocol (version, log = () => {}) {
  const d = mcData(version);
  const types = d.protocol?.play?.toClient?.types;
  if (!types || !types.packet_declare_commands) {
    log(`[probe] 协议里找不到 packet_declare_commands（version=${version}）`);
    return false;
  }
  if (__patched) return true;
  types.packet_declare_commands = ['container', [{ name: 'raw', type: 'restBuffer' }]];
  __patched = true;
  log('[probe] 已把 packet_declare_commands 改为 restBuffer（原样收字节）');
  return true;
}

/** 极简 VarInt 读取器：自己解析原始字节时用，不依赖 protodef。 */
function readVarInt (buf, off) {
  let value = 0; let size = 0; let b;
  do {
    if (off + size >= buf.length) return null;
    b = buf[off + size];
    value |= (b & 0x7f) << (7 * size);
    size++;
  } while ((b & 0x80) !== 0 && size < 5);
  return { value, size };
}

/** 读一个 MC 风格的字符串（VarInt 长度 + UTF-8）。 */
function readString (buf, off) {
  const len = readVarInt(buf, off);
  if (!len) return null;
  const start = off + len.size;
  if (start + len.value > buf.length) return null;
  return { value: buf.toString('utf8', start, start + len.value), size: len.size + len.value };
}

/**
 * 从原始 `declare_commands` 字节里**尽力**找出 registries 段。
 *
 * 诚实说明：这是一次**探测**，不是正经解析。nodes 段里每个命令节点的
 * properties 布局取决于参数类型，模组参数类型我们无从得知，所以无法可靠地
 * 跳过整个 nodes 段。这里用两个务实的办法：
 *   ① 直接扫字节，找形如 `minecraft:block` 的字符串，然后试着从它后面读条目；
 *   ② 报告找到的注册表名，供人工判断这条路通不通。
 *
 * 返回 `{registries: [...], blockEntries: [...], note}`。
 */
function scanRegistries (buf) {
  const out = { registries: [], blockEntries: [], note: null };
  const needle = Buffer.from('minecraft:', 'utf8');
  let i = 0;
  const seen = new Set();
  while (i < buf.length) {
    const at = buf.indexOf(needle, i);
    if (at === -1) break;
    // 往前找 VarInt 长度：一个合理的注册表名长度是 1..64
    for (let back = 1; back <= 2 && at - back >= 0; back++) {
      const len = buf[at - back];
      if (len >= 8 && len <= 64 && at - back + 1 + len <= buf.length) {
        const name = buf.toString('utf8', at - back + 1, at - back + 1 + len);
        if (/^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(name) && !seen.has(name)) {
          seen.add(name);
          out.registries.push({ at: at - back, name });
        }
      }
    }
    i = at + needle.length;
  }
  out.note = out.registries.length
    ? `扫到 ${out.registries.length} 个形如 name:path 的字符串（可能是注册表名，也可能是普通字符串）`
    : '没扫到任何 name:path 形态的字符串 —— registries 段很可能不在这个包里';
  return out;
}

/** 给一个 minecraft-protocol 客户端挂上探针。 */
function attach (client, opts = {}) {
  const log = opts.log || (() => {});
  const maxBytes = opts.maxBytes ?? 4096;
  const stats = {
    packets: 0,
    byName: {},
    declareCommands: null,
    tags: null,
    notes: [],
  };

  client.on('packet', (data, meta) => {
    stats.packets++;
    const n = (meta && meta.name) || '?';
    stats.byName[n] = (stats.byName[n] || 0) + 1;
  });

  client.on('declare_commands', (data) => {
    if (!data || !Buffer.isBuffer(data.raw)) {
      stats.notes.push('declare_commands 到了，但没拿到原始 Buffer');
      return;
    }
    const buf = data.raw;
    const scan = scanRegistries(buf);
    stats.declareCommands = {
      bytes: buf.length,
      headHex: buf.slice(0, Math.min(32, buf.length)).toString('hex'),
      registries: scan.registries.map(r => r.name),
      note: scan.note,
    };
    log(`[probe] declare_commands 收到 ${buf.length} 字节；${scan.note}`);
    if (scan.registries.length) {
      log(`[probe]   候选注册表名：${scan.registries.map(r => r.name).slice(0, 20).join(', ')}`);
    }
    // 把前 maxBytes 存盘，供离线细看（避免往日志里灌二进制）
    try {
      const fs = require('fs');
      const p = require('path').join(__dirname, '..', 'memory', 'declare_commands.bin');
      fs.mkdirSync(require('path').dirname(p), { recursive: true });
      fs.writeFileSync(p, buf.slice(0, maxBytes));
      log(`[probe]   前 ${Math.min(maxBytes, buf.length)} 字节已存到 ${p}`);
    } catch (_) {}
  });

  client.on('tags', (data) => {
    const regs = data?.tags || [];
    const summary = regs.map(r => {
      const entries = (r.tags || []).reduce((a, t) => a + (t.entries ? t.entries.length : 0), 0);
      return { registry: r.registry, tagCount: (r.tags || []).length, entryCount: entries };
    });
    stats.tags = summary;
    const blockReg = summary.find(s => s.registry === 'minecraft:block');
    log(`[probe] tags 包到了：${summary.length} 个注册表`
      + (blockReg ? `，其中 minecraft:block 有 ${blockReg.tagCount} 个 tag / ${blockReg.entryCount} 条条目` : '，但没有 minecraft:block'));
  });

  return stats;
}

module.exports = { patchProtocol, attach, scanRegistries, readVarInt, readString };
