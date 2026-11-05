#!/usr/bin/env python3
"""Add (or refresh) a bomb:  python3 add_bomb.py N
Expects ../bombs/N/ to hold the bomb ELF (any name) and, optionally, its bomb.c."""
import json, os, subprocess, sys
HERE = os.path.dirname(os.path.abspath(__file__)); os.chdir(HERE)
n = sys.argv[1]
d = os.path.join('..', 'bombs', n)
cands = [f for f in sorted(os.listdir(d)) if os.path.isfile(os.path.join(d, f)) and open(os.path.join(d, f), 'rb').read(4) == b'\x7fELF']
cands.sort(key=lambda f: (not f.startswith('bomb'), len(f)))
if not cands: sys.exit('no ELF binary in ' + d)
elf = os.path.join(d, cands[0]); os.chmod(elf, 0o755)
print('binary:', elf, '|', subprocess.run(['file', '-b', elf], capture_output=True, text=True).stdout.strip()[:90])
r = subprocess.run(['python3', 'extract.py', elf, 'data/bomb%s.json' % n], capture_output=True, text=True)
print(r.stdout.strip()[:160] or r.stderr[-800:])
chk = subprocess.run(['node', '-e', r'''
const Emu=require('./emu.js'),fs=require('fs');const d=JSON.parse(fs.readFileSync('data/bomb%s.json'));
let bad=[],tot=0;for(const f in d.funcs)for(const l of d.funcs[f].lines){tot++;try{Emu.parseIns(BigInt(l[0]),l[1],l[2])}catch(e){bad.push(f+': '+l[2])}}
const unk=Object.keys(d.plt).filter(n=>!Emu.MODELLED.includes(n));
console.log('instructions',tot,'unsupported',bad.length,bad.slice(0,8).join(' | '));console.log('library imports',Object.keys(d.plt).length,'not modelled:',unk.join(', ')||'none');
console.log('phases', Object.keys(d.funcs).filter(f=>/phase|func|fun\d|secret/.test(f)).join(' '));''' % n], capture_output=True, text=True)
print(chk.stdout.strip(), chk.stderr.strip()[:500])
for t in 'abc':
    o = subprocess.run(['bash', 'run_diff.sh', n, 'tr/in_%s.txt' % t, t], capture_output=True, text=True, env=dict(os.environ, LINES_OUT='60')).stdout
    lines = [l for l in o.splitlines() if 'compared' in l or 'DIFF' in l]
    print('real-gdb check %s:' % t, ' / '.join(lines[:3]) if lines else o[-300:])
print(subprocess.run(['python3', 'build.py'], capture_output=True, text=True).stdout.strip())
