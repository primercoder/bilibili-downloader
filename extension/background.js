const HOST = "com.opencode.bili_downloader";
let nativePort = null;
let popupPort = null;
let lastState = { state: "idle" };
let lastDefaults = null;
let lastDirectory = "";

function notifyPopup() {
  try { popupPort?.postMessage({ type: "STATE", state: lastState }); } catch (_) { /* popup closed */ }
}

function connectNative() {
  if (nativePort) return nativePort;
  nativePort = chrome.runtime.connectNative(HOST);
  nativePort.onMessage.addListener(message => {
    if (message.type === "defaults") {
      lastDefaults = message;
    } else if (message.type === "directory") {
      lastDirectory = message.path || "";
    } else if (["progress", "done", "error"].includes(message.type)) {
      lastState = message;
    } else {
      return;
    }
    try { popupPort?.postMessage({ type: "NATIVE", message }); } catch (_) { /* popup closed */ }
  });
  nativePort.onDisconnect.addListener(() => {
    const error = chrome.runtime.lastError?.message;
    nativePort = null;
    if (!["done", "error"].includes(lastState.state)) {
      lastState = { type: "error", state: "error", error: error || "本地助手连接已断开，请运行安装脚本。" };
      notifyPopup();
    }
  });
  return nativePort;
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("找不到当前标签页");
  return tab;
}

async function extract(tabId) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId }, world: "MAIN", files: ["page-extractor.js"]
  });
  return result?.result || { ok: false, error: "页面脚本未返回结果，请刷新视频页后重试" };
}

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== "popup") return;
  popupPort = port;
  port.onDisconnect.addListener(() => { if (popupPort === port) popupPort = null; });
  port.postMessage({ type: "STATE", state: lastState });
  if (lastDefaults) port.postMessage({ type: "NATIVE", message: lastDefaults });
  if (lastDirectory) port.postMessage({ type: "NATIVE", message: { type: "directory", path: lastDirectory } });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    if (message.type === "GET_VIDEO_INFO") {
      const tab = await getActiveTab();
      if (!tab.url?.startsWith("https://www.bilibili.com/video/")) return { ok: false, error: "请先打开 Bilibili 视频页面" };
      return await extract(tab.id);
    }
    if (message.type === "GET_DEFAULTS") {
      connectNative().postMessage({ type: "defaults" });
      return { ok: true };
    }
    if (message.type === "CHOOSE_DIRECTORY") {
      connectNative().postMessage({ type: "choose_directory" });
      return { ok: true };
    }
    if (message.type === "START_DOWNLOAD") {
      connectNative().postMessage({ type: "start", job: message.job });
      return { ok: true };
    }
    if (message.type === "CANCEL_DOWNLOAD") {
      connectNative().postMessage({ type: "cancel", jobId: message.jobId });
      return { ok: true };
    }
    if (message.type === "GET_STATE") return lastState;
    return { ok: false, error: "未知操作" };
  })().then(sendResponse).catch(error => sendResponse({ ok: false, error: error?.message || String(error) }));
  return true;
});
