import gdb, json, base64, os, re

P = json.load(open(os.environ['XP']))
OUT = os.environ['XO']


def ex(c):
    return gdb.execute(c, to_string=True)


ex('set pagination off')
ex('set width 0')
ex('set confirm off')
ex('set style enabled off')

res = {'static_bp': {}, 'funcs': {}, 'plt_text': {}, 'main_lines': {}, 'libc': {}}

# breakpoint addresses gdb picks before the program runs
for f in P['funcs']:
    try:
        o = ex('break ' + f['name'])
        m = re.search(r'Breakpoint \d+ at (0x[0-9a-f]+)(.*)', o)
        if m:
            res['static_bp'][f['name']] = [int(m.group(1), 16), m.group(2).strip()]
    except gdb.error as e:
        pass
ex('delete')

ex('break *main')
ex('run < /dev/null')
inf = gdb.selected_inferior()

maps = []
o = ex('info proc mappings')
for line in o.splitlines():
    m = re.match(r'\s*(0x[0-9a-f]+)\s+(0x[0-9a-f]+)\s+(0x[0-9a-f]+)\s+(0x[0-9a-f]+)\s+(\S+)\s*(.*)$', line)
    if m:
        maps.append({'start': int(m.group(1), 16), 'end': int(m.group(2), 16), 'offset': int(m.group(4), 16), 'perms': m.group(5), 'file': m.group(6).strip()})
res['maps_all'] = maps
binpath = P['binpath']
mine = []
seen_bin = False
for mp in maps:
    if mp['file'] == binpath:
        mine.append(mp)
        seen_bin = True
    elif seen_bin and mp['file'] == '' and mine and mp['start'] == mine[-1]['end']:
        mine.append(mp)
        seen_bin = False
    else:
        seen_bin = False if mp['file'] != binpath else seen_bin
for mp in mine:
    data = bytes(inf.read_memory(mp['start'], mp['end'] - mp['start']))
    mp['b64'] = base64.b64encode(data).decode()
res['maps'] = mine
DELTA = mine[0]['start'] if P.get('pie', True) else 0

regs = {}
for r in ['rax', 'rbx', 'rcx', 'rdx', 'rsi', 'rdi', 'rbp', 'rsp', 'r8', 'r9', 'r10', 'r11', 'r12', 'r13', 'r14', 'r15', 'rip', 'eflags', 'fs_base']:
    regs[r] = int(re.search(r'= (0x[0-9a-f]+)', ex('p/x $' + r)).group(1), 16)
res['regs_main'] = regs
fsb = regs['fs_base']
res['canary'] = int.from_bytes(bytes(inf.read_memory(fsb + 0x28, 8)), 'little')

for f in P['funcs']:
    try:
        o = ex('disas /r %d,+%d' % (f['addr'] + DELTA, max(f['size'], 1)))
    except gdb.error as e:
        continue
    lines = []
    for line in o.splitlines():
        m = re.match(r'^(?:=>|  ) (0x[0-9a-f]+) <[^>]*?\+(\d+)>:\t([0-9a-f ]+)\t(.*)$', line)
        if m:
            nb = len(m.group(3).split())
            lines.append([int(m.group(1), 16), nb, m.group(4).rstrip()])
    res['funcs'][f['name']] = lines

for name, addr in P['plt'].items():
    a = addr + DELTA
    try:
        o = ex('x/3i %d' % a)
        res['plt_text'][name] = [l.rstrip() for l in o.splitlines()]
    except gdb.error:
        pass
    try:
        mm = re.search(r'(0x[0-9a-f]+)', ex('p/x (long)&' + name))
        res['libc'][name] = int(mm.group(1), 16)
    except gdb.error:
        pass

for a, n, t in res['funcs'].get('main', []):
    o = ex('info line *%d' % a)
    m = re.search(r'Line (\d+) of "([^"]+)"\s+starts at address (0x[0-9a-f]+)', o)
    if m:
        res['main_lines'][str(a)] = [int(m.group(1)), int(m.group(3), 16)]
        if not m.group(2).endswith('bomb.c'):
            res.setdefault('inline_info', {})[str(a)] = o.strip()
    else:
        m = re.search(r'Line (\d+) of "([^"]+)"\s+is at address (0x[0-9a-f]+)', o)
        if m:
            res['main_lines'][str(a)] = [int(m.group(1)), int(m.group(3), 16)]

json.dump(res, open(OUT, 'w'))
ex('kill')
