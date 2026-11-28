//! The built-in player (KAN-8): the sound decoded by Symphonia and played on
//! Windows' default output by rodio, on threads of their own. The window
//! sends commands by track id and hears the state as events; the playing
//! goes on with the window minimised.
//!
//! - `queue`: what plays and in which order (shuffle, repeat);
//! - `engine`: the queue played on an output, the next track added before
//!   the end of the current one so that they follow without a gap;
//! - here: the real output, and the thread that moves the engine on.

pub mod engine;
pub mod queue;

use std::fs;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use rodio::{Decoder, DeviceSinkBuilder, MixerDeviceSink, Player};

pub use engine::{AudioError, Engine, Library, Memory, Output, Playable, PlayerState, Sink, Skip};
pub use queue::Repeat;

/// How often the engine moves on, and the position is sent while it plays.
pub const TICK: Duration = Duration::from_millis(250);
/// How often what the player has is kept while it plays (and at each change).
const REMEMBER_EVERY: Duration = Duration::from_secs(10);

/// Formats the player reads, as the index names them (track.rs).
const READ: &[&str] = &["MP3", "FLAC", "MP4", "Ogg Vorbis", "WAV", "AIFF"];

/// Whether the player reads a track of this format: not Opus, APE,
/// WavPack, Musepack, Speex nor WMA, which Symphonia does not decode.
pub fn reads(format: &str) -> bool {
    READ.contains(&format)
}

/// Windows' default output, opened at the first track played, and again
/// after Windows reported it lost (its device unplugged).
#[derive(Default)]
pub struct Speakers {
    device: Option<MixerDeviceSink>,
    lost: Arc<AtomicBool>,
    /// For the tests of the commands: the tracks are queued, never played.
    silent: bool,
}

impl Speakers {
    /// An output where nothing comes out of the PC, and nothing moves on.
    #[cfg(test)]
    pub fn silent() -> Self {
        Self {
            silent: true,
            ..Self::default()
        }
    }
}

fn no_output(error: impl std::fmt::Display) -> AudioError {
    AudioError::NoOutput {
        message: error.to_string(),
    }
}

impl Output for Speakers {
    type Sink = Speaker;

    fn sink(&mut self) -> Result<Speaker, AudioError> {
        if self.silent {
            // Seen as lost: a seek does not wait for an output that never plays.
            let (player, _) = Player::new();
            let lost = Arc::new(AtomicBool::new(true));
            return Ok(Speaker { player, lost });
        }
        if self.lost.swap(false, Ordering::SeqCst) {
            self.device = None;
        }
        let device = match &mut self.device {
            Some(device) => device,
            none => {
                let lost = Arc::clone(&self.lost);
                let mut device = DeviceSinkBuilder::from_default_device()
                    .map_err(no_output)?
                    .with_error_callback(move |_| lost.store(true, Ordering::SeqCst))
                    .open_stream()
                    .map_err(no_output)?;
                device.log_on_drop(false);
                none.insert(device)
            }
        };
        Ok(Speaker {
            player: Player::connect_new(device.mixer()),
            lost: Arc::clone(&self.lost),
        })
    }
}

/// rodio's queue of tracks on the output. A seek waits for the output to
/// take it: not once the output is lost, or it would wait for ever.
pub struct Speaker {
    player: Player,
    lost: Arc<AtomicBool>,
}

impl Speaker {
    /// A queue not connected to any output: the tests pull its sound.
    #[cfg(test)]
    fn detached() -> (Self, rodio::queue::SourcesQueueOutput) {
        let (player, output) = Player::new();
        let lost = Arc::new(AtomicBool::new(false));
        (Self { player, lost }, output)
    }
}

fn unreadable(error: impl std::fmt::Display) -> AudioError {
    AudioError::Unreadable {
        message: error.to_string(),
    }
}

impl Sink for Speaker {
    fn append(&mut self, path: &Path) -> Result<(), AudioError> {
        let file = fs::File::open(crate::library::paths::for_io(path)).map_err(unreadable)?;
        // A hostile file must not take Kanade down: a panic is a file not read.
        let decoder = catch_unwind(AssertUnwindSafe(|| Decoder::try_from(file)))
            .map_err(|_| unreadable("the decoder panicked"))?
            .map_err(unreadable)?;
        self.player.append(decoder);
        Ok(())
    }

    fn play(&self) {
        self.player.play();
    }

    fn pause(&self) {
        self.player.pause();
    }

    fn seek(&self, to: Duration) -> Result<(), AudioError> {
        if self.lost.load(Ordering::SeqCst) {
            return Err(no_output("the output was lost"));
        }
        self.player.try_seek(to).map_err(unreadable)
    }

    fn position(&self) -> Duration {
        self.player.get_pos()
    }

    fn len(&self) -> usize {
        self.player.len()
    }

    fn set_volume(&self, volume: f32) {
        self.player.set_volume(volume);
    }
}

/// What the window hears of the player.
pub trait PlayerEvents: Send + Sync + 'static {
    /// The track, the queue or a setting changed.
    fn state(&self, state: &PlayerState);
    /// Where the track playing is, a few times a second while it plays.
    fn position(&self, position_ms: u64);
}

/// The engine, shared by the commands and the thread that moves it on.
pub struct Playback<O: Output + 'static, L: Library + 'static> {
    engine: Arc<Mutex<Engine<O, L>>>,
    events: Arc<dyn PlayerEvents>,
    stop: Arc<AtomicBool>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    // A command that panicked left the engine as it was: it goes on.
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl<O: Output + 'static, L: Library + 'static> Playback<O, L> {
    /// Starts the thread that moves `engine` on every `tick`.
    pub fn start(engine: Engine<O, L>, events: impl PlayerEvents, tick: Duration) -> Self {
        let playback = Self {
            engine: Arc::new(Mutex::new(engine)),
            events: Arc::new(events),
            stop: Arc::new(AtomicBool::new(false)),
        };
        let engine = Arc::clone(&playback.engine);
        let events = Arc::clone(&playback.events);
        let stop = Arc::clone(&playback.stop);
        std::thread::spawn(move || {
            let mut kept = Instant::now();
            while !stop.load(Ordering::SeqCst) {
                std::thread::sleep(tick);
                let mut engine = lock(&engine);
                if engine.tick() {
                    events.state(&engine.state());
                    engine.remember();
                }
                if engine.playing() {
                    events.position(engine.state().position_ms);
                    if kept.elapsed() >= REMEMBER_EVERY {
                        engine.remember();
                        kept = Instant::now();
                    }
                }
            }
        });
        playback
    }

    /// Runs `command` on the engine, then tells the window and keeps the
    /// state.
    pub fn with(&self, command: impl FnOnce(&mut Engine<O, L>)) -> PlayerState {
        let mut engine = lock(&self.engine);
        command(&mut engine);
        let state = engine.state();
        self.events.state(&state);
        engine.remember();
        state
    }

    pub fn state(&self) -> PlayerState {
        lock(&self.engine).state()
    }

    /// Reads the engine, as it is.
    pub fn read<T>(&self, read: impl FnOnce(&Engine<O, L>) -> T) -> T {
        read(&lock(&self.engine))
    }
}

impl<O: Output + 'static, L: Library + 'static> Drop for Playback<O, L> {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        lock(&self.engine).remember();
    }
}

#[cfg(test)]
mod tests;
