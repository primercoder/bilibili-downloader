package main

// Minimal MP4 muxer.
//
// Bilibili serves DASH as fragmented MP4 (ftyp + moov + sidx + moof + mdat...).
// The fragments are individually valid, but fragmented files have no sample
// index, so Windows "电影和电视"、QuickTime、不少剪辑软件和部分手机播放器都
// 无法拖动进度条，个别还拒绝播放。这里把「视频流 + 音频流」两个 fragment
// 流重排成一个普通的 progressive MP4：moov 里带完整 stbl 索引，mdat 顺序存放，
// 播放器兼容性和拖动体验与 ffmpeg -c copy 的结果一致。
//
// 全部在进程内完成，因此用户不需要安装 FFmpeg，也不需要配置 PATH。

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"os"
)

// ---------------------------------------------------------------------------
// Source parsing (streaming, never loads the whole media file into memory)
// ---------------------------------------------------------------------------

type mp4Sample struct {
	offset int64
	size   uint32
	dur    uint32
	cts    int32
	key    bool
}

type sourceTrack struct {
	timescale uint32
	handler   string
	isVideo   bool
	tkhd      []byte
	mdhd      []byte
	hdlr      []byte
	vmhdSmhd  []byte
	dinf      []byte
	stsd      []byte
	edts      []byte
	samples   []mp4Sample
	// fragments records where each moof started, so durations can be rebuilt
	// from the tfdt timeline when the stream omits per-sample durations.
	fragments []fragmentInfo
}

type fragmentInfo struct {
	startTime   uint64 // tfdt baseMediaDecodeTime, 0 when the fragment had none
	firstSample int
	sampleCount int
	hasTime     bool
}

type sourceFile struct {
	file     *os.File
	size     int64
	ftyp     []byte
	tracks   []*sourceTrack
	trackIDs map[uint32]*sourceTrack
}

func (s *sourceFile) Close() {
	if s != nil && s.file != nil {
		_ = s.file.Close()
	}
}

func readAt(file *os.File, offset, length int64) ([]byte, error) {
	if length <= 0 {
		return nil, nil
	}
	buffer := make([]byte, length)
	_, err := file.ReadAt(buffer, offset)
	if err != nil && !errors.Is(err, io.EOF) {
		return nil, err
	}
	return buffer, nil
}

func beU32(data []byte, at int) uint32 {
	if at < 0 || at+4 > len(data) {
		return 0
	}
	return binary.BigEndian.Uint32(data[at : at+4])
}

func beU64(data []byte, at int) uint64 {
	if at < 0 || at+8 > len(data) {
		return 0
	}
	return binary.BigEndian.Uint64(data[at : at+8])
}

type boxHeader struct {
	typ    string
	start  int64
	body   int64
	end    int64
	header int64
}

func readBoxHeader(file *os.File, pos, limit int64) (boxHeader, error) {
	head, err := readAt(file, pos, 16)
	if err != nil {
		return boxHeader{}, err
	}
	if len(head) < 8 {
		return boxHeader{}, io.EOF
	}
	size := int64(binary.BigEndian.Uint32(head[0:4]))
	typ := string(head[4:8])
	header := int64(8)
	switch size {
	case 0:
		size = limit - pos
	case 1:
		if len(head) < 16 {
			return boxHeader{}, io.EOF
		}
		size = int64(binary.BigEndian.Uint64(head[8:16]))
		header = 16
	}
	if size < header || pos+size > limit {
		return boxHeader{}, io.EOF
	}
	return boxHeader{typ: typ, start: pos, body: pos + header, end: pos + size, header: header}, nil
}

func eachChild(data []byte, start, end int, fn func(boxHeader)) {
	pos := int64(start)
	fence := int64(end)
	for pos+8 <= fence {
		size := int64(binary.BigEndian.Uint32(data[pos : pos+4]))
		typ := string(data[pos+4 : pos+8])
		header := int64(8)
		switch size {
		case 0:
			size = fence - pos
		case 1:
			if pos+16 > fence {
				return
			}
			size = int64(binary.BigEndian.Uint64(data[pos+8 : pos+16]))
			header = 16
		}
		if size < header || pos+size > fence {
			return
		}
		fn(boxHeader{typ: typ, start: pos, body: pos + header, end: pos + size, header: header})
		pos += size
	}
}

