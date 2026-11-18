// Injected into the Bilibili page's MAIN world by the service worker.
//
// The page already holds the logged-in session, so requesting playurl here
// returns the qualities the account is entitled to. Nothing is exported except
// plain stream URLs; cookies are never read or forwarded.
(async () => {
  const fail = message => ({ ok: false, error: message });

  const readPageInfo = () => {
    // __playinfo__ is what the player itself received. It is the most reliable
    // source and needs no extra network round-trip.
    const playinfo = window.__playinfo__;
    if (!playinfo || typeof playinfo !== "object") return null;
    const dash = playinfo?.data?.dash;
    if (!dash) return null;
    return playinfo.data;
  };

  const describeCodec = code => {
    if (!code) return "未知";
    if (code.startsWith("avc1")) return "AVC";
    if (code.startsWith("hev1") || code.startsWith("hvc1")) return "HEVC";
    if (code.startsWith("av01")) return "AV1";
    return code;
  };

  const urlsOf = item =>
    [item.baseUrl || item.base_url, ...(item.backupUrl || item.backup_url || [])].filter(
      url => typeof url === "string" && url.startsWith("https://"),
    );

  // True when a cached playinfo response actually belongs to this cid. Bilibili
  // embeds the cid as a path segment of every media URL, and __playinfo__ has no
  // cid field of its own, so the URL is the only reliable marker.
  const cachedOwnsCid = (data, cid) => {
    const dash = data?.dash;
    const first = dash?.video?.[0] || dash?.audio?.[0];
    if (!first) return false;
    const url = urlsOf(first)[0];
    if (!url) return false;
    try {
      return new URL(url).pathname.split("/").includes(String(cid));
    } catch {
      return false;
    }
  };

  try {
    const path = location.pathname;
    const videoMatch = path.match(/\/video\/(BV[0-9A-Za-z]+|av\d+)/i);
    const bangumiMatch = path.match(/\/bangumi\/play\/(ep\d+|ss\d+)/i);
    if (!videoMatch && !bangumiMatch) {
      return fail("当前页面不是 Bilibili 视频页，请打开一个视频后重试");
    }

    const params = new URLSearchParams(location.search);
    const override = Number(window.__biliDownloaderPage || 0);
    const page = Math.max(1, override || Number(params.get("p") || 1) || 1);
    let bvid = videoMatch ? videoMatch[1] : "";
    if (/^av\d+$/i.test(bvid)) {
      const aid = bvid.slice(2);
      const response = await fetch(
        `https://api.bilibili.com/x/web-interface/view?aid=${encodeURIComponent(aid)}`,
        { credentials: "include" },
      );
      const payload = await response.json();
      bvid = payload?.data?.bvid || "";
      if (!bvid) return fail("无法解析该 av 号，请使用新版 BV 号链接");
    }

    let view = null;
    if (bvid) {
      const response = await fetch(
        `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`,
        { credentials: "include" },
      );
      const payload = await response.json();
      if (payload.code !== 0) {
        return fail(`获取视频信息失败（${payload.code}）：${payload.message || "未知错误"}`);
      }
      view = payload.data;
    } else {
      // Bangumi pages: resolve the episode to a bvid + cid.
      const episode = bangumiMatch[1];
      const response = await fetch(
        `https://api.bilibili.com/pgc/view/web/season?ep_id=${encodeURIComponent(
          episode.replace(/^ep/, ""),
        )}`,
        { credentials: "include" },
      ).catch(() => null);
      const payload = response ? await response.json() : null;
      const episodes = payload?.result?.episodes || [];
      const current = episodes.find(item => `ep${item.id}` === episode) || episodes[0];
      if (!current?.bvid) {
        return fail("番剧页面暂不支持（可能受版权限制），请使用普通视频页");
      }
      bvid = current.bvid;
      view = {
        bvid,
        title: payload.result.season_title || current.long_title || "番剧",
        pages: [{ cid: current.cid, page: 1, part: current.long_title || "" }],
        duration: current.duration ? Math.round(current.duration / 1000) : 0,
      };
    }

    const pages = (view.pages || []).map(item => ({
      page: item.page,
      cid: item.cid,
      part: item.part || "",
      duration: item.duration || 0,
    }));
    const currentPage = pages.find(item => item.page === page) || pages[0];
    const cid = currentPage?.cid || view.cid;
    if (!cid) return fail("未能确定视频 CID");

    // Reuse the player's own playurl response when it provably belongs to this
    // video. __playinfo__ carries no cid field, so validate by the stream path
    // instead: Bilibili puts the cid in the media URL (".../upgcxcode/34/78/
    // <cid>/<cid>_u1-1-...m4s"). Without this check, navigating from video A to
    // video B kept A's stale streams while the title came from B, so the saved
    // file had B's name and A's content.
    let playData = null;
    if (!bangumiMatch) {
      const cached = readPageInfo();
      if (cached && cachedOwnsCid(cached, cid)) {
        playData = cached;
      }
    }

    if (!playData) {
      const endpoint =
        `https://api.bilibili.com/x/player/playurl?bvid=${encodeURIComponent(bvid)}` +
        `&cid=${encodeURIComponent(cid)}&fnval=4048&fnver=0&fourk=1&qn=127`;
      const response = await fetch(endpoint, { credentials: "include" });
      const payload = await response.json();
      if (payload.code !== 0 || !payload.data) {
        return fail(
          `获取播放地址失败（${payload.code}）：${payload.message || "未知错误"}` +
            (payload.code === -404 ? "，请确认视频可正常播放" : ""),
        );
      }
      playData = payload.data;
    }

    const dash = playData.dash;
    if (!dash?.video?.length) {
      return fail("没有可用的 DASH 视频流。请确认已登录，且该视频未受版权/地区限制。");
    }

    const qualityNames = {};
    const ids = playData.accept_quality || [];
    const descriptions = playData.accept_description || [];
    ids.forEach((id, index) => {
      qualityNames[id] = descriptions[index] || `${id}`;
    });

    const videos = dash.video
      .map(item => ({
        id: item.id,
        codecs: item.codecs,
        codec: describeCodec(item.codecs),
        width: item.width,
        height: item.height,
        fps: item.frameRate || item.frame_rate || "",
        bandwidth: item.bandwidth || 0,
        urls: urlsOf(item),
      }))
      .filter(item => item.urls.length);

    const audioSource = [
      ...(dash.audio || []),
      ...(dash.dolby?.audio || []),
      ...(dash.flac?.audio ? [dash.flac.audio] : []),
    ];
    const audios = audioSource
      .map(item => ({
        id: item.id,
        codecs: item.codecs || "",
        bandwidth: item.bandwidth || 0,
        urls: urlsOf(item),
      }))
      .filter(item => item.urls.length);

    if (!audios.length) return fail("这个视频没有独立的音频流，暂不支持下载");

    return {
      ok: true,
      bvid,
      cid,
      page,
      pages: pages.length ? pages : [{ page: 1, cid, part: "", duration: view.duration }],
      title: view.title,
      partTitle: pages.length > 1 ? currentPage?.part || "" : "",
      duration: Math.round(dash.duration || view.duration || 0),
      qualityNames,
      videos,
      audios,
    };
  } catch (error) {
    return fail(error?.message || String(error));
  }
})();
