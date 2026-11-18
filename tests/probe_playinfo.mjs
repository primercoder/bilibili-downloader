#!/usr/bin/env node
/**
 * Observe what window.__playinfo__ actually does across an in-page (SPA)
 * navigation, which is what happens when you click another video on Bilibili.
 *
 * This is a probe, not an assertion: it prints the cid embedded in the playinfo
 * stream URLs next to the cid of the page URL, sampled over time.
 *
 *   node tests/probe_playinfo.mjs
 */
const CDP = "http://127.0.0.1:9222";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const A = "https://www.bilibili.com/video/BV132436REqW/";

async function newTab(url) {
  return (await fetch(`${CDP}/json/new?${encodeURIComponent(url)}`, { method: "PUT" })).json();
}

class Session {
  constructor(id) {
    this.id = id;
    this.seq = 0;
    this.pending = new Map();
    this.ws = new WebSocket(`ws://127.0.0.1:9222/devtools/page/${id}`);
    this.ready = new Promise(r => this.ws.addEventListener("open", r));
    this.ws.addEventListener("message", e => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) {
        this.pending.get(m.id)(m);
        this.pending.delete(m.id);
      }
    });
  }
  async call(method, params = {}) {
    await this.ready;
    const id = ++this.seq;
    this.ws.send(JSON.stringify({ id, method, params }));
    const m = await new Promise(r => this.pending.set(id, r));
    if (m.error) throw new Error(JSON.stringify(m.error));
    return m.result || {};
  }
  async eval(expression) {
    const r = await this.call("Runtime.evaluate", {
      expression, awaitPromise: true, returnByValue: true, userGesture: true,
    });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error(d.exception?.description || d.text);
    }
    return r.result?.value;
  }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

// Reads the cid from the playinfo stream URL, whatever the page currently holds.
const SAMPLE = `(() => {
  const p = window.__playinfo__;
  const v = p && p.data && p.data.dash && p.data.dash.video && p.data.dash.video[0];
  const url = v ? (v.baseUrl || v.base_url || "") : "";
  const m = url.match(/\\/(\\d{6,})\\/\\1_/);
  return {
    pageCid: (() => {
      const mm = location.href.match(/\\/video\\/(BV[0-9A-Za-z]+)/);
      return mm ? mm[1] : null;
    })(),
    playinfoCid: m ? m[1] : null,
    hasPlayinfo: Boolean(p),
  };
})()`;

const main = async () => {
  const tab = await newTab(A);
  const s = new Session(tab.id);
  await sleep(8000);

  console.log("A 页面稳定后：", JSON.stringify(await s.eval(SAMPLE)));

  // Click an in-page video link, exactly like a user picking a recommended video.
  const clicked = await s.eval(`(() => {
    const links = [...document.querySelectorAll('a[href*="/video/BV"]')]
      .filter(a => !a.href.includes("BV132436REqW"));
    if (!links.length) return { ok: false };
    const target = links.find(a => a.closest(".video-page-card, .bili-video-card, .recommend-list")) || links[0];
    const href = target.href;
    target.click();
    return { ok: true, href };
  })()`);
  console.log("点击推荐视频：", JSON.stringify(clicked));
  if (!clicked.ok) {
    console.log("页面没有可点的推荐链接，改用 history API 模拟 SPA 跳转");
    await s.eval(`history.pushState({}, "", "/video/BV1GJ411x7h7/"); window.dispatchEvent(new PopStateEvent("popstate"));`);
  }

  for (const delay of [200, 500, 1000, 2000, 4000, 8000]) {
    await sleep(delay === 200 ? 200 : delay - (delay === 500 ? 200 : 0));
    let sample;
    try {
      sample = await s.eval(SAMPLE);
    } catch (error) {
      sample = { error: error.message };
    }
    console.log(`  +${delay}ms:`, JSON.stringify(sample));
  }

  s.close();
};

main().catch(error => {
  console.error("FAIL:", error.message);
  process.exitCode = 1;
});