func childBox(data []byte, start, end int, typ string) (boxHeader, bool) {
	var hit boxHeader
	found := false
	eachChild(data, start, end, func(box boxHeader) {
		if !found && box.typ == typ {
			hit = box
			found = true
		}
	})
	return hit, found
}

func pathBox(data []byte, start, end int, path ...string) (boxHeader, bool) {
	box, ok := childBox(data, start, end, path[0])
	if !ok {
		return boxHeader{}, false
	}
	if len(path) == 1 {
		return box, true
	}
	return pathBox(data, int(box.body), int(box.end), path[1:]...)
}

// openSource parses a Bilibili .m4s (fragmented MP4) file.
func openSource(path string) (*sourceFile, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	info, err := file.Stat()
	if err != nil {
		file.Close()
		return nil, err
	}
	source := &sourceFile{file: file, size: info.Size()}
	if err := source.parse(); err != nil {
		file.Close()
		return nil, err
	}
	return source, nil
}

func (s *sourceFile) parse() error {
	var moov []byte
	var moovStart int64
	pos := int64(0)
	for pos < s.size {
		header, err := readBoxHeader(s.file, pos, s.size)
		if err != nil {
			break
		}
		switch header.typ {
		case "ftyp":
			s.ftyp, _ = readAt(s.file, header.start, header.end-header.start)
		case "moov":
			moov, err = readAt(s.file, header.start, header.end-header.start)
			if err != nil {
				return err
			}
			moovStart = header.start
		}
		if header.typ == "moov" {
			break
		}
		pos = header.end
	}
	_ = moovStart
	if len(moov) == 0 {
		return errors.New("不是有效的 MP4 文件（缺少 moov）")
	}
	if err := s.parseMoov(moov); err != nil {
		return err
	}
	s.parseFragments(moovStart + int64(len(moov)))
	return nil
}

func (s *sourceFile) parseMoov(moov []byte) error {
	byID := map[uint32]*sourceTrack{}
	eachChild(moov, 8, len(moov), func(trak boxHeader) {
		if trak.typ != "trak" {
			return
		}
		track := &sourceTrack{}
		tkhd, ok := childBox(moov, int(trak.body), int(trak.end), "tkhd")
		if !ok {
			return
		}
		track.tkhd = cloneBytes(moov[tkhd.start:tkhd.end])
		version := moov[tkhd.body]
		var trackID uint32
		if version == 1 {
			trackID = beU32(moov, int(tkhd.body)+20)
		} else {
			trackID = beU32(moov, int(tkhd.body)+12)
		}
		if edts, ok := childBox(moov, int(trak.body), int(trak.end), "edts"); ok {
			track.edts = cloneBytes(moov[edts.start:edts.end])
		}
		mdia, ok := childBox(moov, int(trak.body), int(trak.end), "mdia")
		if !ok {
			return
		}
		if mdhd, ok := childBox(moov, int(mdia.body), int(mdia.end), "mdhd"); ok {
			track.mdhd = cloneBytes(moov[mdhd.start:mdhd.end])
			if moov[mdhd.body] == 1 {
				track.timescale = beU32(moov, int(mdhd.body)+20)
			} else {
				track.timescale = beU32(moov, int(mdhd.body)+12)
			}
		}
		if track.timescale == 0 {
			track.timescale = 1000
		}
		if hdlr, ok := childBox(moov, int(mdia.body), int(mdia.end), "hdlr"); ok {
			track.hdlr = cloneBytes(moov[hdlr.start:hdlr.end])
			if hdlr.body+12 <= int64(len(moov)) {
				track.handler = string(moov[hdlr.body+8 : hdlr.body+12])
			}
		}
		track.isVideo = track.handler == "vide"
		minf, ok := childBox(moov, int(mdia.body), int(mdia.end), "minf")
		if !ok {
			return
		}
		if vmhd, ok := childBox(moov, int(minf.body), int(minf.end), "vmhd"); ok {
			track.vmhdSmhd = cloneBytes(moov[vmhd.start:vmhd.end])
		} else if smhd, ok := childBox(moov, int(minf.body), int(minf.end), "smhd"); ok {
			track.vmhdSmhd = cloneBytes(moov[smhd.start:smhd.end])
		}
		if dinf, ok := childBox(moov, int(minf.body), int(minf.end), "dinf"); ok {
			track.dinf = cloneBytes(moov[dinf.start:dinf.end])
		}
		if stbl, ok := childBox(moov, int(minf.body), int(minf.end), "stbl"); ok {
			if stsd, ok := childBox(moov, int(stbl.body), int(stbl.end), "stsd"); ok {
				track.stsd = cloneBytes(moov[stsd.start:stsd.end])
			}
		}
		byID[trackID] = track
		s.tracks = append(s.tracks, track)
	})
	if len(s.tracks) == 0 {
		return errors.New("MP4 中没有可用的轨道")
	}
	s.trackIDs = byID
	return nil
}

