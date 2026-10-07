import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";

const delay = (ms:number) => new Promise(resolve=>setTimeout(resolve,ms));
const live = (pid:number) => {
    try { return readFileSync(`/proc/${pid}/stat`,"utf8").split(") ")[1].split(" ")[0] !== "Z"; }
    catch { return false; }
};
const url = new URL("../monitor-source.ts",import.meta.url).href;

it("monitor command pipes do not pin a background-only host", { skip: process.platform !== "linux" }, async () => {
    const dir=mkdtempSync(join(tmpdir(),"monitor-unref-"));
    try {
        const script=`
            import {spawnCommandSource} from ${JSON.stringify(url)};
            const source=spawnCommandSource({command:'sleep 60',cwd:${JSON.stringify(dir)},logPath:${JSON.stringify(join(dir,"out.log"))},errPath:${JSON.stringify(join(dir,"out.err"))}});
            console.log(source.pid);
        `;
        const result=spawnSync(process.execPath,["--experimental-strip-types","--input-type=module","-e",script],{encoding:"utf8",timeout:5000});
        assert.equal(result.status,0,result.stderr);
        const pid=Number(result.stdout.trim());
        assert.ok(pid>0);
        for(let i=0;i<100&&live(pid);i++) await delay(20);
        assert.equal(live(pid),false,"IPC EOF must clean the monitor group anchor");
    } finally { rmSync(dir,{recursive:true,force:true}); }
});

it("SIGKILL of a monitor host reaps resistant command descendants", { skip: process.platform !== "linux" }, async () => {
    const dir=mkdtempSync(join(tmpdir(),"monitor-parent-"));
    const logPath=join(dir,"out.log");
    const script=`
        import {spawnCommandSource} from ${JSON.stringify(url)};
        spawnCommandSource({command:"trap '' TERM; echo $$; sleep 60 & echo $!; wait",cwd:${JSON.stringify(dir)},logPath:${JSON.stringify(logPath)},errPath:${JSON.stringify(join(dir,"out.err"))}});
        setInterval(()=>{},1000);
    `;
    const parent=spawn(process.execPath,["--experimental-strip-types","--input-type=module","-e",script],{stdio:"ignore"});
    try {
        let pids:number[]=[];
        for(let i=0;i<100;i++) {
            try { pids=readFileSync(logPath,"utf8").trim().split("\n").map(Number); } catch {}
            if(pids.length===2&&pids.every(pid=>pid>0)) break;
            await delay(20);
        }
        assert.equal(pids.length,2);
        const ended=new Promise(resolve=>parent.once("exit",resolve));
        parent.kill("SIGKILL");
        await ended;
        for(let i=0;i<100&&pids.some(live);i++) await delay(20);
        assert.ok(pids.every(pid=>!live(pid)));
    } finally { parent.kill("SIGKILL"); rmSync(dir,{recursive:true,force:true}); }
});
