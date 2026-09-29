#!/usr/bin/env python3
# check-toplevel.py —— 拆文件时有没有丢掉"夹在函数之间的顶层语句"（2026-09-29 补的工具）。
#
# 第 3 步拆 hands / bridge 时，拆分工具只搬函数：常量（SEEN_FILE…）、解构 require（isStandable…）、
# `state.chatlog = chatlog`、`require('../log-stamp')` 全丢了 —— 有的上线即崩，有的在 try 里静默失效。
# 这里把拆前文件第 0 列开头、不是 function/注释/括号收尾的语句逐行拿出来，在拆后目录任一文件里找同一行。
# 找不到的列出来（行尾加了注释的会误报，看一眼即可）。
#
# 用法：python3 scripts/refactor/check-toplevel.py <拆前 git ref> <拆前文件> <拆后目录>
import subprocess,sys,os,re
ref,old,d=sys.argv[1:4]
src=subprocess.run(['git','show',f'{ref}:{old}'],capture_output=True,text=True).stdout.split('\n')
new=set()
for root,_,fs in os.walk(d):
    for f in fs:
        if f.endswith('.js'):
            for l in open(os.path.join(root,f)): new.add(l.strip())
depth=0; miss=[]
for i,l in enumerate(src,1):
    if depth==0 and l and not l[0].isspace() and not re.match(r"(async\s+)?function\b|//|/\*|\*|\}|\)|\]|'use strict'|#!",l):
        if l.strip() not in new: miss.append(f"{i}: {l[:150]}")
    # 粗略括号深度（忽略字符串里的括号，够用）
    t=re.sub(r"'(?:\\.|[^'\\])*'|\"(?:\\.|[^\"\\])*\"|`(?:\\.|[^`\\])*`","",l); t=re.sub(r"//.*","",t)
    depth+=t.count('{')+t.count('(')+t.count('[')-t.count('}')-t.count(')')-t.count(']')
    if depth<0: depth=0
print("\n".join(miss) if miss else "全部顶层语句都在")
