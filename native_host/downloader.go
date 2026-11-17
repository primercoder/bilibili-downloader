package main

// Multi-connection range downloader.
//
// Why: Bilibili's CDN throttles each TCP connection, and the throttle only
// kicks in after the transfer has been running for a while — that is the
// familiar "starts fast, then crawls" symptom. Measured on the same 76 MB 1080p
// stream: one connection settles near 42 MB/s, eight range connections reach
// about 71 MB/s. So the file is split into fixed byte ranges that are fetched
// in parallel on separate connections, spread across the mirror hosts the
// playurl API returns, with automatic failover when a mirror misbehaves.
//
// Every byte is written with WriteAt at its final offset, therefore a finished
// range is never fetched twice, a dropped connection resumes from its last
// byte, and a killed process continues from the segment state on disk.

import (
	"context"
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const (
	segmentBytes   = 4 << 20 // 4 MiB per range request
	defaultWorkers = 8
	maxWorkers     = 16
	userAgent      = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
	stallTimeout   = 45 * time.Second
	maxSegmentTry  = 8
)

var httpClient = &http.Client{
	Transport: &http.Transport{
		Proxy:                 http.ProxyFromEnvironment,
		DialContext:           (&net.Dialer{Timeout: 15 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
		MaxIdleConns:          128,
		MaxIdleConnsPerHost:   32,
		IdleConnTimeout:       60 * time.Second,
		TLSHandshakeTimeout:   15 * time.Second,
		ResponseHeaderTimeout: 25 * time.Second,
		// HTTP/2 would multiplex every range onto one TCP connection, which
		// silently defeats the whole point of the parallel design.
		ForceAttemptHTTP2:  false,
		DisableCompression: true,
	},
}

// ---------------------------------------------------------------------------
// Mirror pool
// ---------------------------------------------------------------------------

type mirror struct {
	url     string
	host    string
	score   float64 // measured bytes per second
	latency time.Duration
	untried bool
	fails   int
	dead    bool
}

type mirrorPool struct {
	mu      sync.Mutex
	mirrors []*mirror
}

func newMirrorPool(urls []string) *mirrorPool {
	pool := &mirrorPool{}
	seen := map[string]bool{}
	for _, raw := range urls {
		raw = strings.TrimSpace(raw)
		if raw == "" || seen[raw] {
			continue
		}
		if !strings.HasPrefix(raw, "https://") && !isLoopbackURL(raw) {
			continue
		}
		seen[raw] = true
		pool.mirrors = append(pool.mirrors, &mirror{url: raw, host: hostOfURL(raw), untried: true})
	}
	return pool
}

func hostOfURL(raw string) string {
	if parsed, err := url.Parse(raw); err == nil && parsed.Host != "" {
		return parsed.Host
	}
	return raw
}

// pick returns the healthiest mirror. Untried mirrors are handed out first so
// each host gets a measured score early in the transfer.
func (p *mirrorPool) pick() *mirror {
	p.mu.Lock()
	defer p.mu.Unlock()
	for _, item := range p.mirrors {
		if !item.dead && item.untried {
			item.untried = false
			return item
		}
	}
	var best *mirror
	for _, item := range p.mirrors {
		if item.dead {
			continue
		}
		if best == nil || item.score > best.score {
			best = item
		}
	}
	return best
}

func (p *mirrorPool) record(item *mirror, bytes int64, elapsed time.Duration) {
	if item == nil || elapsed <= 0 || bytes <= 0 {
		return
	}
	rate := float64(bytes) / elapsed.Seconds()
	p.mu.Lock()
	defer p.mu.Unlock()
	if item.score == 0 {
		item.score = rate
	} else {
		item.score = item.score*0.6 + rate*0.4
	}
	if item.fails > 0 {
		item.fails--
	}
}

func (p *mirrorPool) fail(item *mirror, fatal bool) {
	if item == nil {
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	item.fails++
	item.score *= 0.4
	if fatal || item.fails >= 4 || item.score < 1 {
		item.dead = true
	}
}

func (p *mirrorPool) alive() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	count := 0
	for _, item := range p.mirrors {
		if !item.dead {
			count++
		}
	}
	return count
}

func (p *mirrorPool) summary() string {
	p.mu.Lock()
	defer p.mu.Unlock()
	if len(p.mirrors) == 1 {
		return "单 CDN"
	}
	alive := 0
	for _, item := range p.mirrors {
		if !item.dead {
			alive++
		}
	}
	return fmt.Sprintf("CDN %d/%d", alive, len(p.mirrors))
}

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

func applyHeaders(request *http.Request, referer string) {
	request.Header.Set("User-Agent", userAgent)
	request.Header.Set("Referer", referer)
	request.Header.Set("Origin", "https://www.bilibili.com")
	request.Header.Set("Accept", "*/*")
	request.Header.Set("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8")
}

type httpStatusError struct{ code int }

func (e *httpStatusError) Error() string {
	switch e.code {
	case 401, 403:
		return fmt.Sprintf("CDN 拒绝访问（HTTP %d，媒体地址可能已过期，请重新打开面板）", e.code)
	case 404, 410:
		return fmt.Sprintf("CDN 上已找不到该文件（HTTP %d）", e.code)
	case 429:
		return "CDN 限流（HTTP 429），正在切换镜像"
	}
	return fmt.Sprintf("CDN 返回 HTTP %d", e.code)
}

func fatalStatus(code int) bool {
	switch code {
	case 401, 403, 404, 410, 451:
		return true
	}
	return false
}

var errRangeMismatch = errors.New("服务器忽略了 Range 请求")

// probe measures the file size and the fastest mirror using one-byte range
// requests, so probing costs no meaningful bandwidth.
func probe(ctx context.Context, pool *mirrorPool, referer string) (int64, *mirror, bool, error) {
	type outcome struct {
		mirror  *mirror
		size    int64
		ranges  bool
		elapsed time.Duration
		err     error
	}
	pool.mu.Lock()
	snapshot := append([]*mirror(nil), pool.mirrors...)
	pool.mu.Unlock()
	results := make(chan outcome, len(snapshot))
	for _, item := range snapshot {
		go func(item *mirror) {
			started := time.Now()
			request, err := http.NewRequestWithContext(ctx, http.MethodGet, item.url, nil)
			if err != nil {
				results <- outcome{mirror: item, err: err}
				return
			}
			applyHeaders(request, referer)
			request.Header.Set("Range", "bytes=0-0")
			response, err := httpClient.Do(request)
			if err != nil {
				results <- outcome{mirror: item, err: err}
				return
			}
			defer response.Body.Close()
			_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 1<<20))
			if response.StatusCode != http.StatusOK && response.StatusCode != http.StatusPartialContent {
				results <- outcome{mirror: item, err: &httpStatusError{code: response.StatusCode}}
				return
			}
			size := int64(0)
			if contentRange := response.Header.Get("Content-Range"); contentRange != "" {
				if slash := strings.LastIndex(contentRange, "/"); slash >= 0 {
					fmt.Sscanf(contentRange[slash+1:], "%d", &size)
				}
			}
			if size <= 0 {
				size = response.ContentLength
			}
			results <- outcome{
				mirror:  item,
				size:    size,
				ranges:  response.StatusCode == http.StatusPartialContent,
				elapsed: time.Since(started),
			}
		}(item)
	}

	var best *mirror
	bestElapsed := time.Duration(1<<62 - 1)
	var size int64
	rangeSupport := false
	var lastErr error
	for range snapshot {
		result := <-results
		if result.err != nil {
			pool.fail(result.mirror, fatalStatusOf(result.err))
			lastErr = result.err
			continue
		}
		if result.size <= 0 {
			pool.fail(result.mirror, false)
			continue
		}
		pool.mu.Lock()
		result.mirror.latency = result.elapsed
		result.mirror.untried = false
		pool.mu.Unlock()
		if best == nil || result.elapsed < bestElapsed {
			best, bestElapsed, size, rangeSupport = result.mirror, result.elapsed, result.size, result.ranges
		}
	}
	if best == nil {
		if lastErr == nil {
			lastErr = errors.New("没有可用的下载地址")
		}
		return 0, nil, false, fmt.Errorf("无法连接 B 站 CDN：%w", lastErr)
	}
	return size, best, rangeSupport, nil
}

func fatalStatusOf(err error) bool {
	var status *httpStatusError
	if errors.As(err, &status) {
		return fatalStatus(status.code)
	}
	return false
}

// ---------------------------------------------------------------------------
// Resume state
// ---------------------------------------------------------------------------

type resumeState struct {
	Key       string       `json:"key"`
	Total     int64        `json:"total"`
	Segments  int          `json:"segments"`
	SegBytes  int64        `json:"segmentBytes"`
	Completed map[int]bool `json:"completed"`
	Updated   time.Time    `json:"updatedAt"`
}

func stateDir() string {
	if custom := os.Getenv("BILI_DOWNLOADER_STATE"); custom != "" {
		return custom
	}
	return filepath.Join(os.TempDir(), "bili-downloader")
}

func streamKey(streams ...stream) string {
	hash := sha1.New()
	for _, item := range streams {
		_, _ = io.WriteString(hash, item.Codecs)
		for _, link := range item.URLs {
			if parsed, err := url.Parse(link); err == nil {
				_, _ = io.WriteString(hash, parsed.Path)
			}
		}
	}
	return hex.EncodeToString(hash.Sum(nil))[:16]
}

func loadResume(key string, total, segBytes int64) *resumeState {
	data, err := os.ReadFile(filepath.Join(stateDir(), key+".json"))
	if err != nil {
		return nil
	}
	var state resumeState
	if json.Unmarshal(data, &state) != nil {
		return nil
	}
	if state.Key != key || state.Total != total || state.SegBytes != segBytes || state.Completed == nil {
		return nil
	}
	return &state
}

func saveResume(state *resumeState) {
	state.Updated = time.Now()
	data, err := json.Marshal(state)
	if err != nil {
		return
	}
	path := filepath.Join(stateDir(), state.Key+".json")
	if os.MkdirAll(filepath.Dir(path), 0o755) != nil {
		return
	}
	tmp := path + ".tmp"
	if os.WriteFile(tmp, data, 0o644) != nil {
		return
	}
	_ = os.Rename(tmp, path)
}

func clearResume(key string) {
	_ = os.Remove(filepath.Join(stateDir(), key+".json"))
}

// ---------------------------------------------------------------------------
// Download job
// ---------------------------------------------------------------------------

type progressFunc func(done, total int64, speed float64, detail string)

type streamTask struct {
	label    string
	stream   stream
	target   string
	referer  string
	progress progressFunc
}

// downloadFile fetches one DASH stream, resuming whatever is already on disk.
func downloadFile(ctx context.Context, task streamTask, workers int) error {
	progress := task.progress
	if progress == nil {
		progress = func(int64, int64, float64, string) {}
	}
	if err := validateStream(task.stream, task.label); err != nil {
		return err
	}
	if workers <= 0 {
		workers = defaultWorkers
	}
	if workers > maxWorkers {
		workers = maxWorkers
	}
	pool := newMirrorPool(task.stream.URLs)
	if len(pool.mirrors) == 0 {
		return errors.New("没有可用的 HTTPS 下载地址")
	}

	probeCtx, cancelProbe := context.WithTimeout(ctx, 40*time.Second)
	size, preferred, rangeSupport, err := probe(probeCtx, pool, task.referer)
	cancelProbe()
	if err != nil {
		return err
	}
	if !rangeSupport {
		return downloadWhole(ctx, pool, task, size, progress)
	}

	segments := int((size + segmentBytes - 1) / segmentBytes)
	key := streamKey(task.stream)
	file, err := os.OpenFile(task.target, os.O_CREATE|os.O_RDWR, 0o644)
	if err != nil {
		return err
	}
	defer file.Close()

	written := make([]int64, segments)
	complete := make([]bool, segments)
	resume := loadResume(key, size, segmentBytes)
	info, statErr := file.Stat()
	if resume != nil && statErr == nil && info.Size() == size {
		var restored int64
		for index := range written {
			if resume.Completed[index] {
				written[index] = segmentLength(size, index)
				complete[index] = true
				restored++
			}
		}
		if restored > 0 {
			progress(restoredBytes(written), size, 0,
				fmt.Sprintf("续传 %d/%d 段", restored, segments))
		}
	} else {
		if err := file.Truncate(size); err != nil {
			return err
		}
	}

	state := &resumeState{
		Key: key, Total: size, Segments: segments, SegBytes: segmentBytes,
		Completed: map[int]bool{},
	}
	for index, done := range complete {
		if done {
			state.Completed[index] = true
		}
	}

	jobCtx, cancel := context.WithCancel(ctx)
	defer cancel()

	var mu sync.Mutex
	queue := make(chan int, segments)
	for index := range written {
		if !complete[index] {
			queue <- index
		}
	}
	var lastWrite int64
	atomic.StoreInt64(&lastWrite, time.Now().UnixNano())
	attempts := make([]int, segments)
	var fatal error
	var failOnce sync.Once

	// pending counts segments that are neither finished nor abandoned. When it
	// reaches zero the queue is closed, otherwise the workers block on <-queue
	// forever and the job never completes (the "finished downloading but the
	// panel hangs" bug).
	pending := 0
	for _, done := range complete {
		if !done {
			pending++
		}
	}
	var queueClose sync.Once
	closeQueue := func() {
		queueClose.Do(func() { close(queue) })
	}
	if pending == 0 {
		closeQueue()
	}
	finishSegment := func() {
		mu.Lock()
		pending--
		remaining := pending
		mu.Unlock()
		if remaining == 0 {
			closeQueue()
		}
	}

	progress(restoredBytes(written), size, 0, fmt.Sprintf("%d 线程 · %s", workers, pool.summary()))
	stopProgress := startProgressReporter(jobCtx, func() (int64, float64) {
		mu.Lock()
		done := restoredBytes(written)
		mu.Unlock()
		return done, 0
	}, size, progress, pool)

	var wg sync.WaitGroup
	worker := func() {
		defer wg.Done()
		for {
			select {
			case <-jobCtx.Done():
				return
			case index, ok := <-queue:
				if !ok {
					return
				}
				start := int64(index) * segmentBytes
				end := start + segmentBytes - 1
				if end > size-1 {
					end = size - 1
				}
				for {
					if jobCtx.Err() != nil {
						return
					}
					target := end
					mu.Lock()
					offset := written[index]
					mu.Unlock()
					if start+offset > target {
						break
					}
					attempts[index]++
					item := pool.pick()
					if item == nil {
						failOnce.Do(func() {
							fatal = errors.New("所有 CDN 镜像均不可用，请重新打开下载面板刷新地址")
							cancel()
						})
						return
					}
					started := time.Now()
					got, fetchErr := fetchRange(jobCtx, file, item, task.referer, start+offset, target)
					if got > 0 {
						mu.Lock()
						written[index] += got
						mu.Unlock()
						atomic.StoreInt64(&lastWrite, time.Now().UnixNano())
					}
					pool.record(item, got, time.Since(started))
					if fetchErr == nil {
						mu.Lock()
						written[index] = end - start + 1
						complete[index] = true
						state.Completed[index] = true
						mu.Unlock()
						saveResume(state)
						finishSegment()
						break
					}
					if jobCtx.Err() != nil {
						return
					}
					if errors.Is(fetchErr, errRangeMismatch) {
						pool.fail(item, false)
					} else {
						pool.fail(item, fatalStatusOf(fetchErr))
					}
					if attempts[index] >= maxSegmentTry {
						failOnce.Do(func() {
							fatal = fmt.Errorf("第 %d 段多次失败：%w", index+1, fetchErr)
							cancel()
						})
						return
					}
					wait := time.Duration(300+attempts[index]*400) * time.Millisecond
					if wait > 3*time.Second {
						wait = 3 * time.Second
					}
					select {
					case <-time.After(wait):
					case <-jobCtx.Done():
						return
					}
				}
			}
		}
	}
	for index := 0; index < workers; index++ {
		wg.Add(1)
		go worker()
	}

	// Watchdog: a transfer that makes no progress for 45s is treated as dead
	// instead of hanging forever.
	watchDone := make(chan struct{})
	go func() {
		ticker := time.NewTicker(3 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-watchDone:
				return
			case <-jobCtx.Done():
				return
			case <-ticker.C:
				idle := time.Since(time.Unix(0, atomic.LoadInt64(&lastWrite)))
				if idle > stallTimeout {
					failOnce.Do(func() {
						fatal = fmt.Errorf("下载停滞超过 %d 秒，已停止（可重试续传）", int(stallTimeout.Seconds()))
						cancel()
					})
					return
				}
			}
		}
	}()

	wg.Wait()
	close(watchDone)
	stopProgress()

	if fatal != nil {
		return fatal
	}
	if err := ctx.Err(); err != nil {
		return errors.New("下载已取消")
	}

	mu.Lock()
	total := restoredBytes(written)
	mu.Unlock()
	actual, err := file.Stat()
	if err != nil {
		return err
	}
	if actual.Size() != size {
		return fmt.Errorf("文件长度不符：期望 %d，实际 %d 字节", size, actual.Size())
	}
	if total != size {
		return fmt.Errorf("下载不完整：%d/%d 字节", total, size)
	}
	clearResume(key)
	progress(size, size, 0, "下载完成 · "+pool.summary())
	_ = preferred
	return nil
}

