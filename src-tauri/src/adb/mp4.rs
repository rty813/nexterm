//! Screen recording: the mirror's H.264 stream written to an MP4 as it is (no re-encoding).
//! Samples go straight into `mdat`; their sizes and times are kept and the `moov` index is
//! written at the end, so a recording only costs disk writes. One video track (`avc1`), the
//! parameter sets from scrcpy's config packet in `avcC`.

use std::fs::File;
use std::io::{BufWriter, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};

/// Track timescale (the usual one for video); scrcpy's pts are microseconds.
const TIMESCALE: u64 = 90_000;
/// Movie timescale (mvhd / tkhd durations), milliseconds.
const MOVIE_TIMESCALE: u64 = 1000;
/// Duration of a frame with nothing after it (last one), and the gap used when pts jump back.
const DEFAULT_DELTA: u32 = (TIMESCALE / 30) as u32;

/// NAL units of an Annex B buffer (start codes 00 00 01 / 00 00 00 01 removed).
pub fn annexb_nals(data: &[u8]) -> Vec<&[u8]> {
    let mut starts = Vec::new();
    let mut i = 0;
    while i + 3 <= data.len() {
        if data[i] == 0 && data[i + 1] == 0 && data[i + 2] == 1 {
            starts.push((i, i + 3));
            i += 3;
        } else {
            i += 1;
        }
    }
    let mut out = Vec::new();
    for (k, &(_, body)) in starts.iter().enumerate() {
        let mut end = starts.get(k + 1).map_or(data.len(), |&(sc, _)| sc);
        // A 4-byte start code leaves its leading zero at the end of the previous unit.
        while end > body && data[end - 1] == 0 {
            end -= 1;
        }
        if end > body {
            out.push(&data[body..end]);
        }
    }
    out
}

/// `avcC` (AVCDecoderConfigurationRecord) from a config packet holding SPS and PPS.
pub fn avcc(config: &[u8]) -> Result<Vec<u8>> {
    let nals = annexb_nals(config);
    let sps: Vec<&[u8]> = nals.iter().copied().filter(|n| n[0] & 0x1f == 7).collect();
    let pps: Vec<&[u8]> = nals.iter().copied().filter(|n| n[0] & 0x1f == 8).collect();
    let Some(first) = sps.first().filter(|s| s.len() >= 4) else { bail!("视频配置中没有 SPS") };
    if pps.is_empty() {
        bail!("视频配置中没有 PPS");
    }
    let mut b = vec![1, first[1], first[2], first[3], 0xff, 0xe0 | sps.len() as u8];
    for s in &sps {
        b.extend((s.len() as u16).to_be_bytes());
        b.extend(*s);
    }
    b.push(pps.len() as u8);
    for p in &pps {
        b.extend((p.len() as u16).to_be_bytes());
        b.extend(*p);
    }
    Ok(b)
}

/// An Annex B access unit as an MP4 sample: each NAL with a 4-byte length. Parameter sets
/// and delimiters are left out (they live in `avcC`).
pub fn to_sample(data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len() + 16);
    for n in annexb_nals(data) {
        if matches!(n[0] & 0x1f, 7 | 8 | 9) {
            continue;
        }
        out.extend((n.len() as u32).to_be_bytes());
        out.extend(n);
    }
    out
}

struct Sample {
    offset: u64,
    size: u32,
    /// Track time (TIMESCALE), from 0.
    time: u64,
    key: bool,
}

/// What a finished recording holds.
#[derive(Debug, Clone, Copy, Default)]
pub struct Written {
    pub frames: u64,
    pub duration_ms: u64,
}

pub struct Mp4Writer {
    file: BufWriter<File>,
    path: PathBuf,
    width: u32,
    height: u32,
    avcc: Vec<u8>,
    mdat_at: u64,
    pos: u64,
    samples: Vec<Sample>,
    /// pts (µs) of the first sample, and the shift added after pts went backwards.
    origin: Option<u64>,
    shift: u64,
    last_time: u64,
}

