#!/usr/bin/env node
/**
 * Probe whether the extension can reach the local HTTP helper.
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
      const status = await chrome.runtime.sendMessage({ type: "GET_HOST_STATUS" });
      const defaults = await chrome.runtime.sendMessage({ type: "GET_DEFAULTS" });
      return { status, defaults };
    })()`,
  );
  console.log(JSON.stringify(result, null, 2));
  if (!result?.status?.ok || !result?.defaults?.ok) {
    throw new Error("本地 HTTP 助手不可达");
  }
};

main().catch(error => {
  console.error("FAIL:", error.message);
  process.exitCode = 1;
});