func restoredBytes(written []int64) int64 {
	total := int64(0)
	for _, value := range written {
		total += value
	}
	return total
}

func segmentLength(total int64, index int) int64 {
	start := int64(index) * segmentBytes
	if start >= total {
		return 0
	}
	end := start + segmentBytes
	if end > total {
		end = total
	}
	return end - start
}

// startProgressReporter emits a progress sample twice a second with a smoothed
// speed value, so the panel does not flicker.
func startProgressReporter(ctx context.Context, sample func() (int64, float64), total int64, progress progressFunc, pool *mirrorPool) func() {
	done := make(chan struct{})
	var once sync.Once
	go func() {
		ticker := time.NewTicker(500 * time.Millisecond)
		defer ticker.Stop()
		var previous int64
		previousAt := time.Now()
		smoothed := 0.0
		for {
			select {
			case <-done:
				return
			case <-ctx.Done():
				return
			case now := <-ticker.C:
				current, _ := sample()
				elapsed := now.Sub(previousAt).Seconds()
				if elapsed > 0 {
					instant := float64(current-previous) / elapsed
					if smoothed == 0 {
						smoothed = instant
					} else {
						smoothed = smoothed*0.65 + instant*0.35
					}
					if smoothed < 0 {
						smoothed = 0
					}
					progress(current, total, smoothed, pool.summary())
				}
				previous = current
				previousAt = now
			}
		}
	}()
	return func() { once.Do(func() { close(done) }) }
}

