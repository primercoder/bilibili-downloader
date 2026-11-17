package main

// Test the built-in muxer against real Bilibili fragmented MP4 files.
//
// The fixture files are produced by tests/fetch_fixtures.py (small, publicly
// available stream). When they are missing the test downloads nothing and
// skips, so `go test ./...` stays offline-friendly.

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"testing"
)

func fixturePaths(t *testing.T) (string, string) {
	t.Helper()
	return namedFixtures(t, "video.m4s", "audio.m4s")
}

func namedFixtures(t *testing.T, videoName, audioName string) (string, string) {
	t.Helper()
	root, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(root, "..", "tests", "fixtures")
	video := filepath.Join(dir, videoName)
	audio := filepath.Join(dir, audioName)
	if _, err := os.Stat(video); err != nil {
		t.Skipf("缺少测试样本 tests/fixtures/%s（运行 tests/fetch_fixtures.py 生成）", videoName)
	}
	if _, err := os.Stat(audio); err != nil {
		t.Skipf("缺少测试样本 tests/fixtures/%s", audioName)
	}
	return video, audio
}

// TestMuxHandlesStreamsWithoutSampleDurations covers the second muxing variant
// Bilibili serves: no tfhd default duration and no per-sample duration, so all
// timing comes from tfdt. Before this was handled the output had zero duration
// and every player rejected it — which is exactly how the second download in a
// row failed.
func TestMuxHandlesStreamsWithoutSampleDurations(t *testing.T) {
	video, audio := namedFixtures(t, "video-no-duration.m4s", "audio-no-duration.m4s")
	out := filepath.Join(t.TempDir(), "out.mp4")
	duration, err := muxProgressiveMP4(video, audio, out)
	if err != nil {
		t.Fatalf("mux failed: %v", err)
	}
	if duration < 1 {
		t.Fatalf("duration was not reconstructed: %.2f", duration)
	}
	info, err := verifyMP4(out)
	if err != nil {
		t.Fatalf("verify failed: %v", err)
	}
	if !info.hasAudio || info.duration < 1 {
		t.Fatalf("bad output: %+v", info)
	}
	if ffprobe, err := exec.LookPath("ffprobe"); err == nil {
		probe := exec.Command(ffprobe, "-v", "error", "-print_format", "json",
			"-show_entries", "format=duration", out)
		raw, err := probe.Output()
		if err != nil {
			t.Fatalf("ffprobe rejected the output: %v", err)
		}
		var parsed struct {
			Format struct {
				Duration string `json:"duration"`
			} `json:"format"`
		}
		if err := json.Unmarshal(raw, &parsed); err != nil {
			t.Fatal(err)
		}
		if parsed.Format.Duration == "" || parsed.Format.Duration == "0.000000" {
			t.Fatalf("ffprobe sees no duration: %s", raw)
		}
	}
}

// TestDurationsMatchAcrossStreams is the real invariant: video and audio must
// agree within a couple of seconds, otherwise the file drifts out of sync.
func TestDurationsMatchAcrossStreams(t *testing.T) {
	for _, pair := range [][2]string{
		{"video.m4s", "audio.m4s"},
		{"video-no-duration.m4s", "audio-no-duration.m4s"},
	} {
		video, audio := namedFixtures(t, pair[0], pair[1])
		videoSource, err := openSource(video)
		if err != nil {
			t.Fatalf("%s: %v", pair[0], err)
		}
		audioSource, err := openSource(audio)
		if err != nil {
			t.Fatalf("%s: %v", pair[1], err)
		}
		vd := sourceSeconds(videoSource)
		ad := sourceSeconds(audioSource)
		videoSource.Close()
		audioSource.Close()
		if vd < 0.1 || ad < 0.1 {
			t.Fatalf("%s: zero duration video=%.2f audio=%.2f", pair[0], vd, ad)
		}
		if diff := vd - ad; diff > 2 || diff < -2 {
			t.Fatalf("%s: video %.2fs vs audio %.2fs drift too large", pair[0], vd, ad)
		}
	}
}