func cloneBytes(source []byte) []byte {
	out := make([]byte, len(source))
	copy(out, source)
	return out
}

func (s *sourceFile) parseFragments(start int64) {
	pos := start
	for pos < s.size {
		header, err := readBoxHeader(s.file, pos, s.size)
		if err != nil {
			break
		}
		if header.typ != "moof" {
			pos = header.end
			continue
		}
		moofBytes, err := readAt(s.file, header.start, header.end-header.start)
		if err != nil {
			break
		}
		s.parseMoof(moofBytes, header.start)
		pos = header.end
	}
	for _, track := range s.tracks {
		fillDurations(track)
		markKeyframes(s.file, track)
	}
}

func (s *sourceFile) parseMoof(moof []byte, moofStart int64) {
	eachChild(moof, 8, len(moof), func(traf boxHeader) {
		if traf.typ != "traf" {
			return
		}
		tfhd, ok := childBox(moof, int(traf.body), int(traf.end), "tfhd")
		if !ok {
			return
		}
		flags := beU32(moof, int(tfhd.body)) & 0xFFFFFF
		trackID := beU32(moof, int(tfhd.body)+4)
		track := s.trackIDs[trackID]
		if track == nil {
			return
		}
		cursor := int(tfhd.body) + 8
		baseOffset := moofStart
		if flags&0x01 != 0 {
			baseOffset = int64(beU64(moof, cursor))
			cursor += 8
		}
		if flags&0x02 != 0 {
			cursor += 4
		}
		var defaultDur, defaultSize uint32
		if flags&0x08 != 0 {
			defaultDur = beU32(moof, cursor)
			cursor += 4
		}
		if flags&0x10 != 0 {
			defaultSize = beU32(moof, cursor)
			cursor += 4
		}
		trun, ok := childBox(moof, int(traf.body), int(traf.end), "trun")
		if !ok {
			return
		}
		// tfdt carries the fragment's presentation time. Some Bilibili videos
		// omit both the tfhd default duration and per-sample durations, so this
		// is the only reliable source for their timing.
		info := fragmentInfo{firstSample: len(track.samples), hasTime: false}
		if tfdt, ok := childBox(moof, int(traf.body), int(traf.end), "tfdt"); ok {
			if moof[tfdt.body] == 1 {
				info.startTime = beU64(moof, int(tfdt.body)+4)
			} else {
				info.startTime = uint64(beU32(moof, int(tfdt.body)+4))
			}
			info.hasTime = true
		}
		trunFlags := beU32(moof, int(trun.body)) & 0xFFFFFF
		count := int(beU32(moof, int(trun.body)+4))
		at := int(trun.body) + 8
		dataStart := baseOffset
		if trunFlags&0x01 != 0 {
			dataStart = baseOffset + int64(int32(beU32(moof, at)))
			at += 4
		}
		if trunFlags&0x04 != 0 {
			at += 4
		}
		for i := 0; i < count; i++ {
			var dur, size uint32
			var cts int32
			if trunFlags&0x100 != 0 {
				dur = beU32(moof, at)
				at += 4
			} else {
				dur = defaultDur
			}
			if trunFlags&0x200 != 0 {
				size = beU32(moof, at)
				at += 4
			} else {
				size = defaultSize
			}
			if trunFlags&0x400 != 0 {
				at += 4 // 站点的 sample_flags 不可靠，稍后直接读码流判断关键帧
			}
			if trunFlags&0x800 != 0 {
				cts = int32(beU32(moof, at))
				at += 4
			}
			if at > int(trun.end) || size == 0 || dataStart+int64(size) > s.size {
				return
			}
			track.samples = append(track.samples, mp4Sample{offset: dataStart, size: size, dur: dur, cts: cts})
			dataStart += int64(size)
		}
		info.sampleCount = len(track.samples) - info.firstSample
		if info.sampleCount > 0 {
			track.fragments = append(track.fragments, info)
		}
	})
}

