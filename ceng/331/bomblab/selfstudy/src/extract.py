#!/usr/bin/env python3
"""Extract everything the browser emulator needs from one bomb."""
import base64, json, os, re, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))


def run(*a, **k):
    return subprocess.run(a, capture_output=True, text=True, **k).stdout


def extract(binpath, outpath):
    binpath = os.path.abspath(binpath)
    outpath = os.path.abspath(outpath)
    syms = []
    for line in run('nm', '-n', '-S', '--defined-only', binpath).splitlines():
        p = line.split()
        if len(p) == 4:
            syms.append({'addr': int(p[0], 16), 'size': int(p[1], 16), 'type': p[2], 'name': p[3]})
        elif len(p) == 3:
            syms.append({'addr': int(p[0], 16), 'size': 0, 'type': p[1], 'name': p[2]})
    funcs = [s for s in syms if s['type'] in 'tT' and not s['name'].startswith('_') and s['name'] not in ('deregister_tm_clones', 'register_tm_clones', 'frame_dummy')]
    plt = {}
    for line in run('objdump', '-d', '-j', '.plt', '-j', '.plt.sec', '-j', '.plt.got', binpath).splitlines():
        m = re.match(r'^([0-9a-f]+) <(.+)@plt>:', line)
        if m:
            plt[m.group(2)] = int(m.group(1), 16)
    hdr = run('readelf', '-hW', binpath)
    pie = 'DYN' in [l for l in hdr.splitlines() if 'Type:' in l][0]
    segs = []
    raw = open(binpath, 'rb').read()
    for line in run('readelf', '-lW', binpath).splitlines():
        mm = re.match(r'\s*LOAD\s+(0x[0-9a-f]+)\s+(0x[0-9a-f]+)\s+(0x[0-9a-f]+)\s+(0x[0-9a-f]+)\s+(0x[0-9a-f]+)', line)
        if mm:
            off, va, _pa, fsz, msz = [int(x, 16) for x in mm.groups()]
            blob = raw[off:off + fsz] + b'\0' * (msz - fsz)
            segs.append({'vaddr': va, 'memsz': msz, 'b64': base64.b64encode(blob).decode()})
    params = {'funcs': funcs, 'plt': plt, 'binpath': binpath, 'pie': pie}
    pf = outpath + '.params.json'
    json.dump(params, open(pf, 'w'))
    env = dict(os.environ, XP=pf, XO=outpath + '.gdb.json')
    r = subprocess.run(['gdb', '-q', '-nx', '-batch', '-x', os.path.join(HERE, 'extract_gdb.py'), binpath],
                       capture_output=True, text=True, env=env, cwd=os.path.dirname(binpath))
    if not os.path.exists(outpath + '.gdb.json'):
        print(r.stdout[-3000:], r.stderr[-3000:])
    g = json.load(open(outpath + '.gdb.json'))
    base = [m for m in g['maps'] if m['file']][0]['start']
    delta = base if pie else 0
    binname = os.path.basename(binpath)
    fake = '/home/student/bomblab/' + binname
    maps_all = [[m['start'], m['end'], m['offset'], m['perms'], (fake if m['file'] == binpath else m['file'])] for m in g['maps_all']]
    out = {
        'base': base,
        'maps': [{'start': m['start'], 'end': m['end'], 'perms': m['perms'], 'b64': m['b64']} for m in g['maps']],
        'regs_main': g['regs_main'],
        'canary': g['canary'],
        'static_bp': g['static_bp'],
        'funcs': {},
        'plt': {name: a + delta for name, a in plt.items()},
        'plt_text': g['plt_text'],
        'libc': g['libc'],
        'main_lines': g['main_lines'],
        'symbols': [[s['addr'] + delta, s['size'], s['type'], s['name']] for s in syms
                    if s['type'] in 'tTdDbBrR' and not s['name'].startswith('__') and s['name'] not in ('_init', '_fini', '_start', '_edata', '_end')],
    }
    for f in funcs:
        lines = g['funcs'].get(f['name'])
        if lines:
            out['funcs'][f['name']] = {'start': f['addr'] + delta, 'size': f['size'], 'lines': lines}
    out['pie'] = pie
    inl, cur = [], None
    for line in run('objdump', '--dwarf=info', binpath).splitlines():
        if 'DW_TAG_' in line and 'Abbrev Number' in line:
            cur = {} if ('DW_TAG_inlined_subroutine' in line and line.strip().startswith('<2>')) else None
            if cur is not None: inl.append(cur)
            continue
        if cur is None: continue
        mm = re.search(r'DW_AT_low_pc\s*:\s*(0x[0-9a-f]+)', line)
        if mm: cur['lo'] = int(mm.group(1), 16)
        mm = re.search(r'DW_AT_high_pc\s*:\s*(0x[0-9a-f]+)', line)
        if mm: cur['hi'] = int(mm.group(1), 16)
        mm = re.search(r'DW_AT_call_line\s*:\s*(\d+)', line)
        if mm: cur['line'] = int(mm.group(1))
    ranges = []
    for r in inl:
        if 'lo' in r and 'hi' in r and 'line' in r:
            hi = r['hi'] if r['hi'] > r['lo'] else r['lo'] + r['hi']
            ranges.append((r['lo'] + delta, hi + delta, r['line']))
    for k in list(out['main_lines'].keys()):
        a = int(k)
        for lo, hi, ln in ranges:
            if lo <= a < hi: out['main_lines'][k] = [ln, lo]
    out['inline_ranges'] = ranges
    out['inline_info'] = g.get('inline_info', {})
    out['textsyms'] = [[s['addr'] + delta, s['size'], s['name']] for s in syms if s['type'] in 'tTwW' and s['addr']]
    secs = []
    for line in run('readelf', '-SW', binpath).splitlines():
        mm = re.match(r'\s*\[\s*\d+\]\s+(\S+)\s+\S+\s+([0-9a-f]+)\s+[0-9a-f]+\s+([0-9a-f]+)\s+\S+\s+(\S*A\S*)', line)
        if mm and int(mm.group(2), 16):
            secs.append([mm.group(1), int(mm.group(2), 16) + delta, int(mm.group(3), 16)])
    out['sections'] = secs
    out['bin_name'] = binname
    out['file_maps'] = segs
    out['maps_all'] = maps_all
    out['regs_main'] = {k: hex(v) for k, v in out['regs_main'].items()}
    out['canary'] = hex(out['canary'])
    json.dump(out, open(outpath, 'w'), separators=(',', ':'))
    os.remove(pf)
    os.remove(outpath + '.gdb.json')
    return out


if __name__ == '__main__':
    o = extract(sys.argv[1], sys.argv[2])
    print(sys.argv[1], 'base', hex(o['base']), 'funcs', len(o['funcs']), 'maps', [(hex(m['start']), hex(m['end']), m['perms']) for m in o['maps']], 'bytes', os.path.getsize(sys.argv[2]))
