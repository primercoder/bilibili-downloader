// Injected into the Bilibili page's MAIN world by the service worker.
//
// The page already holds the logged-in session, so requesting playurl here
// returns the qualities the account is entitled to. Nothing is exported except
// plain stream URLs; cookies are never read or forwarded.
(async () => {
  const fail = message => ({ ok: false, error: message });

  // PGC pages put the current episode in __INITIAL_STATE__.epInfo. This is the
  // only reliable way to know which episode an ss-style URL is actually playing.
  const readInitialState = () => {
    const state = window.__INITIAL_STATE__;
    return state && typeof state === "object" ? state : null;
  };

  const readPageInfo = () => {
    // __playinfo__ is what the player itself received. It is the most reliable
    // source and needs no extra network round-trip. PGC responses are sometimes
    // wrapped in result instead of data.
    const playinfo = window.__playinfo__;
    if (!playinfo || typeof playinfo !== "object") return null;
    const payload = playinfo.data || playinfo.result;
    if (!payload || typeof payload !== "object" || !payload.dash) return null;
    return payload;
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

  // Episode durations from PGC APIs are milliseconds, while dash.duration is
  // seconds. Values above 100000 only make sense as milliseconds.
  const secondsOf = value => {
    const number = Number(value) || 0;
    return number > 100000 ? Math.round(number / 1000) : Math.round(number);
  };

  const episodeIdOf = episode => Number(episode?.ep_id || episode?.id || 0) || 0;
  const episodeTitleOf = episode => episode?.long_title || episode?.title || "";

  try {
    const path = location.pathname;
    const videoMatch = path.match(/\/video\/(BV[0-9A-Za-z]+|av\d+)/i);
    const bangumiMatch = path.match(/\/bangumi\/play\/(ep\d+|ss\d+)/i);
    if (!videoMatch && !bangumiMatch) {
      return fail("当前页面不是 Bilibili 视频页，请打开一个视频后重试");
    }

    const params = new URLSearchParams(location.search);
    const override = Number(window.__biliDownloaderPage || 0);
    const initial = readInitialState();
    const stateEpisode =
      initial?.epInfo && typeof initial.epInfo === "object" ? initial.epInfo : null;

    let bvid = "";
    let cid = 0;
    let page = 1;
    let pages = [];
    let title = "";
    let partTitle = "";
    let duration = 0;
    let bangumi = false;
    let episodeId = 0;

    if (videoMatch) {
      bvid = videoMatch[1];
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

      const response = await fetch(
        `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`,
        { credentials: "include" },
      );
      const payload = await response.json();
      if (payload.code !== 0) {
        return fail(`获取视频信息失败（${payload.code}）：${payload.message || "未知错误"}`);
      }
      const view = payload.data;
      pages = (view.pages || []).map(item => ({
        page: item.page,
        cid: item.cid,
        part: item.part || "",
        duration: item.duration || 0,
      }));
      const requested = Math.max(1, override || Number(params.get("p") || 1) || 1);
      const currentPage = pages.find(item => item.page === requested) || pages[0];
      cid = currentPage?.cid || view.cid;
      page = currentPage?.page || 1;
      title = view.title;
      partTitle = pages.length > 1 ? currentPage?.part || "" : "";
      duration = secondsOf(currentPage?.duration || view.duration);
    } else {
      // ---------------------------------------------------------------------
      // Bangumi: resolve the current episode, then use the PGC playurl API.
      // ---------------------------------------------------------------------
      bangumi = true;
      const token = bangumiMatch[1].toLowerCase();
      const kind = token.slice(0, 2);
      const numericId = Number(token.slice(2)) || 0;

      let seasonError = "";
      const fetchSeason = async query => {
        try {
          const response = await fetch(
            `https://api.bilibili.com/pgc/view/web/season?${query}`,
            { credentials: "include" },
          );
          const payload = await response.json();
          if (payload?.code === 0 && payload.result) return payload.result;
          seasonError =
            `获取番剧信息失败（${payload?.code ?? "网络错误"}）：` +
            (payload?.message || "未知错误");
        } catch (error) {
          seasonError = error?.message || String(error);
        }
        return null;
      };

      // ep pages can be resolved directly; ss pages need the current episode
      // from the player state, falling back to the first episode.
      let season = kind === "ep" ? await fetchSeason(`ep_id=${numericId}`) : null;
      if (!season && kind === "ss") {
        season = await fetchSeason(`season_id=${numericId}`);
      }
      if (!season) {
        const stateSeasonId = initial?.mediaInfo?.season_id || stateEpisode?.season_id;
        if (stateSeasonId) season = await fetchSeason(`season_id=${stateSeasonId}`);
      }

      const stateEpisodes = Array.isArray(initial?.epList) ? initial.epList : [];
      let episodes = Array.isArray(season?.episodes) ? [...season.episodes] : [];
      if (!episodes.length && stateEpisodes.length) episodes = [...stateEpisodes];
      if (!episodes.length && Array.isArray(season?.section)) {
        for (const section of season.section) {
          if (Array.isArray(section?.episodes)) episodes.push(...section.episodes);
        }
      }
      // Only episodes with a cid can be played/downloaded. Filtering here keeps
      // the panel's page numbers aligned with the list it shows.
      episodes = episodes.filter(item => Number(item.cid));

      let currentEpisodeId = 0;
      if (kind === "ep") {
        currentEpisodeId = numericId;
      } else {
        currentEpisodeId = episodeIdOf(stateEpisode);
        if (!currentEpisodeId) currentEpisodeId = Number(params.get("ep_id") || 0) || 0;
      }

      let index = -1;
      if (override > 0) index = override - 1;
      if (index < 0 || index >= episodes.length) {
        index = episodes.findIndex(item => episodeIdOf(item) === currentEpisodeId);
      }
      if (index < 0 && stateEpisode && episodeIdOf(stateEpisode)) {
        const stateId = episodeIdOf(stateEpisode);
        if (!episodes.some(item => episodeIdOf(item) === stateId)) episodes.unshift(stateEpisode);
        index = episodes.findIndex(item => episodeIdOf(item) === stateId);
      }
      if (index < 0) index = 0;

      let selected = episodes[index] || stateEpisode;
      if (!selected?.bvid || !selected?.cid) {
        if (stateEpisode?.bvid && stateEpisode?.cid) {
          selected = stateEpisode;
          if (!episodes.length) {
            episodes = [stateEpisode];
            index = 0;
          }
        } else {
          return fail(seasonError || "番剧页面暂不支持（可能受版权限制），请使用普通视频页");
        }
      }

      bvid = selected.bvid;
      cid = Number(selected.cid);
      page = index + 1;
      episodeId = episodeIdOf(selected) || (kind === "ep" ? numericId : 0);
      title =
        season?.season_title ||
        season?.title ||
        initial?.mediaInfo?.title ||
        stateEpisode?.title ||
        "番剧";
      partTitle = episodeTitleOf(selected);
      duration = secondsOf(selected.duration);

      pages = episodes
        .map((item, itemIndex) => ({
          page: itemIndex + 1,
          cid: Number(item.cid) || 0,
          part: episodeTitleOf(item),
          duration: secondsOf(item.duration),
        }))
        .filter(item => item.cid);
    }

    if (!cid) return fail("未能确定视频 CID");

    // Reuse the player's own playurl response when it provably belongs to this
    // video. __playinfo__ carries no cid field, so validate by the stream path
    // instead. Without this check, navigating from video A to video B kept A's
    // stale streams while the title came from B.
    let playData = null;
    const cached = readPageInfo();
    if (cached && cachedOwnsCid(cached, cid)) {
      playData = cached;
    }

    if (!playData) {
      const endpoints = [];
      if (bangumi && episodeId) {
        endpoints.push(
          `https://api.bilibili.com/pgc/player/web/playurl?ep_id=${encodeURIComponent(episodeId)}` +
            `&cid=${encodeURIComponent(cid)}&bvid=${encodeURIComponent(bvid)}` +
            `&fnval=4048&fnver=0&fourk=1&qn=127`,
        );
      }
      endpoints.push(
        `https://api.bilibili.com/x/player/playurl?bvid=${encodeURIComponent(bvid)}` +
          `&cid=${encodeURIComponent(cid)}&fnval=4048&fnver=0&fourk=1&qn=127`,
      );

      let lastCode = 0;
      let lastMessage = "";
      for (const endpoint of endpoints) {
        try {
          const response = await fetch(endpoint, { credentials: "include" });
          const payload = await response.json();
          const data = payload?.result || payload?.data;
          if (payload?.code === 0 && data?.dash?.video?.length) {
            playData = data;
            break;
          }
          lastCode = payload?.code ?? 0;
          lastMessage = payload?.message || "";
        } catch (error) {
          lastMessage = error?.message || String(error);
        }
      }
      if (!playData) {
        return fail(
          `获取播放地址失败（${lastCode || "网络错误"}）：${lastMessage || "未知错误"}` +
            (lastCode === -404 ? "，请确认视频可正常播放" : ""),
        );
      }
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
      bangumi,
      bvid,
      cid,
      page,
      pages: pages.length ? pages : [{ page: 1, cid, part: "", duration }],
      title,
      partTitle,
      duration: Math.round(dash.duration || duration || 0),
      qualityNames,
      videos,
      audios,
    };
  } catch (error) {
    return fail(error?.message || String(error));
  }
})();
