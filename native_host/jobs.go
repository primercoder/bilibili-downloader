package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

// jobManager runs downloads one at a time (two parallel jobs would fight for the
// same CDN bandwidth and make the progress panel meaningless). Jobs that arrive
// while another is running are queued instead of being rejected: that is the fix
// for "after one download finishes I can never download anything again".
type jobManager struct {
	peer    messageSink
	mu      sync.Mutex
	running *runningJob
	queue   []jobRequest
	last    map[string]any
	lastJob string
}

type runningJob struct {
	id     string
	cancel context.CancelFunc
}

func newJobManager(p messageSink) *jobManager {
	return &jobManager{peer: p}
}

func (m *jobManager) start(payload map[string]any) {
	job := parseJob(payload)
	if job.id == "" {
		job.id = fmt.Sprintf("job-%d", time.Now().UnixNano())
	}

	m.mu.Lock()
	if m.running != nil {
		m.queue = append(m.queue, job)
		position := len(m.queue)
		m.mu.Unlock()
		logf("job %s queued at position %d behind %s", job.id, position, m.running.id)
		m.send(map[string]any{
			"type": "queued", "state": "queued", "jobId": job.id,
			"position": position, "title": job.title,
		})
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	m.running = &runningJob{id: job.id, cancel: cancel}
	m.lastJob = job.id
	m.mu.Unlock()
	go m.executeJob(ctx, cancel, job)
}

func (m *jobManager) executeJob(ctx context.Context, cancel context.CancelFunc, job jobRequest) {
	defer func() {
		cancel()
		m.mu.Lock()
		m.running = nil
		var next *jobRequest
		if len(m.queue) > 0 {
			candidate := m.queue[0]
			m.queue = m.queue[1:]
			next = &candidate
		}
		m.mu.Unlock()
		if next != nil {
			nextCtx, nextCancel := context.WithCancel(context.Background())
			m.mu.Lock()
			m.running = &runningJob{id: next.id, cancel: nextCancel}
			m.lastJob = next.id
			m.mu.Unlock()
			logf("starting queued job %s", next.id)
			m.send(map[string]any{
				"type": "progress", "state": "progress", "jobId": next.id,
				"stage": "排队结束，准备下载", "percent": 0,
			})
			go m.executeJob(nextCtx, nextCancel, *next)
		}
	}()
	m.run(ctx, job)
}

func (m *jobManager) cancel(jobID string) {
	m.mu.Lock()
	// A queued job can be cancelled before it ever starts.
	for index, queued := range m.queue {
		if jobID == "" || queued.id == jobID {
			m.queue = append(m.queue[:index], m.queue[index+1:]...)
			m.mu.Unlock()
			m.send(map[string]any{"type": "error", "state": "error", "jobId": jobID, "error": "下载已取消"})
			return
		}
	}
	running := m.running
	m.mu.Unlock()
	if running == nil {
		return
	}
	if jobID == "" || jobID == running.id {
		running.cancel()
	}
}

// cancelAll is used when the popup asks for a clean slate.
func (m *jobManager) cancelAll() {
	m.mu.Lock()
	m.queue = nil
	running := m.running
	m.mu.Unlock()
	if running != nil {
		running.cancel()
	}
}

func (m *jobManager) sendStatus() {
	m.mu.Lock()
	runningID := ""
	if m.running != nil {
		runningID = m.running.id
	}
	queued := make([]string, 0, len(m.queue))
	for _, job := range m.queue {
		queued = append(queued, job.id)
	}
	last := m.last
	m.mu.Unlock()
	m.peer.sendMessage(map[string]any{
		"type":     "status",
		"state":    "status",
		"running":  runningID,
		"queued":   queued,
		"last":     last,
		"muxer":    "builtin",
		"ffmpeg":   hasFFmpeg(),
		"version":  version,
		"platform": runtime.GOOS,
	})
}

func (m *jobManager) send(message map[string]any) {
	if jobID, ok := message["jobId"].(string); ok {
		m.mu.Lock()
		m.last = message
		m.lastJob = jobID
		m.mu.Unlock()
	}
	m.peer.sendMessage(message)
}

type jobRequest struct {
	id        string
	title     string
	partTitle string
	bvid      string
	page      int
	directory string
	keep      bool
	workers   int
	video     stream
	audio     stream
}

func parseJob(payload map[string]any) jobRequest {
	job := jobRequest{
		id:        stringField(payload, "id"),
		title:     stringField(payload, "title"),
		partTitle: stringField(payload, "partTitle"),
		bvid:      stringField(payload, "bvid"),
		directory: stringField(payload, "directory"),
		keep:      boolField(payload, "keep"),
		page:      int(numberField(payload, "page")),
		workers:   int(numberField(payload, "workers")),
		video:     decodeStream(payload["video"]),
		audio:     decodeStream(payload["audio"]),
	}
	if job.page <= 0 {
		job.page = 1
	}
	return job
}

func (m *jobManager) progress(jobID string, stage string, percent float64, done, total int64, speed float64, detail string) {
	if percent < 0 {
		percent = 0
	}
	if percent > 100 {
		percent = 100
	}
	message := map[string]any{
		"type":       "progress",
		"state":      "progress",
		"jobId":      jobID,
		"stage":      stage,
		"percent":    round1(percent),
		"downloaded": done,
		"total":      total,
		"speed":      speed,
		"detail":     detail,
	}
	m.send(message)
}

func round1(value float64) float64 {
	return float64(int(value*10+0.5)) / 10
}

func (m *jobManager) run(ctx context.Context, job jobRequest) {
	logf("job %s start: %s", job.id, job.title)
	if err := m.execute(ctx, job); err != nil {
		if ctx.Err() != nil || errors.Is(err, context.Canceled) {
			m.send(map[string]any{"type": "error", "state": "error", "jobId": job.id, "error": "下载已取消"})
			return
		}
		logf("job %s failed: %v", job.id, err)
		m.send(map[string]any{"type": "error", "state": "error", "jobId": job.id, "error": err.Error()})
	}
}

func (m *jobManager) execute(ctx context.Context, job jobRequest) error {
	if err := validateStream(job.video, "视频"); err != nil {
		return err
	}
	hasAudio := len(job.audio.URLs) > 0
	if hasAudio {
		if err := validateStream(job.audio, "音频"); err != nil {
			return err
		}
	}

	directory := job.directory
	if directory == "" {
		directory = defaultDownloadDir()
	}
	directory = expandHome(directory)
	if err := os.MkdirAll(directory, 0o755); err != nil {
		return fmt.Errorf("无法创建保存目录：%v", err)
	}
	if err := ensureWritable(directory); err != nil {
		return err
	}

	base := safeName(job.title, 120)
	if base == "" {
		base = "bilibili-video"
	}
	if job.partTitle != "" {
		base = safeName(fmt.Sprintf("%s - P%d %s", base, job.page, job.partTitle), 150)
	}
	output := uniquePath(filepath.Join(directory, base+".mp4"))

	// 视频流和音频流同时下载：音频只有 20 MB 左右，跟着视频一起跑可以把空闲
	// 连接也利用起来，比"视频下完再下音频"快 3~5 秒，也避免中途降速带来的
	// 等待叠加。
	// Stable work directory keyed by the streams themselves, not the job id.
	// A retry of the same video gets a fresh job id, and keying by job id would
	// throw away the already-downloaded segments — which is exactly the case
	// where resume matters most (network died at 90%).
	workDir := directory
	keep := job.keep
	streamsKey := streamKey(job.video, job.audio)
	if !keep {
		workDir = filepath.Join(directory, ".bili-tmp-"+streamsKey)
		if err := os.MkdirAll(workDir, 0o755); err != nil {
			return fmt.Errorf("无法创建临时目录：%v", err)
		}
	}
	videoPath := filepath.Join(workDir, "video.m4s")
	audioPath := filepath.Join(workDir, "audio.m4s")
	referer := fmt.Sprintf("https://www.bilibili.com/video/%s/", job.bvid)
	if job.bvid == "" {
		referer = "https://www.bilibili.com/"
	}

	cleanup := func() {
		if keep {
			return
		}
		_ = os.Remove(videoPath)
		_ = os.Remove(audioPath)
		_ = os.RemoveAll(workDir)
	}

	m.progress(job.id, "解析下载地址", 2, 0, 0, 0, "探测 CDN 镜像与文件大小")

	var completed sync.WaitGroup
	var videoTotal, audioTotal int64
	var videoDone, audioDone int64
	var videoSpeed, audioSpeed float64
	var counters sync.Mutex
	// Percent range 4-92 is shared between the two transfers, then mux + verify.
	combinedPercent := func() float64 {
		counters.Lock()
		defer counters.Unlock()
		total := videoTotal + audioTotal
		if total == 0 {
			return 4
		}
		fraction := float64(videoDone+audioDone) / float64(total)
		return 4 + 88*fraction
	}
	forward := func(stage string) progressFunc {
		return func(done, total int64, speed float64, detail string) {
			counters.Lock()
			if strings.Contains(stage, "视频") {
				videoDone, videoTotal, videoSpeed = done, total, speed
			} else {
				audioDone, audioTotal, audioSpeed = done, total, speed
			}
			sumDone := videoDone + audioDone
			sumTotal := videoTotal + audioTotal
			sumSpeed := videoSpeed + audioSpeed
			counters.Unlock()
			m.progress(job.id, stage, combinedPercent(), sumDone, sumTotal, sumSpeed, detail)
		}
	}

	errs := make([]error, 0, 2)
	var errMu sync.Mutex
	launch := func(task streamTask) {
		completed.Add(1)
		go func() {
			defer completed.Done()
			if err := downloadFile(ctx, task, job.workers); err != nil {
				errMu.Lock()
				errs = append(errs, err)
				errMu.Unlock()
			}
		}()
	}
	launch(streamTask{label: "视频", stream: job.video, target: videoPath, referer: referer, progress: forward("下载视频流")})
	if hasAudio {
		launch(streamTask{label: "音频", stream: job.audio, target: audioPath, referer: referer, progress: forward("下载音频流")})
	}
	completed.Wait()

	if ctx.Err() != nil {
		cleanup()
		return context.Canceled
	}
	if len(errs) > 0 {
		cleanup()
		return errs[0]
	}
	for _, path := range []string{videoPath, audioPath} {
		if hasAudio || path != audioPath {
			info, err := os.Stat(path)
			if err != nil || info.Size() == 0 {
				cleanup()
				return fmt.Errorf("下载的文件为空：%s", filepath.Base(path))
			}
		}
	}

	m.progress(job.id, "合成 MP4", 94, 0, 0, 0, "内置合成引擎 · 不重新编码")

	partial := filepath.Join(directory, "."+job.id+".partial.mp4")
	if hasAudio {
		duration, err := muxProgressiveMP4(videoPath, audioPath, partial)
		if err != nil {
			_ = os.Remove(partial)
			cleanup()
			return fmt.Errorf("合成失败：%w", err)
		}
		if duration <= 0 {
			_ = os.Remove(partial)
			cleanup()
			return errors.New("合成失败：输出时长无效")
		}
	} else {
		// 只有视频流：同样重排成普通 MP4。
		if err := muxSingleTo(videoPath, partial); err != nil {
			_ = os.Remove(partial)
			cleanup()
			return fmt.Errorf("合成失败：%w", err)
		}
	}

	m.progress(job.id, "校验文件", 98, 0, 0, 0, "检查 moov 索引与时长")
	probeResult, err := verifyMP4(partial)
	if err != nil {
		_ = os.Remove(partial)
		cleanup()
		return fmt.Errorf("校验失败：%w", err)
	}
	if err := os.Rename(partial, output); err != nil {
		_ = os.Remove(partial)
		cleanup()
		return fmt.Errorf("无法写入最终文件：%v", err)
	}

	kept := []string{}
	if keep {
		// 中间文件按最终文件名命名，方便用户辨认。
		videoKept := strings.TrimSuffix(output, ".mp4") + ".video.m4s"
		audioKept := strings.TrimSuffix(output, ".mp4") + ".audio.m4s"
		_ = os.Rename(videoPath, videoKept)
		if hasAudio {
			_ = os.Rename(audioPath, audioKept)
			kept = []string{videoKept, audioKept}
		} else {
			kept = []string{videoKept}
		}
	} else {
		cleanup()
	}

	m.progress(job.id, "完成", 100, 0, 0, 0, "")
	m.send(map[string]any{
		"type":       "done",
		"state":      "done",
		"jobId":      job.id,
		"output":     output,
		"directory":  directory,
		"kept":       kept,
		"duration":   probeResult.duration,
		"size":       probeResult.size,
		"videoCodec": probeResult.videoCodec,
		"audioCodec": probeResult.audioCodec,
		"hasAudio":   probeResult.hasAudio,
		"muxer":      "builtin",
		"finishedAt": time.Now().Unix(),
		"title":      job.title,
	})
	logf("job %s done: %s (%.1fs)", job.id, output, probeResult.duration)
	return nil
}

func expandHome(path string) string {
	if strings.HasPrefix(path, "~") {
		home, err := os.UserHomeDir()
		if err == nil {
			return filepath.Join(home, strings.TrimPrefix(strings.TrimPrefix(path, "~"), string(os.PathSeparator)))
		}
	}
	return path
}

// probe command: reports which mirror is fastest without downloading.
func (m *jobManager) probe(jobID string, video, audio stream) {
	if err := validateStream(video, "视频"); err != nil {
		m.peer.sendMessage(map[string]any{"type": "error", "state": "error", "error": err.Error()})
		return
	}
	pool := newMirrorPool(video.URLs)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	started := time.Now()
	size, best, ranged, err := probe(ctx, pool, "https://www.bilibili.com/")
	if err != nil {
		m.peer.sendMessage(map[string]any{"type": "error", "state": "error", "error": err.Error()})
		return
	}
	elapsed := time.Since(started)
	payload := map[string]any{
		"type":     "probe",
		"state":    "probe",
		"jobId":    jobID,
		"size":     size,
		"mirrors":  len(pool.mirrors),
		"ranged":   ranged,
		"latency":  elapsed.Milliseconds(),
		"bestHost": best.host,
	}
	if len(audio.URLs) > 0 {
		audioPool := newMirrorPool(audio.URLs)
		if audioSize, _, _, err := probe(ctx, audioPool, "https://www.bilibili.com/"); err == nil {
			payload["audioSize"] = audioSize
		}
	}
	m.peer.sendMessage(payload)
}
