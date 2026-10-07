import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, statSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { spawnWithFileOutput } from '../spawn.ts';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test('logs are exclusive, nofollow and mode 0600', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spawn-security-'));
    try {
        const path = join(dir, 'log');
        writeFileSync(path, 'preserve');
        assert.throws(() => spawnWithFileOutput({ command: 'true', cwd: dir, logPath: path }));
        assert.equal(readFileSync(path, 'utf8'), 'preserve');
        symlinkSync(path, join(dir, 'link'));
        assert.throws(() => spawnWithFileOutput({ command: 'true', cwd: dir, logPath: join(dir, 'link') }));
        const result = spawnWithFileOutput({ command: 'true', cwd: dir, logPath: join(dir, 'new'), foreground: true });
        assert.equal(statSync(result.logPath).mode & 0o777, 0o600);
        assert.equal((await result.exit).code, 0);
        result.release();
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('SIGKILL of parent cleans resistant descendants through IPC EOF', { skip: process.platform !== 'linux' }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spawn-orphan-'));
    const moduleUrl = new URL('../spawn.ts', import.meta.url).href;
    const parent = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', `
        import { spawnWithFileOutput } from ${JSON.stringify(moduleUrl)};
        spawnWithFileOutput({command: "trap '' TERM; echo $$; sleep 60 & echo $!; wait", cwd: ${JSON.stringify(dir)}, logPath: ${JSON.stringify(join(dir, 'log'))}, foreground: true});
    `], { stdio: 'ignore' });
    try {
        let pids: number[] = [];
        for (let i = 0; i < 100; i++) {
            try { pids = readFileSync(join(dir, 'log'), 'utf8').trim().split('\n').map(Number); } catch {}
            if (pids.length === 2 && pids.every(pid => pid > 0)) break;
            await delay(20);
        }
        assert.equal(pids.length, 2);
        const ended = new Promise(resolve => parent.once('exit', resolve));
        parent.kill('SIGKILL');
        await ended;
        const alive = (pid: number) => {
            try { return readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ')[0] !== 'Z'; }
            catch { return false; }
        };
        for (let i = 0; i < 100 && pids.some(alive); i++) await delay(20);
        assert.ok(pids.every(pid => !alive(pid)), 'descendants must be dead (zombies await OS reaping)');
    } finally { parent.kill('SIGKILL'); rmSync(dir, { recursive: true, force: true }); }
});

test('foreground child holds a separate parent event loop until completion', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spawn-ref-'));
    try {
        const url = new URL('../spawn.ts', import.meta.url).href;
        const child = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', `
            import { spawnWithFileOutput } from ${JSON.stringify(url)};
            const r = spawnWithFileOutput({command:'sleep 0.2; echo complete',cwd:${JSON.stringify(dir)},logPath:${JSON.stringify(join(dir, 'log'))},foreground:true});
            await r.exit; r.release();
        `], { stdio: 'ignore' });
        const code = await new Promise(resolve => child.once('exit', resolve));
        assert.equal(code, 0);
        assert.equal(readFileSync(join(dir, 'log'), 'utf8').trim(), 'complete');
    } finally { rmSync(dir, { recursive: true, force: true }); }
});
