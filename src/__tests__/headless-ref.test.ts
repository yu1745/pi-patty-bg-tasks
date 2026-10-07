import { it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

it("a standalone headless host survives a foreground command until exit", () => {
    const script = `
        import { spawnWithFileOutput } from './src/spawn.ts';
        import { logPathFor } from './src/registry.ts';
        const task = spawnWithFileOutput({command:'sleep 0.2; printf finished',cwd:process.cwd(),logPath:logPathFor('headless'),foreground:true});
        task.exit.then(exit => { task.release(); console.log('SETTLED', exit.code); });
    `;
    const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], {
        cwd: new URL("../../", import.meta.url), encoding: "utf8", timeout: 5000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /SETTLED 0/);
});

it("a standalone attach waits for an unreferenced background process", () => {
    const script = `
        import { spawnWithFileOutput } from './src/spawn.ts';
        import { add, createRunningJob, logPathFor } from './src/registry.ts';
        import { BackgroundRegistry } from './src/state.ts';
        import { startBackgroundJob } from './src/lifecycle.ts';
        import { registerJobsTool } from './src/tools/jobs.ts';
        const reg = new BackgroundRegistry();
        let tool;
        const pi = {registerTool(def){tool=def;}, sendMessage(){}};
        const ctx = {ui:{notify(){},setWidget(){},setStatus(){},theme:{fg(_c,t){return t;}}}};
        const logPath = logPathFor('awaited');
        const task = spawnWithFileOutput({command:'sleep 0.2; echo complete',cwd:process.cwd(),logPath});
        const job = add(reg,createRunningJob({id:'awaited',command:'test',pid:task.pid,identity:task.identity,logPath,toolCallId:'t'}));
        startBackgroundJob({reg,pi,ctx,job,exit:task.exit});
        registerJobsTool(pi,reg);
        tool.execute('a',{action:'attach',jobId:job.id},undefined,undefined,ctx).then(result=>console.log(result.content[0].text));
    `;
    const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], {
        cwd: new URL("../../", import.meta.url), encoding: "utf8", timeout: 5000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Status: completed/);
});

it("a standalone host releases its child reference after promotion", () => {
    const script = `
        import { spawnWithFileOutput, killProcessTree } from './src/spawn.ts';
        import { logPathFor } from './src/registry.ts';
        const task = spawnWithFileOutput({command:'sleep 30',cwd:process.cwd(),logPath:logPathFor('promoted'),foreground:true});
        task.release();
        console.log('RELEASED');
    `;
    const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], {
        cwd: new URL("../../", import.meta.url), encoding: "utf8", timeout: 5000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /RELEASED/);
});