// fillDurations rebuilds missing sample durations from the fragment timeline.
// Bilibili has (at least) two muxing variants: one writes tfhd default
// durations, the other writes nothing and relies on tfdt. Without this the
// second variant produced a file with zero duration that every player rejected.
func fillDurations(track *sourceTrack) {
	if len(track.fragments) < 2 {
		return
	}
	usable := false
	for _, fragment := range track.fragments {
		if fragment.hasTime {
			usable = true
			break
		}
	}
	if !usable {
		return
	}
	for index, fragment := range track.fragments {
		var fragmentDuration uint64
		switch {
		case fragment.hasTime && index+1 < len(track.fragments) && track.fragments[index+1].hasTime:
			next := track.fragments[index+1].startTime
			if next >= fragment.startTime {
				fragmentDuration = next - fragment.startTime
			}
		case fragment.hasTime:
			// Last fragment: the next tfdt does not exist. Extrapolate from the
			// previous fragment's per-sample rate, not from its total, because
			// the final fragment commonly carries more samples (Bilibili pads
			// the tail). Using the previous total truncated the video by
			// seconds, which left the end of the movie with audio only.
			previous := index - 1
			if previous >= 0 && track.fragments[previous].hasTime && previous+1 < len(track.fragments) {
				prevFragment := track.fragments[previous]
				prevDelta := fragment.startTime - prevFragment.startTime
				if prevDelta > 0 && prevFragment.sampleCount > 0 {
					fragmentDuration = prevDelta * uint64(fragment.sampleCount) / uint64(prevFragment.sampleCount)
				}
			}
		default:
			continue
		}
		if fragmentDuration == 0 {
			continue
		}
		// Only rewrite the samples that came in without a duration; fragments
		// that carry real per-sample timing keep it.
		missing := false
		for offset := 0; offset < fragment.sampleCount; offset++ {
			if track.samples[fragment.firstSample+offset].dur == 0 {
				missing = true
				break
			}
		}
		if !missing {
			continue
		}
		base := fragmentDuration / uint64(fragment.sampleCount)
		remainder := fragmentDuration % uint64(fragment.sampleCount)
		for offset := 0; offset < fragment.sampleCount; offset++ {
			value := base
			if uint64(offset) < remainder {
				value++
			}
			if value > 0xFFFFFFFF {
				value = 0xFFFFFFFF
			}
			track.samples[fragment.firstSample+offset].dur = uint32(value)
		}
	}
}

// markKeyframes reads the elementary stream so stss lists real sync samples.
// The CDN's trun sample_flags are unreliable (they mark every sample as sync),
// which would let players seek into non-keyframes and show corruption.
func markKeyframes(file *os.File, track *sourceTrack) {
	if len(track.samples) == 0 {
		return
	}
	codec := fourccOf(track.stsd)
	buffer := make([]byte, 4096)
	for i := range track.samples {
		sample := &track.samples[i]
		if i == 0 {
			sample.key = true
			continue
		}
		read := int64(sample.size)
		if read > int64(len(buffer)) {
			read = int64(len(buffer))
		}
		data, err := readAt(file, sample.offset, read)
		if err != nil || len(data) == 0 {
			sample.key = false
			continue
		}
		switch codec {
		case "avc1", "avc3":
			sample.key = hasH264IDR(data)
		case "hvc1", "hev1":
			sample.key = hasHEVCRandomAccess(data)
		case "av01":
			sample.key = hasAV1KeyFrame(data)
		default:
			sample.key = true
		}
	}
}

func fourccOf(stsd []byte) string {
	if len(stsd) < 16 {
		return ""
	}
	var codec string
	eachChild(stsd, 16, len(stsd), func(box boxHeader) {
		if codec == "" {
			codec = box.typ
		}
	})
	return codec
}

