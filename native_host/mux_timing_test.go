package main

// Unit tests for the timing reconstruction in fillDurations.
//
// These cover the second Bilibili muxing variant, which writes no sample
// durations at all, and the tail fragment that carries more samples than the
// others. Both cases produced real, user-visible bugs: a zero-duration file and
// a video track that ended seconds before the audio.

import "testing"

// buildTrack makes a track whose samples all have dur == 0, split into
// fragments with the given start times and sample counts.
func buildTrack(timescale uint32, starts []uint64, counts []int, hasTime []bool) *sourceTrack {
	track := &sourceTrack{timescale: timescale}
	for index, count := range counts {
		first := len(track.samples)
		for i := 0; i < count; i++ {
			track.samples = append(track.samples, mp4Sample{size: 100})
		}
		track.fragments = append(track.fragments, fragmentInfo{
			startTime:   starts[index],
			firstSample: first,
			sampleCount: count,
			hasTime:     hasTime[index],
		})
	}
	return track
}

func durationSum(track *sourceTrack) uint64 {
	total := uint64(0)
	for _, sample := range track.samples {
		total += uint64(sample.dur)
	}
	return total
}

func TestFillDurationsFromTimeline(t *testing.T) {
	// 3 fragments of 5 samples each, 1000 ticks apart.
	track := buildTrack(1000, []uint64{0, 1000, 2000}, []int{5, 5, 5},
		[]bool{true, true, true})
	fillDurations(track)
	got := durationSum(track)
	if got != 3000 {
		t.Fatalf("total duration = %d, want 3000", got)
	}
	if track.samples[0].dur != 200 {
		t.Fatalf("per-sample duration = %d, want 200", track.samples[0].dur)
	}
}

func TestFillDurationsHandlesUnevenTail(t *testing.T) {
	// The last fragment carries 10 samples instead of 5. Its duration must be
	// based on the per-sample rate of the previous fragment, otherwise the
	// track ends early and the tail of the video has audio only.
	track := buildTrack(1000, []uint64{0, 1000, 2000}, []int{5, 5, 10},
		[]bool{true, true, true})
	fillDurations(track)
	got := durationSum(track)
	const want = 2000 + 10*200 // two full fragments + tail at 200 ticks/sample
	if got != want {
		t.Fatalf("total duration = %d, want %d", got, want)
	}
	if tail := track.samples[len(track.samples)-1].dur; tail != 200 {
		t.Fatalf("tail sample duration = %d, want 200", tail)
	}
}

func TestFillDurationsLeavesRealDurationsAlone(t *testing.T) {
	track := &sourceTrack{timescale: 1000}
	for i := 0; i < 6; i++ {
		track.samples = append(track.samples, mp4Sample{size: 10, dur: 33})
	}
	track.fragments = []fragmentInfo{
		{startTime: 0, firstSample: 0, sampleCount: 3, hasTime: true},
		{startTime: 99, firstSample: 3, sampleCount: 3, hasTime: true},
	}
	fillDurations(track)
	for index, sample := range track.samples {
		if sample.dur != 33 {
			t.Fatalf("sample %d was rewritten to %d", index, sample.dur)
		}
	}
}

func TestFillDurationsWithoutTimelineIsNoOp(t *testing.T) {
	track := buildTrack(1000, []uint64{0, 0}, []int{5, 5}, []bool{false, false})
	fillDurations(track)
	if durationSum(track) != 0 {
		t.Fatal("durations were invented without a tfdt timeline")
	}
}

func TestFillDurationsSingleFragmentKeepsExisting(t *testing.T) {
	// A single fragment cannot be extrapolated; existing durations must survive
	// and missing ones must stay at zero rather than producing garbage.
	track := &sourceTrack{timescale: 1000}
	for i := 0; i < 4; i++ {
		track.samples = append(track.samples, mp4Sample{size: 10, dur: 25})
	}
	track.fragments = []fragmentInfo{{startTime: 0, firstSample: 0, sampleCount: 4, hasTime: true}}
	fillDurations(track)
	if durationSum(track) != 100 {
		t.Fatalf("single fragment was rewritten: %d", durationSum(track))
	}
}
