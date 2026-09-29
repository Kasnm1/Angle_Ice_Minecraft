'use strict';

/**
 * 注册表往返自检 —— 名字这一层在模组服上不完全可信（见 `AGENTS.md` 的铁律），
 * `probeRegistry()` 拿几个一定存在的原版名字做一次"名字 → id → 名字"往返，
 * 结果由 `summarizeProbe()` 摘要后挂到 `GET /config` 的 `pathing` 上。
 *
 * 2026-09-29 第 3 步重构从 `src/world/pathing.js` 原样搬出（函数体一字未改）。
 */

// ------------------------------------------------------------------ 自检

/**
 * 注册表往返自检：`名字 → id → 名字` 能不能对上。
 *
 * 为什么需要：第②层（按名字保护）依赖注册表可信。模组服上名字可能整体偏移，
 * 那时"保护清单"里装的是错的 ID，她会拒绝拆泥土、却照样拆羊毛。
 * 这个自检把"名字到底可不可信"变成可观测的事实，而不是一个假设。
 */
function probeRegistry (registry, names = ['white_wool', 'oak_planks', 'oak_log', 'glass', 'stone', 'dirt']) {
  const out = [];
  if (!registry || !registry.blocksByName || !registry.blocks) return out;
  for (const name of names) {
    const def = registry.blocksByName[name];
    if (!def || typeof def.id !== 'number') { out.push({ name, ok: false, reason: 'not-in-registry' }); continue; }
    const back = registry.blocks[def.id];
    const backName = back && back.name;
    out.push({ name, id: def.id, back: backName ?? null, ok: backName === name });
  }
  return out;
}

function summarizeProbe (probe) {
  if (!probe.length) return { checked: 0, ok: 0, mismatched: [] };
  const bad = probe.filter(p => !p.ok);
  return { checked: probe.length, ok: probe.length - bad.length, mismatched: bad.map(p => `${p.name}→${p.back ?? p.reason}`) };
}

module.exports = {
  probeRegistry,
  summarizeProbe,
};
