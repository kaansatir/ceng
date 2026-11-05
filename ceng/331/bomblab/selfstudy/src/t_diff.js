const Emu = require('./emu.js'), fs = require('fs'), crypto = require('crypto');
const [n, tracef, inpf] = process.argv.slice(2);
const d = JSON.parse(fs.readFileSync('data/bomb' + n + '.json'));
const tr = JSON.parse(fs.readFileSync(tracef));
const lines = fs.readFileSync(inpf, 'utf8').split('\n'); if (lines[lines.length - 1] === '') lines.pop();
let out = '';
const emu = new Emu(d, { rsp: tr.rsp, out: s => out += s });
emu.start([], lines.concat([null]));
const REGS = ['rax','rbx','rcx','rdx','rsi','rdi','rbp','rsp','r8','r9','r10','r11','r12','r13','r14','r15'];
const st0 = tr.recs[0].s;
REGS.forEach((r, i) => emu.R[r] = BigInt(st0[i])); emu.R.eflags = BigInt(st0[16]);
emu.write(emu.fsBase + 0x28n, 8, BigInt(tr.canary));
const sb = Buffer.from(tr.stack, 'base64'), slo = BigInt(tr.slo);
for (let i = 0; i < sb.length; i++) emu.raww(Number(slo) + i, 1, BigInt(sb[i]));
const alias = new Map(); // gdb value -> emu value
let lastAct = null, lastIns = null, mism = 0, ctr = 0;
const CALLER = ['rax','rcx','rdx','rsi','rdi','r8','r9','r10','r11'];
function region() { return Buffer.concat(d.maps.filter(m => m.perms[1] === 'w').map(m => { const g = emu.region(m.start); return Buffer.from(g.b.subarray(m.start - g.lo, m.end - g.lo)); })); }
for (let k = 0; k < tr.recs.length; k++) {
  const rec = tr.recs[k], pc = BigInt(rec.pc);
  if (lastAct === 'ni') {
    // sync caller-saved after library call, check rax unless pointer-ish
    const fn = lastIns;
    REGS.forEach((r, i) => { if (CALLER.includes(r)) { const gv = BigInt(rec.s[i]); if (r === 'rax' && emu.R.rax !== gv && !/ctype|getenv|fopen|fgets/.test(fn)) console.log('rax diff after', fn, emu.R.rax.toString(16), gv.toString(16)); if (r === 'rax' && /ctype/.test(fn)) { alias.set(gv, emu.R.rax); } else emu.R[r] = gv; } });
    emu.R.eflags = BigInt(rec.s[16]);
    if (rec.h) { const h = crypto.createHash('md5').update(region()).digest('hex'); if (h !== rec.h) { console.log('MEM DIFF after', fn, 'at rec', k); mism++; } }
  }
  if (emu.R.rip !== pc) { console.log('PC DIFF at', k, 'emu', emu.R.rip.toString(16), 'gdb', rec.pc, 'prev', lastIns); process.exit(1); }
  let bad = [];
  REGS.forEach((r, i) => { const gv = BigInt(rec.s[i]), ev = emu.R[r]; if (gv !== ev && alias.get(gv) !== ev) bad.push(r + ' emu=' + ev.toString(16) + ' gdb=' + gv.toString(16)); });
  const gf = BigInt(rec.s[16]) & 0x8d5n, ef = emu.R.eflags & 0x8d5n;
  if (gf !== ef) {
    const undef = /imul|idiv|div|sar|shr|shl/.test(lastIns || '');
    const diffm = gf ^ ef;
    if (!(undef) && (diffm & ~0x10n)) bad.push('flags emu=' + ef.toString(16) + ' gdb=' + gf.toString(16));
    emu.R.eflags = BigInt(rec.s[16]);
  }
  if (bad.length) { console.log('REG DIFF at rec', k, 'pc', rec.pc, 'after', lastIns, '\n  ' + bad.join('\n  ')); mism++; REGS.forEach((r, i) => { const gv = BigInt(rec.s[i]); if (alias.get(gv) === undefined) emu.R[r] = gv; }); if (mism > 15) process.exit(1); }
  // learn alias for ctype table pointer: after mov (%rax),%rax following ctype
  lastAct = rec.a; lastIns = rec.asm;
  if (rec.end) { console.log('gdb end:', rec.end.replace(/\n/g, ' | ')); }
  if (rec.a === 'skip') { emu.R.rip = emu.getIns(pc).next; continue; }
  if (rec.a === 'ni') {
    let r1 = emu.step({}); if (r1) { console.log('emu stop in call', r1); break; }
    let r2 = emu.step({}); if (r2) { console.log('emu stop', JSON.stringify(r2), 'at', rec.asm); break; }
  } else {
    const ins = emu.getIns(pc);
    let r = emu.step({ one: true });
    if (r) { console.log('emu stop', JSON.stringify(r), 'at', rec.asm); break; }
    // alias the ctype table pointer
    if (ins && /^mov\s+\(%rax\),%rax/.test(ins.text) && k + 1 < tr.recs.length) {
      const gv = BigInt(tr.recs[k + 1].s[0]); if (gv !== emu.R.rax) alias.set(gv, emu.R.rax);
    }
  }
  ctr++;
}
console.log('compared', ctr, 'steps, mismatches', mism);
console.log('--- emu output ---\n' + out);
