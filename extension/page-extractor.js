// Injected by the service worker into the page's MAIN world.
// Site cookies are used automatically; this file never reads or exports cookies.
(async () => {
  try {
    const match = location.pathname.match(/\/video\/(BV[0-9A-Za-z]+)/);
    if (!match) return { ok: false, error: "当前页面不是 Bilibili 视频页" };
    const bvid = match[1];
    const page = Number(new URLSearchParams(location.search).get("p") || 1);
    const response = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`, { credentials: "include" });
    const view = await response.json();
    if (view.code !== 0 || !view.data) return { ok: false, error: `获取视频信息失败（${view.code}）：${view.message || "未知错误"}` };
    const data = view.data;
    const part = data.pages?.[Math.max(0, page - 1)] || data.pages?.[0];
    const cid = part?.cid || data.cid;
    if (!cid) return { ok: false, error: "未能确定视频 CID" };
    const playResponse = await fetch(`https://api.bilibili.com/x/player/playurl?bvid=${encodeURIComponent(bvid)}&cid=${cid}&fnval=4048&fnver=0&fourk=1`, { credentials: "include" });
    const play = await playResponse.json();
    const dash = play.data?.dash;
    if (play.code !== 0 || !dash?.video?.length) {
      return { ok: false, error: `没有可用的 DASH 视频流（${play.code}）。请确认已登录且有观看权限。${play.message || ""}` };
    }
    const codecName = code => code.startsWith("avc1") ? "AVC" : code.startsWith("av01") ? "AV1" : code.startsWith("hev1") || code.startsWith("hvc1") ? "HEVC" : code;
    const videos = dash.video.map(v => ({
      id: v.id, codecs: v.codecs, codec: codecName(v.codecs || ""), width: v.width,
      height: v.height, fps: v.frameRate, bandwidth: v.bandwidth,
      urls: [v.baseUrl || v.base_url, ...(v.backupUrl || v.backup_url || [])].filter(Boolean)
    }));
    const audios = (dash.audio || []).map(a => ({
      id: a.id, codecs: a.codecs, bandwidth: a.bandwidth,
      urls: [a.baseUrl || a.base_url, ...(a.backupUrl || a.backup_url || [])].filter(Boolean)
    }));
    if (!audios.length) return { ok: false, error: "视频流存在，但未找到独立音频流" };
    return {
      ok: true, bvid, cid, page, title: data.title,
      partTitle: data.pages?.length > 1 ? part?.part : "",
      duration: dash.duration || data.duration,
      description: Object.fromEntries((play.data.accept_quality || []).map((q, i) => [q, play.data.accept_description?.[i] || `${q}`])),
      videos, audios
    };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
})()
