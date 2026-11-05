#!/bin/bash
# usage: run_diff.sh N input.txt tag
cd "$(dirname "$0")"
N=$1; INP=$2; TAG=$3
python3 - "$N" "$INP" "$TAG" <<'PY'
import json, subprocess, os, sys
n, inp, tag = sys.argv[1:4]
d = json.load(open('data/bomb%s.json' % n))
p = d['plt']; lo = min(p.values()); hi = max(p.values()) + 16
rw = [[m['start'], m['end'] - m['start']] for m in d['maps'] if m['perms'][1] == 'w']
P = {'inp': os.path.abspath(inp), 'out': os.path.abspath('tr/b%s_%s.json' % (n, tag)), 'max': 60000, 'plt_lo': lo, 'plt_hi': hi, 'explode': d['funcs'].get('explode_bomb', {'start': -1})['start'], 'rw': rw, 'text': [d['maps'][0]['start'], d['maps'][0]['end']]}
json.dump(P, open('tr/p%s.json' % n, 'w'))
r = subprocess.run(['gdb', '-q', '-nx', '-batch', '-x', os.path.abspath('trace_gdb.py'), os.path.abspath('../bombs/%s/%s' % (n, d.get('bin_name', 'bomb-quiet')))], env=dict(os.environ, TP=os.path.abspath('tr/p%s.json' % n)), capture_output=True, text=True, cwd='../bombs/%s' % n)
t = json.load(open(P['out'])); print('bomb', n, 'gdb recs', len(t['recs']), '|', (t['recs'][-1].get('end') or '')[:120].replace('\n', ' '))
PY
node t_diff.js $N tr/b${N}_${TAG}.json $INP 2>&1 | head -${LINES_OUT:-40}
