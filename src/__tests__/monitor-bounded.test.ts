import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMonitorCapture, MONITOR_LOG_BYTES, MONITOR_FRAME_BYTES } from "../monitor-capture.ts";
import { spawnCommandSource } from "../monitor-source.ts";
import { openWsSource } from "../monitor-ws.ts";

function workspace(t: any) {
    const dir = fs.mkdtempSync(join(tmpdir(), "monitor-bounded-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}
class FakeSocket extends EventTarget {
    static latest: FakeSocket;
    closed = false;
    constructor() { super(); FakeSocket.latest = this; }
    close() { this.closed = true; }
    message(data: unknown) { this.dispatchEvent(new MessageEvent("message", { data })); }
}
function socketMock(t: any) {
    const original = globalThis.WebSocket;
    globalThis.WebSocket = FakeSocket as any;
    t.after(() => { globalThis.WebSocket = original; });
}

test("capture stays hard bounded over repeated rotations", (t) => {
    const path = join(workspace(t), "out");
    const capture = openMonitorCapture(path);
    try {
        for (let i = 0; i < 100; i++) {
            capture.write(Buffer.alloc(100_000, 97));
            assert.ok(fs.statSync(path).size <= MONITOR_LOG_BYTES);
        }
    } finally { capture.close(); }
});

test("command bounds stdout and stderr without terminating long-lived source", async (t) => {
    const dir = workspace(t);
    const logPath = join(dir, "out"), errPath = join(dir, "err");
    const source = spawnCommandSource({ cwd: dir, logPath, errPath,
        command: "head -c 3000000 /dev/zero; head -c 3000000 /dev/zero >&2; printf ready; sleep 30" });
    t.after(() => source.stop());
    let ended = false;
    void source.exit.then(() => { ended = true; });
    const deadline = Date.now() + 5000;
    while (!fs.readFileSync(logPath).includes(Buffer.from("ready"))) {
        assert.ok(Date.now() < deadline, "command output did not arrive");
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(ended, false);
    assert.ok(fs.statSync(logPath).size <= MONITOR_LOG_BYTES);
    assert.ok(fs.statSync(errPath).size <= MONITOR_LOG_BYTES);
    source.stop();
    await source.exit;
});

test("WS retention rolls and oversized UTF-8 frames fail and close", async (t) => {
    socketMock(t);
    const path = join(workspace(t), "ws");
    const source = openWsSource({ url: "ws://test" }, path);
    const socket = FakeSocket.latest;
    for (let i = 0; i < 100; i++) socket.message("x".repeat(30_000));
    assert.ok(fs.statSync(path).size <= MONITOR_LOG_BYTES);
    assert.equal(socket.closed, false);
    socket.message("界".repeat(MONITOR_FRAME_BYTES / 2));
    assert.equal(await source.exit, 1);
    assert.equal(socket.closed, true);
    const size = fs.statSync(path).size;
    socket.message("ignored");
    assert.equal(fs.statSync(path).size, size);
});

test("WS constructor failure closes capture descriptor", (t) => {
    socketMock(t);
    const path = join(workspace(t), "ws");
    globalThis.WebSocket = class { constructor() { throw new Error("bad url"); } } as any;
    const original = fs.closeSync;
    let closes = 0;
    fs.closeSync = ((fd: number) => { closes++; return original(fd); }) as any;
    syncBuiltinESMExports();
    try {
        assert.throws(() => openWsSource({ url: "invalid" }, path), /bad url/);
        assert.equal(closes, 1);
    } finally { fs.closeSync = original; syncBuiltinESMExports(); }
});

test("short WS writes fail exit and close socket", async (t) => {
    socketMock(t);
    const source = openWsSource({ url: "ws://test" }, join(workspace(t), "ws"));
    const original = fs.writeSync;
    fs.writeSync = (() => 0) as any;
    syncBuiltinESMExports();
    try { FakeSocket.latest.message("hello"); }
    finally { fs.writeSync = original; syncBuiltinESMExports(); }
    assert.equal(await source.exit, 1);
    assert.equal(FakeSocket.latest.closed, true);
});

test("command capture errors fail visibly", async (t) => {
    const dir = workspace(t);
    const source = spawnCommandSource({ cwd: dir, logPath: join(dir, "out"), errPath: join(dir, "err"), command: "printf output; sleep 30" });
    t.after(() => source.stop());
    const original = fs.writeSync;
    fs.writeSync = (() => { throw new Error("capture disk failure"); }) as any;
    syncBuiltinESMExports();
    let timer: NodeJS.Timeout | undefined;
    try {
        const result = await Promise.race([source.exit, new Promise<never>((_resolve,reject)=>{
            timer=setTimeout(()=>reject(new Error("capture failure did not settle")),5000);
        })]);
        assert.equal(result.code, 1);
    } finally {
        clearTimeout(timer);
        fs.writeSync = original;
        syncBuiltinESMExports();
    }
});