func hasH264IDR(sample []byte) bool {
	for pos := 0; pos+4 <= len(sample); {
		length := int(binary.BigEndian.Uint32(sample[pos : pos+4]))
		pos += 4
		if length <= 0 || pos+length > len(sample) {
			return false
		}
		if sample[pos]&0x1F == 5 {
			return true
		}
		pos += length
	}
	return false
}

func hasHEVCRandomAccess(sample []byte) bool {
	for pos := 0; pos+4 <= len(sample); {
		length := int(binary.BigEndian.Uint32(sample[pos : pos+4]))
		pos += 4
		if length <= 0 || pos+length > len(sample) {
			return false
		}
		nalType := (sample[pos] >> 1) & 0x3F
		if nalType >= 16 && nalType <= 21 {
			return true
		}
		pos += length
	}
	return false
}

func hasAV1KeyFrame(sample []byte) bool {
	for pos := 0; pos+2 <= len(sample); {
		header := sample[pos]
		obuType := (header >> 3) & 0x0F
		hasExtension := header&0x04 != 0
		hasSize := header&0x02 != 0
		cursor := pos + 1
		if hasExtension {
			cursor++
		}
		size := 0
		if hasSize {
			shift := 0
			for {
				if cursor >= len(sample) {
					return true
				}
				value := sample[cursor]
				cursor++
				size |= int(value&0x7F) << shift
				shift += 7
				if value&0x80 == 0 {
					break
				}
			}
		}
		if obuType == 6 && cursor < len(sample) {
			return (sample[cursor]>>5)&0x03 == 0
		}
		if size == 0 {
			return true
		}
		pos = cursor + size
	}
	return true
}

// ---------------------------------------------------------------------------
// Progressive MP4 writer
// ---------------------------------------------------------------------------

const samplesPerChunk = 64

type muxTrack struct {
	source *sourceTrack
	chunks []uint64
}

func be32(value uint32) []byte {
	out := make([]byte, 4)
	binary.BigEndian.PutUint32(out, value)
	return out
}

func be64(value uint64) []byte {
	out := make([]byte, 8)
	binary.BigEndian.PutUint64(out, value)
	return out
}

func newBox(typ string, payload ...[]byte) []byte {
	total := 8
	for _, part := range payload {
		total += len(part)
	}
	out := make([]byte, 8, total)
	binary.BigEndian.PutUint32(out, uint32(total))
	copy(out[4:8], typ)
	for _, part := range payload {
		out = append(out, part...)
	}
	return out
}

func newFullBox(typ string, version byte, flags uint32, payload ...[]byte) []byte {
	head := []byte{version, byte(flags >> 16), byte(flags >> 8), byte(flags)}
	parts := append([][]byte{head}, payload...)
	return newBox(typ, parts...)
}

func patchU32(raw []byte, at int, value uint32) []byte {
	if at < 0 || at+4 > len(raw) {
		return raw
	}
	out := cloneBytes(raw)
	binary.BigEndian.PutUint32(out[at:at+4], value)
	return out
}

func trackDuration(track *sourceTrack) uint64 {
	sum := uint64(0)
	for _, sample := range track.samples {
		sum += uint64(sample.dur)
	}
	return sum
}

func buildMvhd(timescale uint32, duration uint64) []byte {
	payload := make([]byte, 0, 96)
	payload = append(payload, be32(0)...)
	payload = append(payload, be32(0)...)
	payload = append(payload, be32(timescale)...)
	payload = append(payload, be32(uint32(duration))...)
	payload = append(payload, be32(0x00010000)...) // rate 1.0
	payload = append(payload, be32(0x01000000)...) // volume 1.0 (fixed 8.8) + reserved
	payload = append(payload, make([]byte, 8)...)
	for _, value := range []uint32{0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000} {
		payload = append(payload, be32(value)...)
	}
	payload = append(payload, make([]byte, 24)...)
	payload = append(payload, be32(3)...) // next_track_ID
	return newFullBox("mvhd", 0, 0, payload)
}

func buildStts(samples []mp4Sample) []byte {
	type run struct{ count, dur uint32 }
	runs := make([]run, 0, 64)
	for _, sample := range samples {
		if n := len(runs); n > 0 && runs[n-1].dur == sample.dur {
			runs[n-1].count++
		} else {
			runs = append(runs, run{1, sample.dur})
		}
	}
	payload := []byte{0, 0, 0, 0}
	payload = append(payload, be32(uint32(len(runs)))...)
	for _, item := range runs {
		payload = append(payload, be32(item.count)...)
		payload = append(payload, be32(item.dur)...)
	}
	return newBox("stts", payload)
}

