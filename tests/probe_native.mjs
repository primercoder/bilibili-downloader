#!/usr/bin/env node
/**
 * Probe whether Chrome can actually spawn the native host.
 *
 * Prints the raw reply, or the exact chrome.runtime.lastError message, which is
 * what tells "manifest not found" apart from "binary exited immediately".
 *
 *   node tests/probe_native.mjs
 */
const CDP = "http://127.0.0.1:9222";

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function newTab(url) {
  const response = await fetch(`${CDP}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
  return response.json();
}

async function findExtensionId() {
  if (process.env.BILI_EXTENSION_ID) return process.env.BILI_EXTENSION_ID;
  const targets = await (await fetch(`${CDP}/json/list`)).json();
  const candidates = [
    ...new Set(
      targets
        .filter(t => t.type === "service_worker" && t.url.startsWith("chrome-extension://"))
        .map(t => t.url.split("/")[2]),
    ),
  ];
  for (const id of candidates) {
    try {
      const tab = await newTab(`chrome-extension://${id}/popup.html`);
      await sleep(600);
      const title = await evalIn(tab.id, "document.title");
      if (title?.includes("Bili")) return id;
    } catch {
      /* not ours */
    }
  }
  throw new Error("找不到 Bili 扩展");
}

function evalIn(targetId, expression) {
  return new Promise(async (resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:9222/devtools/page/${targetId}`);
    await new Promise(r => ws.addEventListener("open", r));
    const id = 1;
    ws.addEventListener("message", event => {
      const message = JSON.parse(event.data);
      if (message.id !== id) return;
      ws.close();
      if (message.result?.exceptionDetails) {
        reject(new Error(message.result.exceptionDetails.text));
      } else {
        resolve(message.result?.result?.value);
      }
    });
    ws.send(
      JSON.stringify({
        id,
        method: "Runtime.evaluate",
        params: { expression, awaitPromise: true, returnByValue: true },
      }),
    );
  });
}

const main = async () => {
  const extension = await findExtensionId();
  console.log("extension:", extension);
  const tab = await newTab(`chrome-extension://${extension}/popup.html`);
  await sleep(800);
  const result = await evalIn(
    tab.id,
    `(async () => {
      if (!chrome.runtime.connectNative) return { step: "no permission" };
      const port = chrome.runtime.connectNative("com.opencode.bili_downloader");
      return await new Promise(resolve => {
        let settled = false;
        const finish = value => { if (!settled) { settled = true; resolve(value); } };
        port.onMessage.addListener(message => finish({ step: "reply", message }));
        port.onDisconnect.addListener(() =>
          finish({ step: "disconnect", error: chrome.runtime.lastError?.message || "" }));
        port.postMessage({ type: "defaults" });
        setTimeout(() => finish({ step: "timeout" }), 5000);
      });
    })()`,
  );
  console.log(JSON.stringify(result, null, 2));
  const log = "/tmp/bili-downloader-host.log";
  const fs = await import("node:fs");
  if (fs.existsSync(log)) {
    const lines = fs.readFileSync(log, "utf8").trim().split("\n").slice(-6);
    console.log("--- host log tail ---\n" + lines.join("\n"));
  }
};

main().catch(error => {
  console.error("FAIL:", error.message);
  process.exitCode = 1;
});
