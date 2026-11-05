import json, os
HERE = os.path.dirname(os.path.abspath(__file__))
shell = open('shell.html').read()
emu = open('emu.js').read()
gdb = open('gdb.js').read()
import glob, hashlib, re, base64
SCRUB = ('userid', 'user_password')   # personal data baked into course bombs; never used by the phases

def scrub(d):
    """Zero the student id / server password in both memory images the page carries."""
    delta = d['base'] if d.get('pie', True) else 0
    for s in d['symbols']:
        if s[3] not in SCRUB: continue
        lo, size = s[0], s[1] or 64
        for m in d['maps']:
            if m['start'] <= lo < m['end']:
                blob = bytearray(base64.b64decode(m['b64'])); o = lo - m['start']
                blob[o:o + size] = bytes(min(size, len(blob) - o)); m['b64'] = base64.b64encode(bytes(blob)).decode()
        L = lo - delta
        for f in d['file_maps']:
            if f['vaddr'] <= L < f['vaddr'] + f['memsz']:
                blob = bytearray(base64.b64decode(f['b64'])); o = L - f['vaddr']
                blob[o:o + size] = bytes(min(size, len(blob) - o)); f['b64'] = base64.b64encode(bytes(blob)).decode()
bombs, srcs = {}, {}
nums = sorted(int(re.match(r'bomb(\d+)\.json$', os.path.basename(p)).group(1)) for p in glob.glob('data/bomb*.json'))
for n in nums:
    d = json.load(open('data/bomb%d.json' % n))
    p = '../bombs/%d/bomb.c' % n
    text = open(p).read() if os.path.exists(p) else open('../bombs/1/bomb.c').read()
    key = hashlib.md5(text.encode()).hexdigest()[:10]
    srcs[key] = text
    d['src_id'] = key
    scrub(d)
    bombs[str(n)] = d
def esc(s):  # keep inline <script> safe
    return s.replace('</', '<\\/')
data_js = esc(json.dumps(bombs, separators=(',', ':')))
src_js = esc(json.dumps(srcs))
out = shell
out = out.replace('/*__EMU__*/', emu.replace('</', '<\\/'))
out = out.replace('/*__GDB__*/', gdb.replace('</', '<\\/'))
out = out.replace('/*__DATA__*/null', data_js)
out = out.replace('/*__SRC__*/null', src_js)
os.makedirs('dist', exist_ok=True)
open('dist/index.html', 'w').write(out)
print('dist/index.html', round(len(out) / 1024), 'KB', 'bombs', nums, 'sources', len(srcs))