func buildCtts(samples []mp4Sample) []byte {
	any := false
	negative := false
	for _, sample := range samples {
		if sample.cts != 0 {
			any = true
		}
		if sample.cts < 0 {
			negative = true
		}
	}
	if !any {
		return nil
	}
	type offsetRun struct {
		count uint32
		value int32
	}
	runs := make([]offsetRun, 0, 64)
	for _, sample := range samples {
		if n := len(runs); n > 0 && runs[n-1].value == sample.cts {
			runs[n-1].count++
		} else {
			runs = append(runs, offsetRun{1, sample.cts})
		}
	}
	version := byte(0)
	if negative {
		version = 1
	}
	payload := []byte{version, 0, 0, 0}
	payload = append(payload, be32(uint32(len(runs)))...)
	for _, item := range runs {
		payload = append(payload, be32(item.count)...)
		payload = append(payload, be32(uint32(item.value))...)
	}
	return newBox("ctts", payload)
}

func buildStss(samples []mp4Sample) []byte {
	if len(samples) == 0 {
		return nil
	}
	keys := make([]uint32, 0, len(samples)/8)
	for index, sample := range samples {
		if sample.key {
			keys = append(keys, uint32(index+1))
		}
	}
	if len(keys) == len(samples) {
		return nil
	}
	payload := []byte{0, 0, 0, 0}
	payload = append(payload, be32(uint32(len(keys)))...)
	for _, index := range keys {
		payload = append(payload, be32(index)...)
	}
	return newBox("stss", payload)
}

func buildStsc(chunkCount, sampleCount int) []byte {
	payload := []byte{0, 0, 0, 0}
	if chunkCount == 0 || sampleCount == 0 {
		return newBox("stsc", append(payload, be32(0)...))
	}
	entries := [][3]uint32{}
	remainder := sampleCount % samplesPerChunk
	switch {
	case chunkCount == 1:
		entries = append(entries, [3]uint32{1, uint32(sampleCount), 1})
	case remainder == 0:
		entries = append(entries, [3]uint32{1, samplesPerChunk, 1})
	default:
		entries = append(entries,
			[3]uint32{1, samplesPerChunk, 1},
			[3]uint32{uint32(chunkCount), uint32(remainder), 1})
	}
	payload = append(payload, be32(uint32(len(entries)))...)
	for _, entry := range entries {
		payload = append(payload, be32(entry[0])...)
		payload = append(payload, be32(entry[1])...)
		payload = append(payload, be32(entry[2])...)
	}
	return newBox("stsc", payload)
}

func buildStsz(samples []mp4Sample) []byte {
	payload := []byte{0, 0, 0, 0}
	if len(samples) > 0 {
		uniform := true
		for _, sample := range samples {
			if sample.size != samples[0].size {
				uniform = false
				break
			}
		}
		if uniform {
			payload = append(payload, be32(samples[0].size)...)
			payload = append(payload, be32(uint32(len(samples)))...)
			return newBox("stsz", payload)
		}
	}
	payload = append(payload, be32(0)...)
	payload = append(payload, be32(uint32(len(samples)))...)
	for _, sample := range samples {
		payload = append(payload, be32(sample.size)...)
	}
	return newBox("stsz", payload)
}

func buildChunkOffsets(chunks []uint64, wide bool) []byte {
	payload := []byte{0, 0, 0, 0}
	payload = append(payload, be32(uint32(len(chunks)))...)
	for _, offset := range chunks {
		if wide {
			payload = append(payload, be64(offset)...)
		} else {
			payload = append(payload, be32(uint32(offset))...)
		}
	}
	if wide {
		return newBox("co64", payload)
	}
	return newBox("stco", payload)
}