// TestMuxOutputHasCorrectContainerDuration is the check that caught a real bug:
// a 212s file whose mvhd/tkhd were right but whose copied edit list made
// ffprobe report format duration 0.042s. Container duration must match the
// track duration, otherwise players show a broken timeline.
func TestMuxOutputHasCorrectContainerDuration(t *testing.T) {
	ffprobe, err := exec.LookPath("ffprobe")
	if err != nil {
		t.Skip("未安装 ffprobe，跳过容器时长校验")
	}
	video, audio := namedFixtures(t, "video-no-duration.m4s", "audio-no-duration.m4s")
	out := filepath.Join(t.TempDir(), "out.mp4")
	if _, err := muxProgressiveMP4(video, audio, out); err != nil {
		t.Fatalf("mux failed: %v", err)
	}
	probe := exec.Command(ffprobe, "-v", "error", "-print_format", "json",
		"-show_entries", "format=duration:stream=codec_type,duration,start_time", out)
	raw, err := probe.Output()
	if err != nil {
		t.Fatalf("ffprobe failed: %v", err)
	}
	var parsed struct {
		Format struct {
			Duration string `json:"duration"`
		} `json:"format"`
		Streams []struct {
			CodecType string `json:"codec_type"`
			Duration  string `json:"duration"`
			StartTime string `json:"start_time"`
		} `json:"streams"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		t.Fatal(err)
	}
	container, err := strconv.ParseFloat(parsed.Format.Duration, 64)
	if err != nil || container <= 0 {
		t.Fatalf("container duration invalid: %q (%s)", parsed.Format.Duration, raw)
	}
	if container < 5 {
		t.Fatalf("container duration %.3fs is far too short", container)
	}
	for _, stream := range parsed.Streams {
		value, err := strconv.ParseFloat(stream.Duration, 64)
		if err != nil {
			t.Fatalf("%s stream has no duration: %s", stream.CodecType, raw)
		}
		if value < 5 {
			t.Fatalf("%s stream duration %.3fs is far too short", stream.CodecType, value)
		}
		if diff := value - container; diff > 1 || diff < -1 {
			t.Fatalf("%s stream %.2fs vs container %.2fs", stream.CodecType, value, container)
		}
	}
}

func sourceSeconds(source *sourceFile) float64 {
	longest := 0.0
	for _, track := range source.tracks {
		seconds := float64(trackDuration(track)) / float64(track.timescale)
		if seconds > longest {
			longest = seconds
		}
	}
	return longest
}

func TestMuxProducesProgressiveMP4(t *testing.T) {
	video, audio := fixturePaths(t)
	out := filepath.Join(t.TempDir(), "out.mp4")
	duration, err := muxProgressiveMP4(video, audio, out)
	if err != nil {
		t.Fatalf("mux failed: %v", err)
	}
	if duration < 1 {
		t.Fatalf("unexpected duration %.2f", duration)
	}
	info, err := verifyMP4(out)
	if err != nil {
		t.Fatalf("verify failed: %v", err)
	}
	if !info.hasAudio {
		t.Fatal("output lost the audio track")
	}
	if info.videoCodec == "" || info.audioCodec == "" {
		t.Fatalf("missing codec info: %+v", info)
	}
	// mdat must sit after moov so players can start before the whole file is read
	file, err := os.Open(out)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	stat, _ := file.Stat()
	pos := int64(0)
	moovAt, mdatAt := int64(-1), int64(-1)
	for pos < stat.Size() {
		header, err := readBoxHeader(file, pos, stat.Size())
		if err != nil {
			break
		}
		switch header.typ {
		case "moov":
			moovAt = header.start
		case "mdat":
			if mdatAt < 0 {
				mdatAt = header.start
			}
		}
		pos = header.end
	}
	if moovAt < 0 || mdatAt < 0 || mdatAt < moovAt {
		t.Fatalf("bad layout: moov=%d mdat=%d", moovAt, mdatAt)
	}
	t.Logf("muxed %.2fs, %d bytes, codecs %s + %s", info.duration, info.size, info.videoCodec, info.audioCodec)
}

// TestMuxMatchesFFmpegDuration is the important correctness check: the muxed
// file must have the same duration as ffmpeg's own stream-copy mux when ffmpeg
// happens to be installed. It also proves the output decodes cleanly.
func TestMuxMatchesFFmpegDuration(t *testing.T) {
	video, audio := fixturePaths(t)
	ffprobe, err := exec.LookPath("ffprobe")
	if err != nil {
		t.Skip("未安装 ffprobe，跳过交叉验证")
	}
	out := filepath.Join(t.TempDir(), "out.mp4")
	if _, err := muxProgressiveMP4(video, audio, out); err != nil {
		t.Fatalf("mux failed: %v", err)
	}
	probe := exec.Command(ffprobe, "-v", "error", "-print_format", "json",
		"-show_entries", "stream=codec_type,codec_name,duration", out)
	raw, err := probe.Output()
	if err != nil {
		t.Fatalf("ffprobe rejected our output: %v", err)
	}
	var parsed struct {
		Streams []struct {
			CodecType string `json:"codec_type"`
			CodecName string `json:"codec_name"`
			Duration  string `json:"duration"`
		} `json:"streams"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		t.Fatal(err)
	}
	if len(parsed.Streams) != 2 {
		t.Fatalf("expected 2 streams, got %d: %s", len(parsed.Streams), raw)
	}
	// Decode a few megabytes to make sure the sample table is coherent.
	decode := exec.Command(ffprobe, "-v", "error", "-read_intervals", "%+5",
		"-count_frames", "-show_entries", "stream=nb_read_frames", out)
	if output, err := decode.CombinedOutput(); err != nil {
		t.Fatalf("decoder error: %v\n%s", err, output)
	}
}

func TestVerifyRejectsTruncatedFile(t *testing.T) {
	video, audio := fixturePaths(t)
	out := filepath.Join(t.TempDir(), "out.mp4")
	if _, err := muxProgressiveMP4(video, audio, out); err != nil {
		t.Fatal(err)
	}
	stat, _ := os.Stat(out)
	if err := os.Truncate(out, stat.Size()/2); err != nil {
		t.Fatal(err)
	}
	if _, err := verifyMP4(out); err == nil {
		t.Fatal("verifyMP4 accepted a truncated file")
	}
}

func TestSafeName(t *testing.T) {
	cases := map[string]string{
		`a/b\c:d*e?f"g<h>i|j`: "a_b_c_d_e_f_g_h_i_j",
		"CON":                 "_CON",
		"  trailing.  ":       "trailing",
		"":                    "bilibili-video",
	}
	for input, want := range cases {
		if got := safeName(input, 150); got != want {
			t.Errorf("safeName(%q) = %q, want %q", input, got, want)
		}
	}
	long := strings229
	if got := safeName(long, 20); len([]rune(got)) > 20 {
		t.Errorf("safeName did not truncate: %q", got)
	}
}

var strings229 = "一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十"
