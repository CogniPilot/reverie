mod timing;
use crate::{
    Result,
    audio::{self, Wav},
    need, recognize, transcript,
};
use serde_json::{Value, json};
use std::{
    collections::BTreeSet,
    fs,
    io::{self, Write},
    path::Path,
    time::Instant,
};

const FIXTURE: &str = include_str!("../../../scripts/voice-ci/fixtures.json");

pub(crate) async fn run(root: &Path) -> Result<()> {
    let fixture: Value = serde_json::from_str(FIXTURE)?;
    let base = fs::read_to_string(root.join("speech-url.txt"))?;
    let clips = read_json(&root.join("clips.json"))?;
    let clips = clips.as_array().ok_or("Expected captured clips")?;
    let endpoints: BTreeSet<_> = clips
        .iter()
        .map(|clip| text(clip, "endpoint"))
        .collect::<Result<_>>()?;
    need(
        !clips.is_empty() && endpoints == BTreeSet::from(["speak", "turn"]),
        "Both production routes must have captured audio",
    )?;
    let mut results = Vec::new();
    let outcome = validate(root, base.trim(), &fixture, clips, &mut results).await;
    let report = write_json(&root.join("audio-report.json"), &json!(results));
    match (outcome, report) {
        (Ok(()), Ok(())) => {}
        (Err(error), Ok(())) | (Ok(()), Err(error)) => return Err(error),
        (Err(error), Err(report)) => return Err(format!("{error}; report: {report}").into()),
    }
    let accepted = json!({"status":"passed","recognizedClips":results.len(),
        "endpoints":endpoints,"tenSecondDurationAndAsrControl":"passed"});
    write_json(&root.join("acceptance.json"), &accepted)?;
    event(merge(
        accepted,
        json!({"phase":"real-audio-acceptance-complete"}),
    ))
}

async fn validate(
    root: &Path,
    base: &str,
    fixture: &Value,
    clips: &[Value],
    results: &mut Vec<Value>,
) -> Result<()> {
    for clip in clips {
        let file = text(clip, "file")?;
        event(json!({"phase":"recognition-start","file":file}))?;
        let bytes = fs::read(root.join(file))?;
        let wav = Wav::inspect(&bytes)?;
        let started = Instant::now();
        let recognized = recognize::recognize(base, bytes.clone()).await?;
        let millis = started.elapsed().as_secs_f64() * 1000.0;
        fs::write(root.join(format!("{file}.transcript.txt")), &recognized)?;
        let expected = text(clip, "expected")?;
        let long = expected == text(fixture, "reply")?;
        let ending = if long {
            text(fixture, "requiredEnding")?
        } else {
            ""
        };
        let content = transcript::check(expected, &recognized, maximum(fixture)?, ending)?;
        if long {
            audio::duration(wav.duration(), &fixture["durationSeconds"])?;
        }
        need(
            clip["endpoint"] != "speak"
                || clip["voice"] == json!({"provider":"kokoro","id":fixture["voice"]}),
            "Route changed the selected per-utterance voice",
        )?;
        let info = merge(wav.report(), content);
        let timing = json!({"transcript":recognized,"recognitionMs":millis});
        results.push(merge(merge(clip.clone(), info.clone()), timing));
        event(merge(
            info,
            json!({"phase":"recognition-complete","file":file,"recognitionMs":millis}),
        ))?;
    }
    check_browser(root)?;
    let turn = read_json(&root.join("turn.json"))?;
    transcript::check(
        text(fixture, "input")?,
        text(&turn, "transcript")?,
        maximum(fixture)?,
        "",
    )?;
    check_events(root, fixture)?;
    negative(root, base, fixture).await
}

fn check_browser(root: &Path) -> Result<()> {
    for name in ["speak", "turn"] {
        let bytes = fs::read(root.join(format!("{name}.wav")))?;
        let wav = Wav::inspect(&bytes)?;
        let browser = read_json(&root.join(format!("{name}.browser.json")))?;
        let seconds = browser["duration"]
            .as_f64()
            .ok_or("Missing browser duration")?;
        need(
            (wav.duration() - seconds).abs() <= 0.05,
            "Browser and PCM frame durations disagree",
        )?;
    }
    Ok(())
}

fn check_events(root: &Path, fixture: &Value) -> Result<()> {
    let data = fs::read_to_string(root.join("synth-events.jsonl"))?;
    let events: Vec<Value> = data
        .lines()
        .map(serde_json::from_str)
        .collect::<std::result::Result<_, _>>()?;
    need(
        !events.is_empty(),
        "Synth requests changed effective voice/provider",
    )?;
    for event in events {
        need(
            event["effectiveVoice"] == fixture["voice"] && event["provider"] == "kokoro",
            "Synth requests changed effective voice/provider",
        )?;
        timing::check(&event)?;
    }
    Ok(())
}

async fn negative(root: &Path, base: &str, fixture: &Value) -> Result<()> {
    let bytes = fs::read(root.join("speak.wav"))?;
    let truncated = Wav::inspect(&bytes)?.first_ten_seconds()?;
    fs::write(root.join("negative-ten-seconds.wav"), &truncated)?;
    let clipped = Wav::inspect(&truncated)?;
    need(
        audio::duration(clipped.duration(), &fixture["durationSeconds"]).is_err(),
        "Ten-second negative control escaped duration gate",
    )?;
    let recognized = recognize::recognize(base, truncated).await?;
    fs::write(
        root.join("negative-ten-seconds.transcript.txt"),
        &recognized,
    )?;
    need(
        transcript::check(
            text(fixture, "reply")?,
            &recognized,
            maximum(fixture)?,
            text(fixture, "requiredEnding")?,
        )
        .is_err(),
        "Ten-second negative control escaped real ASR gate",
    )
}

fn maximum(fixture: &Value) -> Result<f64> {
    fixture["maxWordErrorRate"]
        .as_f64()
        .ok_or_else(|| "Missing WER maximum".into())
}

fn text<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value[key]
        .as_str()
        .ok_or_else(|| format!("Missing {key}").into())
}

fn read_json(path: &Path) -> Result<Value> {
    Ok(serde_json::from_slice(&fs::read(path)?)?)
}

fn write_json(path: &Path, value: &Value) -> Result<()> {
    Ok(fs::write(path, serde_json::to_vec_pretty(value)?)?)
}

fn merge(mut left: Value, right: Value) -> Value {
    left.as_object_mut()
        .expect("report object")
        .extend(right.as_object().expect("report object").clone());
    left
}

fn event(value: Value) -> Result<()> {
    let mut output = io::stdout().lock();
    serde_json::to_writer(&mut output, &value)?;
    writeln!(output)?;
    Ok(output.flush()?)
}
