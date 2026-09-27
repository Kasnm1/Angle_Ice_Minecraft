'use strict';

// mineflayer-pathfinder 2.4.x 的 useOne 分支在开门后取出下一个待放置项，
// 却没有在队列为空时清掉 placing。下一帧把 undefined 当放置项读 .y，进程崩溃。
// 上游参考：node_modules/mineflayer-pathfinder/index.js 的 monitorMovement。
const fs = require('fs');

const oldCode = `          lockUseBlock.release()
          placingBlock = nextPoint.toPlace.shift()
        }, err => {`;
const firstFix = `          lockUseBlock.release()
          placingBlock = nextPoint.toPlace.shift()
          if (!placingBlock) {
            placing = false
            lastNodeTime = performance.now()
          }
        }, err => {`;
const newCode = `          lockUseBlock.release()
          placingBlock = nextPoint.toPlace.shift()
          if (!placingBlock) {
            placing = false
            lastNodeTime = performance.now()
            resetPath('door_opened') // 门状态变了：从当前脚下重新寻路
          }
        }, err => {`;

function ensure () {
  const file = require.resolve('mineflayer-pathfinder');
  const source = fs.readFileSync(file, 'utf8');
  if (source.includes(newCode)) return { patched: true, changed: false };
  const match = source.includes(firstFix) ? firstFix : source.includes(oldCode) ? oldCode : null;
  if (!match) throw new Error('mineflayer-pathfinder 开门代码已变，需重新核对兼容补丁');
  fs.writeFileSync(file, source.replace(match, newCode));
  return { patched: true, changed: true };
}

module.exports = { ensure };

if (require.main === module) console.log(ensure());
