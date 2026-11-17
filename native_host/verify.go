package main

import (
	"errors"
	"fmt"
	"os"
)

// Output verification.
//
// The old host trusted FFmpeg's exit code and then asked ffprobe. Without
// FFmpeg we check the file's own structure: moov present before mdat, one sample
// table per track, every chunk offset inside the data region, and the sample
// bytes declared by the index adding up to the mdat payload that actually
// exists. That catches the two failures users actually hit — a truncated CDN
// transfer and a mux bug — both of which used to be reported as success.

type outputInfo struct {
	duration   float64
	size       int64
	videoCodec string
	audioCodec string
	hasAudio   bool
}

func verifyMP4(path string) (outputInfo, error) {
	info := outputInfo{}
	file, err := os.Open(path)
	if err != nil {
		return info, err
	}
	defer file.Close()
	stat, err := file.Stat()
	if err != nil {
		return info, err
	}
	info.size = stat.Size()
	if info.size < 1024 {
		return info, errors.New("输出文件过小")
	}

	var moov []byte
	moovOffset := int64(-1)
	mdatOffset := int64(-1)
	mdatPayload := uint64(0)
	for pos := int64(0); pos < stat.Size(); {
		header, err := readBoxHeader(file, pos, stat.Size())
		if err != nil {
			break
		}
		switch header.typ {
		case "moov":
			moov, _ = readAt(file, header.start, header.end-header.start)
			moovOffset = header.start
		case "mdat":
			if mdatOffset < 0 {
				mdatOffset = header.start
			}
			mdatPayload += uint64(header.end - header.body)
		}
		pos = header.end
	}
	if len(moov) == 0 {
		return info, errors.New("输出缺少 moov 索引")
	}
	if mdatOffset >= 0 && mdatOffset < moovOffset {
		return info, errors.New("moov 位于 mdat 之后，无法边下边播")
	}

	tracks := 0
	declaredSamples := uint64(0)
	videoSeconds := 0.0
	audioSeconds := 0.0
	broken := false

	eachChild(moov, 8, len(moov), func(trak boxHeader) {
		if trak.typ != "trak" {
			return
		}
		tracks++

		isVideo := false
		if hdlr, ok := pathBox(moov, int(trak.body), int(trak.end), "mdia", "hdlr"); ok && hdlr.body+12 <= int64(len(moov)) {
			isVideo = string(moov[hdlr.body+8:hdlr.body+12]) == "vide"
		}
		codec := ""
		stbl, hasStbl := pathBox(moov, int(trak.body), int(trak.end), "mdia", "minf", "stbl")
		if hasStbl {
			if stsd, ok := childBox(moov, int(stbl.body), int(stbl.end), "stsd"); ok {
				codec = fourccOf(moov[stsd.start:stsd.end])
			}
			sampleCount, sampleBytes, ok := sampleTable(moov, stbl)
			if !ok || sampleCount == 0 {
				broken = true
				return
			}
			declaredSamples += sampleBytes
			if !chunksInsideFile(moov, stbl, uint64(info.size)) {
				broken = true
				return
			}
		} else {
			broken = true
			return
		}

		mdhd, ok := pathBox(moov, int(trak.body), int(trak.end), "mdia", "mdhd")
		if !ok {
			broken = true
			return
		}
		var timescale uint32
		var duration uint64
		if moov[mdhd.body] == 1 {
			timescale = beU32(moov, int(mdhd.body)+20)
			duration = beU64(moov, int(mdhd.body)+24)
		} else {
			timescale = beU32(moov, int(mdhd.body)+12)
			duration = uint64(beU32(moov, int(mdhd.body)+16))
		}
		if timescale == 0 || duration == 0 {
			broken = true
			return
		}
		seconds := float64(duration) / float64(timescale)
		if isVideo {
			if seconds > videoSeconds {
				videoSeconds = seconds
			}
			if info.videoCodec == "" {
				info.videoCodec = codecLabel(codec)
			}
		} else {
			info.hasAudio = true
			if seconds > audioSeconds {
				audioSeconds = seconds
			}
			if info.audioCodec == "" {
				info.audioCodec = codecLabel(codec)
			}
		}
	})

	if tracks == 0 {
		return info, errors.New("输出中没有任何轨道")
	}
	if broken {
		return info, errors.New("文件结构损坏：索引或时长无效")
	}
	if info.videoCodec == "" && info.audioCodec == "" {
		return info, errors.New("输出中没有可识别的音视频编码")
	}
	// The index must describe exactly the bytes that follow it. A short mdat
	// means the transfer was cut and the file will stop playing partway.
	if mdatOffset >= 0 && declaredSamples > mdatPayload {
		return info, fmt.Errorf("文件不完整：索引声明 %d MiB 数据，实际只有 %d MiB",
			declaredSamples>>20, mdatPayload>>20)
	}

	duration := videoSeconds
	if audioSeconds > duration {
		duration = audioSeconds
	}
	if duration <= 0 {
		return info, errors.New("输出时长无效")
	}
	if videoSeconds > 0 && audioSeconds > 0 {
		diff := videoSeconds - audioSeconds
		if diff < 0 {
			diff = -diff
		}
		if diff > 5 {
			return info, fmt.Errorf("音视频时长不一致（视频 %.1fs / 音频 %.1fs）", videoSeconds, audioSeconds)
		}
	}
	info.duration = duration
	return info, nil
}