impl Mp4Writer {
    /// Creates `path` and writes the header; samples are taken from the next keyframe.
    pub fn create(path: &Path, width: u32, height: u32, config: &[u8]) -> Result<Self> {
        let avcc = avcc(config)?;
        let file = File::create(path).with_context(|| format!("无法创建 {}", path.display()))?;
        let mut file = BufWriter::with_capacity(256 * 1024, file);
        let ftyp = bx(b"ftyp", &[b"isom".as_slice(), &0x200u32.to_be_bytes(), b"isomiso2avc1mp41"].concat());
        file.write_all(&ftyp)?;
        let mdat_at = ftyp.len() as u64;
        // 64-bit size, filled in by `finish`.
        file.write_all(&1u32.to_be_bytes())?;
        file.write_all(b"mdat")?;
        file.write_all(&0u64.to_be_bytes())?;
        Ok(Self {
            file,
            path: path.to_path_buf(),
            width,
            height,
            avcc,
            mdat_at,
            pos: mdat_at + 16,
            samples: Vec::new(),
            origin: None,
            shift: 0,
            last_time: 0,
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn size(&self) -> (u32, u32) {
        (self.width, self.height)
    }

    /// One access unit (Annex B), `pts` in microseconds.
    pub fn push(&mut self, pts: u64, key: bool, data: &[u8]) -> Result<()> {
        if self.samples.is_empty() && !key {
            return Ok(());
        }
        let sample = to_sample(data);
        if sample.is_empty() {
            return Ok(());
        }
        let origin = *self.origin.get_or_insert(pts);
        let mut time = (pts.saturating_sub(origin) + self.shift) * TIMESCALE / 1_000_000;
        if !self.samples.is_empty() && time <= self.last_time {
            // The encoder restarted with an earlier clock: keep the timeline going.
            let next = self.last_time + u64::from(DEFAULT_DELTA);
            self.shift += (next - time) * 1_000_000 / TIMESCALE + 1;
            time = (pts.saturating_sub(origin) + self.shift) * TIMESCALE / 1_000_000;
            time = time.max(next);
        }
        self.file.write_all(&sample)?;
        self.samples.push(Sample { offset: self.pos, size: sample.len() as u32, time, key });
        self.pos += sample.len() as u64;
        self.last_time = time;
        Ok(())
    }

    pub fn frames(&self) -> u64 {
        self.samples.len() as u64
    }

    /// Writes the index and closes the file. A file without frames is removed (error).
    pub fn finish(mut self) -> Result<Written> {
        if self.samples.is_empty() {
            drop(self.file);
            let _ = std::fs::remove_file(&self.path);
            bail!("没有录到画面");
        }
        let deltas = deltas(&self.samples);
        let duration: u64 = deltas.iter().map(|&d| u64::from(d)).sum();
        let moov = moov(&self.samples, &deltas, duration, self.width, self.height, &self.avcc);
        self.file.write_all(&moov)?;
        self.file.seek(SeekFrom::Start(self.mdat_at + 8))?;
        self.file.write_all(&(self.pos - self.mdat_at).to_be_bytes())?;
        self.file.flush()?;
        Ok(Written { frames: self.samples.len() as u64, duration_ms: duration * 1000 / TIMESCALE })
    }
}

/// Duration of each sample: the gap to the next one (the last gets the previous gap).
fn deltas(samples: &[Sample]) -> Vec<u32> {
    let mut out: Vec<u32> = samples
        .windows(2)
        .map(|w| (w[1].time - w[0].time).clamp(1, u64::from(u32::MAX)) as u32)
        .collect();
    out.push(out.last().copied().unwrap_or(DEFAULT_DELTA).min(DEFAULT_DELTA * 3));
    out
}

// ---------------------------------------------------------------------------------------
// Boxes

fn bx(kind: &[u8; 4], body: &[u8]) -> Vec<u8> {
    let mut b = Vec::with_capacity(body.len() + 8);
    b.extend((body.len() as u32 + 8).to_be_bytes());
    b.extend(kind);
    b.extend(body);
    b
}

fn full(kind: &[u8; 4], version: u8, flags: u32, body: &[u8]) -> Vec<u8> {
    let mut v = Vec::with_capacity(body.len() + 4);
    v.push(version);
    v.extend(&flags.to_be_bytes()[1..]);
    v.extend(body);
    bx(kind, &v)
}

const MATRIX: [u32; 9] = [0x0001_0000, 0, 0, 0, 0x0001_0000, 0, 0, 0, 0x4000_0000];

fn matrix() -> Vec<u8> {
    MATRIX.iter().flat_map(|v| v.to_be_bytes()).collect()
}

fn u32s(values: &[u32]) -> Vec<u8> {
    values.iter().flat_map(|v| v.to_be_bytes()).collect()
}

fn moov(samples: &[Sample], deltas: &[u32], duration: u64, width: u32, height: u32, avcc: &[u8]) -> Vec<u8> {
    let movie_duration = duration * MOVIE_TIMESCALE / TIMESCALE;
    // Version 1 boxes: 64-bit durations, no limit on recording length.
    let mut mvhd = vec![0u8; 16];
    mvhd.extend((MOVIE_TIMESCALE as u32).to_be_bytes());
    mvhd.extend(movie_duration.to_be_bytes());
    mvhd.extend(0x0001_0000u32.to_be_bytes()); // rate 1.0
    mvhd.extend(0x0100u16.to_be_bytes()); // volume 1.0
    mvhd.extend([0u8; 10]);
    mvhd.extend(matrix());
    mvhd.extend([0u8; 24]);
    mvhd.extend(2u32.to_be_bytes()); // next track id

    let mut tkhd = vec![0u8; 16];
    tkhd.extend(1u32.to_be_bytes()); // track id
    tkhd.extend([0u8; 4]);
    tkhd.extend(movie_duration.to_be_bytes());
    tkhd.extend([0u8; 8]);
    tkhd.extend([0u8; 4]); // layer, alternate group
    tkhd.extend([0u8; 4]); // volume (video: 0), reserved
    tkhd.extend(matrix());
    tkhd.extend((width << 16).to_be_bytes());
    tkhd.extend((height << 16).to_be_bytes());

    let mut mdhd = vec![0u8; 16];
    mdhd.extend((TIMESCALE as u32).to_be_bytes());
    mdhd.extend(duration.to_be_bytes());
    mdhd.extend(0x55c4u16.to_be_bytes()); // "und"
    mdhd.extend([0u8; 2]);

    let mut hdlr = vec![0u8; 4];
    hdlr.extend(b"vide");
    hdlr.extend([0u8; 12]);
    hdlr.extend(b"VideoHandler\0");

    let mut avc1 = vec![0u8; 6];
    avc1.extend(1u16.to_be_bytes()); // data reference index
    avc1.extend([0u8; 16]);
    avc1.extend((width as u16).to_be_bytes());
    avc1.extend((height as u16).to_be_bytes());
    avc1.extend(0x0048_0000u32.to_be_bytes()); // 72 dpi
    avc1.extend(0x0048_0000u32.to_be_bytes());
    avc1.extend([0u8; 4]);
    avc1.extend(1u16.to_be_bytes()); // frame count
    avc1.extend([0u8; 32]); // compressor name
    avc1.extend(0x0018u16.to_be_bytes()); // depth
    avc1.extend(0xffffu16.to_be_bytes());
    avc1.extend(bx(b"avcC", avcc));
    let stsd = full(b"stsd", 0, 0, &[u32s(&[1]), bx(b"avc1", &avc1)].concat());

    // Run-length time-to-sample.
    let mut runs: Vec<(u32, u32)> = Vec::new();
    for &d in deltas {
        match runs.last_mut() {
            Some((n, v)) if *v == d => *n += 1,
            _ => runs.push((1, d)),
        }
    }
    let mut stts = u32s(&[runs.len() as u32]);
    for (n, d) in runs {
        stts.extend(u32s(&[n, d]));
    }
    let keys: Vec<u32> = samples.iter().enumerate().filter(|(_, s)| s.key).map(|(i, _)| i as u32 + 1).collect();
    let stss = [u32s(&[keys.len() as u32]), u32s(&keys)].concat();
    let sizes: Vec<u32> = samples.iter().map(|s| s.size).collect();
    let stsz = [u32s(&[0, sizes.len() as u32]), u32s(&sizes)].concat();
    // One sample per chunk.
    let stsc = u32s(&[1, 1, 1, 1]);
    let mut co64 = u32s(&[samples.len() as u32]);
    for s in samples {
        co64.extend(s.offset.to_be_bytes());
    }

    let stbl = bx(
        b"stbl",
        &[
            stsd,
            full(b"stts", 0, 0, &stts),
            full(b"stss", 0, 0, &stss),
            full(b"stsz", 0, 0, &stsz),
            full(b"stsc", 0, 0, &stsc),
            full(b"co64", 0, 0, &co64),
        ]
        .concat(),
    );
    let dinf = bx(b"dinf", &full(b"dref", 0, 0, &[u32s(&[1]), full(b"url ", 0, 1, &[])].concat()));
    let minf = bx(b"minf", &[full(b"vmhd", 0, 1, &[0u8; 8]), dinf, stbl].concat());
    let mdia = bx(b"mdia", &[full(b"mdhd", 1, 0, &mdhd), full(b"hdlr", 0, 0, &hdlr), minf].concat());
    let trak = bx(b"trak", &[full(b"tkhd", 1, 3, &tkhd), mdia].concat());
    bx(b"moov", &[full(b"mvhd", 1, 0, &mvhd), trak].concat())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SPS: &[u8] = &[0x67, 0x42, 0xc0, 0x1f, 0xda, 0x01];
    const PPS: &[u8] = &[0x68, 0xce, 0x3c, 0x80];

    fn config() -> Vec<u8> {
        [&[0, 0, 0, 1][..], SPS, &[0, 0, 1], PPS].concat()
    }

    #[test]
    fn splits_annexb() {
        let data = [&[0, 0, 0, 1, 0x65, 1, 2][..], &[0, 0, 1, 0x41, 3]].concat();
        assert_eq!(annexb_nals(&data), vec![&[0x65, 1, 2][..], &[0x41, 3][..]]);
        assert!(annexb_nals(&[1, 2, 3]).is_empty());
    }

    #[test]
    fn builds_avcc() {
        let a = avcc(&config()).unwrap();
        assert_eq!(&a[..6], &[1, 0x42, 0xc0, 0x1f, 0xff, 0xe1]);
        assert_eq!(&a[6..8], &(SPS.len() as u16).to_be_bytes());
        assert_eq!(a[8 + SPS.len()], 1);
        assert!(avcc(&[0, 0, 1, 0x65, 1]).is_err());
    }

    #[test]
    fn samples_are_length_prefixed() {
        let au = [&[0, 0, 0, 1, 0x09, 0xf0][..], &[0, 0, 0, 1], SPS, &[0, 0, 1, 0x65, 7, 7]].concat();
        assert_eq!(to_sample(&au), vec![0, 0, 0, 3, 0x65, 7, 7]);
    }

    fn find(data: &[u8], kind: &[u8; 4]) -> Option<usize> {
        data.windows(4).position(|w| w == kind)
    }

    #[test]
    fn writes_a_file() {
        let dir = std::env::temp_dir().join(format!("nexterm-mp4-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("a.mp4");
        let mut w = Mp4Writer::create(&path, 720, 1280, &config()).unwrap();
        // Before the first keyframe: skipped.
        w.push(1_000, false, &[0, 0, 1, 0x41, 1]).unwrap();
        w.push(10_000, true, &[0, 0, 1, 0x65, 1, 2, 3]).unwrap();
        w.push(43_334, false, &[0, 0, 1, 0x41, 4]).unwrap();
        // Clock went back (encoder restart): still after the previous frame.
        w.push(5_000, true, &[0, 0, 1, 0x65, 5]).unwrap();
        assert_eq!(w.frames(), 3);
        let times: Vec<u64> = w.samples.iter().map(|s| s.time).collect();
        assert_eq!(times[0], 0);
        assert_eq!(times[1], 3000);
        assert!(times[2] > times[1]);
        let written = w.finish().unwrap();
        assert_eq!(written.frames, 3);

        let data = std::fs::read(&path).unwrap();
        assert_eq!(&data[4..8], b"ftyp");
        let mdat = find(&data, b"mdat").unwrap();
        let size = u64::from_be_bytes(data[mdat + 4..mdat + 12].try_into().unwrap());
        let moov = find(&data, b"moov").unwrap();
        // mdat runs up to moov's size field.
        assert_eq!(mdat as u64 - 4 + size, moov as u64 - 4);
        // The first sample right after the 16-byte mdat header.
        assert_eq!(&data[mdat + 12..mdat + 20], &[0, 0, 0, 4, 0x65, 1, 2, 3]);
        assert!(find(&data, b"avcC").is_some() && find(&data, b"stss").is_some());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn empty_recording_is_removed() {
        let path = std::env::temp_dir().join(format!("nexterm-mp4-{}.mp4", uuid::Uuid::new_v4().simple()));
        let w = Mp4Writer::create(&path, 10, 10, &config()).unwrap();
        assert!(w.finish().is_err());
        assert!(!path.exists());
    }

    /// `NEXTERM_H264=<annex b file> cargo test ... real_stream -- --ignored`: muxes a raw
    /// stream (`ffmpeg -f lavfi -i testsrc -c:v libx264 -bsf:v h264_mp4toannexb x.h264`)
    /// into `<file>.mp4` for checking with ffprobe.
    #[test]
    #[ignore]
    fn real_stream() {
        let src = std::env::var("NEXTERM_H264").unwrap();
        let data = std::fs::read(&src).unwrap();
        let nals = annexb_nals(&data);
        let config: Vec<u8> = nals
            .iter()
            .filter(|n| matches!(n[0] & 0x1f, 7 | 8))
            .flat_map(|n| [&[0, 0, 0, 1][..], n].concat())
            .collect();
        let out = PathBuf::from(format!("{src}.mp4"));
        let mut w = Mp4Writer::create(&out, 320, 240, &config).unwrap();
        let mut frame = 0u64;
        for n in nals.iter().filter(|n| matches!(n[0] & 0x1f, 1 | 5)) {
            w.push(frame * 40_000, n[0] & 0x1f == 5, &[&[0, 0, 0, 1][..], n].concat()).unwrap();
            frame += 1;
        }
        w.finish().unwrap();
    }
}
