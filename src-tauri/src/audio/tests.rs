use std::sync::Mutex;
use std::thread;

use rodio::Source;
use rodio::queue::SourcesQueueOutput;

use super::engine::tests::{Fake, Shelf};
use super::*;
use crate::library::TrackId;
use crate::library::track::tests::{FIXTURES, fixture};

/// Pulls `ms` of sound from the queue, as the sound card would.
fn pull(output: &mut SourcesQueueOutput, ms: u64) {
    let per_ms = u64::from(output.sample_rate().get()) * u64::from(output.channels().get()) / 1000;
    for _ in 0..per_ms * ms {
        output.next();
    }
}

#[test]
fn reads_the_formats_symphonia_decodes() {
    for format in ["MP3", "FLAC", "MP4", "Ogg Vorbis", "WAV", "AIFF"] {
        assert!(reads(format), "{format}");
    }
    for format in ["Opus", "APE", "WavPack", "Musepack", "Speex", "WMA", "AAC"] {
        assert!(!reads(format), "{format}");
    }
}

#[test]
fn a_speaker_plays_each_format_it_reads_one_after_the_other() {
    let (mut speaker, mut output) = Speaker::detached();
    let mut queued = 0;
    for (name, format) in FIXTURES {
        let appended = speaker.append(&fixture(name));
        assert_eq!(appended.is_ok(), reads(format), "{name}: {appended:?}");
        queued += usize::from(appended.is_ok());
    }
    assert!(matches!(
        speaker.append(&fixture("gone.mp3")),
        Err(AudioError::Unreadable { .. })
    ));
    assert_eq!(speaker.len(), queued);
    speaker.set_volume(0.5);
    speaker.play();
    pull(&mut output, 300);
    let at = speaker.position();
    assert!(at >= Duration::from_millis(250), "{at:?}");
    // Paused, the position stays (the pause is taken within 5 ms of sound).
    speaker.pause();
    pull(&mut output, 200);
    assert!(speaker.position() - at <= Duration::from_millis(10));
    speaker.play();

    // A seek is taken by the output as it plays.
    thread::scope(|s| {
        let seeking = s.spawn(|| speaker.seek(Duration::from_millis(700)));
        while !seeking.is_finished() {
            pull(&mut output, 5);
        }
        seeking.join().unwrap().unwrap();
    });
    assert!(speaker.position() >= Duration::from_millis(700));
    // The first track ends: the next one plays, without a gap.
    pull(&mut output, 400);
    assert_eq!(speaker.len(), queued - 1);
    assert!(speaker.position() < Duration::from_millis(400));

    // The output lost: a seek no longer waits for it.
    speaker.lost.store(true, Ordering::SeqCst);
    assert!(matches!(
        speaker.seek(Duration::ZERO),
        Err(AudioError::NoOutput { .. })
    ));
}

#[test]
fn opens_windows_output_or_says_there_is_none() {
    // A runner of the CI has no sound card; a PC has one. Nothing is played.
    let mut speakers = Speakers::default();
    for _ in 0..2 {
        match speakers.sink() {
            Ok(sink) => assert_eq!(sink.len(), 0),
            Err(error) => assert!(matches!(error, AudioError::NoOutput { .. }), "{error:?}"),
        }
        // Lost: opened again.
        speakers.lost.store(true, Ordering::SeqCst);
    }
}

/// The events heard, for the tests to read.
#[derive(Default)]
struct Heard {
    states: Mutex<Vec<PlayerState>>,
    positions: Mutex<Vec<u64>>,
}

impl PlayerEvents for Arc<Heard> {
    fn state(&self, state: &PlayerState) {
        self.states.lock().unwrap().push(state.clone());
    }
    fn position(&self, position_ms: u64) {
        self.positions.lock().unwrap().push(position_ms);
    }
}

#[test]
fn the_player_moves_on_by_itself_and_tells_the_window() {
    let heard = Arc::new(Heard::default());
    let shelf = Shelf::default();
    let out = Fake::default();
    let engine = Engine::new(out.clone(), shelf.clone(), 1);
    let playback = Playback::start(engine, Arc::clone(&heard), Duration::from_millis(5));
    let state = playback.with(|e| e.play(vec![TrackId(1), TrackId(2)], 0));
    assert!(state.playing);
    assert_eq!(heard.states.lock().unwrap().last(), Some(&state));
    assert_eq!(playback.state(), state);

    // Positions while it plays.
    let wait = |what: &str, done: &dyn Fn() -> bool| {
        for _ in 0..400 {
            if done() {
                return;
            }
            thread::sleep(Duration::from_millis(5));
        }
        panic!("still waiting: {what}");
    };
    wait("a position", &|| {
        !heard.positions.lock().unwrap().is_empty()
    });
    // The track ends: the next one, told.
    out.finish();
    wait("the next track", &|| {
        heard
            .states
            .lock()
            .unwrap()
            .last()
            .and_then(|s| s.current.as_ref())
            .map(|c| c.id)
            == Some(TrackId(2))
    });
    drop(playback);
    let kept = shelf.recall().unwrap();
    assert_eq!(kept.queue.current(), Some(TrackId(2)));
}