func buildTrak(track *muxTrack, movieTimescale uint32, wide bool) []byte {
	source := track.source
	sum := trackDuration(source)
	movieDuration := uint64(float64(sum) / float64(source.timescale) * float64(movieTimescale))

	tkhd := source.tkhd
	if len(tkhd) > 8 && tkhd[8] == 1 {
		tkhd = patchU32(tkhd, 36, uint32(movieDuration))
	} else {
		tkhd = patchU32(tkhd, 28, uint32(movieDuration))
	}
	mdhd := source.mdhd
	if len(mdhd) > 8 && mdhd[8] == 1 {
		mdhd = patchU32(mdhd, 32, uint32(sum))
	} else {
		mdhd = patchU32(mdhd, 24, uint32(sum))
	}

	stbl := [][]byte{source.stsd, buildStts(source.samples)}
	if ctts := buildCtts(source.samples); ctts != nil {
		stbl = append(stbl, ctts)
	}
	if stss := buildStss(source.samples); stss != nil {
		stbl = append(stbl, stss)
	}
	stbl = append(stbl, buildStsc(len(track.chunks), len(source.samples)))
	stbl = append(stbl, buildChunkOffsets(track.chunks, wide))
	stbl = append(stbl, buildStsz(source.samples))

	minf := [][]byte{}
	if len(source.vmhdSmhd) > 0 {
		minf = append(minf, source.vmhdSmhd)
	}
	if len(source.dinf) > 0 {
		minf = append(minf, source.dinf)
	}
	minf = append(minf, newBox("stbl", stbl...))

	mdia := [][]byte{mdhd}
	if len(source.hdlr) > 0 {
		mdia = append(mdia, source.hdlr)
	}
	mdia = append(mdia, newBox("minf", minf...))

	children := [][]byte{tkhd}
	// Every Bilibili stream ships an edit list (often "empty edit + media_time
	// 0") that describes the *fragmented* timeline. Copying it into a
	// progressive file makes players treat the whole track as a fraction of a
	// second — ffprobe reported 0.042s for a 212s file. Drop it: tkhd/mdhd now
	// carry the real duration and the sample table is authoritative.
	children = append(children, newBox("mdia", mdia...))
	return newBox("trak", children...)
}

func buildMoov(tracks []*muxTrack, movieTimescale uint32, wide bool) []byte {
	longest := uint64(0)
	for _, track := range tracks {
		seconds := float64(trackDuration(track.source)) / float64(track.source.timescale)
		scaled := uint64(seconds * float64(movieTimescale))
		if scaled > longest {
			longest = scaled
		}
	}
	children := [][]byte{buildMvhd(movieTimescale, longest)}
	for _, track := range tracks {
		children = append(children, buildTrak(track, movieTimescale, wide))
	}
	return newBox("moov", children...)
}

