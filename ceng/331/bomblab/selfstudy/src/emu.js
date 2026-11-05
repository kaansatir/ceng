(function (root) {
  'use strict';
  var M64 = (1n << 64n) - 1n;
  var MASK = { 1: 0xffn, 2: 0xffffn, 4: 0xffffffffn, 8: M64 };
  function u64(v) { return BigInt.asUintN(64, v); }
  function sx(v, sz) { return BigInt.asIntN(sz * 8, v); }

  var REG = {};
  function ar(n, r, s, h) { REG[n] = { r: r, size: s, hi: !!h }; }
  ['a', 'b', 'c', 'd'].forEach(function (c) { var r = 'r' + c + 'x'; ar(r, r, 8); ar('e' + c + 'x', r, 4); ar(c + 'x', r, 2); ar(c + 'l', r, 1); ar(c + 'h', r, 1, true); });
  [['rsi', 'si'], ['rdi', 'di'], ['rbp', 'bp'], ['rsp', 'sp']].forEach(function (p) { ar(p[0], p[0], 8); ar('e' + p[1], p[0], 4); ar(p[1], p[0], 2); ar(p[1] + 'l', p[0], 1); });
  for (var i = 8; i <= 15; i++) { var r = 'r' + i; ar(r, r, 8); ar(r + 'd', r, 4); ar(r + 'w', r, 2); ar(r + 'b', r, 1); }
  ar('rip', 'rip', 8);
  var GPR = ['rax', 'rbx', 'rcx', 'rdx', 'rsi', 'rdi', 'rbp', 'rsp', 'r8', 'r9', 'r10', 'r11', 'r12', 'r13', 'r14', 'r15'];

  var BASEOPS = new Set(['mov', 'movabs', 'add', 'adc', 'sub', 'sbb', 'and', 'or', 'xor', 'cmp', 'test', 'lea', 'push', 'pop', 'inc', 'dec', 'neg', 'not', 'imul', 'mul', 'idiv', 'div', 'shl', 'sal', 'shr', 'sar', 'rol', 'ror', 'xchg', 'nop', 'call', 'ret', 'leave', 'jmp', 'hlt', 'scas', 'cmps', 'movs', 'stos', 'lods', 'cltq', 'cltd', 'cqto', 'cwtl', 'cbtw', 'endbr64', 'bt']);
  var CC = { o: 1, no: 1, b: 1, c: 1, nae: 1, ae: 1, nb: 1, nc: 1, e: 1, z: 1, ne: 1, nz: 1, be: 1, na: 1, a: 1, nbe: 1, s: 1, ns: 1, p: 1, pe: 1, np: 1, po: 1, l: 1, nge: 1, ge: 1, nl: 1, le: 1, ng: 1, g: 1, nle: 1 };
  var EXT = { movzbl: [1, 4, 0], movzbw: [1, 2, 0], movzwl: [2, 4, 0], movzbq: [1, 8, 0], movzwq: [2, 8, 0], movsbl: [1, 4, 1], movsbw: [1, 2, 1], movswl: [2, 4, 1], movsbq: [1, 8, 1], movswq: [2, 8, 1], movslq: [4, 8, 1] };
  var PREF = new Set(['rep', 'repz', 'repe', 'repnz', 'repne', 'lock', 'cs', 'ds', 'ss', 'es', 'fs', 'gs', 'data16', 'notrack', 'bnd', 'addr32']);

  function splitOps(s) {
    var out = [], depth = 0, cur = '';
    for (var i = 0; i < s.length; i++) {
      var c = s[i];
      if (c === '(') depth++; else if (c === ')') depth--;
      if (c === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += c;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  }
  function pnum(s) { var neg = s[0] === '-'; if (neg || s[0] === '+') s = s.slice(1); var v = BigInt(s); return neg ? -v : v; }
  function parseOperand(s) {
    if (s[0] === '$') return { k: 'imm', v: pnum(s.slice(1)) };
    if (s[0] === '*') { var o = parseOperand(s.slice(1)); o.ind = true; return o; }
    var seg = null, m = /^%(fs|gs|es|ds|cs|ss):(.*)$/.exec(s);
    if (m) { seg = m[1]; s = m[2]; }
    if (s[0] === '%') { var nm = s.slice(1); if (!REG[nm]) throw new Error('bad register ' + s); var d = REG[nm]; return { k: 'reg', name: nm, size: d.size }; }
    m = /^(-?(?:0x[0-9a-f]+|\d+))?(?:\(\s*(%\w+)?\s*(?:,\s*(%\w+)?\s*(?:,\s*(\d))?)?\s*\))?(?:\s*<[^>]*>)?$/i.exec(s);
    if (!m) throw new Error('bad operand ' + s);
    var mem = { k: 'mem', seg: seg, disp: m[1] ? pnum(m[1]) : 0n, base: m[2] ? m[2].slice(1) : null, index: m[3] ? m[3].slice(1) : null, scale: m[4] ? BigInt(m[4]) : 1n };
    if (!m[2] && !m[3] && s.indexOf('(') < 0) mem.abs = true;
    return mem;
  }
  function parseIns(addr, len, text) {
    var t = text.split('#')[0].trim(), toks = t.split(/\s+/), rep = null;
    while (toks.length > 1 && PREF.has(toks[0])) { var p = toks.shift(); if (p.indexOf('rep') === 0) rep = p; }
    var mn = toks.shift() || '', opstr = toks.join(' ');
    var ins = { addr: addr, len: len, next: addr + BigInt(len), text: text, mn: mn, rep: rep, ops: [] };
    if (mn === 'ret' || mn === 'retq') { ins.op = 'ret'; return ins; }
    if (/^(nop[a-z]?|xchg)$/.test(mn) && (mn !== 'xchg' || opstr === '%ax,%ax')) { ins.op = 'nop'; return ins; }
    if (mn === 'call' || mn === 'callq' || mn === 'jmp' || mn === 'jmpq' || (mn[0] === 'j' && CC[mn.slice(1)])) {
      ins.op = mn.indexOf('call') === 0 ? 'call' : mn.indexOf('jmp') === 0 ? 'jmp' : 'jcc';
      if (ins.op === 'jcc') ins.cc = mn.slice(1);
      if (opstr[0] === '*') ins.ops = [parseOperand(opstr)];
      else { var mt = /^(0x[0-9a-f]+)/.exec(opstr); ins.target = BigInt(mt[1]); }
      return ins;
    }
    if (opstr) ins.ops = splitOps(opstr).map(parseOperand);
    if (EXT[mn]) { ins.op = 'movx'; ins.src = EXT[mn][0]; ins.sz = EXT[mn][1]; ins.sign = EXT[mn][2]; return ins; }
    if (mn.indexOf('set') === 0 && CC[mn.slice(3)]) { ins.op = 'setcc'; ins.cc = mn.slice(3); ins.sz = 1; return ins; }
    if (mn.indexOf('cmov') === 0) {
      var rest = mn.slice(4), sfx = null;
      if (!CC[rest] && /[wlq]$/.test(rest) && CC[rest.slice(0, -1)]) { sfx = rest.slice(-1); rest = rest.slice(0, -1); }
      ins.op = 'cmov'; ins.cc = rest; ins.sz = regSize(ins.ops) || { w: 2, l: 4, q: 8 }[sfx]; return ins;
    }
    var base = mn, sz = null;
    if (!BASEOPS.has(base) && /[bwlq]$/.test(base) && BASEOPS.has(base.slice(0, -1))) { sz = { b: 1, w: 2, l: 4, q: 8 }[base.slice(-1)]; base = base.slice(0, -1); }
    if (base === 'sal') base = 'shl';
    if (!BASEOPS.has(base)) throw new Error('unsupported instruction ' + text);
    ins.op = base;
    if (base === 'scas' || base === 'cmps' || base === 'movs' || base === 'stos' || base === 'lods') {
      var r = ins.ops.filter(function (o) { return o.k === 'reg'; })[0];
      ins.sz = sz || (r ? r.size : 1);
    } else ins.sz = sz || regSize(ins.ops) || (base === 'push' || base === 'pop' ? 8 : 8);
    return ins;
  }
  function regSize(ops) { for (var i = ops.length - 1; i >= 0; i--) if (ops[i].k === 'reg' && !ops[i].ind) return ops[i].size; return null; }

  function par(r) { var p = Number(r & 0xffn), c = 0; while (p) { c += p & 1; p >>= 1; } return c % 2 === 0; }
  function flagsArith(a, b, r, sz, cf, of) {
    var sb = 1n << BigInt(sz * 8 - 1), f = 0x202n;
    if (cf) f |= 1n; if (par(r)) f |= 4n; if ((a ^ b ^ r) & 0x10n) f |= 0x10n; if (r === 0n) f |= 0x40n; if (r & sb) f |= 0x80n; if (of) f |= 0x800n;
    return f;
  }
  function fsub(a, b, sz) { var m = MASK[sz]; a &= m; b &= m; var r = (a - b) & m, sb = 1n << BigInt(sz * 8 - 1); return { r: r, f: flagsArith(a, b, r, sz, a < b, ((a ^ b) & (a ^ r) & sb) !== 0n) }; }
  function fadd(a, b, sz, carry) { var m = MASK[sz]; a &= m; b &= m; var full = a + b + (carry || 0n), r = full & m, sb = 1n << BigInt(sz * 8 - 1); return { r: r, f: flagsArith(a, b, r, sz, full > m, (~(a ^ b) & (a ^ r) & sb) !== 0n) }; }
  function flogic(r, sz) { var sb = 1n << BigInt(sz * 8 - 1), f = 0x202n; if (par(r)) f |= 4n; if (r === 0n) f |= 0x40n; if (r & sb) f |= 0x80n; return f; }

  function b64dec(s) {
    if (typeof atob === 'function') { var bin = atob(s), a = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); return a; }
    return new Uint8Array(Buffer.from(s, 'base64'));
  }

  var STACK_LO = 0x7ffffffde000, STACK_HI = 0x7ffffffff000;
  var LIBC_RET = 0x7ffff7c2a1can, LDSO_ENTRY = 0x7ffff7fe4540n, FAKEFILE = 0x5555556062a0n;
  var CTYPE_PAGE = 0x7ffff7f80000;
  var LIBSTEPS = 60;

  function Emu(data, opts) {
    opts = opts || {};
    this.d = data;
    this.base = BigInt(data.base);
    this.initRsp = opts.rsp !== undefined ? BigInt(opts.rsp) : BigInt(data.regs_main.rsp);
    this.out = opts.out || function () { };
    this.files = opts.files || {};
    this.progName = opts.progName || '/home/student/bomb/bomb-quiet';
    this.ins = new Map();
    this.funcs = [];
    var self = this;
    Object.keys(data.funcs).forEach(function (name) {
      var f = data.funcs[name], lines = f.lines, start = BigInt(lines[0][0]), last = lines[lines.length - 1];
      var end = BigInt(last[0]) + BigInt(last[1]);
      self.funcs.push({ name: name, start: start, end: end, lines: lines });
      lines.forEach(function (l) { self.ins.set(BigInt(l[0]), { raw: l }); });
    });
    this.funcs.sort(function (a, b) { return a.start < b.start ? -1 : 1; });
    this.plt = new Map(); this.pltName = {};
    Object.keys(data.plt).forEach(function (n) { self.plt.set(BigInt(data.plt[n]), n); self.pltName[n] = BigInt(data.plt[n]); });
    this.libc = {}; this.libcByAddr = new Map();
    Object.keys(data.libc).forEach(function (n) { self.libc[n] = BigInt(data.libc[n]); self.libcByAddr.set(BigInt(data.libc[n]), n); });
    this.mainLines = new Map(); this.lineStarts = new Map();
    Object.keys(data.main_lines || {}).forEach(function (k) { var v = data.main_lines[k]; self.mainLines.set(BigInt(k), v[0]); self.lineStarts.set(BigInt(v[1]), v[0]); });
    var hiEnd = 0;
    (data.maps || []).forEach(function (m) { if (m.end > hiEnd) hiEnd = m.end; });
    this.heapLo = Math.ceil(hiEnd / 4096) * 4096;
    this.fakeFile = BigInt(this.heapLo) + 0x2a0n;
    this.alive = false;
  }
  Emu.prototype.getIns = function (a) {
    var e = this.ins.get(a);
    if (!e) return null;
    if (!e.p) e.p = parseIns(a, e.raw[1], e.raw[2]);
    return e.p;
  };
  Emu.prototype.funcAt = function (a) {
    for (var i = 0; i < this.funcs.length; i++) { var f = this.funcs[i]; if (a >= f.start && a < f.end) return f; }
    return null;
  };
  Emu.prototype.start = function (args, stdinLines) {
    var d = this.d, self = this;
    this.regions = d.maps.map(function (m) { return { lo: m.start, hi: m.end, w: m.perms[1] === 'w', x: m.perms[2] === 'x', b: b64dec(m.b64) }; });
    this.regions.push({ lo: STACK_LO, hi: STACK_HI, w: true, b: new Uint8Array(STACK_HI - STACK_LO) });
    var fsb = Number(BigInt(d.regs_main.fs_base)), fpage = fsb - (fsb % 4096);
    this.regions.push({ lo: fpage, hi: fpage + 8192, w: true, b: new Uint8Array(8192) });
    this.regions.push({ lo: CTYPE_PAGE, hi: CTYPE_PAGE + 4096, w: false, b: new Uint8Array(4096) });
    this.regions.push({ lo: this.heapLo, hi: this.heapLo + 0x21000, w: true, b: new Uint8Array(0x21000) });
    this.brk = BigInt(this.heapLo) + 0x6a0n; this.allocs = new Map(); this.rng = null; this.warned = {};
    this.regions.sort(function (a, b) { return a.lo - b.lo; });
    this.fsBase = BigInt(fsb);
    this.write(this.fsBase + 0x28n, 8, BigInt(d.canary));
    var tbl = CTYPE_PAGE + 0x100;
    for (var c = -128; c < 256; c++) {
      var ch = c & 0xff, v = 0;
      if (ch === 32 || (ch >= 9 && ch <= 13)) v |= 0x2000;
      if (ch >= 48 && ch <= 57) v |= 0x0800;
      if ((ch >= 65 && ch <= 90) || (ch >= 97 && ch <= 122)) v |= 0x0400;
      if (ch >= 32 && ch < 127) v |= 0x4000;
      this.raww(tbl + (c + 128) * 2, 2, BigInt(v));
    }
    this.raww(CTYPE_PAGE, 8, BigInt(tbl + 128 * 2));
    var up = CTYPE_PAGE + 0x400, lo = CTYPE_PAGE + 0xa00;
    for (var c2 = -128; c2 < 256; c2++) {
      var ch2 = c2 & 0xff, U = c2, L = c2;
      if (c2 >= 97 && c2 <= 122) U = c2 - 32;
      if (c2 >= 65 && c2 <= 90) L = c2 + 32;
      this.raww(up + (c2 + 128) * 4, 4, BigInt.asUintN(32, BigInt(U)));
      this.raww(lo + (c2 + 128) * 4, 4, BigInt.asUintN(32, BigInt(L)));
    }
    this.raww(CTYPE_PAGE + 8, 8, BigInt(up + 128 * 4));
    this.raww(CTYPE_PAGE + 16, 8, BigInt(lo + 128 * 4));
    var oldRsp = BigInt(d.regs_main.rsp), newRsp = this.initRsp, delta = newRsp - oldRsp;
    var R = this.R = {};
    GPR.forEach(function (r) {
      var v = BigInt(d.regs_main[r]);
      if (v >= BigInt(STACK_LO) - 0x40000n && v < BigInt(STACK_HI)) v = v + delta;
      R[r] = u64(v);
    });
    R.rsp = newRsp; R.rip = BigInt(d.funcs.main.start);
    R.eflags = BigInt(d.regs_main.eflags);
    var strs = [this.progName].concat(args || []);
    var top = BigInt(STACK_HI) - 0x200n, ptrs = [];
    strs.forEach(function (s) { ptrs.push(top); for (var i = 0; i < s.length; i++) self.write(top + BigInt(i), 1, BigInt(s.charCodeAt(i) & 0xff)); self.write(top + BigInt(s.length), 1, 0n); top += BigInt(s.length + 1); });
    var argv = newRsp + 0x120n;
    ptrs.forEach(function (p, i) { self.write(argv + BigInt(8 * i), 8, p); });
    this.write(argv + BigInt(8 * ptrs.length), 8, 0n);
    this.write(argv + BigInt(8 * ptrs.length + 8), 8, 0n);
    R.rdi = BigInt(strs.length); R.rsi = argv; R.rbx = argv; R.rdx = argv + BigInt(8 * ptrs.length + 8); R.r12 = BigInt(strs.length);
    this.write(newRsp, 8, LIBC_RET);
    this.argc = strs.length; this.argv = argv;
    this.shadow = [{ ret: LIBC_RET, sp: newRsp }];
    this.lib = null;
    this.streams = {}; this.stdinQ = (stdinLines || []).slice(); this.stdinBuf = '';
    this.fileName = null;
    this.alive = true;
    this.exitCode = null;
  };
  Emu.prototype.region = function (a) {
    var rs = this.regions;
    for (var i = 0; i < rs.length; i++) if (a >= rs[i].lo && a < rs[i].hi) return rs[i];
    return null;
  };
  Emu.prototype.rawr = function (a, n) {
    var g = this.region(a);
    if (!g || a + n > g.hi) { var e = new Error('fault'); e.fault = true; e.addr = a; throw e; }
    var v = 0n;
    for (var i = n - 1; i >= 0; i--) v = (v << 8n) | BigInt(g.b[a - g.lo + i]);
    return v;
  };
  Emu.prototype.raww = function (a, n, v) {
    var g = this.region(a);
    if (!g || a + n > g.hi) { var e = new Error('fault'); e.fault = true; e.addr = a; throw e; }
    for (var i = 0; i < n; i++) { g.b[a - g.lo + i] = Number(v & 0xffn); v >>= 8n; }
  };
  Emu.prototype.read = function (a, n) {
    a = u64(BigInt(a));
    if (a > 0x7fffffffffffn) { var e = new Error('fault'); e.fault = true; e.addr = Number(a & 0xffffffffffffn); e.big = a; throw e; }
    return this.rawr(Number(a), n);
  };
  Emu.prototype.write = function (a, n, v) {
    a = u64(BigInt(a));
    if (a > 0x7fffffffffffn) { var e = new Error('fault'); e.fault = true; e.big = a; throw e; }
    var g = this.region(Number(a));
    if (g && !g.w && this.alive) { var e2 = new Error('fault'); e2.fault = true; e2.addr = Number(a); throw e2; }
    this.raww(Number(a), n, u64(BigInt(v)));
  };
  Emu.prototype.readable = function (a) { a = u64(BigInt(a)); return a <= 0x7fffffffffffn && !!this.region(Number(a)); };
  Emu.prototype.cstr = function (a, max) {
    max = max || 4096; var s = '';
    for (var i = 0; i < max; i++) { var c = Number(this.read(u64(BigInt(a) + BigInt(i)), 1)); if (!c) return s; s += String.fromCharCode(c); }
    return s;
  };
  Emu.prototype.wstr = function (a, s, nul) {
    for (var i = 0; i < s.length; i++) this.write(BigInt(a) + BigInt(i), 1, BigInt(s.charCodeAt(i) & 0xff));
    if (nul !== false) this.write(BigInt(a) + BigInt(s.length), 1, 0n);
  };

  Emu.prototype.getReg = function (name) { var d = REG[name], v = d.r === 'rip' ? this.R.rip : this.R[d.r]; if (d.hi) return (v >> 8n) & 0xffn; return v & MASK[d.size]; };
  Emu.prototype.setReg = function (name, val) {
    var d = REG[name], R = this.R; val = val & MASK[d.size];
    if (d.size === 8) R[d.r] = val;
    else if (d.size === 4) R[d.r] = val;
    else if (d.size === 2) R[d.r] = (R[d.r] & ~0xffffn) | val;
    else if (d.hi) R[d.r] = (R[d.r] & ~0xff00n) | (val << 8n);
    else R[d.r] = (R[d.r] & ~0xffn) | val;
  };
  Emu.prototype.ea = function (o, ins) {
    var a = o.disp;
    if (o.base) a += o.base === 'rip' ? ins.next : this.getReg(o.base);
    if (o.index) a += this.getReg(o.index) * o.scale;
    if (o.seg === 'fs') a += this.fsBase;
    return u64(a);
  };
  Emu.prototype.rd = function (o, sz, ins) {
    if (o.k === 'reg') return this.getReg(o.name);
    if (o.k === 'imm') return o.v & MASK[sz];
    return this.read(this.ea(o, ins), sz);
  };
  Emu.prototype.wr = function (o, sz, v, ins) {
    if (o.k === 'reg') { if (o.size !== sz) { this.setReg(o.name, v); return; } this.setReg(o.name, v); return; }
    this.write(this.ea(o, ins), sz, v & MASK[sz]);
  };
  Emu.prototype.flag = function (b) { return (this.R.eflags >> BigInt(b)) & 1n; };
  Emu.prototype.cond = function (cc) {
    var CF = this.flag(0) === 1n, PF = this.flag(2) === 1n, ZF = this.flag(6) === 1n, SF = this.flag(7) === 1n, OF = this.flag(11) === 1n;
    switch (cc) {
      case 'o': return OF; case 'no': return !OF;
      case 'b': case 'c': case 'nae': return CF; case 'ae': case 'nb': case 'nc': return !CF;
      case 'e': case 'z': return ZF; case 'ne': case 'nz': return !ZF;
      case 'be': case 'na': return CF || ZF; case 'a': case 'nbe': return !CF && !ZF;
      case 's': return SF; case 'ns': return !SF;
      case 'p': case 'pe': return PF; case 'np': case 'po': return !PF;
      case 'l': case 'nge': return SF !== OF; case 'ge': case 'nl': return SF === OF;
      case 'le': case 'ng': return ZF || SF !== OF; case 'g': case 'nle': return !ZF && SF === OF;
    }
    throw new Error('bad cc ' + cc);
  };
  Emu.prototype.push = function (v) { this.R.rsp = u64(this.R.rsp - 8n); this.write(this.R.rsp, 8, v); };
  Emu.prototype.pop = function () { var v = this.read(this.R.rsp, 8); this.R.rsp = u64(this.R.rsp + 8n); return v; };
  Emu.prototype.popShadow = function () { var sp = this.R.rsp; while (this.shadow.length && this.shadow[this.shadow.length - 1].sp < sp) this.shadow.pop(); };

  Emu.prototype.exec = function (ins) {
    var R = this.R, o = ins.ops, sz = ins.sz, a, b, r, x;
    R.rip = ins.next;
    switch (ins.op) {
      case 'nop': case 'endbr64': return;
      case 'mov': case 'movabs': this.wr(o[1], sz, this.rd(o[0], sz, ins), ins); return;
      case 'movx': a = this.rd(o[0], ins.src, ins); if (ins.sign) a = u64(sx(a, ins.src)); this.wr(o[1], ins.sz, a & MASK[ins.sz], ins); return;
      case 'lea': this.wr(o[1], sz, this.ea(o[0], ins), ins); return;
      case 'add': x = fadd(this.rd(o[1], sz, ins), this.rd(o[0], sz, ins), sz); this.wr(o[1], sz, x.r, ins); R.eflags = x.f; return;
      case 'adc': x = fadd(this.rd(o[1], sz, ins), this.rd(o[0], sz, ins), sz, this.flag(0)); this.wr(o[1], sz, x.r, ins); R.eflags = x.f; return;
      case 'sub': x = fsub(this.rd(o[1], sz, ins), this.rd(o[0], sz, ins), sz); this.wr(o[1], sz, x.r, ins); R.eflags = x.f; return;
      case 'sbb': a = this.rd(o[1], sz, ins); b = (this.rd(o[0], sz, ins) + this.flag(0)); x = fsub(a, b, sz); x.f = (x.f & ~1n) | ((a & MASK[sz]) < (b) ? 1n : 0n); this.wr(o[1], sz, x.r, ins); R.eflags = x.f; return;
      case 'cmp': R.eflags = fsub(this.rd(o[1], sz, ins), this.rd(o[0], sz, ins), sz).f; return;
      case 'and': case 'or': case 'xor': case 'test':
        a = this.rd(o[1], sz, ins); b = this.rd(o[0], sz, ins);
        r = ins.op === 'or' ? a | b : ins.op === 'xor' ? a ^ b : a & b;
        r &= MASK[sz];
        if (ins.op !== 'test') this.wr(o[1], sz, r, ins);
        R.eflags = flogic(r, sz); return;
      case 'not': this.wr(o[0], sz, ~this.rd(o[0], sz, ins) & MASK[sz], ins); return;
      case 'neg': a = this.rd(o[0], sz, ins); x = fsub(0n, a, sz); this.wr(o[0], sz, x.r, ins); R.eflags = (x.f & ~1n) | (a !== 0n ? 1n : 0n); return;
      case 'inc': case 'dec':
        a = this.rd(o[0], sz, ins); x = ins.op === 'inc' ? fadd(a, 1n, sz) : fsub(a, 1n, sz);
        this.wr(o[0], sz, x.r, ins); R.eflags = (x.f & ~1n) | (R.eflags & 1n); return;
      case 'shl': case 'shr': case 'sar': case 'rol': case 'ror': {
        var dst = o.length === 2 ? o[1] : o[0], cnt = o.length === 2 ? Number(this.rd(o[0], 1, ins)) : 1;
        cnt &= sz === 8 ? 63 : 31;
        if (cnt === 0) return;
        var bits = BigInt(sz * 8), v = this.rd(dst, sz, ins), C = BigInt(cnt), res, cf, of = 0n, sb = 1n << (bits - 1n);
        if (ins.op === 'shl') { res = (v << C) & MASK[sz]; cf = C <= bits ? (v >> (bits - C)) & 1n : 0n; of = ((res & sb) ? 1n : 0n) ^ cf; }
        else if (ins.op === 'shr') { res = v >> C; cf = (v >> (C - 1n)) & 1n; of = (v & sb) ? 1n : 0n; }
        else if (ins.op === 'sar') { res = u64(sx(v, sz) >> C) & MASK[sz]; cf = (u64(sx(v, sz) >> (C - 1n))) & 1n; of = 0n; }
        else {
          var k = C % bits;
          res = ins.op === 'rol' ? ((v << k) | (v >> (bits - k))) & MASK[sz] : ((v >> k) | (v << (bits - k))) & MASK[sz];
          cf = ins.op === 'rol' ? res & 1n : (res >> (bits - 1n)) & 1n;
          this.wr(dst, sz, res, ins); R.eflags = (R.eflags & ~0x801n) | cf; return;
        }
        this.wr(dst, sz, res, ins);
        var f = flogic(res, sz) | cf;
        if (cnt === 1 && of) f |= 0x800n;
        R.eflags = f; return;
      }
      case 'imul': case 'mul': {
        var s0, s1, full, tr;
        if (o.length === 1) {
          var accName = { 1: 'al', 2: 'ax', 4: 'eax', 8: 'rax' }[sz];
          s0 = this.getReg(accName); s1 = this.rd(o[0], sz, ins);
          if (ins.op === 'imul') { full = sx(s0, sz) * sx(s1, sz); }
          else full = s0 * s1;
          var lo = u64(full) & MASK[sz], hi = (BigInt.asUintN(sz * 16, full) >> BigInt(sz * 8)) & MASK[sz];
          if (sz === 1) this.setReg('ax', (hi << 8n) | lo);
          else { this.setReg(accName, lo); this.setReg({ 2: 'dx', 4: 'edx', 8: 'rdx' }[sz], hi); }
          var ovf = ins.op === 'imul' ? sx(lo, sz) !== full : hi !== 0n;
          R.eflags = (flogic(lo, sz) & ~0x10n) | (ovf ? 0x801n : 0n);
          return;
        }
        var src = o.length === 3 ? o[1] : o[0], imm = o.length === 3 ? o[0] : null, dst2 = o.length === 3 ? o[2] : o[1];
        s0 = sx(this.rd(src, sz, ins), sz);
        s1 = imm ? sx(imm.v & MASK[sz], sz) : sx(this.rd(dst2, sz, ins), sz);
        full = s0 * s1; tr = u64(full) & MASK[sz];
        this.wr(dst2, sz, tr, ins);
        R.eflags = (flogic(tr, sz) & ~0x10n) | (sx(tr, sz) !== full ? 0x801n : 0n);
        return;
      }
      case 'idiv': case 'div': {
        var dv = this.rd(o[0], sz, ins), lowN = { 1: 'al', 2: 'ax', 4: 'eax', 8: 'rax' }[sz], highN = { 1: 'ah', 2: 'dx', 4: 'edx', 8: 'rdx' }[sz];
        var num = sz === 1 ? this.getReg('ax') : (this.getReg(highN) << BigInt(sz * 8)) | this.getReg(lowN);
        if (dv === 0n) { R.rip = ins.addr; throw { signal: 'SIGFPE' }; }
        var q, rm;
        if (ins.op === 'idiv') { var n2 = BigInt.asIntN(sz * 16, num), d2 = sx(dv, sz); q = n2 / d2; rm = n2 % d2; if (q > (MASK[sz] >> 1n) || q < -(MASK[sz] >> 1n) - 1n) { R.rip = ins.addr; throw { signal: 'SIGFPE' }; } }
        else { q = num / dv; rm = num % dv; if (q > MASK[sz]) { R.rip = ins.addr; throw { signal: 'SIGFPE' }; } }
        if (sz === 1) this.setReg('ax', ((u64(rm) & 0xffn) << 8n) | (u64(q) & 0xffn));
        else { this.setReg(lowN, u64(q)); this.setReg(highN, u64(rm)); }
        return;
      }
      case 'cltq': R.rax = u64(sx(R.rax & MASK[4], 4)); return;
      case 'cwtl': this.setReg('eax', u64(sx(R.rax & 0xffffn, 2))); return;
      case 'cbtw': this.setReg('ax', u64(sx(R.rax & 0xffn, 1))); return;
      case 'cltd': this.setReg('edx', (R.rax & 0x80000000n) ? 0xffffffffn : 0n); return;
      case 'cqto': R.rdx = (R.rax & (1n << 63n)) ? M64 : 0n; return;
      case 'setcc': this.wr(o[0], 1, this.cond(ins.cc) ? 1n : 0n, ins); return;
      case 'cmov': a = this.rd(o[0], sz, ins); if (this.cond(ins.cc)) this.wr(o[1], sz, a, ins); else if (sz === 4) this.wr(o[1], 4, this.rd(o[1], 4, ins), ins); return;
      case 'xchg': a = this.rd(o[0], sz, ins); b = this.rd(o[1], sz, ins); this.wr(o[0], sz, b, ins); this.wr(o[1], sz, a, ins); return;
      case 'push': a = o[0].k === 'imm' ? u64(o[0].v) : this.rd(o[0], 8, ins); this.push(a); return;
      case 'pop': a = this.pop(); this.wr(o[0], 8, a, ins); return;
      case 'leave': R.rsp = R.rbp; R.rbp = this.pop(); return;
      case 'call': {
        var tgt = ins.target !== undefined ? ins.target : this.indTarget(ins);
        this.push(ins.next); this.shadow.push({ ret: ins.next, sp: R.rsp, from: ins.addr });
        R.rip = tgt; return;
      }
      case 'jmp': R.rip = ins.target !== undefined ? ins.target : this.indTarget(ins); return;
      case 'jcc': if (this.cond(ins.cc)) R.rip = ins.target; return;
      case 'ret': R.rip = this.pop(); this.popShadow(); return;
      case 'hlt': R.rip = ins.addr; throw { signal: 'SIGSEGV' };
      case 'scas': case 'cmps': case 'stos': case 'movs': case 'lods': return this.strop(ins);
      case 'bt': a = this.rd(o[1], sz, ins); b = this.rd(o[0], sz, ins) % BigInt(sz * 8); R.eflags = (R.eflags & ~1n) | ((a >> b) & 1n); return;
    }
    throw new Error('unimplemented ' + ins.text);
  };
  Emu.prototype.indTarget = function (ins) { var op = ins.ops[0]; return op.k === 'reg' ? this.getReg(op.name) : this.read(this.ea(op, ins), 8); };
  Emu.prototype.strop = function (ins) {
    var R = this.R, sz = ins.sz, step = BigInt(sz), acc = { 1: 'al', 2: 'ax', 4: 'eax', 8: 'rax' }[sz], rep = ins.rep, self = this;
    function once() {
      if (ins.op === 'scas') { var f1 = fsub(self.getReg(acc), self.read(R.rdi, sz), sz).f; R.rdi = u64(R.rdi + step); return f1; }
      else if (ins.op === 'cmps') { var f2 = fsub(self.read(R.rsi, sz), self.read(R.rdi, sz), sz).f; R.rsi = u64(R.rsi + step); R.rdi = u64(R.rdi + step); return f2; }
      else if (ins.op === 'stos') { self.write(R.rdi, sz, self.getReg(acc)); R.rdi = u64(R.rdi + step); }
      else if (ins.op === 'movs') { self.write(R.rdi, sz, self.read(R.rsi, sz)); R.rsi = u64(R.rsi + step); R.rdi = u64(R.rdi + step); }
      else { self.setReg(acc, self.read(R.rsi, sz)); R.rsi = u64(R.rsi + step); }
    }
    var cmp = ins.op === 'scas' || ins.op === 'cmps', guard = 0, fl;
    if (!rep) { fl = once(); if (cmp) R.eflags = fl; return; }
    for (;;) {
      if (R.rcx === 0n) { R.rip = ins.next; return; }
      R.rip = ins.addr;
      fl = once();
      R.rcx = u64(R.rcx - 1n);
      if (R.rcx === 0n) { R.rip = ins.next; if (cmp) R.eflags = fl; return; }
      if (cmp) {
        var zf = ((fl >> 6n) & 1n) === 1n;
        if (((rep === 'repz' || rep === 'repe') && !zf) || ((rep === 'repnz' || rep === 'repne') && zf)) { R.rip = ins.next; R.eflags = fl; return; }
      } else if (rep !== 'rep' && rep !== 'repz' && rep !== 'repe' && rep !== 'repnz' && rep !== 'repne') { R.rip = ins.next; return; }
      if (this.oneIter) return;
      if (++guard > 50000000) return;
    }
  };

  /* library functions */
  Emu.prototype.arg = function (i) {
    var R = this.R, regs = [R.rdi, R.rsi, R.rdx, R.rcx, R.r8, R.r9];
    if (i < 6) return regs[i];
    return this.read(R.rsp + BigInt(8 * (i - 5)), 8);
  };
  Emu.prototype.fmt = function (fmt, ai) {
    var out = '', i = 0, self = this;
    while (i < fmt.length) {
      var c = fmt[i];
      if (c !== '%') { out += c; i++; continue; }
      var m = /^%([-+ 0#]*)(\d*)(?:\.(\d+))?(hh|h|ll|l|z|j|t)?([diouxXcsp%])/.exec(fmt.slice(i));
      if (!m) { out += c; i++; continue; }
      i += m[0].length;
      var conv = m[5], v;
      if (conv === '%') { out += '%'; continue; }
      v = self.arg(ai++);
      var s;
      var big = m[4] === 'l' || m[4] === 'll' || m[4] === 'z' || m[4] === 'j';
      if (conv === 'd' || conv === 'i') s = (big ? BigInt.asIntN(64, v) : BigInt.asIntN(32, v)).toString();
      else if (conv === 'u') s = (big ? v : v & 0xffffffffn).toString();
      else if (conv === 'x' || conv === 'X') { s = (big ? v : v & 0xffffffffn).toString(16); if (conv === 'X') s = s.toUpperCase(); }
      else if (conv === 'o') s = (big ? v : v & 0xffffffffn).toString(8);
      else if (conv === 'c') s = String.fromCharCode(Number(v & 0xffn));
      else if (conv === 's') { try { s = v === 0n ? '(null)' : self.cstr(v); } catch (e) { s = ''; } if (m[3]) s = s.slice(0, +m[3]); }
      else if (conv === 'p') s = '0x' + v.toString(16);
      var w = +m[2] || 0;
      if (s.length < w) s = m[1].indexOf('-') >= 0 ? s + ' '.repeat(w - s.length) : (m[1].indexOf('0') >= 0 && conv !== 's' ? s.padStart(w, '0') : s.padStart(w, ' '));
      out += s;
    }
    return out;
  };
  function isSpace(c) { return c === ' ' || c === '\t' || c === '\n' || c === '\v' || c === '\f' || c === '\r'; }
  Emu.prototype.scanf = function (str, fmt, argStart) {
    var i = 0, k = 0, n = 0, ai = argStart, self = this;
    function fail() { return n; }
    while (k < fmt.length) {
      var c = fmt[k];
      if (isSpace(c)) { while (k < fmt.length && isSpace(fmt[k])) k++; while (i < str.length && isSpace(str[i])) i++; continue; }
      if (c !== '%') { if (i >= str.length) return n === 0 ? -1 : n; if (str[i] !== c) return n; i++; k++; continue; }
      var m = /^%(\*)?(\d*)(hh|h|ll|l|z|j|t|L)?([diouxXcs%n\[])/.exec(fmt.slice(k));
      if (!m) return n;
      k += m[0].length;
      var sup = !!m[1], width = m[2] ? +m[2] : 0, len = m[3] || '', conv = m[4];
      if (conv === '%') { while (i < str.length && isSpace(str[i])) i++; if (str[i] !== '%') return n; i++; continue; }
      if (conv === 'n') { if (!sup) self.write(self.arg(ai++), 4, BigInt(i)); continue; }
      if (conv !== 'c') { while (i < str.length && isSpace(str[i])) i++; }
      if (i >= str.length) return n === 0 ? -1 : n;
      var lim = width ? Math.min(str.length, i + width) : str.length;
      if (conv === 'c') {
        var w = width || 1;
        if (str.length - i < 1) return n === 0 ? -1 : n;
        var chunk = str.slice(i, i + w); i += chunk.length;
        if (!sup) { self.wstr(self.arg(ai++), chunk, false); n++; }
        continue;
      }
      if (conv === 's') {
        var j = i; while (j < lim && !isSpace(str[j])) j++;
        var word = str.slice(i, j); i = j;
        if (!sup) { self.wstr(self.arg(ai++), word, true); n++; }
        continue;
      }
      var baseN = conv === 'x' || conv === 'X' ? 16 : conv === 'o' ? 8 : conv === 'i' ? 0 : 10;
      var p = i, neg = false;
      if (p < lim && (str[p] === '-' || str[p] === '+')) { neg = str[p] === '-'; p++; }
      if (baseN === 16 || baseN === 0) {
        if (p + 1 < lim && str[p] === '0' && (str[p + 1] === 'x' || str[p + 1] === 'X') && /[0-9a-f]/i.test(str[p + 2] || '')) { p += 2; baseN = 16; }
        else if (baseN === 0) baseN = (str[p] === '0') ? 8 : 10;
      }
      var digs = '', re = baseN === 16 ? /[0-9a-f]/i : baseN === 8 ? /[0-7]/ : /[0-9]/;
      while (p < lim && re.test(str[p])) { digs += str[p]; p++; }
      if (!digs) return n;
      i = p;
      var val = BigInt((baseN === 16 ? '0x' : baseN === 8 ? '0o' : '') + digs);
      if (neg) val = -val;
      var LMAX = (1n << 63n) - 1n;
      if (conv === 'd' || conv === 'i') { if (val > LMAX) val = LMAX; if (val < -LMAX - 1n) val = -LMAX - 1n; }
      else { if (val > M64 || val < -M64) val = M64; }
      if (!sup) {
        var bytes = len === 'hh' ? 1 : len === 'h' ? 2 : (len === 'l' || len === 'll' || len === 'z' || len === 'j' || len === 't') ? 8 : 4;
        self.write(self.arg(ai++), bytes, u64(val) & MASK[bytes]); n++;
      }
    }
    return n;
  };
  Emu.prototype.strtol = function (s, base) {
    var i = 0; while (i < s.length && isSpace(s[i])) i++;
    var neg = false; if (s[i] === '-' || s[i] === '+') { neg = s[i] === '-'; i++; }
    var b = base;
    if ((b === 16 || b === 0) && s[i] === '0' && (s[i + 1] === 'x' || s[i + 1] === 'X') && /[0-9a-f]/i.test(s[i + 2] || '')) { i += 2; b = 16; }
    else if (b === 0) b = s[i] === '0' ? 8 : 10;
    var start = i, v = 0n, B2 = BigInt(b), over = false, LMAX = (1n << 63n) - 1n;
    while (i < s.length) { var d = parseInt(s[i], 36); if (isNaN(d) || d >= b) break; v = v * B2 + BigInt(d); if (v > LMAX + 1n) over = true; i++; }
    if (i === start) return { v: 0n, end: 0 };
    if (neg) v = -v;
    if (over || v > LMAX) v = neg ? -LMAX - 1n : LMAX;
    if (v < -LMAX - 1n) v = -LMAX - 1n;
    return { v: v, end: i };
  };
  Emu.prototype.getLine = function (stream, n) {
    var max = n - 1;
    if (stream === this.fakeFile) {
      var st = this.streams.file;
      if (!st || st.pos >= st.text.length) return { eof: true };
      var nl = st.text.indexOf('\n', st.pos), end = nl < 0 ? st.text.length : nl + 1;
      if (end - st.pos > max) end = st.pos + max;
      var s = st.text.slice(st.pos, end); st.pos = end; return { s: s };
    }
    if (!this.stdinBuf) {
      if (!this.stdinQ.length) return { block: true };
      if (this.stdinQ[0] === null) { this.stdinQ.shift(); return { eof: true }; }
      this.stdinBuf = this.stdinQ.shift() + '\n';
    }
    var e2 = this.stdinBuf.indexOf('\n'); e2 = e2 < 0 ? this.stdinBuf.length : e2 + 1;
    if (e2 > max) e2 = max;
    var s2 = this.stdinBuf.slice(0, e2); this.stdinBuf = this.stdinBuf.slice(e2); return { s: s2 };
  };
  Emu.prototype.alloc = function (n) {
    n = Math.max(1, n); var p = this.brk + 16n; var end = (p + BigInt(n) + 15n) & ~15n;
    if (end > BigInt(this.heapLo + 0x21000)) return 0n;
    this.brk = end; this.allocs.set(p, n); return p;
  };
  function GlibcRand(seed) {
    seed = seed >>> 0; if (seed === 0) seed = 1;
    var r = [seed | 0];
    for (var i = 1; i < 31; i++) { var hi = Math.trunc(r[i - 1] / 127773), lo = r[i - 1] % 127773, w = 16807 * lo - 2836 * hi; if (w < 0) w += 2147483647; r.push(w); }
    for (i = 31; i < 34; i++) r.push(r[i - 31]);
    for (i = 34; i < 344; i++) r.push((r[i - 31] + r[i - 3]) | 0);
    this.r = r;
  }
  GlibcRand.prototype.next = function () { var r = this.r, i = r.length, v = (r[i - 31] + r[i - 3]) | 0; r.push(v); if (r.length > 4096) this.r = r.slice(-64); return v >>> 1; };
  Emu.prototype.libcall = function (name) {
    var R = this.R, a0 = R.rdi, ret = 0n, s;
    switch (name) {
      case 'puts': this.usedHeap = true; s = this.cstr(a0); this.out(s + '\n'); ret = BigInt(s.length + 1); break;
      case '__printf_chk': this.usedHeap = true; s = this.fmt(this.cstr(R.rsi), 2); this.out(s); ret = BigInt(s.length); break;
      case 'printf': this.usedHeap = true; s = this.fmt(this.cstr(R.rdi), 1); this.out(s); ret = BigInt(s.length); break;
      case 'exit': return { exit: Number(a0 & 0xffn) };
      case 'fopen': { this.usedHeap = true; var p = this.cstr(a0), base = p.replace(/^.*\//, ''); if (Object.prototype.hasOwnProperty.call(this.files, p) || Object.prototype.hasOwnProperty.call(this.files, base)) { var txt = this.files[p] !== undefined ? this.files[p] : this.files[base]; this.streams.file = { text: txt, pos: 0 }; ret = this.fakeFile; } else ret = 0n; break; }
      case 'fgets': { this.usedHeap = true;
        var g = this.getLine(R.rdx, Number(R.rsi & 0xffffffffn));
        if (g.block) return { block: true };
        if (g.eof) ret = 0n; else { this.wstr(a0, g.s, true); ret = a0; }
        break;
      }
      case '__ctype_b_loc': ret = BigInt(CTYPE_PAGE); break;
      case 'getenv': ret = 0n; break;
      case 'signal': ret = 0n; break;
      case 'sleep': ret = 0n; break;
      case 'fflush': ret = 0n; break;
      case 'strtol': { var str = this.cstr(a0), t = this.strtol(str, Number(R.rdx & 0xffffffffn)); if (R.rsi !== 0n) this.write(R.rsi, 8, a0 + BigInt(t.end)); ret = u64(t.v); break; }
      case '__isoc99_sscanf': case 'sscanf': ret = u64(BigInt(this.scanf(this.cstr(a0), this.cstr(R.rsi), 2))); break;
      case '__strcat_chk': case 'strcat': { var d0 = this.cstr(a0), s1 = this.cstr(R.rsi); this.wstr(a0 + BigInt(d0.length), s1, true); ret = a0; break; }
      case 'strlen': ret = BigInt(this.cstr(a0).length); break;
      case '__stack_chk_fail': this.out('*** stack smashing detected ***: terminated\n'); return { signal: 'SIGABRT' };
      case '_exit': return { exit: Number(a0 & 0xffn) };
      case 'strcmp': case 'strncmp': {
        var sa = this.cstr(a0), sb = this.cstr(R.rsi), lim = name === 'strncmp' ? Number(R.rdx) : Infinity, d = 0;
        for (var i = 0; i < lim; i++) { var ca = i < sa.length ? sa.charCodeAt(i) : 0, cb = i < sb.length ? sb.charCodeAt(i) : 0; if (ca !== cb) { d = ca - cb; break; } if (!ca) break; }
        ret = BigInt.asUintN(32, BigInt(d)); break;
      }
      case 'strcpy': case '__strcpy_chk': case 'stpcpy': { var sc = this.cstr(R.rsi); this.wstr(a0, sc, true); ret = name === 'stpcpy' ? a0 + BigInt(sc.length) : a0; break; }
      case 'strncpy': case '__strncpy_chk': { var sn = this.cstr(R.rsi), nn = Number(R.rdx); for (var k = 0; k < nn; k++) this.write(a0 + BigInt(k), 1, BigInt(k < sn.length ? sn.charCodeAt(k) & 0xff : 0)); ret = a0; break; }
      case 'memset': case '__memset_chk': { var nm = Number(R.rdx); for (var k2 = 0; k2 < nm; k2++) this.write(a0 + BigInt(k2), 1, R.rsi & 0xffn); ret = a0; break; }
      case 'memcpy': case '__memcpy_chk': case 'memmove': case '__memmove_chk': { var nc = Number(R.rdx), tmp = []; for (var k3 = 0; k3 < nc; k3++) tmp.push(this.read(R.rsi + BigInt(k3), 1)); for (k3 = 0; k3 < nc; k3++) this.write(a0 + BigInt(k3), 1, tmp[k3]); ret = a0; break; }
      case 'atoi': case 'atol': case 'atoll': ret = u64(this.strtol(this.cstr(a0), 10).v); break;
      case 'strtoul': case 'strtoull': case 'strtoll': { var su = this.cstr(a0), tu = this.strtol(su, Number(R.rdx & 0xffffffffn)); if (R.rsi !== 0n) this.write(R.rsi, 8, a0 + BigInt(tu.end)); ret = u64(tu.v); break; }
      case 'strchr': case 'strrchr': { var sh = this.cstr(a0), chh = String.fromCharCode(Number(R.rsi & 0xffn)), ix = chh === '\0' ? sh.length : (name === 'strchr' ? sh.indexOf(chh) : sh.lastIndexOf(chh)); ret = ix < 0 ? 0n : a0 + BigInt(ix); break; }
      case 'strstr': { var hs = this.cstr(a0), nd = this.cstr(R.rsi), ix2 = hs.indexOf(nd); ret = ix2 < 0 ? 0n : a0 + BigInt(ix2); break; }
      case 'putchar': this.out(String.fromCharCode(Number(a0 & 0xffn))); ret = a0 & 0xffn; break;
      case 'fputc': case 'putc': case '_IO_putc': this.out(String.fromCharCode(Number(a0 & 0xffn))); ret = a0 & 0xffn; break;
      case 'fputs': s = this.cstr(a0); this.out(s); ret = 1n; break;
      case 'fprintf': s = this.fmt(this.cstr(R.rsi), 2); this.out(s); ret = BigInt(s.length); break;
      case '__fprintf_chk': s = this.fmt(this.cstr(R.rdx), 3); this.out(s); ret = BigInt(s.length); break;
      case 'sprintf': s = this.fmt(this.cstr(R.rsi), 2); this.wstr(a0, s, true); ret = BigInt(s.length); break;
      case '__sprintf_chk': s = this.fmt(this.cstr(R.rcx), 4); this.wstr(a0, s, true); ret = BigInt(s.length); break;
      case 'snprintf': case '__snprintf_chk': {
        s = name === 'snprintf' ? this.fmt(this.cstr(R.rdx), 3) : this.fmt(this.cstr(R.r8), 5);
        var cap = Number(R.rsi); if (cap > 0) this.wstr(a0, s.slice(0, cap - 1), true); ret = BigInt(s.length); break;
      }
      case 'toupper': case 'tolower': { var cv = Number(BigInt.asIntN(32, a0)); if (name === 'toupper' && cv >= 97 && cv <= 122) cv -= 32; if (name === 'tolower' && cv >= 65 && cv <= 90) cv += 32; ret = BigInt.asUintN(32, BigInt(cv)); break; }
      case '__ctype_toupper_loc': ret = BigInt(CTYPE_PAGE + 8); break;
      case '__ctype_tolower_loc': ret = BigInt(CTYPE_PAGE + 16); break;
      case 'abs': { var av = BigInt.asIntN(32, a0); ret = BigInt.asUintN(32, av < 0n ? -av : av); break; }
      case 'labs': case 'llabs': { var lv = BigInt.asIntN(64, a0); ret = u64(lv < 0n ? -lv : lv); break; }
      case 'srand': case 'srandom': this.rng = new GlibcRand(Number(a0 & 0xffffffffn)); ret = 0n; break;
      case 'rand': case 'random': if (!this.rng) this.rng = new GlibcRand(1); ret = BigInt(this.rng.next()); break;
      case 'time': { var tnow = BigInt(Math.floor(Date.now() / 1000)); if (a0 !== 0n) this.write(a0, 8, tnow); ret = tnow; break; }
      case 'alarm': ret = 0n; break;
      case 'getpid': ret = 4242n; break;
      case 'fclose': case 'rewind': ret = 0n; break;
      case 'malloc': ret = this.alloc(Number(a0)); break;
      case 'calloc': ret = this.alloc(Number(a0 * R.rsi)); break;
      case 'realloc': { var np = this.alloc(Number(R.rsi)), old = this.allocs.get(a0) || 0; for (var k4 = 0; k4 < Math.min(old, Number(R.rsi)); k4++) this.write(np + BigInt(k4), 1, this.read(a0 + BigInt(k4), 1)); ret = np; break; }
      case 'free': ret = 0n; break;
      default:
        if (!this.warned[name]) { this.warned[name] = 1; this.out('[simulator: ' + name + '() is not modelled; it returned 0]\n'); }
        ret = 0n;
    }
    R.rax = ret;
    R.rip = this.pop(); this.popShadow();
    this.lib = null;
    return null;
  };
  /* one machine step. mode.si: step into library code instruction by instruction */
  Emu.prototype.step = function (mode) {
    var R = this.R, pc = R.rip;
    this.oneIter = !!(mode && mode.one);
    try {
      if (pc === LIBC_RET) { var code = Number(R.rax & 0xffn); return { exit: code }; }
      var pn = this.plt.get(pc);
      if (pn !== undefined) {
        if (mode && mode.si) { this.lib = { name: pn, steps: 0, entry: this.libc[pn] || 0x7ffff7c00000n }; R.rip = this.lib.entry; return null; }
        return this.libcall(pn);
      }
      if (this.lib) {
        if (mode && mode.si && this.lib.steps < LIBSTEPS - 1) { this.lib.steps++; R.rip = this.lib.entry + BigInt(4 * this.lib.steps); return null; }
        return this.libcall(this.lib.name);
      }
      var ins = this.getIns(pc);
      if (!ins) { if (this.readable(pc)) return { signal: 'SIGILL' }; return { signal: 'SIGSEGV', addr: pc }; }
      this.exec(ins);
      return null;
    } catch (e) {
      if (e && e.signal) return { signal: e.signal };
      if (e && e.fault) { R.rip = pc; return { signal: 'SIGSEGV', addr: e.addr }; }
      throw e;
    }
  };

  Emu.MODELLED = ['puts', '__printf_chk', 'printf', 'exit', '_exit', 'fopen', 'fgets', '__ctype_b_loc', 'getenv', 'signal', 'sleep', 'fflush', 'strtol',
    '__isoc99_sscanf', 'sscanf', '__strcat_chk', 'strcat', 'strlen', '__stack_chk_fail', 'strcmp', 'strncmp', 'strcpy', '__strcpy_chk', 'stpcpy', 'strncpy', '__strncpy_chk',
    'memset', '__memset_chk', 'memcpy', '__memcpy_chk', 'memmove', '__memmove_chk', 'atoi', 'atol', 'atoll', 'strtoul', 'strtoull', 'strtoll', 'strchr', 'strrchr', 'strstr',
    'putchar', 'fputc', 'putc', '_IO_putc', 'fputs', 'fprintf', '__fprintf_chk', 'sprintf', '__sprintf_chk', 'snprintf', '__snprintf_chk', 'toupper', 'tolower',
    '__ctype_toupper_loc', '__ctype_tolower_loc', 'abs', 'labs', 'llabs', 'srand', 'srandom', 'rand', 'random', 'time', 'alarm', 'getpid', 'fclose', 'rewind',
    'malloc', 'calloc', 'realloc', 'free', '__cxa_finalize', '__libc_start_main', '__gmon_start__'];
  Emu.REG = REG; Emu.GPR = GPR; Emu.parseIns = parseIns; Emu.u64 = u64; Emu.LIBC_RET = LIBC_RET; Emu.LDSO_ENTRY = LDSO_ENTRY; Emu.FAKEFILE = FAKEFILE;
  if (typeof module !== 'undefined') module.exports = Emu; else root.Emu = Emu;
})(this);
