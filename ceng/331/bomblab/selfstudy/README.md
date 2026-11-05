# Bomb Lab Debugger

A gdb you can run in the browser, for practicing the bomb lab
on machines that can't run x86-64 Linux binaries (Apple Silicon Macs, etc.).

Open `index.html` in any browser. It's self-contained, with the practice bombs built in.

- Pick a bomb tab and type gdb commands: `break`, `run`, `si`, `ni`, `x/s`,
  `info registers`, `display/i $pc`, `watch`, `finish`, `up`/`down`, and more.
- Put your answers in the `sol.txt` box and `run sol.txt`, as in the real lab.
- Explosions are free. Nothing is sent anywhere.

The emulator runs the bombs' real machine code. It was checked instruction by
instruction against real gdb, and the gdb messages match real gdb 15 output.

## Adding a bomb (needs Linux x86-64 with gdb)

1. Put the binary (and its `bomb.c`, if any) in `bombs/N/` next to `src/`.
2. `cd src && python3 add_bomb.py N`
   This extracts the bomb, checks every instruction is supported, lists any
   unmodelled C-library calls, compares three runs against real gdb, and rebuilds.
3. Copy `src/dist/index.html` over `index.html`.