// muxProgressiveMP4 combines one video and one audio fragmented MP4 file into
// a single progressive MP4. Returns the output duration in seconds.
func muxProgressiveMP4(videoPath, audioPath, outputPath string) (float64, error) {
	video, err := openSource(videoPath)
	if err != nil {
		return 0, fmt.Errorf("解析视频流失败：%w", err)
	}
	defer video.Close()
	audio, err := openSource(audioPath)
	if err != nil {
		return 0, fmt.Errorf("解析音频流失败：%w", err)
	}
	defer audio.Close()

	var videoTrack, audioTrack *sourceTrack
	for _, track := range video.tracks {
		if track.isVideo && videoTrack == nil {
			videoTrack = track
		}
	}
	for _, track := range audio.tracks {
		if !track.isVideo && audioTrack == nil {
			audioTrack = track
		}
	}
	if videoTrack == nil {
		return 0, errors.New("视频流中没有找到视频轨道")
	}
	if audioTrack == nil {
		return 0, errors.New("音频流中没有找到音频轨道")
	}
	if len(videoTrack.samples) == 0 || len(audioTrack.samples) == 0 {
		return 0, errors.New("下载的流不完整，没有样本数据")
	}

	tracks := []*muxTrack{{source: videoTrack}, {source: audioTrack}}
	for _, track := range tracks {
		track.chunks = make([]uint64, (len(track.source.samples)+samplesPerChunk-1)/samplesPerChunk)
	}

	ftyp := video.ftyp
	if len(ftyp) == 0 {
		ftyp = newBox("ftyp", []byte("isom"), be32(0x200), []byte("isomiso2avc1mp41"))
	}

	movieTimescale := uint32(1000)
	payload := int64(0)
	for _, track := range tracks {
		for _, sample := range track.source.samples {
			payload += int64(sample.size)
		}
	}
	wide := payload > 0xF0000000

	// Two passes: the first gives the moov size, the second bakes in the final
	// chunk offsets once the mdat position is known.
	moov := buildMoov(tracks, movieTimescale, wide)
	mdatHeader := int64(8)
	if payload+8 > 0xFFFFFFFF {
		mdatHeader = 16
	}
	base := uint64(int64(len(ftyp)) + int64(len(moov)) + mdatHeader)
	cursor := base
	for _, track := range tracks {
		for index := range track.source.samples {
			if index%samplesPerChunk == 0 {
				track.chunks[index/samplesPerChunk] = cursor
			}
			cursor += uint64(track.source.samples[index].size)
		}
	}
	moov = buildMoov(tracks, movieTimescale, wide)
	if expected := uint64(int64(len(ftyp)) + int64(len(moov)) + mdatHeader); expected != base {
		return 0, errors.New("MP4 布局计算失败，请重试")
	}

	output, err := os.Create(outputPath)
	if err != nil {
		return 0, err
	}
	defer output.Close()
	writer := newBufferedWriter(output)
	if _, err := writer.Write(ftyp); err != nil {
		return 0, err
	}
	if _, err := writer.Write(moov); err != nil {
		return 0, err
	}
	if mdatHeader == 16 {
		if _, err := writer.Write(append(be32(1), []byte("mdat")...)); err != nil {
			return 0, err
		}
		if _, err := writer.Write(be64(uint64(payload + 16))); err != nil {
			return 0, err
		}
	} else if _, err := writer.Write(append(be32(uint32(payload+8)), []byte("mdat")...)); err != nil {
		return 0, err
	}

	for _, track := range tracks {
		source := video
		if !track.source.isVideo {
			source = audio
		}
		if err := copySamples(writer, source.file, track.source.samples, payload); err != nil {
			return 0, err
		}
	}
	if err := writer.Flush(); err != nil {
		return 0, err
	}
	if err := output.Sync(); err != nil {
		return 0, err
	}
	if writer.count != int64(base)+payload {
		return 0, fmt.Errorf("写入长度不一致：%d", writer.count)
	}
	duration := 0.0
	for _, track := range tracks {
		seconds := float64(trackDuration(track.source)) / float64(track.source.timescale)
		if seconds > duration {
			duration = seconds
		}
	}
	return duration, nil
}

func copySamples(writer *bufWriter, file *os.File, samples []mp4Sample, total int64) error {
	buffer := make([]byte, 1<<20)
	for _, sample := range samples {
		remaining := int64(sample.size)
		position := sample.offset
		for remaining > 0 {
			step := int64(len(buffer))
			if remaining < step {
				step = remaining
			}
			read, err := file.ReadAt(buffer[:step], position)
			if err != nil && !errors.Is(err, io.EOF) {
				return err
			}
			if read == 0 {
				return io.ErrUnexpectedEOF
			}
			if _, err := writer.Write(buffer[:read]); err != nil {
				return err
			}
			position += int64(read)
			remaining -= int64(read)
		}
	}
	return nil
}

type bufWriter struct {
	file  *os.File
	buf   []byte
	count int64
	err   error
}

func newBufferedWriter(file *os.File) *bufWriter {
	return &bufWriter{file: file, buf: make([]byte, 0, 4<<20)}
}

func (w *bufWriter) Write(data []byte) (int, error) {
	if w.err != nil {
		return 0, w.err
	}
	if len(w.buf)+len(data) > cap(w.buf) {
		if err := w.Flush(); err != nil {
			return 0, err
		}
	}
	if len(data) > cap(w.buf) {
		if _, err := w.file.Write(data); err != nil {
			w.err = err
			return 0, err
		}
		w.count += int64(len(data))
		return len(data), nil
	}
	w.buf = append(w.buf, data...)
	return len(data), nil
}

func (w *bufWriter) Flush() error {
	if w.err != nil {
		return w.err
	}
	if len(w.buf) == 0 {
		return nil
	}
	if _, err := w.file.Write(w.buf); err != nil {
		w.err = err
		return err
	}
	w.count += int64(len(w.buf))
	w.buf = w.buf[:0]
	return nil
}
