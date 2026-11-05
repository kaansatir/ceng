(function (root) {
  'use strict';
  var Emu = (typeof require !== 'undefined' && typeof module !== 'undefined') ? require('./emu.js') : root.Emu;
  var LIBC_RET = Emu.LIBC_RET, u64 = Emu.u64;
  var LIBC = '/lib/x86_64-linux-gnu/libc.so.6';
  var READ_PC = 0x7ffff7d1ba61n;
  var GUARD = 2000000;
  var SIGDESC = { SIGSEGV: 'Segmentation fault', SIGFPE: 'Arithmetic exception', SIGABRT: 'Aborted', SIGILL: 'Illegal instruction', SIGINT: 'Interrupt', SIGTRAP: 'Trace/breakpoint trap' };
  var REGNUM = { rax: 0, rbx: 1, rcx: 2, rdx: 3, rsi: 4, rdi: 5, rbp: 6, rsp: 7, r8: 8, r9: 9, r10: 10, r11: 11, r12: 12, r13: 13, r14: 14, r15: 15, rip: 16 };

  function hx(v, w) { var s = BigInt.asUintN(64, BigInt(v)).toString(16); if (w) while (s.length < w) s = '0' + s; return '0x' + s; }
  function pad(s, n) { s = String(s); while (s.length < n) s += ' '; return s; }
  function lpad(s, n) { s = String(s); while (s.length < n) s = ' ' + s; return s; }
  function b64dec(s) {
    if (typeof atob === 'function') { var bin = atob(s), a = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); return a; }
    return new Uint8Array(Buffer.from(s, 'base64'));
  }
  function GErr(msg) { var e = new Error(msg); e.gdb = true; return e; }
  function memErr(a) { var e = GErr('Cannot access memory at address ' + hx(a)); e.mem = true; e.addr = a; return e; }
  function cmpB(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

  /* ---------------- types ---------------- */
  function canonType(t) {
    t = String(t).trim();
    var m = /^(.*?)\s*(\*+)$/.exec(t), base = (m ? m[1] : t).replace(/\s+/g, ' ').trim(), stars = m ? m[2] : '';
    var MAP = { 'unsigned': 'unsigned int', 'signed': 'int', 'long int': 'long', 'long long int': 'long long', 'short int': 'short', 'unsigned long int': 'unsigned long', 'unsigned short int': 'unsigned short', 'signed int': 'int', 'signed long': 'long', 'signed short': 'short' };
    if (MAP[base]) base = MAP[base];
    return stars ? base + ' ' + stars : base;
  }
  function isPtr(t) { return !!t && /\*$/.test(t); }
  function pointee(t) { return canonType(t.replace(/\*$/, '')); }
  function tsize(t) {
    if (!t) return 8;
    if (isPtr(t)) return 8;
    switch (t) {
      case 'char': case 'signed char': case 'unsigned char': case 'int8': case 'void': return 1;
      case 'short': case 'unsigned short': return 2;
      case 'int': case 'unsigned int': case 'eflags': return 4;
    }
    return 8;
  }
  function isUns(t) { return /^unsigned/.test(t || '') || isPtr(t); }
  function sv(x) { var n = tsize(x.t) * 8; return isUns(x.t) ? BigInt.asUintN(n, x.v) : BigInt.asIntN(n, x.v); }
  function mk(v, t) { return { v: BigInt.asUintN(tsize(t) * 8, BigInt(v)), t: t }; }
  function promote(t) { return (t === 'char' || t === 'signed char' || t === 'unsigned char' || t === 'int8' || t === 'short' || t === 'unsigned short' || t === 'eflags') ? 'int' : t; }
  function arithType(a, b) {
    a = promote(a); b = promote(b);
    if (/unsigned long/.test(a) || /unsigned long/.test(b)) return 'unsigned long';
    if (/long/.test(a) || /long/.test(b)) return 'long';
    if (a === 'unsigned int' || b === 'unsigned int') return 'unsigned int';
    return 'int';
  }
  var TYPEDEFS = { int8_t: 'int8', uint8_t: 'unsigned char', int16_t: 'short', uint16_t: 'unsigned short', int32_t: 'int', uint32_t: 'unsigned int', int64_t: 'long', uint64_t: 'unsigned long', size_t: 'unsigned long', ssize_t: 'long', intptr_t: 'long', uintptr_t: 'unsigned long' };
  function parseType(s) {
    s = String(s).trim();
    var m = /^((?:unsigned|signed)\s+)?(char|short\s+int|short|int|long\s+long\s+int|long\s+long|long\s+int|long|void|unsigned|signed|int8_t|uint8_t|int16_t|uint16_t|int32_t|uint32_t|int64_t|uint64_t|size_t|ssize_t|intptr_t|uintptr_t)?\s*(\**)$/.exec(s);
    if (!m || (!m[1] && !m[2])) return null;
    var b = m[2] || 'int';
    if (TYPEDEFS[b]) b = TYPEDEFS[b];
    return canonType(((m[1] || '') + b).replace(/\s+/g, ' ').trim() + (m[3] ? ' ' + m[3] : ''));
  }
  function chRep(c, q) {
    if (c === 0) return '\\000'; if (c === 10) return '\\n'; if (c === 9) return '\\t'; if (c === 13) return '\\r';
    if (c === 7) return '\\a'; if (c === 8) return '\\b'; if (c === 12) return '\\f'; if (c === 11) return '\\v'; if (c === 27) return '\\033';
    if (c === 92) return '\\\\'; if (q && c === q.charCodeAt(0)) return '\\' + q;
    if (c >= 32 && c < 127) return String.fromCharCode(c);
    var o = c.toString(8); while (o.length < 3) o = '0' + o; return '\\' + o;
  }
  function fmtG(x, p) {
    if (x === 0) return (1 / x < 0) ? '-0' : '0';
    if (x !== x) return '-nan(0x8000000000000)';
    if (!isFinite(x)) return x > 0 ? 'inf' : '-inf';
    var e = Math.floor(Math.log10(Math.abs(x))), s;
    if (e < -4 || e >= p) {
      s = x.toExponential(p - 1);
      var m = /^(-?[\d.]+)e([+-])(\d+)$/.exec(s), mant = m[1].indexOf('.') >= 0 ? m[1].replace(/0+$/, '').replace(/\.$/, '') : m[1];
      return mant + 'e' + m[2] + (m[3].length < 2 ? '0' + m[3] : m[3]);
    }
    s = x.toPrecision(p); if (s.indexOf('.') >= 0) s = s.replace(/0+$/, '').replace(/\.$/, ''); return s;
  }
  function asFloat(v, size) {
    var dv = new DataView(new ArrayBuffer(8)); dv.setBigUint64(0, BigInt.asUintN(64, v), true);
    return size === 4 ? fmtG(dv.getFloat32(0, true), 9) : fmtG(dv.getFloat64(0, true), 17);
  }

  /* ---------------- GDB ---------------- */
  function GDB(data, opts) {
    opts = opts || {};
    var self = this;
    this.data = data;
    this.out = opts.out || function () { };
    this.src = opts.src || [];
    this.files = opts.files || {};
    this.binName = data.bin_name || 'bomb-quiet';
    this.progPath = '/home/student/bomblab/' + this.binName;
    this.base = BigInt(data.base);
    this.pie = data.pie !== false;
    this.delta = this.pie ? this.base : 0n;
    var hi = this.base, tlo = null, thi = null;
    (data.maps || []).forEach(function (m) { var s = BigInt(m.start), e = BigInt(m.end); if (e > hi) hi = e; if (m.perms[2] === 'x' && tlo === null) { tlo = s; thi = e; } });
    this.span = hi - this.base; this.textLo = tlo !== null ? tlo : this.base; this.textHi = thi !== null ? thi : this.base;
    this.fsegs = (data.file_maps || []).map(function (s) { return { lo: BigInt(s.vaddr), hi: BigInt(s.vaddr) + BigInt(s.memsz), b: b64dec(s.b64) }; });
    this.sym = [];
    (data.symbols || []).forEach(function (s) { if ('tT'.indexOf(s[2]) < 0) self.sym.push({ addr: BigInt(s[0]), size: BigInt(s[1]), name: s[3] }); });
    this.sym.sort(function (a, b) { return cmpB(a.addr, b.addr); });
    this.funcList = Object.keys(data.funcs).map(function (n) { return { name: n, start: BigInt(data.funcs[n].start), size: BigInt(data.funcs[n].size), lines: data.funcs[n].lines }; });
    this.funcList.sort(function (a, b) { return cmpB(a.start, b.start); });
    this.plt = new Map(); this.pltAddr = {};
    Object.keys(data.plt || {}).forEach(function (n) { var a = BigInt(data.plt[n]); self.plt.set(a, n); self.pltAddr[n] = a; });
    this.pltIns = new Map();
    Object.keys(data.plt_text || {}).forEach(function (n) {
      (data.plt_text[n] || []).forEach(function (line) { var m = /^(?:=>)?\s*(0x[0-9a-f]+)\s*(?:<[^>]*>)?:\t(.*)$/.exec(line); if (m) self.pltIns.set(BigInt(m[1]), m[2]); });
    });
    this.libcAddr = {};
    Object.keys(data.libc || {}).forEach(function (n) { self.libcAddr[n] = BigInt(data.libc[n]); });
    this.sections = (data.sections || []).map(function (s) { return { name: s[0], lo: BigInt(s[1]), hi: BigInt(s[1]) + BigInt(s[2]) }; });
    var textSecs = this.sections.filter(function (s) { return /^\.(init|plt|plt\.got|plt\.sec|text|fini)$/.test(s.name); });
    this.textsyms = (data.textsyms || []).filter(function (t) { var a = BigInt(t[0]); return textSecs.some(function (s) { return a >= s.lo && a < s.hi; }); })
      .map(function (t) { return { addr: BigInt(t[0]), name: t[2] }; });
    this.mainLines = new Map(); this.lineStarts = new Map();
    Object.keys(data.main_lines || {}).forEach(function (k) { var v = data.main_lines[k]; self.mainLines.set(BigInt(k), v[0]); self.lineStarts.set(BigInt(v[1]), v[0]); });
    this.inlineStarts = new Set(); this.inlineInfo = data.inline_info || {};
    (data.inline_ranges || []).forEach(function (r) { self.inlineStarts.add(BigInt(r[0])); });
    this.lineStartList = Array.from(this.lineStarts.keys()).sort(cmpB);
    this.codeStarts = this.lineStartList.filter(function (a) { return !self.inlineStarts.has(a); });
    this.mainFn = this.funcList.filter(function (f) { return f.name === 'main'; })[0];
    var stdSym = this.sym.filter(function (x) { return /^stdin@/.test(x.name); })[0];
    if (stdSym) { var ra = stdSym.addr; (data.maps || []).forEach(function (m) { var lo = BigInt(m.start), hi2 = BigInt(m.end); if (ra >= lo && ra + 8n <= hi2) { var b = b64dec(m.b64), off = Number(ra - lo), v = 0n; for (var k = 7; k >= 0; k--) v = (v << 8n) | BigInt(b[off + k]); self.stdinVal = v; } }); }
    var mbl = /line (\d+)/.exec((data.static_bp && data.static_bp.main && data.static_bp.main[1]) || ''); this.mainBpLine = mbl ? +mbl[1] : 37;

    this.bps = []; this.bpNum = 0; this.watchCount = 0;
    this.displays = []; this.dispN = 0;
    this.valHist = []; this.conv = {};
    this.last = ''; this.lastCmd = '';
    this.listLast = null; this.listsize = 10;
    this.args = ''; this.confirm = true; this.printElements = 200; this.repeats = 10; this.dnl = false;
    this.loaded = false; this.running = false; this.exited = false; this.waiting = false; this.inRead = false;
    this.question = null; this.quitting = false; this.sigPending = null; this.selFrame = 0; this.pend = null;
    this.xnext = null; this.xf = 'x'; this.xu = 'w';
    this.pid = 1000 + Math.floor(Math.random() * 60000);
    this.reset();
  }

  GDB.prototype.reset = function () {
    this.emu = new Emu(this.data, { out: this.out, files: this.files, progName: this.progPath });
    this.running = false; this.waiting = false; this.inRead = false; this.pend = null; this.sigPending = null; this.selFrame = 0;
  };

  /* ---------------- address spaces ---------------- */
  GDB.prototype.toRt = function (a) { return this.loaded ? BigInt.asUintN(64, a) : BigInt.asUintN(64, a + this.delta); };
  GDB.prototype.toUser = function (rt) { return this.loaded ? rt : BigInt.asUintN(64, rt - this.delta); };
  GDB.prototype.inText = function (rt) { return rt >= this.textLo && rt < this.textHi; };
  GDB.prototype.mread = function (A, n) {
    A = BigInt.asUintN(64, A);
    if (this.running) { try { return this.emu.read(A, n); } catch (e) { if (e && e.fault) throw memErr(A); throw e; } }
    var L = this.loaded ? BigInt.asUintN(64, A - this.delta) : A;
    for (var i = 0; i < this.fsegs.length; i++) {
      var s = this.fsegs[i];
      if (L >= s.lo && L + BigInt(n) <= s.hi) { var off = Number(L - s.lo), v = 0n; for (var k = n - 1; k >= 0; k--) v = (v << 8n) | BigInt(s.b[off + k]); return v; }
    }
    throw memErr(A);
  };
  GDB.prototype.mwrite = function (A, n, v) {
    A = BigInt.asUintN(64, A);
    if (!this.running) throw memErr(A);
    var g = this.emu.region(Number(A));
    if (!g || A + BigInt(n) > BigInt(g.hi)) throw memErr(A);
    this.emu.raww(Number(A), n, BigInt.asUintN(n * 8, v));
  };
  GDB.prototype.mstr = function (A, limit) {
    var s = '', lim = limit || 0;
    for (var i = 0; lim === 0 || i < lim; i++) {
      var c;
      try { c = Number(this.mread(A + BigInt(i), 1)); } catch (e) { if (i === 0) throw e; return { s: s, err: A + BigInt(i) }; }
      if (c === 0) return { s: s, end: true };
      s += String.fromCharCode(c);
      if (i > 100000) break;
    }
    return { s: s, trunc: true };
  };
  GDB.prototype.quoteStr = function (s, trunc) {
    var out = [], cur = '', i = 0, th = this.repeats;
    while (i < s.length) {
      var j = i; while (j < s.length && s[j] === s[i]) j++;
      var run = j - i;
      if (th > 0 && run > th) {
        if (cur) { out.push('"' + cur + '"'); cur = ''; }
        out.push("'" + chRep(s.charCodeAt(i), "'") + "' <repeats " + run + ' times>');
        i = j; continue;
      }
      for (var k = i; k < j; k++) cur += chRep(s.charCodeAt(k), '"');
      i = j;
    }
    if (cur || !out.length) out.push('"' + cur + '"');
    return out.join(', ') + (trunc ? '...' : '');
  };
  GDB.prototype.strAt = function (A) {
    var r;
    try { r = this.mstr(A, this.printElements); } catch (e) { return '<error: Cannot access memory at address ' + hx(A) + '>'; }
    var q = this.quoteStr(r.s, !!r.trunc);
    if (r.err !== undefined) q += '<error: Cannot access memory at address ' + hx(r.err) + '>';
    return q;
  };

  /* ---------------- symbols / labels ---------------- */
  GDB.prototype.funcAt = function (a) {
    for (var i = 0; i < this.funcList.length; i++) { var f = this.funcList[i]; if (a >= f.start && a < f.start + f.size) return f; }
    return null;
  };
  GDB.prototype.symAt = function (a) {
    var best = null;
    for (var i = 0; i < this.sym.length; i++) {
      var s = this.sym[i];
      if (a >= s.addr && (s.size === 0n ? a === s.addr : a < s.addr + s.size)) { if (!best || s.addr > best.addr) best = s; }
    }
    return best;
  };
  GDB.prototype.pltAt = function (rt) {
    var it = this.plt.entries(), e;
    while (!(e = it.next()).done) { if (rt >= e.value[0] && rt < e.value[0] + 16n) return { name: e.value[1], start: e.value[0] }; }
    return null;
  };
  GDB.prototype.labelRt = function (rt) {
    var f = this.funcAt(rt);
    if (f) return '<' + f.name + (rt > f.start ? '+' + (rt - f.start) : '') + '>';
    var p = this.pltAt(rt);
    if (p) return '<' + p.name + '@plt' + (rt > p.start ? '+' + (rt - p.start) : '') + '>';
    var s = this.symAt(rt);
    if (s) return '<' + s.name + (rt > s.addr ? '+' + (rt - s.addr) : '') + '>';
    if (this.loaded) for (var n in this.libcAddr) if (this.libcAddr[n] === rt) return '<' + n + '>';
    if (this.loaded && this.stdinVal !== undefined && rt === this.stdinVal) return '<_IO_2_1_stdin_>';
    return null;
  };
  GDB.prototype.labelU = function (A) { return this.labelRt(this.toRt(A)); };
  GDB.prototype.rebase = function (text) {
    if (this.loaded || this.delta === 0n) return text;
    var b = this.base, e = this.base + this.span, d = this.delta;
    return text.replace(/0x[0-9a-f]{9,}/g, function (m) { var v = BigInt(m); return (v >= b && v < e) ? '0x' + (v - d).toString(16) : m; });
  };
  GDB.prototype.srcLine = function (n) { return this.src[n - 1] !== undefined ? this.src[n - 1] : ''; };
  GDB.prototype.mainInsAt = function (a) {
    var f = this.mainFn; if (!f || a < f.start || a >= f.start + f.size) return null;
    for (var i = 0; i < f.lines.length; i++) { var s = BigInt(f.lines[i][0]); if (a >= s && a < s + BigInt(f.lines[i][1])) return s; }
    return null;
  };
  GDB.prototype.lineFor = function (a) { var s = this.mainInsAt(a); return s === null ? undefined : this.mainLines.get(s); };
  GDB.prototype.insAt = function (rt) {
    var ins = this.emu.getIns(rt);
    if (ins) return { text: ins.text, len: ins.len };
    if (this.pltIns.has(rt)) {
      var ks = Array.from(this.pltIns.keys()).filter(function (k) { return k > rt; }).sort(cmpB);
      var p = this.pltAt(rt), nx = ks.length ? ks[0] : rt + 6n;
      if (p && nx > p.start + 16n) nx = p.start + 16n;
      return { text: this.pltIns.get(rt), len: Number(nx - rt) };
    }
    return null;
  };

  /* ---------------- frames ---------------- */
  GDB.prototype.frames = function () {
    var emu = this.emu, fr = [], sh = emu.shadow;
    if (this.inRead) {
      var fg = (this.libcAddr.fgets || 0x7ffff7c85bc0n) + 0x7an;
      fr.push({ pc: READ_PC, lib: 'read' }, { pc: 0x7ffff7c8d1f5n, lib: '_IO_file_underflow' }, { pc: 0x7ffff7c8e3a2n, lib: '_IO_default_uflow' },
        { pc: 0x7ffff7c8288cn, lib: '_IO_getline_info' }, { pc: 0x7ffff7c8299cn, lib: '_IO_getline' }, { pc: fg, lib: 'fgets' });
    } else if (emu.lib && !this.inText(emu.R.rip)) fr.push({ pc: emu.R.rip, lib: emu.lib.name, sh: sh.length - 1 });
    else fr.push({ pc: emu.R.rip, sh: sh.length - 1 });
    if (this.funcAt(fr[0].pc) && this.funcAt(fr[0].pc).name === 'main') return fr;
    for (var i = sh.length - 1; i >= 1; i--) {
      fr.push({ pc: sh[i].ret, outer: true, sh: i - 1 });
      var f = this.funcAt(sh[i].ret);
      if (f && f.name === 'main') break;
    }
    return fr;
  };
  GDB.prototype.cfa = function (fr) { var e = this.emu.shadow[fr.sh !== undefined ? fr.sh : this.emu.shadow.length - 1]; return e ? e.sp + 8n : this.emu.R.rsp; };
  GDB.prototype.frameHead = function (idx, f) {
    if (f.lib) return hx(f.pc, 16) + ' in ' + f.lib + ' () from ' + LIBC;
    var fn = this.funcAt(f.pc);
    if (fn && fn.name === 'main') {
      var L = this.lineFor(f.outer ? f.pc - 1n : f.pc);
      var atStart = !f.outer && this.lineStarts.get(f.pc) === this.mainLines.get(f.pc);
      var args = (idx === 0 && f.pc === fn.start) ? 'argc=' + this.emu.argc + ', argv=' + hx(this.emu.argv) : 'argc=<optimized out>, argv=<optimized out>';
      return (atStart ? '' : hx(f.pc, 16) + ' in ') + 'main (' + args + ') at bomb.c:' + L;
    }
    if (fn) return hx(f.pc, 16) + ' in ' + fn.name + ' ()';
    var p = this.pltAt(f.pc); if (p) return hx(f.pc, 16) + ' in ' + p.name + '@plt ()';
    if (f.pc === LIBC_RET) return hx(f.pc, 16) + ' in __libc_start_call_main () from ' + LIBC;
    return hx(f.pc, 16) + ' in ?? ()';
  };
  GDB.prototype.frameSrc = function (f) {
    var fn = this.funcAt(f.pc);
    if (f.lib || !fn || fn.name !== 'main') return '';
    var L = this.lineFor(f.outer ? f.pc - 1n : f.pc);
    return L !== undefined ? L + '\t' + this.srcLine(L) + '\n' : '';
  };
  /* location text after a stop. same = same function+depth as when the command started */
  GDB.prototype.where = function (same) {
    var fr = this.frames()[0], pc = fr.pc, fn = this.funcAt(pc);
    if (!fr.lib && fn && fn.name === 'main' && this.mainLines.has(pc)) {
      var ln = this.mainLines.get(pc), ls = this.lineStarts.get(pc) === ln;
      if (same) return (ls ? '' : hx(pc, 16) + '\t') + ln + '\t' + this.srcLine(ln) + '\n';
      return this.frameHead(0, fr) + '\n' + ln + '\t' + this.srcLine(ln) + '\n';
    }
    return this.frameHead(0, fr) + '\n';
  };
  GDB.prototype.selected = function () { var fr = this.frames(); if (this.selFrame >= fr.length) this.selFrame = fr.length - 1; return { fr: fr, f: fr[this.selFrame], idx: this.selFrame }; };
  GDB.prototype.ctx = function () { var f = this.frames()[0]; return { fn: this.funcAt(f.pc), depth: this.emu.shadow.length, lib: !!f.lib }; };
  GDB.prototype.sameCtx = function (c) { var n = this.ctx(); return !n.lib && !c.lib && n.fn === c.fn && n.depth === c.depth; };

  /* ---------------- expressions ---------------- */
  function Parser(s, g) { this.s = s; this.i = 0; this.g = g; }
  Parser.prototype.ws = function () { while (this.i < this.s.length && /\s/.test(this.s[this.i])) this.i++; };
  Parser.prototype.syntax = function () { throw GErr('A syntax error in expression, near `' + this.s.slice(this.i) + "'."); };
  var LEVELS = [['||'], ['&&'], ['|'], ['^'], ['&'], ['==', '!='], ['<=', '>=', '<', '>'], ['<<', '>>'], ['+', '-'], ['*', '/', '%']];
  Parser.prototype.expr = function () { return this.bin(0); };
  Parser.prototype.bin = function (lvl) {
    if (lvl >= LEVELS.length) return this.unary();
    var a = this.bin(lvl + 1);
    for (; ;) {
      this.ws();
      var op = null, ops = LEVELS[lvl];
      for (var k = 0; k < ops.length; k++) {
        var o = ops[k];
        if (this.s.substr(this.i, o.length) !== o) continue;
        var nx = this.s[this.i + o.length];
        if ((o === '&' && nx === '&') || (o === '|' && nx === '|') || (o === '<' && (nx === '<' || nx === '=')) || (o === '>' && (nx === '>' || nx === '='))) continue;
        op = o; break;
      }
      if (!op) return a;
      this.i += op.length;
      var b = this.bin(lvl + 1);
      a = this.g.binop(op, a, b);
    }
  };
  Parser.prototype.matchParen = function (open) {
    var d = 0;
    for (var j = open; j < this.s.length; j++) { if (this.s[j] === '(') d++; else if (this.s[j] === ')') { d--; if (d === 0) return j; } }
    return -1;
  };
  Parser.prototype.unary = function () {
    this.ws(); var c = this.s[this.i], g = this.g;
    if (c === '-' && this.s[this.i + 1] !== '-') { this.i++; return g.neg(this.unary()); }
    if (c === '+') { this.i++; return g.rv(this.unary()); }
    if (c === '!') { this.i++; var x2 = g.rv(this.unary()); return mk(sv(x2) === 0n ? 1n : 0n, 'int'); }
    if (c === '~') { this.i++; var x3 = g.rv(this.unary()); return mk(~sv(x3), promote(x3.t)); }
    if (c === '*') { this.i++; return g.deref(this.unary()); }
    if (c === '&') { this.i++; return g.addrOf(this.unary()); }
    if (c === '{') {
      var close = this.s.indexOf('}', this.i); if (close < 0) this.syntax();
      var ty = parseType(this.s.slice(this.i + 1, close));
      if (!ty) throw GErr('No symbol "' + this.s.slice(this.i + 1, close).trim() + '" in current context.');
      this.i = close + 1;
      return g.atAddr(this.unary(), ty);
    }
    if (c === '(') {
      var cl = this.matchParen(this.i);
      if (cl > 0) { var ty2 = parseType(this.s.slice(this.i + 1, cl)); if (ty2) { this.i = cl + 1; return g.cast(this.unary(), ty2); } }
    }
    return this.postfix();
  };
  Parser.prototype.postfix = function () {
    var x = this.primary();
    for (; ;) {
      this.ws();
      if (this.s[this.i] === '[') { this.i++; var idx = this.expr(); this.ws(); if (this.s[this.i] !== ']') this.syntax(); this.i++; x = this.g.deref(this.g.binop('+', x, idx)); continue; }
      if (this.s[this.i] === '(' && (x.func || x.t === 'textptr')) throw GErr('[simulator: calling functions inside the program is not supported]');
      return x;
    }
  };
  Parser.prototype.primary = function () {
    this.ws(); var c = this.s[this.i], rest = this.s.slice(this.i), g = this.g, m;
    if (this.i >= this.s.length) throw GErr("A syntax error in expression, near `'.");
    if (c === '(') { this.i++; var e = this.expr(); this.ws(); if (this.s[this.i] !== ')') this.syntax(); this.i++; return e; }
    if (c === '$') {
      m = /^\$(\$\d*|\d+|[A-Za-z_][A-Za-z0-9_]*)?/.exec(rest); this.i += m[0].length;
      var name = m[1] || '';
      if (name === '' || name[0] === '$' || /^\d+$/.test(name)) return g.histVal(name);
      return g.regOrConv(name);
    }
    if (c === "'") {
      m = /^'([^']+)'/.exec(rest);
      if (m && m[1].length > 1) { this.i += m[0].length; return g.symVal(m[1]); }
      m = /^'(\\[0-7]{1,3}|\\.|[^\\'])'/.exec(rest);
      if (m) {
        this.i += m[0].length; var ch = m[1], code;
        if (ch[0] === '\\') { var E = { n: 10, t: 9, r: 13, a: 7, b: 8, f: 12, v: 11, '0': 0, '\\': 92, "'": 39, '"': 34 }; code = /^\\[0-7]+$/.test(ch) ? parseInt(ch.slice(1), 8) : E[ch[1]]; }
        else code = ch.charCodeAt(0);
        return mk(BigInt(code), 'char');
      }
      this.syntax();
    }
    m = /^(0x[0-9a-fA-F]+|0[0-7]*|[1-9][0-9]*)([uUlL]*)(?![A-Za-z0-9_])/.exec(rest);
    if (m) {
      this.i += m[0].length;
      var v = m[1].length > 1 && m[1][0] === '0' && m[1][1] !== 'x' && m[1][1] !== 'X' ? BigInt('0o' + m[1].slice(1)) : BigInt(m[1]);
      var hexo = /^0[xX0-7]/.test(m[1]) && m[1] !== '0', suf = m[2].toLowerCase(), t;
      if (suf.indexOf('l') >= 0) t = suf.indexOf('u') >= 0 ? 'unsigned long' : 'long';
      else if (v <= 0x7fffffffn) t = suf.indexOf('u') >= 0 ? 'unsigned int' : 'int';
      else if (v <= 0xffffffffn && (hexo || suf.indexOf('u') >= 0)) t = 'unsigned int';
      else if (v <= 0x7fffffffffffffffn) t = 'long';
      else t = 'unsigned long';
      return mk(v, t);
    }
    m = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(rest);
    if (m) { this.i += m[0].length; return g.symVal(m[0]); }
    this.syntax();
  };

  GDB.prototype.evalExpr = function (s) {
    if (!String(s).trim()) throw GErr("A syntax error in expression, near `'.");
    var p = new Parser(s, this), v = p.expr();
    p.ws(); if (p.i < p.s.length) p.syntax();
    return v;
  };
  GDB.prototype.symVal = function (name) {
    if (name === 'argc' || name === 'argv' || name === 'input') {
      if (!this.running) throw GErr('No symbol "' + name + '" in current context.');
      var sl = this.selected(), mf = this.funcAt(sl.f.pc);
      if (mf && mf.name === 'main' && !sl.f.lib) {
        var ty = name === 'argc' ? 'int' : name === 'argv' ? 'char **' : 'char *';
        if (name !== 'input' && sl.idx === 0 && sl.f.pc === mf.start) return name === 'argc' ? mk(BigInt(this.emu.argc), 'int') : { v: this.emu.argv, t: 'char **' };
        return { optimized: true, t: ty };
      }
    }
    if (name === 'infile') {
      for (var q = 0; q < this.sym.length; q++) if (this.sym[q].name === 'infile') { var ia = this.toUser(this.sym[q].addr); return { v: this.mread(ia, 8), t: 'FILE *', lval: { addr: ia } }; }
    }
    var f = this.data.funcs[name];
    if (f) return { func: true, v: this.toUser(BigInt(f.start)), t: 'func', name: name };
    var pm = /^(.*)@plt$/.exec(name);
    if (pm && this.pltAddr[pm[1]] !== undefined) return { func: true, v: this.toUser(this.pltAddr[pm[1]]), t: 'func', name: name };
    for (var k = 0; k < this.sym.length; k++) if (this.sym[k].name === name) return { nodebug: true, addr: this.toUser(this.sym[k].addr), name: name };
    if (this.loaded && this.libcAddr[name] !== undefined) return { func: true, v: this.libcAddr[name], t: 'func', name: name };
    throw GErr('No symbol "' + name + '" in current context.');
  };
  GDB.prototype.nodebugErr = function (x) { return GErr("'" + x.name + "' has unknown type; cast it to its declared type"); };
  GDB.prototype.rv = function (x) {
    if (x.nodebug) throw this.nodebugErr(x);
    if (x.optimized) throw GErr('value has been optimized out');
    if (x.func) return { v: x.v, t: 'textptr' };
    return x;
  };
  GDB.prototype.ptrScale = function (t) {
    if (t === 'textptr' || t === 'code *' || t === 'void *') return 1n;
    if (t === 'nodebug *') throw GErr('Cannot perform pointer math on incomplete type "<data variable, no debug info>", try casting to a known type, or void *.');
    return BigInt(tsize(pointee(t)));
  };
  GDB.prototype.binop = function (op, a, b) {
    if (a.nodebug) throw this.nodebugErr(a); if (b.nodebug) throw this.nodebugErr(b);
    if (a.optimized || b.optimized) throw GErr('value has been optimized out');
    if (a.voidc || b.voidc) throw GErr('Argument to arithmetic operation not a number or boolean.');
    a = this.rv(a); b = this.rv(b);
    var pa = isPtr(a.t) || a.t === 'textptr', pb = isPtr(b.t) || b.t === 'textptr';
    if ((op === '+' || op === '-') && pa && !pb) return { v: BigInt.asUintN(64, a.v + (op === '+' ? sv(b) : -sv(b)) * this.ptrScale(a.t)), t: a.t };
    if (op === '+' && pb && !pa) return { v: BigInt.asUintN(64, b.v + sv(a) * this.ptrScale(b.t)), t: b.t };
    if (op === '-' && pa && pb) return mk((BigInt.asIntN(64, a.v) - BigInt.asIntN(64, b.v)) / this.ptrScale(a.t), 'long');
    if ((pa || pb) && !/^(==|!=|<|>|<=|>=|&&|\|\|)$/.test(op)) throw GErr('Argument to arithmetic operation not a number or boolean.');
    var x = pa ? BigInt.asUintN(64, a.v) : sv(a), y = pb ? BigInt.asUintN(64, b.v) : sv(b), rt = (pa || pb) ? 'unsigned long' : arithType(a.t, b.t), r;
    switch (op) {
      case '+': r = x + y; break; case '-': r = x - y; break; case '*': r = x * y; break;
      case '/': if (y === 0n) throw GErr('Division by zero'); r = x / y; break;
      case '%': if (y === 0n) throw GErr('Division by zero'); r = x % y; break;
      case '<<': r = x << y; break; case '>>': r = x >> y; break;
      case '&': r = x & y; break; case '|': r = x | y; break; case '^': r = x ^ y; break;
      case '==': return mk(x === y ? 1n : 0n, 'int'); case '!=': return mk(x !== y ? 1n : 0n, 'int');
      case '<': return mk(x < y ? 1n : 0n, 'int'); case '>': return mk(x > y ? 1n : 0n, 'int');
      case '<=': return mk(x <= y ? 1n : 0n, 'int'); case '>=': return mk(x >= y ? 1n : 0n, 'int');
      case '&&': return mk(x !== 0n && y !== 0n ? 1n : 0n, 'int'); case '||': return mk(x !== 0n || y !== 0n ? 1n : 0n, 'int');
    }
    return mk(r, rt);
  };
  GDB.prototype.neg = function (x) {
    x = this.rv(x);
    if (x.voidc) throw GErr('Argument to arithmetic operation not a number or boolean.');
    if (isPtr(x.t) || x.t === 'textptr') throw GErr('Argument to arithmetic operation not a number or boolean.');
    var t = promote(x.t); return mk(-sv(x), t);
  };
  GDB.prototype.deref = function (x) {
    if (x.nodebug) throw this.nodebugErr(x);
    if (x.func) return x;
    if (x.t === 'textptr') return { func: true, v: x.v, t: 'func', name: null };
    if (x.t === 'code *') return { codefn: true, v: x.v, t: 'codefn' };
    if (x.voidc || !isPtr(x.t)) throw GErr('Attempt to take contents of a non-pointer value.');
    if (x.t === 'void *') throw GErr('Attempt to dereference a generic pointer.');
    if (x.t === 'nodebug *') throw this.nodebugErr({ name: x.name });
    if (x.optimized) throw GErr('value has been optimized out');
    if (x.t === 'FILE *') throw GErr('[simulator: printing a whole FILE struct is not supported here]');
    var pt = pointee(x.t);
    return { v: this.mread(x.v, tsize(pt)), t: pt, lval: { addr: x.v } };
  };
  GDB.prototype.addrOf = function (x) {
    if (x.nodebug) return { v: x.addr, t: 'nodebug *', name: x.name, nodebugPtr: true };
    if (x.lval) return { v: x.lval.addr, t: canonType(x.t + ' *') };
    if (x.func) return { v: x.v, t: 'textptr' };
    if (x.codefn) return { v: x.v, t: 'code *' };
    throw GErr('Attempt to take address of value not located in memory.');
  };
  GDB.prototype.atAddr = function (x, ty) {
    var a = x.nodebug ? x.addr : (x.func ? x.v : BigInt.asUintN(64, isPtr(x.t) || x.t === 'textptr' ? x.v : sv(x)));
    if (ty === 'void') throw GErr('Attempt to take contents of a non-pointer value.');
    return { v: this.mread(a, tsize(ty)), t: ty, lval: { addr: a } };
  };
  GDB.prototype.cast = function (x, ty) {
    if (x.voidc) throw GErr('Invalid cast.');
    if (x.nodebug) { return { v: this.mread(x.addr, tsize(ty)), t: ty, lval: { addr: x.addr }, softwatch: true }; }
    if (ty === 'void') return { voidc: true };
    x = this.rv(x);
    var raw = (isPtr(x.t) || x.t === 'textptr' || x.t === 'codefn') ? BigInt.asUintN(64, x.v) : sv(x);
    return mk(raw, ty);
  };
  GDB.prototype.regOrConv = function (name) {
    var R = this.emu.R, isReg = name === 'pc' || name === 'sp' || name === 'fp' || name === 'eflags' || name === 'fs_base' || name === 'gs_base' || /^(cs|ss|ds|es|fs|gs)$/.test(name) || !!Emu.REG[name];
    if (name === '_exitcode') return this.conv._exitcode || { voidc: true };
    if (!isReg) return this.conv[name] ? Object.assign({ conv: name }, this.conv[name]) : { voidc: true, conv: name };
    if (!this.running) throw GErr('No registers.');
    var s = this.selected(), f = s.f;
    if (name === 'pc' || name === 'rip') return { v: f.pc, t: 'code *', reg: 'rip' };
    if (name === 'sp' || name === 'rsp') return { v: s.idx === 0 ? R.rsp : this.cfa(s.fr[s.idx - 1]), t: 'void *', reg: 'rsp' };
    if (name === 'fp' || name === 'rbp') return { v: this.frameReg('rbp', s), t: 'void *', reg: 'rbp' };
    if (name === 'eflags') return { v: R.eflags, t: 'eflags', reg: 'eflags' };
    if (name === 'fs_base') return { v: this.emu.fsBase, t: 'long', reg: name };
    if (name === 'gs_base') return { v: 0n, t: 'long', reg: name };
    if (/^(cs|ss|ds|es|fs|gs)$/.test(name)) return { v: { cs: 0x33n, ss: 0x2bn }[name] || 0n, t: 'int', reg: name };
    var d = Emu.REG[name], t = d.size === 8 ? 'long' : d.size === 4 ? 'int' : d.size === 2 ? 'short' : 'int8';
    var full = d.size === 8 ? this.frameReg(d.r, s) : null;
    return { v: full !== null ? full : this.emu.getReg(name), t: t, reg: name };
  };
  /* value of a 64-bit register in the selected frame (callee-saved ones are unwound from prologue pushes) */
  GDB.prototype.frameReg = function (r, s) {
    var R = this.emu.R;
    if (!s || s.idx === 0) return R[r];
    if (r === 'rip') return s.f.pc;
    if (r === 'rsp') return this.cfa(s.fr[s.idx - 1]);
    var val = R[r];
    for (var k = 0; k < s.idx; k++) { var sv2 = this.savedRegs(s.fr[k]); if (sv2[r] !== undefined) { try { val = this.mread(sv2[r], 8); } catch (e) { } } }
    return val;
  };
  GDB.prototype.savedRegs = function (fr) {
    var out = {}, fn = this.funcAt(fr.pc); if (!fn || fr.lib) return out;
    var cfa = this.cfa(fr), j = 0;
    for (var i = 0; i < fn.lines.length; i++) {
      var l = fn.lines[i], m = /^push\s+%(r\w+)$/.exec(l[2]);
      if (!m) break;
      if (!fr.outer && fr.pc <= BigInt(l[0])) break;
      j++; out[m[1]] = cfa - 8n - 8n * BigInt(j);
    }
    out.rip = cfa - 8n;
    return out;
  };
  GDB.prototype.histVal = function (name) {
    var h = this.valHist, idx;
    if (name === '') idx = h.length - 1;
    else if (name === '$') idx = h.length - 2;
    else if (name[0] === '$') idx = h.length - 1 - parseInt(name.slice(1), 10);
    else { idx = parseInt(name, 10) - 1; if (idx >= h.length || idx < 0) throw GErr('History has not yet reached $' + name + '.'); }
    if (idx < 0 || idx >= h.length) return { voidc: true };
    return h[idx];
  };

  /* ---------------- value formatting ---------------- */
  GDB.prototype.fmtVal = function (x, fmt) {
    if (x.voidc) return 'void';
    if (x.optimized) return '<optimized out>';
    var f = fmt ? fmt.replace(/[0-9bhwg]/g, '') : '';
    if (x.func) {
      if (f && f !== 'a') return this.fmtNum(x.v, 'unsigned long', f);
      var lb = this.labelU(x.v); return '{<text variable, no debug info>} ' + hx(x.v) + (lb ? ' ' + lb : '');
    }
    if (x.codefn) { var lc = this.labelU(x.v); return '{void ()} ' + hx(x.v) + (lc ? ' ' + lc : ''); }
    if (f && f !== 's') return this.fmtNum(x.v, x.t, f);
    var t = x.t;
    if (t === 'eflags') return this.flagStr(x.v);
    if (t === 'code *') { var l1 = this.labelU(x.v); return '(void (*)()) ' + hx(x.v) + (l1 ? ' ' + l1 : ''); }
    if (t === 'textptr') { var l2 = this.labelU(x.v); return '(<text variable, no debug info> *) ' + hx(x.v) + (l2 ? ' ' + l2 : ''); }
    if (t === 'nodebug *') { var l3 = this.labelU(x.v); return '(<data variable, no debug info> *) ' + hx(x.v) + (l3 ? ' ' + l3 : ''); }
    if (isPtr(t)) {
      var pt = pointee(t);
      if (pt === 'char' || pt === 'unsigned char' || pt === 'signed char') return hx(x.v) + ' ' + this.strAt(x.v);
      var l4 = this.labelU(x.v); return '(' + t + ') ' + hx(x.v) + (l4 ? ' ' + l4 : '');
    }
    if (t === 'char' || t === 'signed char' || t === 'unsigned char') { var cv = sv(x); return cv + " '" + chRep(Number(BigInt.asUintN(8, x.v)), "'") + "'"; }
    return sv(x).toString();
  };
  GDB.prototype.fmtNum = function (v, t, f) {
    var size = tsize(t), bits = BigInt(size * 8), u = BigInt.asUintN(Number(bits), v), s = BigInt.asIntN(Number(bits), v);
    switch (f) {
      case 'x': return hx(u);
      case 'z': return hx(u, size * 2);
      case 'd': return s.toString();
      case 'u': return u.toString();
      case 'o': return u === 0n ? '0' : '0' + u.toString(8);
      case 't': return u.toString(2);
      case 'c': { var c = Number(BigInt.asUintN(8, v)); return BigInt.asIntN(8, v).toString() + " '" + chRep(c, "'") + "'"; }
      case 'a': { var lb = this.labelU(u); return hx(u) + (lb ? ' ' + lb : ''); }
      case 'f': return (size === 4 || size === 8) && !/char|short/.test(t) ? (t === 'int' || t === 'long' || /unsigned|\*/.test(t) ? s.toString() : asFloat(v, size)) : s.toString();
      case 'i': throw GErr('Format letter "i" is meaningless in "print" command.');
    }
    throw GErr('Undefined output format "' + f + '".');
  };
  GDB.prototype.flagStr = function (ef) {
    var names = [[0, 'CF'], [2, 'PF'], [4, 'AF'], [6, 'ZF'], [7, 'SF'], [8, 'TF'], [9, 'IF'], [10, 'DF'], [11, 'OF']], o = [];
    names.forEach(function (n) { if ((ef >> BigInt(n[0])) & 1n) o.push(n[1]); });
    return '[ ' + o.join(' ') + (o.length ? ' ' : '') + ']';
  };
  GDB.prototype.record = function (x) { this.valHist.push(x); return this.valHist.length; };

  /* ---------------- questions ---------------- */
  GDB.prototype.ask = function (text, kind, cb) {
    if (!this.confirm) { cb.call(this, kind !== 'yN'); return; }
    this.out(text);
    this.question = { text: text, kind: kind, cb: cb };
  };
  GDB.prototype.answer = function (line) {
    var q = this.question, a = line.trim().toLowerCase();
    if (q.kind === 'yN') {
      if (a === '' || a === 'n' || a === 'no') { this.question = null; q.cb.call(this, false); return; }
      if (a === 'y' || a === 'yes') { this.question = null; q.cb.call(this, true); return; }
      this.out('Please answer y or [n].\n' + q.text); return;
    }
    if (a === 'y' || a === 'yes') { this.question = null; q.cb.call(this, true); return; }
    if (a === 'n' || a === 'no') { this.question = null; q.cb.call(this, false); return; }
    this.out('Please answer y or n.\n' + q.text);
  };

  /* ---------------- breakpoints ---------------- */
  GDB.prototype.dispAddr = function (bp) { return (this.loaded || bp.literal) ? bp.addr : BigInt.asUintN(64, bp.addr - this.delta); };
  GDB.prototype.resolveLoc = function (spec, forBreak) {
    spec = spec.trim(); var m;
    if (spec[0] === '*') {
      var lit = /^\*\s*(0x[0-9a-f]+|\d+)\s*$/i.test(spec), v = this.rv(this.evalExpr(spec.slice(1)));
      var val = BigInt.asUintN(64, isPtr(v.t) || v.t === 'textptr' || v.t === 'code *' ? v.v : sv(v));
      var rt = lit && forBreak ? val : this.toRt(val);
      var o = { addr: rt, literal: lit, trap: !this.inText(rt) && !this.isLibAddr(rt) };
      var L = this.mainLines.get(rt); if (L !== undefined) o.line = L;
      return o;
    }
    if ((m = /^(?:(\S+\.c):)?(\d+)$/.exec(spec))) {
      var want = parseInt(m[2], 10), best = null, bestLn = null, self = this;
      this.codeStarts.forEach(function (a) { var ln = self.lineStarts.get(a); if (ln >= want && (bestLn === null || ln < bestLn || (ln === bestLn && a < best))) { best = a; bestLn = ln; } });
      if (best === null || want < 1 || want > this.src.length) throw GErr('No line ' + want + ' in the current file.', 'pending');
      return { addr: best, line: bestLn, func: 'main' };
    }
    var f = this.data.funcs[spec];
    if (f) {
      var sb = this.data.static_bp[spec];
      var addr = sb ? BigInt(sb[0]) + this.delta : BigInt(f.start);
      var lnm = /line (\d+)/.exec(sb && sb[1] || '');
      return { addr: addr, func: spec, line: lnm ? parseInt(lnm[1], 10) : undefined };
    }
    var pm = /^(.*?)(@plt)?$/.exec(spec);
    if (this.pltAddr[pm[1]] !== undefined) {
      if (pm[2] || !this.loaded || this.libcAddr[pm[1]] === undefined) return { addr: this.pltAddr[pm[1]], func: pm[1] + '@plt', plt: true, libName: pm[2] ? null : pm[1] };
      return { addr: this.libcAddr[pm[1]] + 4n, func: pm[1], lib: true };
    }
    throw GErr('Function "' + spec + '" not defined.');
  };
  GDB.prototype.isLibAddr = function (rt) { for (var n in this.libcAddr) { var a = this.libcAddr[n]; if (rt >= a && rt < a + 0x400n) return true; } return false; };
  GDB.prototype.bpsAt = function (rt) { return this.bps.filter(function (b) { return !b.pending && !b.watch && b.addr === rt; }); };
  GDB.prototype.cmdBreak = function (arg, temp) {
    arg = (arg || '').trim();
    var cond = null, cm = /^(.*?)\s+if\s+(.*)$/.exec(arg) || /^if\s+(.*)$/.exec(arg) && [null, '', /^if\s+(.*)$/.exec(arg)[1]];
    if (cm) { arg = cm[1].trim(); cond = cm[2]; }
    if (!arg) {
      if (!this.running) { this.out('No default breakpoint address now.\n'); return; }
      var s = this.selected(); arg = '*' + this.toUser(s.f.pc).toString();
    }
    var loc;
    try { loc = this.resolveLoc(arg, true); }
    catch (e) {
      this.out(e.message + '\n');
      if (/not defined\.$|No line \d+ in the current file\./.test(e.message)) {
        var spec = arg;
        this.ask('Make breakpoint pending on future shared library load? (y or [n]) ', 'yN', function (yes) {
          if (!yes) return;
          var num = ++this.bpNum;
          this.bps.push({ num: num, pending: true, spec: spec, temp: temp, enabled: true, hits: 0, cond: cond });
          this.out((temp ? 'Temporary breakpoint ' : 'Breakpoint ') + num + ' (' + spec + ') pending.\n');
        });
      }
      return;
    }
    if (cond) { try { this.evalExpr(cond); } catch (e2) { if (!e2.mem && !/No registers/.test(e2.message)) { this.out(e2.message + '\n'); return; } } }
    var bp = { num: ++this.bpNum, temp: temp, addr: loc.addr, enabled: true, hits: 0, spec: arg, func: loc.func, line: loc.line, literal: !!loc.literal, trap: !!loc.trap, cond: cond, plt: loc.plt, libName: loc.libName };
    var others = this.bpsAt(loc.addr);
    if (others.length) {
      var nums = others.map(function (b) { return b.num; }), lst = nums.length === 1 ? 'breakpoint ' + nums[0] : 'breakpoints ' + nums.slice(0, -1).join(', ') + ' and ' + nums[nums.length - 1];
      this.out('Note: ' + lst + ' also set at pc ' + hx(this.dispAddr(bp)) + '.\n');
    }
    this.bps.push(bp);
    var suffix = loc.line !== undefined ? ': file bomb.c, line ' + loc.line + '.' : '';
    this.out((temp ? 'Temporary breakpoint ' : 'Breakpoint ') + bp.num + ' at ' + hx(this.dispAddr(bp)) + suffix + '\n');
  };
  GDB.prototype.cmdWatch = function (arg) {
    arg = (arg || '').trim();
    if (!arg) { this.out('Argument required (expression to compute).\n'); return; }
    var v;
    try { v = this.evalExpr(arg); if (v.nodebug) throw this.nodebugErr(v); } catch (e) { this.out(e.message + '\n'); return; }
    var hw = !!v.lval && !v.softwatch;
    var w = { num: ++this.bpNum, watch: true, hw: hw, expr: arg, enabled: true, hits: 0, old: this.watchStr(arg) };
    this.bps.push(w); this.watchCount++;
    this.out((hw ? 'Hardware watchpoint ' : 'Watchpoint ') + w.num + ': ' + arg + '\n');
  };
  GDB.prototype.watchStr = function (expr) { try { return this.fmtVal(this.evalExpr(expr)); } catch (e) { return '<unreadable>'; } };
  GDB.prototype.watchCheck = function () {
    for (var i = 0; i < this.bps.length; i++) {
      var w = this.bps[i]; if (!w.watch || !w.enabled) continue;
      var nv = this.watchStr(w.expr);
      if (nv !== w.old) { var old = w.old; w.old = nv; w.hits++; return { watch: w, old: old, nw: nv }; }
    }
    return null;
  };
  GDB.prototype.bpCheck = function (pc) {
    for (var i = 0; i < this.bps.length; i++) {
      var b = this.bps[i];
      if (!b.enabled || b.pending || b.watch || b.trap || b.addr !== pc) continue;
      if (b.cond) {
        var ok;
        try { var cv = this.evalExpr(b.cond); ok = cv.voidc ? false : (isPtr(cv.t) ? cv.v !== 0n : sv(this.rv(cv)) !== 0n); }
        catch (e) { b.hits++; return { condErr: b, msg: e.message }; }
        if (!ok) continue;
      }
      b.hits++;
      return { bp: b };
    }
    return null;
  };
  GDB.prototype.removeBp = function (bp) { this.bps = this.bps.filter(function (x) { return x !== bp; }); this.watchCount = this.bps.filter(function (x) { return x.watch; }).length; };
  GDB.prototype.cmdInfoBreak = function (watchOnly) {
    var list = this.bps.filter(function (b) { return !watchOnly || b.watch; });
    if (!list.length) { this.out(watchOnly ? 'No watchpoints.\n' : 'No breakpoints, watchpoints, tracepoints, or catchpoints.\n'); return; }
    var allPending = list.every(function (b) { return b.pending || b.watch; }), aw = allPending ? 10 : 18, self = this;
    this.out('Num     Type           Disp Enb ' + pad('Address', aw) + ' What\n');
    list.forEach(function (b) {
      var type = b.watch ? (b.hw ? 'hw watchpoint' : 'watchpoint') : 'breakpoint';
      var addr = b.watch ? pad('', aw) : b.pending ? pad('<PENDING>', aw) : hx(self.dispAddr(b), 16);
      var what;
      if (b.watch) what = b.expr;
      else if (b.pending) what = b.spec;
      else if (b.line !== undefined) what = 'in main at bomb.c:' + b.line;
      else { var lb = self.labelRt(b.addr); what = b.lib ? (lb || '') + (lb ? '' : '') : (lb || ''); if (b.lib) what = '<' + b.func + '+4>'; }
      self.out(pad(b.num, 8) + pad(type, 15) + (b.temp ? 'del ' : 'keep') + ' ' + (b.enabled ? 'y' : 'n') + '   ' + addr + (what ? ' ' + what : '') + '\n');
      if (b.cond) self.out('\tstop only if ' + b.cond + '\n');
      if (b.hits) self.out('\tbreakpoint already hit ' + b.hits + ' time' + (b.hits > 1 ? 's' : '') + '\n');
    });
  };
  GDB.prototype.bpNums = function (arg) {
    var out = [], self = this;
    arg.split(/\s+/).forEach(function (t) {
      if (!t) return;
      var r = /^(\d+)-(\d+)$/.exec(t);
      if (r) { for (var k = +r[1]; k <= +r[2]; k++) out.push(k); return; }
      if (!/^\d+$/.test(t)) { out.push(t); return; }
      out.push(+t);
    });
    return out;
  };
  GDB.prototype.cmdDelete = function (arg) {
    arg = (arg || '').trim();
    var dm = /^(?:display|disp)\b\s*(.*)$/.exec(arg); if (dm) return this.cmdUndisplay(dm[1]);
    var bm = /^(?:breakpoints|br|b)\b\s*(.*)$/.exec(arg); if (bm) arg = bm[1];
    if (!arg) {
      if (!this.bps.length) return;
      this.ask('Delete all breakpoints, watchpoints, tracepoints, and catchpoints? (y or n) ', 'yn', function (yes) { if (yes) { this.bps = []; this.watchCount = 0; } });
      return;
    }
    var self = this;
    this.bpNums(arg).forEach(function (n) {
      if (typeof n !== 'number') { self.out('Convenience variable must have integer value.\nArgs must be numbers or \'$\' variables.\n'); return; }
      var b = self.bps.filter(function (x) { return x.num === n; })[0];
      if (!b) self.out('No breakpoint number ' + n + '.\n'); else self.removeBp(b);
    });
  };
  GDB.prototype.cmdEnable = function (arg, on) {
    arg = (arg || '').trim(); var self = this;
    var dm = /^(?:display|disp)\b\s*(.*)$/.exec(arg);
    if (dm) { var ds = dm[1] ? this.bpNums(dm[1]) : null; this.displays.forEach(function (d) { if (!ds || ds.indexOf(d.num) >= 0) d.enabled = on; }); return; }
    var om = /^once\s+(.*)$/.exec(arg); if (om) arg = om[1];
    if (!arg) { this.bps.forEach(function (b) { b.enabled = on; }); return; }
    this.bpNums(arg).forEach(function (n) {
      var b = self.bps.filter(function (x) { return x.num === n; })[0];
      if (!b) self.out('No breakpoint number ' + n + '.\n'); else b.enabled = on;
    });
  };
  GDB.prototype.cmdCondition = function (arg) {
    var m = /^(\d+)\s*(.*)$/.exec((arg || '').trim());
    if (!m) { this.out('Argument required (breakpoint number).\n'); return; }
    var b = this.bps.filter(function (x) { return x.num === +m[1]; })[0];
    if (!b) { this.out('No breakpoint number ' + m[1] + '.\n'); return; }
    if (!m[2]) { b.cond = null; this.out('Breakpoint ' + b.num + ' now unconditional.\n'); return; }
    b.cond = m[2];
  };

  /* ---------------- running ---------------- */
  GDB.prototype.threadHdr = function () {
    this.out('[Thread debugging using libthread_db enabled]\n');
    this.out('Using host libthread_db library "/lib/x86_64-linux-gnu/libthread_db.so.1".\n');
  };
  GDB.prototype.cmdRun = function (arg, viaStart) {
    if (this.running) {
      this.ask('The program being debugged has been started already.\nStart it from the beginning? (y or n) ', 'yn', function (yes) {
        if (yes) this.doRun(arg, viaStart); else this.out('Program not restarted.\n');
      });
      return;
    }
    this.doRun(arg, viaStart);
  };
  GDB.prototype.doRun = function (arg, viaStart) {
    arg = (arg || '').trim();
    if (arg) this.args = arg;
    if (viaStart) {
      var sb = this.data.static_bp.main, ln = /line (\d+)/.exec(sb[1] || ''), rt = BigInt(sb[0]) + this.delta;
      var bp = { num: ++this.bpNum, temp: true, addr: rt, enabled: true, hits: 0, func: 'main', line: ln ? +ln[1] : undefined };
      this.bps.push(bp);
      this.out('Temporary breakpoint ' + bp.num + ' at ' + hx(this.loaded ? rt : BigInt(sb[0])) + (bp.line ? ': file bomb.c, line ' + bp.line + '.' : '') + '\n');
    }
    var argv = [], stdinLines = null, a = this.args, rm = /(?:^|\s)<\s*(\S+)/.exec(a);
    if (rm) {
      a = (a.slice(0, rm.index) + a.slice(rm.index + rm[0].length)).trim();
      var fname = rm[1], fb = fname.replace(/^.*\//, '');
      var txt = this.files[fname] !== undefined ? this.files[fname] : this.files[fb];
      if (txt === undefined) {
        this.out('Starting program: ' + this.progPath + ' ' + this.args + '\n/bin/bash: line 1: ' + fname + ': No such file or directory\nDuring startup program exited with code 1.\n');
        this.loaded = true; this.exited = true; this.running = false; return;
      }
      var parts = txt.split('\n'); if (parts.length && parts[parts.length - 1] === '') parts.pop();
      stdinLines = parts.concat([null]);
    }
    if (a) argv = a.split(/\s+/);
    this.reset();
    this.emu.start(argv, stdinLines);
    this.loaded = true; this.running = true; this.exited = false; this.conv._exitcode = undefined;
    this.pid = 1000 + Math.floor(Math.random() * 60000);
    this.out('Starting program: ' + this.progPath + (this.args ? ' ' + this.args : '') + '\n');
    this.threadHdr();
    var self = this;
    this.bps.forEach(function (b) {
      if (b.libName && self.libcAddr[b.libName] !== undefined) { b.addr = self.libcAddr[b.libName] + 4n; b.lib = true; b.func = b.libName; b.plt = false; b.libName = null; }
      if (b.watch) b.old = self.watchStr(b.expr);
    });
    var traps = this.bps.filter(function (b) { return b.enabled && b.trap; });
    if (traps.length) {
      this.out('Warning:\n'); traps.forEach(function (t) { self.out('Cannot insert breakpoint ' + t.num + '.\nCannot access memory at address ' + hx(t.addr) + '\n'); }); this.out('\n');
      return;
    }
    this.go({ mode: { si: true }, stop: null, skip: false });
  };
  GDB.prototype.notRunning = function () { if (!this.running) { this.out('The program is not being run.\n'); return true; } return false; };
  GDB.prototype.resumeGuard = function (continuing) {
    if (this.notRunning()) return true;
    if (this.sigPending) {
      if (continuing) this.out('Continuing.\n');
      var sig = this.sigPending;
      this.out('\nProgram terminated with signal ' + sig + ', ' + SIGDESC[sig] + '.\nThe program no longer exists.\n');
      this.running = false; this.exited = true; this.sigPending = null; return true;
    }
    var traps = this.bps.filter(function (b) { return b.enabled && b.trap; }), self = this;
    if (traps.length) {
      if (continuing) this.out('Continuing.\n');
      this.out('Warning:\n'); traps.forEach(function (t) { self.out('Cannot insert breakpoint ' + t.num + '.\nCannot access memory at address ' + hx(t.addr) + '\n'); });
      this.out('\nCommand aborted.\n'); return true;
    }
    return false;
  };
  GDB.prototype.go = function (o) {
    this.selFrame = 0;
    var r = this.loop(o.mode, o.stop, o.skip);
    if (r.block) { this.waiting = true; this.inRead = false; this.pend = o; return; }
    this.pend = null; this.waiting = false; this.inRead = false;
    this.report(r, o.done);
  };
  GDB.prototype.loop = function (mode, stop, skip) {
    var emu = this.emu, first = true, n = 0;
    for (; ;) {
      var pc = emu.R.rip;
      if (!(first && skip)) { var b = this.bpCheck(pc); if (b) return b; }
      if (!first && stop) { var s = stop.call(this, pc); if (s) return s; }
      if (++n > GUARD) return { runaway: true };
      first = false;
      var r = emu.step(mode);
      if (r) return r;
      if (this.watchCount) { var w = this.watchCheck(); if (w) return w; }
    }
  };
  GDB.prototype.report = function (r, done) {
    if (r.exit !== undefined) { this.endExit(r.exit); return; }
    if (r.signal) {
      this.sigPending = r.signal;
      if (r.signal === 'SIGABRT') { this.out('\nProgram received signal SIGABRT, Aborted.\n0x00007ffff7c969fc in pthread_kill () from ' + LIBC + '\n'); this.afterStop(); return; }
      this.out('\nProgram received signal ' + r.signal + ', ' + SIGDESC[r.signal] + '.\n' + this.where(false)); this.afterStop(); return;
    }
    if (r.runaway) { this.out('\n[simulator: paused after ' + GUARD + ' instructions without stopping; the program may be in a loop]\n\nProgram received signal SIGINT, Interrupt.\n' + this.where(false)); this.afterStop(); return; }
    if (r.bp) { var bp = r.bp; this.out('\n' + (bp.temp ? 'Temporary breakpoint ' : 'Breakpoint ') + bp.num + ', ' + this.where(false)); if (bp.temp) this.removeBp(bp); this.afterStop(); return; }
    if (r.condErr) { this.out('Error in testing condition for breakpoint ' + r.condErr.num + ':\n' + r.msg + '\n' + this.where(false)); this.afterStop(); return; }
    if (r.watch) { this.out('\n' + (r.watch.hw ? 'Hardware watchpoint ' : 'Watchpoint ') + r.watch.num + ': ' + r.watch.expr + '\n\nOld value = ' + r.old + '\nNew value = ' + r.nw + '\n' + this.where(false)); this.afterStop(); return; }
    if (done) done.call(this, r); else this.out(this.where(false));
    this.afterStop();
  };
  GDB.prototype.afterStop = function () {
    if (!this.running) return;
    this.noteListPos();
    if (this.dnl) {
      var pc = this.frames()[0].pc, ins = this.insAt(pc);
      if (ins) { var bytes = []; for (var i = 0; i < ins.len; i++) { try { bytes.push(hx(this.mread(pc + BigInt(i), 1), 2).slice(2)); } catch (e) { } } this.out('=> ' + hx(pc, 16) + ' ' + (this.labelRt(pc) || '') + ':\t' + bytes.join(' ') + '\t' + ins.text + '\n'); }
    }
    this.showDisplays();
  };
  GDB.prototype.noteListPos = function () {
    var f = this.frames()[this.selFrame] || this.frames()[0], fn = this.funcAt(f.pc);
    if (fn && fn.name === 'main' && !f.lib) { var L = this.lineFor(f.outer ? f.pc - 1n : f.pc); if (L !== undefined) { this.listCenter = L; this.listLast = null; } }
  };
  GDB.prototype.endExit = function (code) {
    this.out('[Inferior 1 (process ' + this.pid + ') exited ' + (code === 0 ? 'normally' : 'with code ' + (code ? '0' + (code & 0xff).toString(8) : '0')) + ']\n');
    this.running = false; this.exited = true; this.waiting = false; this.inRead = false; this.pend = null;
    this.conv._exitcode = mk(BigInt(code), 'int');
  };
  GDB.prototype.fromRead = function (pre, done) {
    if (pre) this.out(pre);
    var self = this;
    this.inRead = false;
    this.go({ mode: {}, stop: function (pc) { return self.inText(pc) && !self.emu.lib ? { done: true } : false; }, skip: true, done: done || function () { this.out(this.where(false)); } });
  };
  GDB.prototype.cmdContinue = function () {
    if (this.resumeGuard(true)) return;
    this.out('Continuing.\n');
    if (this.inRead) { this.inRead = false; this.go({ mode: { si: true }, stop: null, skip: false }); return; }
    this.go({ mode: { si: true }, stop: null, skip: true });
  };
  GDB.prototype.cmdStepi = function (n, over) {
    if (this.resumeGuard(false)) return;
    if (this.inRead) { this.fromRead(); return; }
    n = n || 1;
    var c0 = this.ctx(), self = this;
    for (var i = 0; i < n; i++) {
      var ins = this.emu.getIns(this.emu.R.rip), depth = this.emu.shadow.length, isCall = over && ins && ins.op === 'call';
      var stop = isCall ? function () { return self.emu.shadow.length <= depth ? { done: true } : false; } : function () { return { done: true }; };
      var last = i === n - 1;
      var o = { mode: { si: true, one: true }, stop: stop, skip: true, done: last ? function () { this.out(this.where(this.sameCtx(c0))); } : function () { } };
      this.selFrame = 0;
      var r = this.loop(o.mode, o.stop, o.skip);
      if (r.block) { this.waiting = true; o.done = function () { this.out(this.where(false)); }; this.pend = o; return; }
      if (!r.done || last) { this.report(r, o.done); return; }
    }
  };
  GDB.prototype.cmdFinish = function () {
    if (this.resumeGuard(false)) return;
    var s = this.selected();
    if (this.inRead) { this.fromRead('Run till exit from #0  ' + this.frameHead(0, s.fr[0]) + '\n'); return; }
    if (s.idx + 1 >= s.fr.length) { this.out('"finish" not meaningful in the outermost frame.\n'); return; }
    var target = s.f.sh !== undefined ? s.f.sh + 1 : this.emu.shadow.length;
    this.out('Run till exit from #' + s.idx + '  ' + this.frameHead(s.idx, s.f) + '\n');
    var self = this;
    this.go({ mode: { si: true }, stop: function () { return self.emu.shadow.length < target ? { done: true } : false; }, skip: true,
      done: function () { this.out(this.where(false)); } });
  };
  GDB.prototype.cmdStep = function (n, over) {
    if (this.resumeGuard(false)) return;
    if (this.inRead) { this.fromRead('Single stepping until exit from function read,\nwhich has no line number information.\n'); return; }
    n = n || 1;
    var self = this;
    var pc = this.emu.R.rip, fn = this.funcAt(pc), lib = this.emu.lib && !this.inText(pc);
    if (lib || !fn || fn.name !== 'main' || !this.mainLines.has(pc)) {
      var nm = lib ? this.emu.lib.name : fn ? fn.name : null;
      if (!nm) { this.out('Cannot find bounds of current function\n'); return; }
      this.out('Single stepping until exit from function ' + nm + ',\nwhich has no line number information.\n');
      var d0 = this.emu.shadow.length;
      this.go({ mode: { si: true }, stop: function (p) {
        if (self.emu.shadow.length >= d0) return false;
        var f2 = self.funcAt(p);
        if (f2 && f2.name === 'main' && self.lineStarts.get(p) !== self.mainLines.get(p)) return false;
        return { done: true };
      }, skip: true, done: function () { this.out(this.where(false)); } });
      return;
    }
    var startLine = this.mainLines.get(pc), depth = this.emu.shadow.length, left = n;
    var stop = function (p) {
      var d = self.emu.shadow.length;
      if (d > depth) return false;
      if (d < depth) return { done: true, out: true };
      if (self.lineStarts.get(p) !== undefined && self.mainLines.get(p) !== startLine) {
        if (--left > 0) { startLine = self.mainLines.get(p); return false; }
        return { done: true };
      }
      return false;
    };
    this.go({ mode: { si: true }, stop: stop, skip: true, done: function (r) { this.out(this.where(!r.out)); } });
  };
  GDB.prototype.cmdUntil = function (arg, advance) {
    if (this.resumeGuard(false)) return;
    arg = (arg || '').trim();
    if (!arg) { if (advance) { this.out('Argument required (a location).\n'); return; } return this.cmdStep(1, true); }
    var loc; try { loc = this.resolveLoc(arg); } catch (e) { this.out(e.message + '\n'); return; }
    var depth = this.emu.shadow.length, self = this, c0 = this.ctx();
    this.go({ mode: { si: true }, stop: function (p) { if (p === loc.addr) return { done: true }; if (self.emu.shadow.length < depth) return { done: true }; return false; }, skip: true,
      done: function () { this.out(this.where(false)); } });
  };
  GDB.prototype.cmdJump = function (arg) {
    if (this.resumeGuard(false)) return;
    var loc; try { loc = this.resolveLoc((arg || '').trim()); } catch (e) { this.out(e.message + '\n'); return; }
    this.out('Continuing at ' + hx(this.toUser(loc.addr)) + '.\n');
    this.emu.R.rip = loc.addr; this.emu.lib = null;
    this.go({ mode: { si: true }, stop: null, skip: false });
  };
  GDB.prototype.cmdReturn = function () {
    if (this.notRunning()) return;
    var s = this.selected();
    if (s.idx + 1 >= s.fr.length) { this.out('Can not force return from the outermost frame.\n'); return; }
    var mfn = this.funcAt(s.f.pc), name = (!s.f.lib && mfn && mfn.name === 'main') ? 'main' : 'selected stack frame';
    this.ask('Make ' + name + ' return now? (y or n) ', 'yn', function (yes) {
      if (!yes) { this.out('Not confirmed\n'); return; }
      var emu = this.emu, fr = this.frames(), k = this.selFrame;
      for (var i = 0; i <= k; i++) {
        var f = fr[i], sv2 = this.savedRegs(f), ent = emu.shadow[f.sh !== undefined ? f.sh : emu.shadow.length - 1];
        for (var r in sv2) if (r !== 'rip') { try { emu.R[r] = this.mread(sv2[r], 8); } catch (e) { } }
        emu.R.rip = ent.ret; emu.R.rsp = ent.sp + 8n; emu.shadow.length = f.sh !== undefined ? f.sh : emu.shadow.length - 1;
      }
      emu.lib = null; this.inRead = false; this.waiting = false; this.pend = null; this.selFrame = 0;
      var nf = this.frames()[0];
      this.out('#0  ' + this.frameHead(0, nf) + '\n' + this.frameSrc(nf));
    });
  };
  GDB.prototype.cmdKill = function () {
    if (!this.running) { this.out('The program is not being run.\n'); return; }
    this.ask('Kill the program being debugged? (y or n) ', 'yn', function (yes) {
      if (!yes) { this.out('Not confirmed.\n'); return; }
      this.out('[Inferior 1 (process ' + this.pid + ') killed]\n');
      this.running = false; this.exited = false; this.waiting = false; this.inRead = false; this.pend = null; this.sigPending = null;
    });
  };
  GDB.prototype.feedStdin = function (line) {
    this.emu.stdinQ.push(line);
    var o = this.pend || { mode: { si: true }, stop: null };
    this.waiting = false;
    this.go({ mode: o.mode, stop: o.stop, skip: false, done: o.done });
  };
  GDB.prototype.feedEOF = function () { return this.feedStdin(null); };
  GDB.prototype.ctrlD = function () {
    if (this.question) { this.out('EOF [answered Y; input not from terminal]\n'); var q = this.question; this.question = null; q.cb.call(this, true); return 'eof'; }
    if (this.waiting) { this.feedEOF(); return 'stdin'; }
    this.out('quit\n'); this.exec('quit'); return 'quit';
  };
  GDB.prototype.interrupt = function () {
    if (this.question) { this.out('Quit\n'); this.question = null; return true; }
    if (this.running && this.waiting) {
      this.out('^C\nProgram received signal SIGINT, Interrupt.\n' + hx(READ_PC, 16) + ' in read () from ' + LIBC + '\n');
      this.waiting = false; this.inRead = true; this.selFrame = 0;
      this.showDisplays();
      return true;
    }
    this.out('Quit\n');
    return false;
  };

  /* ---------------- stack ---------------- */
  GDB.prototype.cmdBt = function (arg) {
    if (!this.running) { this.out('No stack.\n'); return; }
    var fr = this.frames(), n = parseInt((arg || '').replace(/full/, '').trim(), 10), lo = 0, hi = fr.length;
    if (n > 0) hi = Math.min(n, fr.length); else if (n < 0) lo = Math.max(0, fr.length + n);
    for (var i = lo; i < hi; i++) this.out('#' + i + '  ' + this.frameHead(i, fr[i]) + '\n');
    if (hi < fr.length) this.out('(More stack frames follow...)\n');
  };
  GDB.prototype.cmdFrame = function (kind, arg) {
    if (!this.running) { this.out('No stack.\n'); return; }
    var fr = this.frames(), n = parseInt(arg, 10);
    if (kind === 'up') { n = isNaN(n) ? 1 : n; if (this.selFrame + n >= fr.length) { if (this.selFrame === fr.length - 1) { this.out('Initial frame selected; you cannot go up.\n'); return; } this.selFrame = fr.length - 1; } else this.selFrame += n; }
    else if (kind === 'down') { n = isNaN(n) ? 1 : n; if (this.selFrame - n < 0) { if (this.selFrame === 0) { this.out('Bottom (innermost) frame selected; you cannot go down.\n'); return; } this.selFrame = 0; } else this.selFrame -= n; }
    else if (!isNaN(n)) { if (n >= fr.length || n < 0) { this.out('No frame at level ' + arg.trim() + '.\n'); return; } this.selFrame = n; }
    var f = fr[this.selFrame];
    this.out('#' + this.selFrame + '  ' + this.frameHead(this.selFrame, f) + '\n' + this.frameSrc(f));
    this.noteListPos();
  };
  GDB.prototype.cmdInfoFrame = function () {
    if (!this.running) { this.out('No stack.\n'); return; }
    var s = this.selected(), f = s.f, k = s.idx, fr = s.fr, cfa = this.cfa(f), fn = this.funcAt(f.pc), nm = f.lib || (fn ? fn.name : '??');
    var ent = this.emu.shadow[f.sh !== undefined ? f.sh : this.emu.shadow.length - 1];
    var isMain = fn && fn.name === 'main' && !f.lib, L = isMain ? this.lineFor(f.outer ? f.pc - 1n : f.pc) : undefined;
    this.out('Stack level ' + k + ', frame at ' + hx(cfa) + ':\n');
    this.out(' rip = ' + hx(f.pc) + ' in ' + nm + (isMain ? ' (bomb.c:' + L + ')' : '') + '; saved rip = ' + hx(ent ? ent.ret : 0n) + '\n');
    var rel = [];
    if (k + 1 < fr.length) rel.push('called by frame at ' + hx(this.cfa(fr[k + 1])));
    if (k > 0) rel.push('caller of frame at ' + hx(this.cfa(fr[k - 1])));
    if (rel.length) this.out(' ' + rel.join(', ') + '\n');
    if (isMain) this.out(' source language c.\n');
    this.out(' Arglist at ' + hx(cfa - 16n) + ', args: ' + (isMain ? 'argc=<optimized out>, argv=<optimized out>' : '') + '\n');
    this.out(' Locals at ' + hx(cfa - 16n) + ', Previous frame\'s sp is ' + hx(cfa) + '\n');
    var sr = this.savedRegs(f), ks = Object.keys(sr).sort(function (a, b) { return REGNUM[a] - REGNUM[b]; });
    this.out(' Saved registers:\n  ' + ks.map(function (r) { return r + ' at ' + hx(sr[r]); }).join(', ') + '\n');
  };

  /* ---------------- print / x / display ---------------- */
  GDB.prototype.splitAssign = function (s) {
    var d = 0, q = false;
    for (var i = 0; i < s.length; i++) {
      var c = s[i];
      if (c === "'" || c === '"') q = !q;
      if (q) continue;
      if (c === '(' || c === '[' || c === '{') d++; else if (c === ')' || c === ']' || c === '}') d--;
      else if (c === '=' && d === 0 && s[i + 1] !== '=' && '=!<>'.indexOf(s[i - 1]) < 0) return [s.slice(0, i).trim(), s.slice(i + 1).trim()];
    }
    return null;
  };
  GDB.prototype.assign = function (lhs, rhs) {
    var rv = this.rv(this.evalExpr(rhs)), m = /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(lhs.trim());
    if (rv.voidc) throw GErr('Argument to arithmetic operation not a number or boolean.');
    if (m) {
      var name = m[1], R = this.emu.R;
      var isReg = name === 'pc' || name === 'sp' || name === 'fp' || name === 'eflags' || !!Emu.REG[name];
      if (!isReg) { this.conv[name] = { v: rv.v, t: rv.t }; return this.conv[name]; }
      if (!this.running) throw GErr('No registers.');
      var val = BigInt.asUintN(64, isPtr(rv.t) || rv.t === 'textptr' ? rv.v : sv(rv));
      if (name === 'pc' || name === 'rip') { R.rip = this.toRt(val); this.emu.lib = null; }
      else if (name === 'sp') R.rsp = val; else if (name === 'fp') R.rbp = val;
      else if (name === 'eflags') R.eflags = val & 0xffffffffn;
      else this.emu.setReg(name, val);
      return this.regOrConv(name === 'rip' ? 'pc' : name);
    }
    var lv = this.evalExpr(lhs);
    if (lv.nodebug) throw this.nodebugErr(lv);
    if (!lv.lval) throw GErr('Left operand of assignment is not an lvalue.');
    var sz = tsize(lv.t), nv = BigInt.asUintN(sz * 8, isPtr(rv.t) ? rv.v : sv(rv));
    this.mwrite(lv.lval.addr, sz, nv);
    return { v: nv, t: lv.t, lval: lv.lval };
  };
  GDB.prototype.cmdPrint = function (arg, quiet) {
    var fmt = null, m = /^\/(\w+)\s*/.exec(arg || ''); if (m) { fmt = m[1]; arg = arg.slice(m[0].length); }
    arg = (arg || '').trim();
    try {
      if (fmt && /[^xduotacfsiz0-9bhwg]/.test(fmt)) { var bad = fmt.replace(/[xduotacfsiz0-9bhwg]/g, '')[0]; throw GErr('Undefined output format "' + bad + '".'); }
      var v;
      if (!arg) { v = this.histVal(''); if (!this.valHist.length) { this.out('$1 = <error: No registers.>\n'); return; } }
      else { var as = this.splitAssign(arg); v = as ? this.assign(as[0], as[1]) : this.evalExpr(arg); }
      if (v.nodebug) throw this.nodebugErr(v);
      var txt = this.fmtVal(v, fmt);
      if (quiet) { this.out(txt); return; }
      var n = this.record(v);
      this.out('$' + n + ' = ' + txt + '\n');
    } catch (e) { if (!e.gdb) throw e; this.out(e.message + '\n'); }
  };
  GDB.prototype.parseXfmt = function (s) {
    var m = /^\/(\d*)([A-Za-z]*)\s*/.exec(s), o = { count: 1, f: null, u: null, rest: s };
    if (!m) return o;
    if (m[1]) o.count = parseInt(m[1], 10);
    for (var i = 0; i < m[2].length; i++) {
      var ch = m[2][i];
      if ('bhwg'.indexOf(ch) >= 0) o.u = ch; else if ('xduotacfsiz'.indexOf(ch) >= 0) o.f = ch; else throw GErr('Invalid format letter "' + ch + '".');
    }
    o.rest = s.slice(m[0].length);
    return o;
  };
  GDB.prototype.cmdX = function (arg, fromDisplay) {
    var o;
    try { o = this.parseXfmt((arg || '').trim()); } catch (e) { this.out(e.message + '\n'); return; }
    var f = o.f || this.xf, u = o.u || (o.f === 'a' ? 'g' : o.f === 'c' ? 'b' : (f === 's' || f === 'i') && !o.u ? this.xu : this.xu);
    if (!o.u && o.f === 'a') u = 'g'; if (!o.u && o.f === 'c') u = 'b';
    var addr;
    var expr = o.rest.trim();
    if (!expr) {
      if (this.xnext === null) { this.out('Argument required (starting display address).\n'); return; }
      addr = this.xnext;
    } else {
      try {
        var v = this.evalExpr(expr);
        if (v.nodebug) throw this.nodebugErr(v);
        if (v.voidc) throw GErr('Attempt to take contents of a non-pointer value.');
        addr = BigInt.asUintN(64, v.func || v.codefn ? v.v : (isPtr(v.t) || v.t === 'textptr' ? v.v : sv(v)));
      } catch (e) { if (!e.gdb) throw e; this.out(e.message + '\n'); return; }
    }
    if (!fromDisplay) { this.xf = f; if (f !== 's' && f !== 'i') this.xu = u; }
    if (f === 'i') return this.examineInsns(addr, o.count);
    if (f === 's') return this.examineStrs(addr, o.count);
    var usz = { b: 1, h: 2, w: 4, g: 8 }[u], per = f === 'c' ? 8 : (f === 'a' ? 2 : (usz === 8 ? 2 : usz === 4 ? 4 : 8));
    if (f === 'a') usz = 8;
    var done = 0, last = addr;
    while (done < o.count) {
      var lbl = this.labelU(addr), line = hx(addr) + (lbl ? ' ' + lbl : '') + ':';
      for (var k = 0; k < per && done < o.count; k++, done++) {
        var val;
        try { val = this.mread(addr, usz); } catch (e) { this.out(line === hx(addr) + (lbl ? ' ' + lbl : '') + ':' ? line + '\tCannot access memory at address ' + hx(addr) + '\n' : line + '\n' + hx(addr) + ':\tCannot access memory at address ' + hx(addr) + '\n'); this.xnext = addr; return; }
        line += '\t' + this.xval(val, f, usz);
        last = addr; addr = BigInt.asUintN(64, addr + BigInt(usz));
      }
      this.out(line + '\n');
    }
    this.xnext = addr; this.conv._ = { v: last, t: 'long' };
  };
  GDB.prototype.xval = function (val, f, usz) {
    var bits = usz * 8;
    switch (f) {
      case 'x': case 'z': return hx(val, usz * 2);
      case 'd': return BigInt.asIntN(bits, val).toString();
      case 'u': return BigInt.asUintN(bits, val).toString();
      case 'o': return val === 0n ? '0' : '0' + val.toString(8);
      case 't': { var b = val.toString(2); while (b.length < bits) b = '0' + b; return b; }
      case 'c': return BigInt.asIntN(8, val & 0xffn).toString() + " '" + chRep(Number(val & 0xffn), "'") + "'";
      case 'a': { var lb = this.labelU(val); return hx(val) + (lb ? ' ' + lb : ''); }
      case 'f': return (usz === 4 || usz === 8) ? asFloat(val, usz) : BigInt.asIntN(bits, val).toString();
    }
    return hx(val, usz * 2);
  };
  GDB.prototype.examineInsns = function (A, count) {
    var pcNow = this.running ? this.frames()[this.selFrame].pc : null;
    for (var k = 0; k < count; k++) {
      if (this.inRead && A === READ_PC) { this.out((pcNow === READ_PC ? '=> ' : '   ') + hx(A) + ' <read+17>:\tcmp    $0xfffffffffffff000,%rax\n'); A += 6n; continue; }
      var rt = this.toRt(A), ins = this.insAt(rt), lbl = this.labelU(A), arrow = (pcNow !== null && pcNow === rt) ? '=> ' : '   ';
      if (!ins) {
        try { this.mread(A, 1); } catch (e) { this.out(arrow + hx(A) + ':\tCannot access memory at address ' + hx(A) + '\n'); this.xnext = A; return; }
        this.out(arrow + hx(A) + (lbl ? ' ' + lbl : '') + ':\t(bad)\n'); A = BigInt.asUintN(64, A + 1n); continue;
      }
      this.out(arrow + hx(A) + (lbl ? ' ' + lbl : '') + ':\t' + this.rebase(ins.text) + '\n');
      this.conv._ = { v: A, t: 'long' };
      A = BigInt.asUintN(64, A + BigInt(ins.len));
    }
    this.xnext = A;
  };
  GDB.prototype.examineStrs = function (A, count) {
    for (var k = 0; k < count; k++) {
      var lbl = this.labelU(A), r;
      try { r = this.mstr(A, this.printElements); } catch (e) { this.out(hx(A) + (lbl ? ' ' + lbl : '') + ':\t<error: Cannot access memory at address ' + hx(A) + '>\n'); this.xnext = A; return; }
      var q = this.quoteStr(r.s, !!r.trunc);
      if (r.err !== undefined) q += '<error: Cannot access memory at address ' + hx(r.err) + '>';
      this.out(hx(A) + (lbl ? ' ' + lbl : '') + ':\t' + q + '\n');
      this.conv._ = { v: A, t: 'long' };
      A = BigInt.asUintN(64, A + BigInt(r.s.length + (r.trunc ? 0 : 1)));
    }
    this.xnext = A;
  };
  GDB.prototype.cmdDisplay = function (arg) {
    arg = (arg || '').trim();
    if (!arg) { this.showDisplays(); return; }
    var m = /^\/(\S+)\s*(.*)$/.exec(arg), fmt = m ? m[1] : null, expr = m ? m[2] : arg;
    var xstyle = !!fmt && (/[is]/.test(fmt) || /\d/.test(fmt) || /[bhwg]/.test(fmt));
    var d = { num: ++this.dispN, fmt: fmt, expr: expr, xstyle: xstyle, enabled: true };
    this.displays.push(d);
    if (this.running) this.showOne(d);
  };
  GDB.prototype.showOne = function (d) {
    if (!d.enabled) return;
    if (d.xstyle) { this.out(d.num + ': x/' + d.fmt + ' ' + d.expr + '\n'); this.cmdX('/' + d.fmt + ' ' + d.expr, true); return; }
    try { var v = this.evalExpr(d.expr); if (v.nodebug) throw this.nodebugErr(v); this.out(d.num + ': ' + (d.fmt ? '/' + d.fmt + ' ' : '') + d.expr + ' = ' + this.fmtVal(v, d.fmt) + '\n'); }
    catch (e) { if (!e.gdb) throw e; }
  };
  GDB.prototype.showDisplays = function () { if (!this.running) return; for (var i = 0; i < this.displays.length; i++) this.showOne(this.displays[i]); };
  GDB.prototype.cmdUndisplay = function (arg) {
    arg = (arg || '').trim();
    if (!arg) { if (!this.displays.length) return; this.ask('Delete all auto-display expressions? (y or n) ', 'yn', function (yes) { if (yes) this.displays = []; }); return; }
    var self = this;
    this.bpNums(arg).forEach(function (n) { var before = self.displays.length; self.displays = self.displays.filter(function (d) { return d.num !== n; }); if (self.displays.length === before) self.out('No display number ' + n + '.\n'); });
  };
  GDB.prototype.cmdInfoDisplay = function () {
    if (!this.displays.length) { this.out('There are no auto-display expressions now.\n'); return; }
    this.out('Auto-display expressions now in effect:\nNum Enb Expression\n');
    var self = this;
    this.displays.forEach(function (d) {
      var f = d.fmt ? '/' + d.fmt + ' ' : '';
      if (d.xstyle) { var o = self.parseXfmt('/' + d.fmt); var ff = o.f || 'x'; f = '/' + o.count + ((ff === 'i' || ff === 's') ? 'b' : (o.u || 'w')) + ff + ' '; }
      self.out(d.num + ':   ' + (d.enabled ? 'y' : 'n') + '  ' + f + d.expr + '\n');
    });
  };

  /* ---------------- printf / echo ---------------- */
  GDB.prototype.unescape = function (s) {
    return s.replace(/\\([0-7]{1,3}|.)/g, function (m, c) { if (/^[0-7]+$/.test(c)) return String.fromCharCode(parseInt(c, 8)); return { n: '\n', t: '\t', r: '\r', a: '\x07', '\\': '\\', '"': '"', "'": "'", e: '\x1b' }[c] !== undefined ? { n: '\n', t: '\t', r: '\r', a: '\x07', '\\': '\\', '"': '"', "'": "'", e: '\x1b' }[c] : c; });
  };
  GDB.prototype.splitArgs = function (s) {
    var out = [], d = 0, q = null, cur = '';
    for (var i = 0; i < s.length; i++) {
      var c = s[i];
      if (q) { cur += c; if (c === '\\') { cur += s[++i] || ''; continue; } if (c === q) q = null; continue; }
      if (c === '"' || c === "'") { q = c; cur += c; continue; }
      if (c === '(' || c === '[' || c === '{') d++; if (c === ')' || c === ']' || c === '}') d--;
      if (c === ',' && d === 0) { out.push(cur.trim()); cur = ''; continue; }
      cur += c;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  };
  GDB.prototype.cmdPrintf = function (arg) {
    var parts = this.splitArgs(arg || '');
    if (!parts.length || !/^".*"$/.test(parts[0])) { this.out('Bad format string\n'); return; }
    var fmt = this.unescape(parts[0].slice(1, -1)), vals = parts.slice(1), out = '', self = this, ai = 0;
    try {
      out = fmt.replace(/%([-+ 0#]*)(\d*)(?:\.(\d+))?(hh|h|ll|l|z)?([diouxXcsp%])/g, function (m, fl, w, pr, len, conv) {
        if (conv === '%') return '%';
        if (ai >= vals.length) throw GErr('Bad format string, missing \'"\'');
        var v = self.rv(self.evalExpr(vals[ai++])), s;
        var big = len === 'l' || len === 'll' || len === 'z';
        if (conv === 's') s = (function () { try { return self.mstr(BigInt.asUintN(64, v.v), 0).s; } catch (e) { return '<error>'; } })();
        else if (conv === 'c') s = String.fromCharCode(Number(v.v & 0xffn));
        else if (conv === 'p') s = hx(v.v);
        else {
          var n = big ? BigInt.asIntN(64, v.v) : BigInt.asIntN(32, v.v), un = big ? BigInt.asUintN(64, v.v) : BigInt.asUintN(32, v.v);
          s = conv === 'd' || conv === 'i' ? n.toString() : conv === 'u' ? un.toString() : conv === 'o' ? un.toString(8) : conv === 'x' ? un.toString(16) : un.toString(16).toUpperCase();
          if (fl.indexOf('#') >= 0 && (conv === 'x' || conv === 'X') && un !== 0n) s = (conv === 'x' ? '0x' : '0X') + s;
        }
        if (pr && conv === 's') s = s.slice(0, +pr);
        var W = +w || 0;
        if (s.length < W) s = fl.indexOf('-') >= 0 ? pad(s, W) : (fl.indexOf('0') >= 0 && conv !== 's' && conv !== 'c' ? s.padStart(W, '0') : lpad(s, W));
        return s;
      });
    } catch (e) { if (!e.gdb) throw e; this.out(e.message + '\n'); return; }
    this.out(out);
  };

  /* ---------------- info ---------------- */
  var IREGS = ['rax', 'rbx', 'rcx', 'rdx', 'rsi', 'rdi', 'rbp', 'rsp', 'r8', 'r9', 'r10', 'r11', 'r12', 'r13', 'r14', 'r15'];
  GDB.prototype.cmdInfoReg = function (which) {
    if (!this.running) { this.out('The program has no registers now.\n'); return; }
    var self = this, s = this.selected(), R = this.emu.R, inRead = this.inRead && s.idx === 0;
    function row(name, hexv, nat) { self.out(pad(name, 15) + pad(hexv, 20) + nat + '\n'); }
    function val(r) {
      if (inRead) { if (r === 'rax') return 0xfffffffffffffe00n; if (r === 'rdi') return 0n; if (r === 'rdx') return 0x400n; if (r === 'rip') return READ_PC; }
      if (r === 'rip') return s.f.pc;
      return self.frameReg(r, s);
    }
    function one(r) {
      r = r.replace(/^\$/, '');
      if (r === 'pc') r = 'rip';
      if (r === 'eflags') { row('eflags', hx(R.eflags), self.flagStr(R.eflags)); return true; }
      if (r === 'rip') { var pc = val('rip'), lb = inRead ? '<read+17>' : self.labelRt(pc); row('rip', hx(pc), hx(pc) + (lb ? ' ' + lb : '')); return true; }
      if (/^(cs|ss|ds|es|fs|gs)$/.test(r)) { var sg = { cs: 0x33n, ss: 0x2bn }[r] || 0n; row(r, hx(sg), sg.toString()); return true; }
      if (r === 'fs_base') { row('fs_base', hx(self.emu.fsBase), BigInt.asIntN(64, self.emu.fsBase).toString()); return true; }
      if (r === 'gs_base') { row('gs_base', '0x0', '0'); return true; }
      var d = Emu.REG[r]; if (!d) return false;
      var v = d.size === 8 ? val(r) : self.emu.getReg(r);
      if (d.size === 8) row(r, hx(v), (r === 'rbp' || r === 'rsp') ? hx(v) : BigInt.asIntN(64, v).toString());
      else row(r, hx(v), BigInt.asIntN(d.size * 8, v).toString());
      return true;
    }
    which = (which || '').trim();
    if (which && which !== 'all' && which !== 'general') {
      var names = which.split(/\s+/);
      for (var i = 0; i < names.length; i++) if (!one(names[i])) { this.out('Invalid register `' + names[i].replace(/^\$/, '') + "'\n"); return; }
      return;
    }
    IREGS.forEach(function (r) { one(r); });
    ['rip', 'eflags', 'cs', 'ss', 'ds', 'es', 'fs', 'gs', 'fs_base', 'gs_base'].forEach(function (r) { one(r); });
  };
  GDB.prototype.cmdInfoFunctions = function (arg) {
    arg = (arg || '').trim();
    var re; try { re = new RegExp(arg); } catch (e) { this.out('Invalid regexp: ' + e.message + '\n'); return; }
    this.out(arg ? 'All functions matching regular expression "' + arg + '":\n' : 'All defined functions:\n');
    if (re.test('main')) this.out('\nFile bomb.c:\n36:\tint main(int, char **);\n');
    var self = this, list = [];
    this.textsyms.forEach(function (t) { if (t.name !== 'main' && re.test(t.name)) list.push({ a: t.addr, n: t.name }); });
    Object.keys(this.pltAddr).forEach(function (n) { if (re.test(n + '@plt')) list.push({ a: self.pltAddr[n], n: n + '@plt' }); });
    list.sort(function (a, b) { return cmpB(a.a, b.a); });
    if (list.length) { this.out('\nNon-debugging symbols:\n'); list.forEach(function (x) { self.out(hx(self.toUser(x.a), 16) + '  ' + x.n + '\n'); }); }
  };
  GDB.prototype.cmdInfoLine = function (arg) {
    arg = (arg || '').trim(); var rt, self = this;
    try {
      if (!arg) { if (!this.running) { this.out('No line number information available.\n'); return; } rt = this.frames()[this.selFrame].pc; }
      else if (/^(?:bomb\.c:)?\d+$/.test(arg)) {
        var want = parseInt(arg.replace(/^bomb\.c:/, ''), 10), loc = this.resolveLoc(arg); rt = loc.addr;
        if (loc.line !== want) { this.out('Line ' + want + ' of "bomb.c" is at address ' + hx(this.toUser(rt)) + ' ' + this.labelRt(rt) + ' but contains no code.\n'); return; }
      }
      else { var loc2 = this.resolveLoc(arg[0] === '*' ? arg : arg); rt = loc2.addr; }
    } catch (e) { this.out(e.message + '\n'); return; }
    var start = this.mainInsAt(rt), L = start !== null ? this.mainLines.get(start) : undefined;
    if (start !== null && this.inlineInfo[String(start)]) { this.out(this.rebase(this.inlineInfo[String(start)]) + '\n'); return; }
    if (L === undefined) { var lb = this.labelRt(rt); this.out('No line number information available for address ' + hx(this.toUser(rt)) + (lb ? ' ' + lb : '') + '\n'); return; }
    var entry = null, next = null;
    var cs = this.codeStarts.concat(Array.from(this.inlineStarts)).sort(cmpB);
    cs.forEach(function (a) { if (a <= rt && (entry === null || a > entry)) entry = a; });
    cs.forEach(function (a) { if (a > entry && (next === null || a < next)) next = a; });
    if (next === null) next = this.mainFn.start + this.mainFn.size;
    this.out('Line ' + L + ' of "bomb.c" starts at address ' + hx(this.toUser(entry)) + ' ' + this.labelRt(entry) + ' and ends at ' + hx(this.toUser(next)) + ' ' + (this.labelRt(next) || '') + '.\n');
  };
  GDB.prototype.sectionOf = function (rt) { for (var i = 0; i < this.sections.length; i++) { var s = this.sections[i]; if (rt >= s.lo && rt < s.hi) return s.name; } return null; };
  GDB.prototype.cmdInfoSymbol = function (arg) {
    var v; try { v = this.rv(this.evalExpr(arg || '')); } catch (e) { this.out(e.message + '\n'); return; }
    var A = BigInt.asUintN(64, isPtr(v.t) || v.t === 'textptr' ? v.v : sv(v)), rt = this.toRt(A), sec = this.sectionOf(rt);
    var f = this.funcAt(rt), p = this.pltAt(rt), s = this.symAt(rt), nm = null, base = null;
    if (f) { nm = f.name; base = f.start; } else if (p) { nm = p.name + '@plt'; base = p.start; } else if (s) { nm = s.name; base = s.addr; }
    if (nm && sec) { this.out(nm + (rt > base ? ' + ' + (rt - base) : '') + ' in section ' + sec + '\n'); return; }
    if (this.loaded) for (var n in this.libcAddr) { var a = this.libcAddr[n]; if (rt >= a && rt < a + 0x100n) { this.out(n + (rt > a ? ' + ' + (rt - a) : '') + ' in section .text of ' + LIBC + '\n'); return; } }
    this.out('No symbol matches ' + arg.trim() + '.\n');
  };
  GDB.prototype.cmdInfoAddress = function (arg) {
    arg = (arg || '').trim();
    if (!arg) { this.out('Argument required.\n'); return; }
    if (arg === 'main') { this.out('Symbol "main" is a function at address ' + hx(this.toUser(this.mainFn.start)) + '.\n'); return; }
    var v; try { v = this.symVal(arg); } catch (e) { this.out(e.message + '\n'); return; }
    this.out('Symbol "' + arg + '" is at ' + hx(v.func ? v.v : v.addr) + ' in a file compiled without debugging.\n');
  };
  GDB.prototype.cmdInfoProc = function (arg) {
    if (!this.running) { this.out('No current process: you must name one.\n'); return; }
    arg = (arg || '').trim();
    if (!arg || arg === 'all') { this.out('process ' + this.pid + '\ncmdline = \'' + this.progPath + (this.args ? ' ' + this.args : '') + '\'\ncwd = \'/home/student/bomblab\'\nexe = \'' + this.progPath + '\'\n'); if (!arg) return; }
    if (arg === 'mappings' || arg === 'all') {
      this.out((arg === 'all' ? '' : 'process ' + this.pid + '\n') + 'Mapped address spaces:\n\n          Start Addr           End Addr       Size     Offset  Perms  objfile\n');
      var self = this;
      var rows = (this.data.maps_all || []).slice(), heapLo = BigInt(this.emu.heapLo);
      if (this.emu.usedHeap && !rows.some(function (m) { return m[4] === '[heap]'; })) {
        var at = 0; rows.forEach(function (m, i) { if (BigInt(m[1]) === heapLo) at = i + 1; });
        rows.splice(at, 0, [Number(heapLo), Number(heapLo) + 0x21000, 0, 'rw-p', '[heap]']);
      }
      rows.forEach(function (m) {
        var s = BigInt(m[0]), e = BigInt(m[1]);
        self.out(lpad(hx(s), 20) + lpad(hx(e), 19) + lpad(hx(e - s), 11) + lpad(hx(BigInt(m[2])), 11) + '  ' + m[3] + '   ' + m[4] + '\n');
      });
      return;
    }
    this.out('Undefined info proc command: "' + arg + '".  Try "help info proc".\n');
  };
  GDB.prototype.cmdInfo = function (arg) {
    arg = (arg || '').trim();
    var m = /^(\S+)\s*(.*)$/.exec(arg); if (!m) { this.out('List of info subcommands:\n\ninfo address, info breakpoints, info display, info frame, info functions, info line, info proc, info registers, info sharedlibrary, info symbol, info watchpoints\n'); return; }
    var sub = m[1], rest = m[2];
    function is(full, min) { return full.indexOf(sub) === 0 && sub.length >= min; }
    if (is('breakpoints', 1)) return this.cmdInfoBreak(false);
    if (is('watchpoints', 3)) return this.cmdInfoBreak(true);
    if (is('registers', 1) || sub === 'reg') return this.cmdInfoReg(rest);
    if (is('all-registers', 2)) return this.cmdInfoReg('');
    if (is('functions', 3)) return this.cmdInfoFunctions(rest);
    if (is('frame', 1)) return this.cmdInfoFrame();
    if (is('display', 1)) return this.cmdInfoDisplay();
    if (is('line', 2)) return this.cmdInfoLine(rest);
    if (is('symbol', 2)) return this.cmdInfoSymbol(rest);
    if (is('address', 2)) return this.cmdInfoAddress(rest);
    if (is('proc', 3)) return this.cmdInfoProc(rest);
    if (is('stack', 1)) return this.cmdBt(rest);
    if (is('sharedlibrary', 2) || sub === 'dll') {
      if (!this.running) { this.out('No shared libraries loaded at this time.\n'); return; }
      this.out('From                To                  Syms Read   Shared Object Library\n0x00007ffff7fc6000  0x00007ffff7ff0195  Yes         /lib64/ld-linux-x86-64.so.2\n0x00007ffff7c28800  0x00007ffff7dadc8d  Yes         ' + LIBC + '\n'); return;
    }
    if (is('args', 2) || is('locals', 2)) {
      if (!this.running) { this.out('No frame selected.\n'); return; }
      var f = this.selected().f, fn = this.funcAt(f.pc);
      if (fn && fn.name === 'main' && !f.lib) { var entry = this.selFrame === 0 && f.pc === fn.start; this.out(sub[0] === 'a' ? (entry ? 'argc = ' + this.emu.argc + '\nargv = ' + hx(this.emu.argv) + '\n' : 'argc = <optimized out>\nargv = <optimized out>\n') : 'input = <optimized out>\n'); }
      else this.out('No symbol table info available.\n');
      return;
    }
    if (is('source', 2)) { this.out(this.loaded || this.src.length ? 'Current source file is bomb.c\nCompilation directory is /home/student/bomblab\nContains ' + this.src.length + ' lines.\nSource language is c.\n' : 'No current source file.\n'); return; }
    if (is('program', 3)) { if (!this.running) { this.out('The program being debugged is not being run.\n'); return; } this.out('\tUsing the running image of child process ' + this.pid + '.\nProgram stopped at ' + hx(this.emu.R.rip) + '.\n'); return; }
    this.out('Undefined info command: "' + sub + '".  Try "help info".\n');
  };

  /* ---------------- disassemble / list ---------------- */
  GDB.prototype.cmdDisas = function (arg) {
    arg = (arg || '').trim();
    var raw = false, mods = /^\/(\w+)\s*/.exec(arg);
    if (mods) { raw = mods[1].indexOf('r') >= 0; arg = arg.slice(mods[0].length); }
    var self = this, pcSel = this.running ? this.frames()[this.selFrame].pc : null;
    var line = function (rt, len, text, rel) {
      var A = self.toUser(rt), arrow = pcSel === rt ? '=> ' : '   ', bytes = '';
      if (raw) { var bs = []; for (var i = 0; i < len; i++) { try { bs.push(hx(self.mread(A + BigInt(i), 1), 2).slice(2)); } catch (e) { bs.push('??'); } } bytes = pad(bs.join(' '), 19) + '\t'; }
      self.out(arrow + hx(A, 16) + ' <' + rel + '>:\t' + bytes + self.rebase(text) + '\n');
    };
    var rng = /^(.+?)\s*,\s*(\+)?\s*(.+)$/.exec(arg);
    if (rng) {
      var a, b;
      try { a = BigInt.asUintN(64, sv(this.rv(this.evalExpr(rng[1])))); b = BigInt.asUintN(64, sv(this.rv(this.evalExpr(rng[3])))); } catch (e) { this.out(e.message + '\n'); return; }
      var end = rng[2] ? a + b : b, rt = this.toRt(a), rtEnd = this.toRt(end);
      this.out('Dump of assembler code from ' + hx(a) + ' to ' + hx(end) + ':\n');
      while (rt < rtEnd) {
        var ins = this.insAt(rt); if (!ins) break;
        var lb = this.labelRt(rt) || '<??>'; lb = lb.slice(1, -1); if (lb.indexOf('+') < 0) lb += '+0';
        line(rt, ins.len, ins.text, lb); rt += BigInt(ins.len);
      }
      this.out('End of assembler dump.\n'); return;
    }
    var fname, prt = null;
    if (!arg) {
      if (!this.running) { this.out('No frame selected.\n'); return; }
      var s = this.selected();
      if (s.f.lib) { this.out('No function contains program counter for selected frame.\n'); return; }
      var f0 = this.funcAt(s.f.pc); if (f0) fname = f0.name; else { var p0 = this.pltAt(s.f.pc); if (p0) prt = p0; else { this.out('No function contains program counter for selected frame.\n'); return; } }
    } else if (this.data.funcs[arg]) fname = arg;
    else {
      try {
        var v = this.evalExpr(arg); if (v.nodebug) throw this.nodebugErr(v);
        var A = BigInt.asUintN(64, v.func || v.codefn ? v.v : (isPtr(v.t) || v.t === 'textptr' ? v.v : sv(v))), rtA = this.toRt(A);
        var f2 = this.funcAt(rtA); if (f2) fname = f2.name; else { prt = this.pltAt(rtA); if (!prt) { this.out('No function contains specified address.\n'); return; } }
      } catch (e) { if (!e.gdb) throw e; this.out(e.message + '\n'); return; }
    }
    if (prt) {
      this.out('Dump of assembler code for function ' + prt.name + '@plt:\n');
      for (var r2 = prt.start; r2 < prt.start + 16n;) { var i2 = this.insAt(r2); if (!i2) break; line(r2, i2.len, i2.text, '+' + (r2 - prt.start)); r2 += BigInt(i2.len); }
      this.out('End of assembler dump.\n'); return;
    }
    var fn = this.data.funcs[fname], start = BigInt(fn.start);
    this.out('Dump of assembler code for function ' + fname + ':\n');
    fn.lines.forEach(function (l) { line(BigInt(l[0]), l[1], l[2], '+' + (BigInt(l[0]) - start)); });
    this.out('End of assembler dump.\n');
  };
  GDB.prototype.listRange = function (lo, hi) {
    lo = Math.max(1, lo); hi = Math.min(this.src.length, hi);
    if (lo > this.src.length) { this.out('Line number ' + lo + ' out of range; "bomb.c" has ' + this.src.length + ' lines.\n'); return; }
    for (var j = lo; j <= hi; j++) this.out(j + '\t' + this.srcLine(j) + '\n');
    this.listLast = { lo: lo, hi: hi };
  };
  GDB.prototype.cmdList = function (arg) {
    arg = (arg || '').trim(); var n = this.listsize, m;
    if (!arg) {
      if (this.listCenter) { var lc = this.listCenter; this.listCenter = null; return this.listRange(lc - Math.floor(n / 2), lc - Math.floor(n / 2) + n - 1); }
      if (this.listLast) { if (this.listLast.hi >= this.src.length) { this.out('Line number ' + (this.listLast.hi + 1) + ' out of range; "bomb.c" has ' + this.src.length + ' lines.\n'); return; } return this.listRange(this.listLast.hi + 1, this.listLast.hi + n); }
      var c0 = Math.max(this.mainBpLine - (n - 1), 1); return this.listRange(c0 - Math.floor(n / 2), c0 - Math.floor(n / 2) + n - 1);
    }
    if (arg === '-') { if (!this.listLast || this.listLast.lo <= 1) { this.out('Already at the start of bomb.c.\n'); return; } return this.listRange(this.listLast.lo - n, this.listLast.lo - 1); }
    if ((m = /^(\d+)\s*,\s*(\d+)$/.exec(arg))) return this.listRange(+m[1], +m[2]);
    if ((m = /^(\d+)\s*,$/.exec(arg))) return this.listRange(+m[1], +m[1] + n - 1);
    if ((m = /^,\s*(\d+)$/.exec(arg))) return this.listRange(+m[1] - n + 1, +m[1]);
    if ((m = /^(?:bomb\.c:)?(\d+)$/.exec(arg))) { var L = +m[1]; return this.listRange(L - Math.floor(n / 2), L - Math.floor(n / 2) + n - 1); }
    if (arg[0] === '*') {
      var loc; try { loc = this.resolveLoc(arg); } catch (e) { this.out(e.message + '\n'); return; }
      var L2 = this.lineFor(loc.addr);
      if (L2 === undefined) { var lb = this.labelRt(loc.addr); this.out('No line number information available for address ' + hx(this.toUser(loc.addr)) + (lb ? ' ' + lb : '') + '\n'); return; }
      this.out(hx(this.toUser(loc.addr)) + ' is in main (bomb.c:' + L2 + ').\n');
      return this.listRange(L2 - Math.floor(n / 2), L2 - Math.floor(n / 2) + n - 1);
    }
    if (arg === 'main') return this.listRange(36 - Math.floor(n / 2) + 1, 36 - Math.floor(n / 2) + n);
    if (this.data.funcs[arg] || this.pltAddr[arg.replace(/@plt$/, '')] !== undefined) return;
    this.out('Function "' + arg + '" not defined.\n');
  };

  /* ---------------- set / show / help ---------------- */
  GDB.prototype.cmdSet = function (arg) {
    arg = (arg || '').trim(); var m;
    if ((m = /^(?:var(?:iable)?\s+)?(.*)$/.exec(arg)) && this.splitAssign(m[1]) && (/^var/.test(arg) || /^[\$*({]/.test(m[1].trim()) || /^\$/.test(m[1]))) {
      var as = this.splitAssign(m[1]);
      try { this.assign(as[0], as[1]); } catch (e) { if (!e.gdb) throw e; this.out(e.message + '\n'); }
      return;
    }
    if ((m = /^args\s*(.*)$/.exec(arg))) { this.args = m[1].trim(); return; }
    if ((m = /^confirm\s*(on|off)?$/.exec(arg))) { this.confirm = m[1] !== 'off'; return; }
    if ((m = /^listsize\s+(\d+|unlimited)$/.exec(arg))) { this.listsize = m[1] === 'unlimited' ? 100000 : +m[1]; return; }
    if ((m = /^print\s+elements\s+(\d+|unlimited)$/.exec(arg))) { this.printElements = m[1] === 'unlimited' ? 0 : +m[1]; return; }
    if ((m = /^print\s+repeats\s+(\d+|unlimited)$/.exec(arg))) { this.repeats = m[1] === 'unlimited' ? 0 : +m[1]; return; }
    if ((m = /^disassemble-next-line\s+(on|off|auto)$/.exec(arg))) { this.dnl = m[1] === 'on'; return; }
    if ((m = /^disassembly-flavor\s+(\w+)$/.exec(arg))) { if (m[1] !== 'att') this.out('[simulator: only AT&T syntax is available here; your course and the exam use AT&T too]\n'); return; }
    if (/^(pagination|height|width|style|logging|print|verbose|history|startup-with-shell|disable-randomization|breakpoint|step-mode|can-use-hw-watchpoints)\b/.test(arg)) return;
    if (this.splitAssign(arg)) { var as2 = this.splitAssign(arg); try { this.assign(as2[0], as2[1]); } catch (e) { if (!e.gdb) throw e; this.out(e.message + '\n'); } return; }
    this.out('No symbol "' + arg.split(/\s+/)[0] + '" in current context.\n');
  };
  GDB.prototype.cmdShow = function (arg) {
    arg = (arg || '').trim();
    if (/^args/.test(arg)) { this.out('Argument list to give program being debugged when it is started is "' + this.args + '".\n'); return; }
    if (/^confirm/.test(arg)) { this.out('Whether to confirm potentially dangerous operations is ' + (this.confirm ? 'on' : 'off') + '.\n'); return; }
    if (/^version/.test(arg)) { this.out('GNU gdb (Ubuntu 15.1-1ubuntu1~24.04.1) 15.1\nCopyright (C) 2024 Free Software Foundation, Inc.\n'); return; }
    if (/^listsize/.test(arg)) { this.out('Number of source lines gdb will list by default is ' + this.listsize + '.\n'); return; }
    if (/^disassembly-flavor/.test(arg)) { this.out('The disassembly flavor is "att".\n'); return; }
    if (/^convenience|^conv/.test(arg)) { var ks = Object.keys(this.conv).filter(function (k) { return this.conv[k]; }, this); if (!ks.length) this.out('No debugger convenience values now defined.\n'); else ks.forEach(function (k) { this.out('$' + k + ' = ' + this.fmtVal(this.conv[k]) + '\n'); }, this); return; }
    this.out('[simulator: "show ' + arg + '" is not available here]\n');
  };
  var HELP = {
    break: 'Set breakpoint at specified location.\nbreak [LOCATION] [if CONDITION]\nLOCATION may be a function name, a line number (bomb.c:74), or *ADDRESS (*phase_1+10, *0x555555401f1e).',
    run: 'Start debugged program.\nrun [ARGS]   e.g. run sol.txt   or   run < sol.txt',
    continue: 'Continue program being debugged, after signal or breakpoint.',
    stepi: 'Step one instruction exactly.\nstepi [N]', nexti: 'Step one instruction, but proceed through subroutine calls.\nnexti [N]',
    step: 'Step program until it reaches a different source line.', next: 'Step program, proceeding through subroutine calls.',
    finish: 'Execute until selected stack frame returns.',
    print: 'Print value of expression EXP.\nprint[/FMT] EXP   FMT: x d u o t c a s z f\n  e.g. p/x $rax   p *(int*)($rsp+8)   p (char*)$rdi   p $eflags',
    x: 'Examine memory: x/FMT ADDRESS.\nFMT is a repeat count followed by a format letter and a size letter.\nFormat letters are o(octal), x(hex), d(decimal), u(unsigned decimal), t(binary), f(float), a(address), i(instruction), c(char), s(string) and z(hex, zero padded on the left).\nSize letters are b(byte), h(halfword), w(word), g(giant, 8 bytes).',
    display: 'Print value of expression EXP each time the program stops.\ndisplay/i $pc   shows the next instruction after every stop.',
    disassemble: 'Disassemble a specified section of memory.\ndisassemble [/r] [FUNCTION | ADDRESS | START,END | START,+LENGTH]',
    info: 'Generic command for showing things about the program being debugged.\ninfo registers | breakpoints | frame | functions | line | symbol | address | display | proc mappings | watchpoints',
    backtrace: 'Print backtrace of all stack frames.', watch: 'Set a watchpoint for EXPRESSION.\nwatch *(int*)0x555555604a9c', delete: 'Delete all or some breakpoints.\ndelete [N...]   delete display [N]',
    until: 'Continue running until a source line past the current line, in the current stack frame, is reached.\nuntil LOCATION / advance LOCATION: run until LOCATION is reached or the current frame returns.',
    set: 'Evaluate expression EXP and assign result to variable VAR.\nset $rax = 5   set var *(int*)($rsp+4) = 7   set {int}0x555555604a9c = 1',
    up: 'Select and print stack frame that called this one.', down: 'Select and print stack frame called by this one.', frame: 'Select and print a stack frame.',
    kill: 'Kill execution of program being debugged.', tbreak: 'Set a temporary breakpoint.', list: 'List specified function or line.',
    condition: 'Specify breakpoint number N to break only if COND is true.\ncondition N COND', jump: 'Continue program being debugged at specified line or address.',
    'return': 'Make selected stack frame return to its caller.', printf: 'Formatted printing, like the C "printf" function.\nprintf "%s\\n", $rdi',
    echo: 'Print a constant string.  Give string as argument.', undisplay: 'Cancel some expressions to be displayed when program stops.'
  };
  GDB.prototype.cmdHelp = function (arg) {
    arg = (arg || '').trim();
    if (!arg) {
      this.out('List of classes of commands:\n\naliases -- User-defined aliases of other commands.\nbreakpoints -- Making program stop at certain points.\ndata -- Examining data.\nfiles -- Specifying and examining files.\ninternals -- Maintenance commands.\nobscure -- Obscure features.\nrunning -- Running the program.\nstack -- Examining the stack.\nstatus -- Status inquiries.\nsupport -- Support facilities.\ntext-user-interface -- TUI is the GDB text based interface.\ntracepoints -- Tracing of program execution without stopping the program.\nuser-defined -- User-defined commands.\n\nType "help" followed by a class name for a list of commands in that class.\nType "help all" for the list of all commands.\nType "help" followed by command name for full documentation.\nType "apropos word" to search for commands related to "word".\nType "apropos -v word" for full documentation of commands related to "word".\nCommand name abbreviations are allowed if unambiguous.\n');
      return;
    }
    var c = this.resolveCmd(arg.split(/\s+/)[0]);
    if (c && HELP[c]) { this.out(HELP[c] + '\n'); return; }
    if (c) { this.out('[simulator] ' + c + ' is supported; see the field notes for examples.\n'); return; }
    this.out('Undefined command: "' + arg + '".  Try "help".\n');
  };

  /* ---------------- dispatch ---------------- */
  var CMDS = ['advance', 'awatch', 'backtrace', 'break', 'call', 'condition', 'continue', 'delete', 'disable', 'disassemble', 'display', 'down', 'echo', 'enable', 'finish', 'frame', 'help',
    'info', 'inspect', 'jump', 'kill', 'list', 'next', 'nexti', 'output', 'print', 'printf', 'quit', 'return', 'run', 'rwatch', 'set', 'shell', 'show', 'start', 'starti', 'step', 'stepi',
    'tbreak', 'undisplay', 'until', 'up', 'watch', 'where', 'x', 'layout', 'tui', 'file', 'target', 'attach', 'detach', 'core-file', 'source', 'define', 'commands', 'ignore', 'checkpoint', 'record', 'reverse-step', 'reverse-next', 'reverse-continue', 'reverse-stepi', 'reverse-nexti'];
  var ALIAS = { b: 'break', br: 'break', bre: 'break', brea: 'break', c: 'continue', cont: 'continue', fg: 'continue', n: 'next', s: 'step', si: 'stepi', ni: 'nexti', p: 'print', pri: 'print', prin: 'print', inspect: 'print',
    i: 'info', bt: 'backtrace', where: 'backtrace', l: 'list', k: 'kill', d: 'delete', f: 'frame', u: 'until', j: 'jump', r: 'run', q: 'quit', h: 'help', tb: 'tbreak', disas: 'disassemble', dis: 'disable', disa: 'disable',
    fin: 'finish', en: 'enable', ret: 'return', wa: 'watch', '!': 'shell', rs: 'reverse-step', rc: 'reverse-continue', rn: 'reverse-next', rsi: 'reverse-stepi', rni: 'reverse-nexti' };
  var NOREPEAT = { run: 1, start: 1, starti: 1, kill: 1, delete: 1, display: 1, undisplay: 1, set: 1, 'return': 1, jump: 1, echo: 1, printf: 1, output: 1, watch: 1, condition: 1, tbreak: 1, show: 1, help: 1, disassemble: 1, info: 0 };
  GDB.prototype.resolveCmd = function (cmd) {
    if (ALIAS[cmd]) return ALIAS[cmd];
    if (CMDS.indexOf(cmd) >= 0) return cmd;
    var hits = CMDS.filter(function (c) { return c.indexOf(cmd) === 0; });
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) return { ambiguous: hits };
    return null;
  };
  GDB.prototype.exec = function (line) {
    if (this.question) { this.answer(line); return; }
    var trimmed = line.trim();
    if (trimmed === '') {
      if (!this.last) return;
      var lc = this.resolveCmd((/^([A-Za-z_-]+|!)/.exec(this.last) || [''])[0]);
      if (lc === 'x') { var xo; try { xo = this.parseXfmt(((/^x\s*(\/\S*)?/.exec(this.last) || [])[1]) || ''); } catch (e) { xo = { count: 1 }; } this.cmdX('/' + xo.count + this.xf + (this.xf === 's' || this.xf === 'i' ? '' : this.xu)); return; }
      if (lc === 'list') { this.cmdList(''); return; }
      trimmed = this.last;
    } else this.last = trimmed;
    if (trimmed[0] === '#') return;
    var cm = /^([A-Za-z_][A-Za-z0-9_-]*|!)/.exec(trimmed), word = cm ? cm[1] : trimmed, arg = trimmed.slice(word.length).replace(/^\s+/, '');
    var C = this.resolveCmd(word);
    if (C && C.ambiguous) { this.out('Ambiguous command "' + word + '": ' + C.ambiguous.slice(0, 12).join(', ') + (C.ambiguous.length > 12 ? '...' : '') + '.\n'); return; }
    if (C && NOREPEAT[C]) this.last = '';
    try { this.dispatch(C, word, arg); }
    catch (e) { if (e && e.gdb) this.out(e.message + '\n'); else throw e; }
  };
  GDB.prototype.dispatch = function (C, word, arg) {
    var n = parseInt(arg, 10);
    switch (C) {
      case 'break': return this.cmdBreak(arg, false);
      case 'tbreak': return this.cmdBreak(arg, true);
      case 'watch': return this.cmdWatch(arg);
      case 'rwatch': case 'awatch': this.out('[simulator: only "watch" (write watchpoints) is supported here]\n'); return;
      case 'run': return this.cmdRun(arg, false);
      case 'start': return this.cmdRun(arg, true);
      case 'starti': this.out('[simulator: starti is not available; use start, then si]\n'); return;
      case 'continue': return this.cmdContinue();
      case 'stepi': return this.cmdStepi(n || 1, false);
      case 'nexti': return this.cmdStepi(n || 1, true);
      case 'step': return this.cmdStep(n || 1, false);
      case 'next': return this.cmdStep(n || 1, true);
      case 'finish': return this.cmdFinish();
      case 'until': return this.cmdUntil(arg, false);
      case 'advance': return this.cmdUntil(arg, true);
      case 'jump': return this.cmdJump(arg);
      case 'return': return this.cmdReturn();
      case 'kill': return this.cmdKill();
      case 'print': return this.cmdPrint(arg);
      case 'output': this.cmdPrint(arg, true); return;
      case 'call': if (/\(/.test(arg)) { this.out('[simulator: calling functions inside the program is not supported]\n'); return; } return this.cmdPrint(arg);
      case 'printf': return this.cmdPrintf(arg);
      case 'echo': this.out(this.unescape(arg)); return;
      case 'x': return this.cmdX(arg);
      case 'display': return this.cmdDisplay(arg);
      case 'undisplay': return this.cmdUndisplay(arg);
      case 'disassemble': return this.cmdDisas(arg);
      case 'backtrace': return this.cmdBt(arg);
      case 'frame': return this.cmdFrame('frame', arg);
      case 'up': return this.cmdFrame('up', arg);
      case 'down': return this.cmdFrame('down', arg);
      case 'list': return this.cmdList(arg);
      case 'delete': return this.cmdDelete(arg);
      case 'disable': return this.cmdEnable(arg, false);
      case 'enable': return this.cmdEnable(arg, true);
      case 'condition': return this.cmdCondition(arg);
      case 'info': return this.cmdInfo(arg);
      case 'set': return this.cmdSet(arg);
      case 'show': return this.cmdShow(arg);
      case 'help': return this.cmdHelp(arg);
      case 'quit':
        if (this.running) { this.ask('A debugging session is active.\n\n\tInferior 1 [process ' + this.pid + '] will be killed.\n\nQuit anyway? (y or n) ', 'yn', function (yes) { if (yes) this.quitting = true; else this.out('Not confirmed.\n'); }); return; }
        this.quitting = true; return;
      case 'shell': this.out('[simulator: there is no shell here]\n'); return;
      case 'layout': case 'tui': this.out('[simulator: the TUI is not available; use "display/i $pc" and "disas" instead]\n'); return;
      case 'reverse-step': case 'reverse-next': case 'reverse-continue': case 'reverse-stepi': case 'reverse-nexti': case 'record': case 'checkpoint':
        this.out('Target native does not support this command.\n'); return;
      case 'file': case 'target': case 'attach': case 'detach': case 'core-file': case 'source': case 'define': case 'commands': case 'ignore':
        this.out('[simulator: "' + C + '" is not available here]\n'); return;
    }
    this.out('Undefined command: "' + word + '".  Try "help".\n');
  };
  GDB.prototype.prompt = function () { return this.question ? '' : this.waiting ? '' : '(gdb) '; };

  GDB.version = 2;
  if (typeof module !== 'undefined') module.exports = GDB; else root.GDB = GDB;
})(this);
