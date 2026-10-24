/*
 * LumeOS - apps/terminal/app.ts
 * Interactive shell over the VFS and the C backend diagnostics.
 */

import type { LumeApp, AppContext } from '../../desktop/types.js';

export const terminalApp: LumeApp = {
  manifest: {
    id: 'terminal',
    name: 'Terminal',
    glyph: '⌨️',
    description: 'Command-line interface to the LumeOS kernel and C engine.',
    category: 'developer',
    type: 'builtin',
    width: 760,
    height: 460,
    onDesktop: true,
  },

  mount(ctx: AppContext) {
    const term = document.createElement('div');
    term.className = 'terminal';

    const out = document.createElement('div');
    const promptLine = document.createElement('div');
    promptLine.className = 'terminal__prompt';

    const cwdLabel = document.createElement('span');
    cwdLabel.textContent = 'lume:/$';

    const input = document.createElement('input');
    input.autocomplete = 'off';
    input.spellcheck = false;

    promptLine.append(cwdLabel, input);
    term.append(out, promptLine);
    ctx.window.body.appendChild(term);

    let cwd = '/';

    const write = (text: string, cls = ''): void => {
      const line = document.createElement('div');
      line.className = `terminal__line ${cls}`.trim();
      line.textContent = text;
      out.appendChild(line);
      term.scrollTop = term.scrollHeight;
    };

    const setCwd = (p: string): void => {
      cwd = p.startsWith('/') ? p : `${cwd === '/' ? '' : cwd}/${p}`;
      cwd = cwd.replace(/\/{2,}/g, '/');
      const parts = cwd.split('/').filter(Boolean);
      /* resolve .. */
      const stack: string[] = [];
      for (const part of parts) {
        if (part === '..') stack.pop();
        else if (part !== '.') stack.push(part);
      }
      cwd = '/' + stack.join('/');
      cwdLabel.textContent = `lume:${cwd === '/' ? '' : cwd}$`;
    };

    const abs = (p: string): string => {
      if (!p) return cwd;
      if (p.startsWith('/')) return p;
      return (cwd === '/' ? '' : cwd) + '/' + p;
    };

    const commands: Record<string, (args: string[]) => Promise<void> | void> = {
      help() {
        write('LumeOS shell — built-in commands:', 'info');
        write('  ls [path]            list directory');
        write('  cat <file>           print file contents');
        write('  mkdir <dir>          create directory');
        write('  touch <file>         create empty file');
        write('  write <file> <text>  write text to file');
        write('  rm <path>            remove file/dir');
        write('  cd <path>            change directory');
        write('  pwd                  print working directory');
        write('  echo <text>          echo text');
        write('  sysinfo              host telemetry from C backend');
        write('  pkgs                 list available .lume packages');
        write('  lume-pkg list        same as pkgs');
        write('  open <app>           launch a LumeOS app');
        write('  theme <dark|light>   switch desktop theme');
        write('  clear                clear the screen');
        write('  whoami / date        identity and time');
      },
      async ls(args) {
        const path = abs(args[0] ?? '');
        try {
          const entries = await ctx.kernel.vfs.list(path);
          if (entries.length === 0) {
            write('(empty)');
            return;
          }
          for (const e of entries) {
            const kind = e.type === 'dir' ? 'd' : '-';
            write(`${kind}  ${String(e.size).padStart(8)}  ${e.name}`);
          }
        } catch (e) {
          write(`ls: ${(e as Error).message}`, 'err');
        }
      },
      async cat(args) {
        if (!args[0]) return write('cat: missing operand', 'err');
        try {
          write(await ctx.kernel.vfs.readText(abs(args[0])));
        } catch (e) {
          write(`cat: ${(e as Error).message}`, 'err');
        }
      },
      async mkdir(args) {
        if (!args[0]) return write('mkdir: missing operand', 'err');
        try {
          await ctx.kernel.vfs.mkdir(abs(args[0]));
        } catch (e) {
          write(`mkdir: ${(e as Error).message}`, 'err');
        }
      },
      async touch(args) {
        if (!args[0]) return write('touch: missing operand', 'err');
        try {
          await ctx.kernel.vfs.writeText(abs(args[0]), '');
        } catch (e) {
          write(`touch: ${(e as Error).message}`, 'err');
        }
      },
      async write(args) {
        if (args.length < 2) return write('write: usage: write <file> <text>', 'err');
        const [file, ...rest] = args;
        try {
          await ctx.kernel.vfs.writeText(abs(file), rest.join(' '));
          write(`wrote ${abs(file)}`, 'info');
        } catch (e) {
          write(`write: ${(e as Error).message}`, 'err');
        }
      },
      async rm(args) {
        if (!args[0]) return write('rm: missing operand', 'err');
        try {
          await ctx.kernel.vfs.remove(abs(args[0]));
        } catch (e) {
          write(`rm: ${(e as Error).message}`, 'err');
        }
      },
      cd(args) {
        setCwd(args[0] ?? '/');
      },
      pwd() {
        write(cwd);
      },
      echo(args) {
        write(args.join(' '));
      },
      async sysinfo() {
        if (!ctx.kernel.isServerOnline()) {
          write('sysinfo: C backend offline', 'err');
          return;
        }
        try {
          const i = await ctx.kernel.api.systemInfo();
          write(`os        : ${i.os} ${i.kernel}`);
          write(`arch      : ${i.arch}`);
          write(`hostname  : ${i.hostname}`);
          write(`cpus      : ${i.cpus}`);
          write(`memory    : ${(i.mem_available_kb / 1024).toFixed(0)} / ${(i.mem_total_kb / 1024).toFixed(0)} MB free`);
          write(`load      : ${i.load1.toFixed(2)} ${i.load5.toFixed(2)} ${i.load15.toFixed(2)}`);
          write(`disk free : ${(i.disk_free_bytes / 1024 / 1024).toFixed(0)} MB`);
          write(`lume      : v${i.lume_version} @ ${i.time}`);
        } catch (e) {
          write(`sysinfo: ${(e as Error).message}`, 'err');
        }
      },
      async pkgs() {
        if (!ctx.kernel.isServerOnline()) {
          write('pkgs: C backend offline', 'err');
          return;
        }
        try {
          const list = await ctx.kernel.api.listPackages();
          if (list.length === 0) write('(no packages in repository)');
          for (const p of list) {
            write(`${p.kind.padEnd(8)} ${String(p.size).padStart(9)}  ${p.name}`);
          }
        } catch (e) {
          write(`pkgs: ${(e as Error).message}`, 'err');
        }
      },
      open(args) {
        if (!args[0]) return write('open: usage: open <app-id>', 'err');
        ctx.kernel.openApp(args[0]);
      },
      theme(args) {
        const t = args[0] === 'light' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', t);
        write(`theme -> ${t}`, 'info');
      },
      clear() {
        out.innerHTML = '';
      },
      whoami() {
        write('lume-user@lumeos');
      },
      date() {
        write(new Date().toString());
      },
    };
    commands['lume-pkg'] = async (args: string[]) => {
      if ((args[0] ?? 'list') === 'list') await commands.pkgs([]);
      else write(`lume-pkg: unknown subcommand '${args[0]}'`, 'err');
    };

    const run = async (raw: string): Promise<void> => {
      const line = raw.trim();
      write(`lume:${cwd === '/' ? '' : cwd}$ ${line}`);
      if (!line) return;
      const parts = line.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];
      const argv = parts.map((p) => p.replace(/^"|"$/g, ''));
      const cmd = argv.shift() as string;
      const fn = commands[cmd];
      if (!fn) {
        write(`lume: command not found: ${cmd} (try 'help')`, 'err');
        return;
      }
      try {
        await fn(argv);
      } catch (e) {
        write(`${cmd}: ${(e as Error).message}`, 'err');
      }
    };

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const value = input.value;
        input.value = '';
        void run(value);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
      }
    });

    term.addEventListener('click', () => input.focus());

    write('LumeOS Terminal v1.0.0', 'info');
    write("Type 'help' for available commands.");
    write(`C backend: ${ctx.kernel.isServerOnline() ? 'online' : 'offline'}`);
    setTimeout(() => input.focus(), 60);
  },
};
