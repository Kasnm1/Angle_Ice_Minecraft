'use strict';

/**
 * paths.js —— 运行时数据路径的**唯一来源**。
 *
 * ## 为什么需要它（重构第 2 步）
 *
 * 重构前，所有 memory/ knowledge/ registry/ config.json .env 都是用
 * path.join(__dirname, ...) 拼出来的，而每份代码都住在仓库根。文件一挪进
 * src/xxx/，__dirname 就变成了 src/xxx/，这些路径**全部会指到不存在的地方** ——
 * 而且不报错：读 config.json 失败只是"用默认值"，读 memory 失败只是"记忆是空的"。
 *
 * 所以把"项目根"和"各数据目录"收进这一个文件：任何地方要用数据路径就走这里，
 * 不再自己数 .. 有几层。
 *
 * ## 规矩
 *
 * 1. 这里**只放路径常量**，不做任何 IO、不读文件内容。
 * 2. 数据目录（memory/ knowledge/ registry/ logs/ config.json .env）
 *    **留在项目根**，不跟着代码挪进 src/（见 REFACTOR-PLAN-20260928 第 2 步目录图）。
 * 3. 新增数据路径先加到这里，别在别处 path.join(__dirname, ...)。
 */

const path = require('path');

/** 项目根 = 本文件所在目录（`src/`）的上一级。 */
const ROOT = path.resolve(__dirname, '..');

module.exports = {
  ROOT,

  // ---- 数据目录（都在项目根）-------------------------------------------------
  /** 她的记忆：`mind.json` / `plan.json` / `self-review.jsonl` / `journal.md` … */
  MEMORY: path.join(ROOT, 'memory'),
  /** 整合包知识库（配方 / 任务书 / 物品名 …），数据目录本体 */
  KNOWLEDGE: path.join(ROOT, 'knowledge'),
  /** 注册表快照：方块调色板、物品表、实体表 */
  REGISTRY: path.join(ROOT, 'registry'),
  /** bridge / mind 的运行日志（`scripts/win/angel.ps1` 也会写这里） */
  LOGS: path.join(ROOT, 'logs'),

  // ---- 根目录的两个文件 ------------------------------------------------------
  /** 服务器地址 / 账号等本机配置（不入库） */
  CONFIG: path.join(ROOT, 'config.json'),
  /** LLM 线路与密钥（不入库） */
  ENV: path.join(ROOT, '.env'),
};