// fetchRange downloads [start,end] into its final file position.
func fetchRange(ctx context.Context, file *os.File, item *mirror, referer string, start, end int64) (int64, error) {
	if end < start {
		return 0, nil
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, item.url, nil)
	if err != nil {
		return 0, err
	}
	applyHeaders(request, referer)
	request.Header.Set("Range", fmt.Sprintf("bytes=%d-%d", start, end))
	response, err := httpClient.Do(request)
	if err != nil {
		return 0, err
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusOK {
		// Range ignored: the caller must not append these bytes elsewhere.
		return 0, errRangeMismatch
	}
	if response.StatusCode != http.StatusPartialContent {
		return 0, &httpStatusError{code: response.StatusCode}
	}
	expected := end - start + 1
	buffer := make([]byte, 256<<10)
	written := int64(0)
	for written < expected {
		limit := int64(len(buffer))
		if remaining := expected - written; remaining < limit {
			limit = remaining
		}
		read, readErr := response.Body.Read(buffer[:limit])
		if read > 0 {
			if _, writeErr := file.WriteAt(buffer[:read], start+written); writeErr != nil {
				return written, writeErr
			}
			written += int64(read)
		}
		if readErr != nil {
			if readErr == io.EOF {
				break
			}
			return written, readErr
		}
	}
	if written != expected {
		return written, fmt.Errorf("连接提前结束（%d/%d 字节）", written, expected)
	}
	return written, nil
}

// downloadWhole handles a mirror that ignores Range requests.
func downloadWhole(ctx context.Context, pool *mirrorPool, task streamTask, size int64, progress progressFunc) error {
	item := pool.pick()
	if item == nil {
		return errors.New("没有可用的镜像")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, item.url, nil)
	if err != nil {
		return err
	}
	applyHeaders(request, task.referer)
	response, err := httpClient.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK && response.StatusCode != http.StatusPartialContent {
		return &httpStatusError{code: response.StatusCode}
	}
	file, err := os.Create(task.target)
	if err != nil {
		return err
	}
	defer file.Close()
	buffer := make([]byte, 512<<10)
	written := int64(0)
	started := time.Now()
	lastReport := time.Now()
	for {
		if err := ctx.Err(); err != nil {
			return errors.New("下载已取消")
		}
		read, readErr := response.Body.Read(buffer)
		if read > 0 {
			if _, err := file.Write(buffer[:read]); err != nil {
				return err
			}
			written += int64(read)
			if time.Since(lastReport) > 500*time.Millisecond {
				progress(written, size, float64(written)/time.Since(started).Seconds(), "单连接下载")
				lastReport = time.Now()
			}
		}
		if readErr != nil {
			if readErr == io.EOF {
				break
			}
			return readErr
		}
	}
	if size > 0 && written != size {
		return fmt.Errorf("下载不完整：%d/%d 字节", written, size)
	}
	progress(written, size, 0, "校验完成")
	return nil
}