// sampleTable returns the sample count and total payload bytes declared by stsz.
func sampleTable(moov []byte, stbl boxHeader) (uint32, uint64, bool) {
	stsz, ok := childBox(moov, int(stbl.body), int(stbl.end), "stsz")
	if !ok {
		return 0, 0, false
	}
	uniform := beU32(moov, int(stsz.body)+4)
	count := beU32(moov, int(stsz.body)+8)
	if uniform != 0 {
		return count, uint64(uniform) * uint64(count), true
	}
	total := uint64(0)
	for index := uint32(0); index < count; index++ {
		total += uint64(beU32(moov, int(stsz.body)+12+int(index)*4))
	}
	return count, total, true
}

// chunksInsideFile checks that the chunk offset table actually fits the file.
func chunksInsideFile(moov []byte, stbl boxHeader, fileSize uint64) bool {
	read := func(box boxHeader, entrySize int, readOffset func(box boxHeader, index int) uint64) bool {
		count := beU32(moov, int(box.body)+4)
		if count == 0 {
			return false
		}
		if int(box.body)+8+int(count)*entrySize > len(moov) {
			return false
		}
		for index := 0; index < int(count); index++ {
			offset := readOffset(box, index)
			if offset == 0 || offset >= fileSize {
				return false
			}
		}
		return true
	}
	if stco, ok := childBox(moov, int(stbl.body), int(stbl.end), "stco"); ok {
		return read(stco, 4, func(box boxHeader, index int) uint64 {
			return uint64(beU32(moov, int(box.body)+8+index*4))
		})
	}
	if co64, ok := childBox(moov, int(stbl.body), int(stbl.end), "co64"); ok {
		return read(co64, 8, func(box boxHeader, index int) uint64 {
			return beU64(moov, int(box.body)+8+index*8)
		})
	}
	return false
}

func codecLabel(fourcc string) string {
	switch fourcc {
	case "avc1", "avc3":
		return "AVC/H.264"
	case "hvc1", "hev1":
		return "HEVC/H.265"
	case "av01":
		return "AV1"
	case "mp4a":
		return "AAC"
	case "opus":
		return "Opus"
	}
	return fourcc
}

// muxSingleTo rewrites a lone stream (no audio) into a progressive MP4 so the
// output layout is identical whether or not an audio track exists.
func muxSingleTo(inputPath, outputPath string) error {
	source, err := openSource(inputPath)
	if err != nil {
		return err
	}
	defer source.Close()
	var chosen *sourceTrack
	for _, track := range source.tracks {
		if track.isVideo {
			chosen = track
			break
		}
	}
	if chosen == nil && len(source.tracks) > 0 {
		chosen = source.tracks[0]
	}
	if chosen == nil || len(chosen.samples) == 0 {
		return errors.New("输入流中没有样本")
	}
	tracks := []*muxTrack{{source: chosen}}
	tracks[0].chunks = make([]uint64, (len(chosen.samples)+samplesPerChunk-1)/samplesPerChunk)
	ftyp := source.ftyp
	if len(ftyp) == 0 {
		ftyp = newBox("ftyp", []byte("isom"), be32(0x200), []byte("isomiso2avc1mp41"))
	}
	payload := int64(0)
	for _, sample := range chosen.samples {
		payload += int64(sample.size)
	}
	wide := payload > 0xF0000000
	moov := buildMoov(tracks, 1000, wide)
	base := uint64(int64(len(ftyp)) + int64(len(moov)) + 8)
	cursor := base
	for index := range chosen.samples {
		if index%samplesPerChunk == 0 {
			tracks[0].chunks[index/samplesPerChunk] = cursor
		}
		cursor += uint64(chosen.samples[index].size)
	}
	moov = buildMoov(tracks, 1000, wide)
	if uint64(int64(len(ftyp))+int64(len(moov))+8) != base {
		return errors.New("MP4 布局计算失败")
	}

	output, err := os.Create(outputPath)
	if err != nil {
		return err
	}
	defer output.Close()
	writer := newBufferedWriter(output)
	if _, err := writer.Write(ftyp); err != nil {
		return err
	}
	if _, err := writer.Write(moov); err != nil {
		return err
	}
	if _, err := writer.Write(append(be32(uint32(payload+8)), []byte("mdat")...)); err != nil {
		return err
	}
	if err := copySamples(writer, source.file, chosen.samples, payload); err != nil {
		return err
	}
	if err := writer.Flush(); err != nil {
		return err
	}
	return output.Sync()
}
