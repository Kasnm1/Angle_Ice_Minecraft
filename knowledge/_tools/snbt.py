#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
极简 SNBT (Stringified NBT) 解析器 —— 专为 FTB Quests 的 .snbt 文件写。

支持：
  compound   { key: value, ... }      key 可带引号也可裸写
  list       [ value, value, ... ]
  array      [B; ...] [S; ...] [I; ...] [L; ...]
  string     "..." （带转义）或裸 token
  number     123  123b  123s  123L  1.5f  2.0d  1e3
  bool       true / false

用法：
  from snbt import parse
  data = parse(open(path, encoding='utf-8').read())
"""

import re


class SnbtError(Exception):
    pass


# 数字后缀 -> (类型, 转换函数)
_NUM_SUFFIX = {
    'b': ('byte', int),
    'B': ('byte', int),
    's': ('short', int),
    'S': ('short', int),
    'l': ('long', int),
    'L': ('long', int),
    'f': ('float', float),
    'F': ('float', float),
    'd': ('double', float),
    'D': ('double', float),
}

_NUM_RE = re.compile(
    r'^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?[a-zA-Z]?$'
)

_WS = ' \t\r\n'


class _Parser:
    def __init__(self, s):
        self.s = s
        self.i = 0
        self.n = len(s)

    # ---- 基础工具 ----------------------------------------------------
    def err(self, msg):
        line = self.s.count('\n', 0, self.i) + 1
        col = self.i - (self.s.rfind('\n', 0, self.i) + 1) + 1
        raise SnbtError(f'{msg} @line {line}:{col}')

    def skip_ws(self):
        while self.i < self.n and self.s[self.i] in _WS:
            self.i += 1

    def peek(self):
        self.skip_ws()
        return self.s[self.i] if self.i < self.n else ''

    def expect(self, ch):
        if self.peek() != ch:
            self.err(f'expected {ch!r} but found {self.peek()!r}')
        self.i += 1

    # ---- 值 ----------------------------------------------------------
    def parse_value(self):
        c = self.peek()
        if c == '{':
            return self.parse_compound()
        if c == '[':
            return self.parse_list()
        if c == '"':
            return self.parse_quoted()
        return self.parse_bare()

    def parse_compound(self):
        self.expect('{')
        out = {}
        while True:
            self.skip_ws()
            if self.i >= self.n:
                self.err('unterminated compound')
            if self.s[self.i] == '}':
                self.i += 1
                return out
            key = self.parse_key()
            self.expect(':')
            out[key] = self.parse_value()
            self.skip_ws()
            if self.i < self.n and self.s[self.i] == ',':
                self.i += 1

    def parse_key(self):
        c = self.peek()
        if c == '"':
            return self.parse_quoted()
        start = self.i
        while self.i < self.n and self.s[self.i] not in ':' + _WS:
            self.i += 1
        if self.i == start:
            self.err('empty key')
        return self.s[start:self.i]

    def parse_list(self):
        self.expect('[')
        # 类型化数组 [B; ...] / [I; ...] 等
        save = self.i
        self.skip_ws()
        if self.i + 1 < self.n and self.s[self.i + 1] == ';' and self.s[self.i] in 'BSILbsil':
            tag = self.s[self.i].upper()
            self.i += 2
            vals = []
            while True:
                self.skip_ws()
                if self.i >= self.n:
                    self.err('unterminated array')
                if self.s[self.i] == ']':
                    self.i += 1
                    break
                vals.append(self.parse_value())
                self.skip_ws()
                if self.i < self.n and self.s[self.i] == ',':
                    self.i += 1
            return {f'__array_{tag}': vals}
        self.i = save

        out = []
        while True:
            self.skip_ws()
            if self.i >= self.n:
                self.err('unterminated list')
            if self.s[self.i] == ']':
                self.i += 1
                return out
            out.append(self.parse_value())
            self.skip_ws()
            if self.i < self.n and self.s[self.i] == ',':
                self.i += 1

    def parse_quoted(self):
        self.expect('"')
        buf = []
        while True:
            if self.i >= self.n:
                self.err('unterminated string')
            c = self.s[self.i]
            if c == '\\':
                nxt = self.s[self.i + 1] if self.i + 1 < self.n else ''
                mapping = {'n': '\n', 't': '\t', 'r': '\r', '"': '"', '\\': '\\', "'": "'"}
                if nxt in mapping:
                    buf.append(mapping[nxt])
                    self.i += 2
                    continue
                if nxt == 'u':
                    buf.append(chr(int(self.s[self.i + 2:self.i + 6], 16)))
                    self.i += 6
                    continue
                buf.append(nxt)
                self.i += 2
                continue
            if c == '"':
                self.i += 1
                return ''.join(buf)
            buf.append(c)
            self.i += 1

    def parse_bare(self):
        start = self.i
        while self.i < self.n and self.s[self.i] not in ',]}' + _WS:
            self.i += 1
        tok = self.s[start:self.i]
        if not tok:
            self.err('empty token')

        if tok in ('true', 'True'):
            return True
        if tok in ('false', 'False'):
            return False

        if _NUM_RE.match(tok):
            suffix = tok[-1]
            if suffix.isalpha() and suffix in _NUM_SUFFIX:
                _, conv = _NUM_SUFFIX[suffix]
                body = tok[:-1]
                try:
                    return conv(float(body)) if conv is int else conv(body)
                except ValueError:
                    pass
            try:
                if any(ch in tok for ch in '.eE'):
                    return float(tok)
                return int(tok)
            except ValueError:
                pass
        # 裸标识符（未加引号的字符串）
        return tok


def parse(text):
    """解析一段 SNBT，返回 Python 对象。"""
    # 去掉 BOM
    if text and text[0] == '\ufeff':
        text = text[1:]
    p = _Parser(text)
    v = p.parse_value()
    p.skip_ws()
    return v


if __name__ == '__main__':
    import sys, json
    print(json.dumps(parse(open(sys.argv[1], encoding='utf-8').read()),
                     ensure_ascii=False, indent=2)[:3000])
