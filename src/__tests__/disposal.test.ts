import { it } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, writeFileSync } from "node:fs";
import { BackgroundRegistry } from "../state.ts";
import { add, createRunningJob, logPathFor, stopSidebarTicker } from "../registry.ts";
import { abortJob, startBackgroundJob } from "../lifecycle.ts";
import { startMonitorSession } from "../monitor-session.ts";
import type { SpawnExit } from "../spawn.ts";

const tick = () => new Promise(resolve => setImmediate(resolve));

for (const replace of [false, true]) {
    it(`late completion cleans resources without accessing disposed host${replace ? ' after replacement' : ''}`, async () => {
        const reg = new BackgroundRegistry();
        let resolve!: (result: SpawnExit) => void;
        const exit = new Promise<SpawnExit>(r => { resolve = r; });
        let stale = false;
        let staleAccesses = 0;
        let cleanup = 0;
        let sends = 0;
        const ctx = { get ui() {
            if (stale) { staleAccesses++; throw new Error('stale UI'); }
            return { setWidget(){}, setStatus(){}, theme:{fg(_c:string,t:string){return t;}} };
        } };
        const pi = { sendMessage(){ sends++; if(stale) throw new Error('stale API'); } };
        const logPath = logPathFor(`dispose-${replace}`);
        writeFileSync(logPath, 'done');
        const job = add(reg,createRunningJob({id:`dispose-${replace}`,command:'test',pid:0,logPath,toolCallId:'t'}));
        startBackgroundJob({ reg, job, pi:pi as never, ctx:ctx as never, exit,
            onExit:()=>{ staleAccesses++; throw new Error('disposed completion callback must be fenced'); },
            onCleanup:()=>{cleanup++;} });
        reg.disposed = true; reg.generation++; stale = true;
        stopSidebarTicker(reg);
        abortJob(reg,job.id);
        if (replace) reg.disposed = false;
        resolve({code:0,signal:null});
        await tick();
        assert.equal(cleanup,1);
        assert.equal(job.status,'completed');
        assert.equal(reg.jobs.size,0);
        assert.equal(reg.jobAborts.size,0);
        assert.equal(staleAccesses,0);
        assert.equal(sends,0);
    });
}

it('monitor flush after disposal cannot emit into a stale or replacement session', async () => {
    const reg = new BackgroundRegistry();
    let resolve!: (result: SpawnExit) => void;
    const exit = new Promise<SpawnExit>(r=>{resolve=r;});
    let sends=0;
    const pi={sendMessage(){sends++;}};
    const ctx={ui:{setWidget(){},setStatus(){},theme:{fg(_c:string,t:string){return t;}}}};
    const logPath=logPathFor('dispose-monitor');
    writeFileSync(logPath,'');
    const job=add(reg,createRunningJob({id:'dispose-monitor',command:'test',pid:0,logPath,toolCallId:'t',kind:'monitor'}));
    startMonitorSession({reg,pi:pi as never,ctx:ctx as never,job,source:{logPath,pid:0,label:'test',exit,stop(){}},description:'test',persistent:true,timeoutMs:1000});
    reg.disposed=true; reg.generation++;
    stopSidebarTicker(reg);
    abortJob(reg,job.id);
    appendFileSync(logPath,'late line\n');
    // Model a new session reusing the registry before the old exit resolves.
    reg.disposed=false;
    resolve({code:0,signal:null});
    await tick();
    assert.equal(job.status,'completed');
    assert.equal(reg.jobs.size,0);
    assert.equal(sends,0);
});
