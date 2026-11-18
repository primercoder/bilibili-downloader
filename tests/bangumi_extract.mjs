#!/usr/bin/env node
/**
 * Offline regression test for bangumi episode resolution.
 *
 * The page-extractor normally runs inside bilibili.com, but its bangumi path
 * only needs window.__INITIAL_STATE__, location and fetch. Mock those so the
 * ep/ss selection logic can be checked without a browser or login.
 *
 *   node tests/bangumi_extract.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";

const code = fs.readFileSync(new URL("../extension/page-extractor.js", import.meta.url), "utf8");

const episode = (id, cid, title) => ({
  id,
  ep_id: id,
  bvid: `BV${id}`,
  cid,
  long_title: title,
  duration: 1426000,
});

const episodes = [episode(554, 111, "第一话"), episode(555, 222, "第二话")];
const season = {
  code: 0,
  result: { season_title: "测试番剧", episodes },
};
const play = {
  code: 0,
  result: {
    accept_quality: [80],
    accept_description: ["1080P"],
    dash: {
      duration: 1426,
      video: [
        {
          id: 80,
          baseUrl: "https://example.com/video.m4s",
          backupUrl: [],
          codecs: "avc1.64001f",
          bandwidth: 1000,
          width: 1920,
          height: 1080,
          frameRate: "30",
        },
      ],
      audio: [
        {
          id: 30280,
          baseUrl: "https://example.com/audio.m4s",
          backupUrl: [],
          codecs: "mp4a.40.2",
          bandwidth: 128000,
        },
      ],
    },
  },
};

globalThis.fetch = async url => ({
  json: async () => {
    if (url.includes("pgc/view/web/season")) return season;
    if (url.includes("playurl")) return play;
    return { code: -404, message: "unexpected request" };
  },
});

async function extract({ pathname, page = 0, state }) {
  globalThis.window = {
    __INITIAL_STATE__: state,
    __biliDownloaderPage: page,
  };
  globalThis.location = { pathname, search: "" };
  return await eval(code);
}

const state = {
  mediaInfo: { season_id: 999, title: "测试番剧" },
  epInfo: episodes[1],
  epList: episodes,
};

const current = await extract({ pathname: "/bangumi/play/ss999", state });
assert.equal(current.ok, true, current.error);
assert.equal(current.bangumi, true);
assert.equal(current.page, 2);
assert.equal(current.partTitle, "第二话");
assert.equal(current.cid, 222);
assert.equal(current.pages.length, 2);

const selected = await extract({ pathname: "/bangumi/play/ss999", page: 1, state });
assert.equal(selected.ok, true, selected.error);
assert.equal(selected.page, 1);
assert.equal(selected.partTitle, "第一话");
assert.equal(selected.cid, 111);

console.log("PASS: 番剧 ss 页能定位当前集，并可按选集切换");
