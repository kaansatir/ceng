import gdb, json, os, re, base64, hashlib
P = json.load(open(os.environ['TP']))
def ex(c): return gdb.execute(c, to_string=True)
for c in ['set pagination off', 'set width 0', 'set confirm off', 'set style enabled off']: ex(c)
ex('break *main')
ex('run < ' + P['inp'])
inf = gdb.selected_inferior()
M = (1 << 64) - 1
REGS = ['rax','rbx','rcx','rdx','rsi','rdi','rbp','rsp','r8','r9','r10','r11','r12','r13','r14','r15']
def rd(r): return int(gdb.parse_and_eval('$' + r)) & M
def flags():
    return int(re.search(r'= (0x[0-9a-f]+)', ex('p/x $eflags')).group(1), 16)
fsb = int(re.search(r'= (0x[0-9a-f]+)', ex('p/x $fs_base')).group(1), 16)
canary = int.from_bytes(bytes(inf.read_memory(fsb + 0x28, 8)), 'little')
rsp = rd('rsp')
slo = rsp - 0x6000
stack = base64.b64encode(bytes(inf.read_memory(slo, 0x6000 + 0x400))).decode()
def mh(): return hashlib.md5(b''.join(bytes(inf.read_memory(a, n)) for a, n in P['rw'])).hexdigest()
recs = []
prev = None
res = {'canary': hex(canary), 'rsp': hex(rsp), 'slo': hex(slo), 'stack': stack, 'recs': recs}
for i in range(P['max']):
    if inf.pid == 0: break
    pc = rd('pc')
    if not (P['text'][0] <= pc < P['text'][1]):
        recs.append({'pc': hex(pc), 's': [hex(rd(r)) for r in REGS] + [hex(flags())], 'a': 'out', 'asm': '', 'end': 'left bomb'}); break
    st = [hex(rd(r)) for r in REGS] + [hex(flags())]
    d = gdb.selected_frame().architecture().disassemble(pc)[0]
    asm, ln = d['asm'], d['length']
    act = 'si'
    m = re.match(r'call\s+(0x[0-9a-f]+)', asm)
    if m:
        t = int(m.group(1), 16)
        if P['plt_lo'] <= t < P['plt_hi']: act = 'ni'
        elif t == P['explode']: act = 'skip'
    rec = {'pc': hex(pc), 's': st, 'a': act, 'asm': asm}
    if prev == 'ni': rec['h'] = mh()
    recs.append(rec); prev = act
    if act == 'skip':
        gdb.execute('set $pc = %d' % (pc + ln)); continue
    try:
        o = ex('stepi' if act == 'si' else 'nexti')
    except gdb.error as e:
        rec['err'] = str(e); break
    if 'Program received signal' in o or 'exited' in o or inf.pid == 0:
        rec['end'] = o.strip()[:300]
        try: rec['code'] = int(gdb.parse_and_eval('$_exitcode'))
        except Exception: pass
        break
json.dump(res, open(P['out'], 'w'))
