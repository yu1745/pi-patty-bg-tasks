import { it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { BackgroundRegistry } from "../state.ts";
import { add, createRunningJob, logPathFor, stopSidebarTicker } from "../registry.ts";
import { killProcessTree, spawnWithFileOutput } from "../spawn.ts";
import { registerShortcuts } from "../shortcuts.ts";
import { openBgListPanel } from "../ui.ts";

const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));

for(const [mode,dispose] of [["shortcut",false],["panel",false],["shortcut",true]] as const) {
    it(`${mode} reports termination only after observed death${dispose ? ' and fences disposed UI' : ''}`,async()=>{
        const reg=new BackgroundRegistry();
        const id=`ui-${mode}-${dispose}`;
        const logPath=logPathFor(id);
        const task=spawnWithFileOutput({command:"trap '' TERM; printf ready; while true; do sleep 1; done",cwd:process.cwd(),logPath,foreground:true});
        const job=add(reg,createRunningJob({id,command:'resistant',pid:task.pid,identity:task.identity,logPath,toolCallId:'t'}));
        const messages:string[]=[];
        let selections=0;
        const ctx={ui:{notify(message:string){messages.push(message);},setWidget(){},setStatus(){},theme:{fg(_c:string,t:string){return t;}},
            async select(_title:string,items:string[]){selections++;return selections===1?items[0]:selections===2?'Kill':undefined;}}};
        try {
            for(let i=0;i<150&&!readFileSync(logPath,'utf8').includes('ready');i++) await delay(20);
            assert.match(readFileSync(logPath,'utf8'),/ready/);
            let pending:Promise<void>;
            if(mode==='shortcut') {
                const handlers=new Map<string,(ctx:unknown)=>Promise<void>>();
                registerShortcuts({registerShortcut(key:string,def:{handler:(ctx:unknown)=>Promise<void>}){handlers.set(key,def.handler);}} as never,reg);
                pending=handlers.get('ctrl+shift+x')!(ctx);
            } else pending=openBgListPanel(reg,ctx as never);
            await delay(100);
            assert.equal(job.status,'running','sending TERM must not mark killed');
            assert.equal(messages.length,0,'no optimistic success toast');
            if(dispose){reg.disposed=true;reg.generation++;}
            await pending;
            assert.equal(job.status,'killed');
            if(dispose) assert.equal(messages.length,0);
            else assert.ok(messages.some(message=>message.startsWith('Killed ')));
        } finally {
            killProcessTree(task.identity,'SIGKILL');
            task.release();
            stopSidebarTicker(reg);
        }
    });
}
