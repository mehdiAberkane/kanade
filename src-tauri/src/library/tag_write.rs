//! Writing tags into the audio files (KAN-7), without losing anything.
//!
//! A file is never written in place: a copy, next to it, is edited by lofty,
//! read again and checked (the same audio, the other tags and covers as they
//! were, the new values there), then put in its place by one rename. A
//! failure at any step leaves the original as it was.
//!
//! Each block of tags already in the file (ID3v2, ID3v1 and APE in an MP3)
//! gets the same values, and none is removed. The block the format reads
//! first (ID3v2 in an MP3, Vorbis comments in a FLAC…) is made from the
//! others when it is missing. lofty splits each block into what a generic
//! `Tag` knows and the rest (`SplitTag`), then puts the rest back
//! (`MergeTag`): what Kanade does not edit goes through untouched.
//!
//! The tags are read in lofty's strict mode: a file whose tags do not follow
//! their format is not written, since lofty would leave out what it skipped.
//! MP3 tags are written as ID3v2.3, which every player reads.

use std::collections::BTreeMap;
use std::fs;
use std::io::{self, Seek};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::Path;

use lofty::aac::AacFile;
use lofty::ape::{ApeFile, ApeTag};
use lofty::config::{ParseOptions, ParsingMode, WriteOptions};
use lofty::file::{FileType, TaggedFile};
use lofty::flac::FlacFile;
use lofty::id3::v1::Id3v1Tag;
use lofty::id3::v2::Id3v2Tag;
use lofty::iff::aiff::{AiffFile, AiffTextChunks};
use lofty::iff::wav::{RiffInfoList, WavFile};
use lofty::mp4::{Ilst, Mp4File};
use lofty::mpeg::MpegFile;
use lofty::musepack::MpcFile;
use lofty::ogg::tag::VorbisComments;
use lofty::ogg::{OpusFile, SpeexFile, VorbisFile};
use lofty::prelude::*;
use lofty::probe::Probe;
use lofty::tag::{ItemValue, Tag, TagItem, TagType};
use lofty::wavpack::WavPackFile;
use serde::{Deserialize, Serialize};

use super::paths;
use super::scan::LibraryError;
use super::track::{self, FileStamp, MAX_FILE_SIZE, MAX_TAG_CHARS, Track};

/// The copy being written, in the file's folder: one at a time, and not an
/// audio file, so neither a scan nor the watcher lists it.
const TEMP_NAME: &str = ".kanade-tags.tmp";

/// The highest track or disc number the editor takes.
pub const MAX_NUMBER: u32 = 9999;

/// A field of the tag editor.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TagField {
    Title,
    Artist,
    AlbumArtist,
    Album,
    Track,
    Disc,
    Year,
    Genre,
}

impl TagField {
    /// The items the field is written to: a year replaces both the date
    /// and the year a file may hold.
    fn keys(self) -> &'static [Key] {
        match self {
            Self::Title => &[Key::Title],
            Self::Artist => &[Key::Artist],
            Self::AlbumArtist => &[Key::AlbumArtist],
            Self::Album => &[Key::Album],
            Self::Track => &[Key::Track],
            Self::Disc => &[Key::Disc],
            Self::Year => &[Key::Date, Key::Year],
            Self::Genre => &[Key::Genre],
        }
    }
}

/// A tag item Kanade writes, as the journal names it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Key {
    Title,
    Artist,
    AlbumArtist,
    Album,
    Track,
    Disc,
    Date,
    Year,
    Genre,
}

impl Key {
    fn item(self) -> ItemKey {
        match self {
            Self::Title => ItemKey::TrackTitle,
            Self::Artist => ItemKey::TrackArtist,
            Self::AlbumArtist => ItemKey::AlbumArtist,
            Self::Album => ItemKey::AlbumTitle,
            Self::Track => ItemKey::TrackNumber,
            Self::Disc => ItemKey::DiscNumber,
            Self::Date => ItemKey::RecordingDate,
            Self::Year => ItemKey::Year,
            Self::Genre => ItemKey::Genre,
        }
    }

    fn field(self) -> TagField {
        match self {
            Self::Title => TagField::Title,
            Self::Artist => TagField::Artist,
            Self::AlbumArtist => TagField::AlbumArtist,
            Self::Album => TagField::Album,
            Self::Track => TagField::Track,
            Self::Disc => TagField::Disc,
            Self::Date | Self::Year => TagField::Year,
            Self::Genre => TagField::Genre,
        }
    }
}

/// Tag items and their values, an empty list for none: what a change
/// writes, and what the file held before (kept to undo it).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Values(pub BTreeMap<Key, Vec<String>>);

impl Values {
    /// The values of `keys` in `tag`.
    fn of(tag: &Tag, keys: impl IntoIterator<Item = Key>) -> Self {
        Self(
            keys.into_iter()
                .map(|key| (key, values(tag, key)))
                .collect(),
        )
    }

    /// Only the items whose values differ from `tag`'s.
    fn differing(mut self, tag: &Tag) -> Self {
        self.0.retain(|key, list| values(tag, *key) != *list);
        self
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// The items of every field these values touch: the ones the check of
    /// the written copy leaves aside.
    fn touched(&self) -> Vec<ItemKey> {
        self.0
            .keys()
            .flat_map(|key| key.field().keys())
            .map(|key| key.item())
            .collect()
    }
}

fn values(tag: &Tag, key: Key) -> Vec<String> {
    tag.get_strings(key.item()).map(str::to_owned).collect()
}

/// What to write into a file, given the tags it holds.
pub trait Change {
    /// The items to set in a file whose tags read `current`: only the ones
    /// that differ.
    fn values(&self, current: &Tag) -> Result<Values, Refusal>;
}

impl<T: Change + ?Sized> Change for &T {
    fn values(&self, current: &Tag) -> Result<Values, Refusal> {
        (**self).values(current)
    }
}

/// A change undone: the values found before written back, when the file
/// still has the ones written. A field changed since (by another program)
/// is not overwritten: the file is left as it is. A file already undone
/// (an undo stopped half way, then asked again) is left too.
#[derive(Debug, Clone, Copy)]
pub struct Undo<'a> {
    pub before: &'a Values,
    pub after: &'a Values,
}

impl Change for Undo<'_> {
    fn values(&self, current: &Tag) -> Result<Values, Refusal> {
        let undo = self.before.clone().differing(current);
        if undo.is_empty() || self.after.clone().differing(current).is_empty() {
            Ok(undo)
        } else {
            Err(Refusal::Changed)
        }
    }
}

/// What the editor asks: for each field touched, its new value, `None` to
/// remove it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TagEdit(BTreeMap<TagField, Option<String>>);

impl TagEdit {
    /// The editor's fields, checked: a text of at most `MAX_TAG_CHARS`
    /// characters without control characters, a number from 1 to
    /// `MAX_NUMBER`, a year of four digits. An empty value removes the field.
    pub fn from_input(input: BTreeMap<TagField, String>) -> Result<Self, LibraryError> {
        input
            .into_iter()
            .map(|(field, raw)| Ok((field, checked(field, &raw)?)))
            .collect::<Result<_, _>>()
            .map(Self)
    }

    pub fn fields(&self) -> impl Iterator<Item = TagField> + '_ {
        self.0.keys().copied()
    }
}

fn checked(field: TagField, raw: &str) -> Result<Option<String>, LibraryError> {
    let value = raw.trim();
    if value.is_empty() {
        return Ok(None);
    }
    let valid = match field {
        TagField::Track | TagField::Disc => value
            .parse::<u32>()
            .ok()
            .filter(|n| (1..=MAX_NUMBER).contains(n))
            .map(|n| n.to_string()),
        TagField::Year => (value.len() == 4
            && value.bytes().all(|b| b.is_ascii_digit())
            && !value.starts_with('0'))
        .then(|| value.to_owned()),
        _ => (value.chars().count() <= MAX_TAG_CHARS && !value.chars().any(char::is_control))
            .then(|| value.to_owned()),
    };
    valid.map(Some).ok_or(LibraryError::InvalidTag { field })
}

impl Change for TagEdit {
    fn values(&self, current: &Tag) -> Result<Values, Refusal> {
        let mut values = Values::default();
        for (field, value) in &self.0 {
            let number = value.as_deref().and_then(|v| v.parse::<u32>().ok());
            match field {
                // The same year keeps the full date (2021-05-03), and "03"
                // already is track 3.
                TagField::Year
                    if number.is_some() && current.date().map(|d| u32::from(d.year)) == number => {}
                TagField::Track if number.is_some() && current.track() == number => {}
                TagField::Disc if number.is_some() && current.disk() == number => {}
                _ => {
                    for (i, key) in field.keys().iter().enumerate() {
                        // The value in the first item, the others emptied.
                        let list = if i == 0 { value.clone() } else { None };
                        values.0.insert(*key, list.into_iter().collect());
                    }
                }
            }
        }
        Ok(values.differing(current))
    }
}

/// Why a file was not written. Its original stays as it was.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Refusal {
    /// The file is no longer there.
    Gone,
    /// The file changed since Kanade read it: its tags may not be the ones
    /// shown. The next scan reads it again.
    Changed,
    ReadOnly,
    /// Only in the cloud (OneDrive…): writing it would download it.
    OnlineOnly,
    /// A format whose tags Kanade does not write (WMA).
    Unsupported,
    /// Its tags do not follow their format: written again, what lofty
    /// skipped would be lost.
    Damaged,
    /// A cover (or a file) too big for Kanade to hold in memory.
    TooBig,
    /// Another program holds the file open.
    InUse,
    /// Writing or checking the copy failed.
    Failed {
        message: String,
    },
}

/// A file written: the values before and after, for the journal, and the
/// file as the index now keeps it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Written {
    pub before: Values,
    pub after: Values,
    pub track: Track,
}

/// Writes `change` into the file at `path`, which the index knows with
/// `stamp`: refused when the file changed since. `None` when the file
/// already had these values, left as it was.
pub fn write(
    path: &Path,
    stamp: FileStamp,
    change: &impl Change,
) -> Result<Option<Written>, Refusal> {
    let io_path = paths::for_io(path);
    let metadata = fs::metadata(&io_path).map_err(|e| gone_or_failed(&e))?;
    if FileStamp::of(&metadata) != stamp {
        return Err(Refusal::Changed);
    }
    if metadata.permissions().readonly() {
        return Err(Refusal::ReadOnly);
    }
    if paths::is_online_only(&metadata) {
        return Err(Refusal::OnlineOnly);
    }
    if metadata.len() > MAX_FILE_SIZE {
        return Err(Refusal::TooBig);
    }
    let file_type = FileType::from_path(path).ok_or(Refusal::Unsupported)?;
    track::configure_lofty();
    let (before, mode) = read_tagged(&io_path, file_type)?;
    let current = text_of(&before);
    let values = change.values(&current)?;
    if values.is_empty() {
        return Ok(None);
    }
    let found = Values::of(&current, values.0.keys().copied());

    let temp = io_path.with_file_name(TEMP_NAME);
    let replaced = write_copy(
        &io_path,
        &temp,
        &metadata,
        (file_type, mode),
        &values,
        &before,
    )
    .and_then(|()| {
        // Changed while the copy was made: the copy has the old content.
        let now = fs::metadata(&io_path).map_err(|e| gone_or_failed(&e))?;
        if FileStamp::of(&now) != stamp {
            return Err(Refusal::Changed);
        }
        fs::rename(&temp, &io_path).map_err(|e| not_replaced(&e))
    });
    if replaced.is_err() {
        // Nothing to do when it is not there.
        let _ = fs::remove_file(&temp);
    }
    replaced?;

    let written = fs::metadata(&io_path).map_err(|e| gone_or_failed(&e))?;
    let track = track::read_track(path, FileStamp::of(&written))
        .map_err(|e| Refusal::Failed { message: e.message })?;
    Ok(Some(Written {
        before: found,
        after: values,
        track,
    }))
}

/// Copies the file to `temp`, writes `values` into the copy and checks it.
fn write_copy(
    original: &Path,
    temp: &Path,
    metadata: &fs::Metadata,
    (file_type, mode): (FileType, ParsingMode),
    values: &Values,
    before: &TaggedFile,
) -> Result<(), Refusal> {
    fs::copy(original, temp).map_err(|e| in_use_or_failed(&e))?;
    {
        let mut file = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(temp)
            .map_err(|e| failed(&e))?;
        edit_blocks(&mut file, file_type, mode, values)?;
        keep_created(&file, metadata);
        file.sync_all().map_err(|e| failed(&e))?;
    }
    let (after, _) = read_tagged(temp, file_type).map_err(|refusal| Refusal::Failed {
        message: format!("the copy written does not read back: {refusal:?}"),
    })?;
    check(before, &after, values)
}

/// The tags written keep the file's creation date (Explorer shows it); its
/// modification date changes, as with any program.
#[cfg(windows)]
fn keep_created(file: &fs::File, metadata: &fs::Metadata) {
    use std::os::windows::fs::FileTimesExt;
    if let Ok(created) = metadata.created() {
        // Not kept: the date of the copy, nothing lost in the file.
        let _ = file.set_times(fs::FileTimes::new().set_created(created));
    }
}

#[cfg(not(windows))]
fn keep_created(_file: &fs::File, _metadata: &fs::Metadata) {}

fn parse_options(mode: ParsingMode) -> ParseOptions {
    ParseOptions::new().parsing_mode(mode).read_cover_art(true)
}

fn write_options() -> WriteOptions {
    WriteOptions::new().use_id3v23(true)
}

/// The size of an ID3v1 block, always last in its file.
const ID3V1_SIZE: u64 = 128;

/// Reads the whole file as lofty's generic view, strictly, with the mode the
/// file is to be read in to write it.
///
/// One exception: an ID3v1 block whose year is empty (lofty itself writes
/// it as zeros) or not a year. There is nothing to lose in it, so the rest
/// of the file is checked strictly without it, then the whole file read
/// leniently, which gives the same blocks with no year in the ID3v1.
fn read_tagged(path: &Path, file_type: FileType) -> Result<(TaggedFile, ParsingMode), Refusal> {
    match probe(path, file_type, None, ParsingMode::Strict)? {
        Ok(tagged) => Ok((tagged, ParsingMode::Strict)),
        Err(error) if !in_id3v1(&error) => Err(unreadable(&error)),
        Err(_) => {
            let len = fs::metadata(path).map_err(|e| failed(&e))?.len();
            probe(
                path,
                file_type,
                Some(len.saturating_sub(ID3V1_SIZE)),
                ParsingMode::Strict,
            )?
            .map_err(|e| unreadable(&e))?;
            let tagged = probe(path, file_type, None, ParsingMode::BestAttempt)?
                .map_err(|e| unreadable(&e))?;
            Ok((tagged, ParsingMode::BestAttempt))
        }
    }
}

/// One lofty read of the file, of its first `len` bytes when given.
fn probe(
    path: &Path,
    file_type: FileType,
    len: Option<u64>,
    mode: ParsingMode,
) -> Result<Result<TaggedFile, lofty::error::FileParseError>, Refusal> {
    let file = fs::File::open(path).map_err(|e| in_use_or_failed(&e))?;
    let len = match len {
        Some(len) => len,
        None => file.metadata().map_err(|e| failed(&e))?.len(),
    };
    let reader = Cut {
        inner: io::BufReader::new(file),
        len,
        pos: 0,
    };
    lofty_safely(|| {
        Probe::with_file_type(reader, file_type)
            .options(parse_options(mode))
            .read()
    })
}

/// Whether lofty stopped on an ID3v1 block.
fn in_id3v1(error: &dyn std::error::Error) -> bool {
    let id3v1 = format!("failed to parse {:?} tag", TagType::Id3v1);
    let mut cause = Some(error);
    while let Some(e) = cause {
        if e.to_string() == id3v1 {
            return true;
        }
        cause = e.source();
    }
    false
}

/// A file read as if it ended `len` bytes in: without its last block.
struct Cut<R> {
    inner: R,
    len: u64,
    pos: u64,
}

impl<R: io::Read> io::Read for Cut<R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let left = usize::try_from(self.len.saturating_sub(self.pos)).unwrap_or(usize::MAX);
        let end = left.min(buf.len());
        let n = self.inner.read(&mut buf[..end])?;
        self.pos += u64::try_from(n).unwrap_or(u64::MAX);
        Ok(n)
    }
}

impl<R: Seek> Seek for Cut<R> {
    fn seek(&mut self, to: io::SeekFrom) -> io::Result<u64> {
        let target = match to {
            io::SeekFrom::Start(n) => Some(n),
            io::SeekFrom::End(delta) => self.len.checked_add_signed(delta),
            io::SeekFrom::Current(delta) => self.pos.checked_add_signed(delta),
        }
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "seek out of the file"))?;
        self.pos = self.inner.seek(io::SeekFrom::Start(target))?;
        Ok(self.pos)
    }
}

/// Runs lofty, a panic caught as damaged content.
fn lofty_safely<T>(run: impl FnOnce() -> T) -> Result<T, Refusal> {
    catch_unwind(AssertUnwindSafe(run)).map_err(|_| Refusal::Damaged)
}

/// Reads the file as `$file`, writes the values into its first block of tags
/// (made from the `$seed` blocks when missing) and into each other block
/// there, then saves it.
macro_rules! edit_file {
    ($file:ty, $io:ident, $mode:ident, $values:ident,
     first: $remove:ident / $set:ident as $tag_type:expr, seeded from [$($seed:ident),*],
     others: [$($remove_other:ident / $set_other:ident),*]) => {{
        let mut f = <$file>::read_from($io, parse_options($mode)).map_err(|e| unreadable(&e))?;
        let first = f
            .$remove()
            .unwrap_or_else(|| seed($tag_type, [$(f.$seed().map(to_tag)),*]).into());
        f.$set(edited(first, $values));
        $(
            if let Some(tag) = f.$remove_other() {
                f.$set_other(edited(tag, $values));
            }
        )*
        save(&f, $io)
    }};
}

/// The same for an Ogg file, whose Vorbis comments are always there.
macro_rules! edit_ogg {
    ($file:ty, $io:ident, $mode:ident, $values:ident) => {{
        let mut f = <$file>::read_from($io, parse_options($mode)).map_err(|e| unreadable(&e))?;
        let tag = f.remove_vorbis_comments();
        f.set_vorbis_comments(edited(tag, $values));
        save(&f, $io)
    }};
}

/// Writes `values` into every block of tags of the file, the first one
/// made from the others when missing.
fn edit_blocks(
    io: &mut fs::File,
    file_type: FileType,
    mode: ParsingMode,
    values: &Values,
) -> Result<(), Refusal> {
    lofty_safely(|| match file_type {
        FileType::Mpeg => edit_file!(MpegFile, io, mode, values,
            first: remove_id3v2 / set_id3v2 as TagType::Id3v2, seeded from [id3v1, ape],
            others: [remove_id3v1 / set_id3v1, remove_ape / set_ape]),
        FileType::Aac => edit_file!(AacFile, io, mode, values,
            first: remove_id3v2 / set_id3v2 as TagType::Id3v2, seeded from [id3v1],
            others: [remove_id3v1 / set_id3v1]),
        FileType::Flac => edit_file!(FlacFile, io, mode, values,
            first: remove_vorbis_comments / set_vorbis_comments as TagType::VorbisComments,
            seeded from [id3v2],
            others: [remove_id3v2 / set_id3v2]),
        FileType::Mp4 => edit_file!(Mp4File, io, mode, values,
            first: remove_ilst / set_ilst as TagType::Mp4Ilst, seeded from [],
            others: []),
        FileType::Wav => edit_file!(WavFile, io, mode, values,
            first: remove_id3v2 / set_id3v2 as TagType::Id3v2, seeded from [riff_info],
            others: [remove_riff_info / set_riff_info]),
        FileType::Aiff => edit_file!(AiffFile, io, mode, values,
            first: remove_id3v2 / set_id3v2 as TagType::Id3v2, seeded from [text_chunks],
            others: [remove_text_chunks / set_text_chunks]),
        FileType::WavPack => edit_file!(WavPackFile, io, mode, values,
            first: remove_ape / set_ape as TagType::Ape, seeded from [id3v1],
            others: [remove_id3v1 / set_id3v1]),
        FileType::Ape => edit_file!(ApeFile, io, mode, values,
            first: remove_ape / set_ape as TagType::Ape, seeded from [id3v2, id3v1],
            others: [remove_id3v2 / set_id3v2, remove_id3v1 / set_id3v1]),
        FileType::Mpc => edit_file!(MpcFile, io, mode, values,
            first: remove_ape / set_ape as TagType::Ape, seeded from [id3v2, id3v1],
            others: [remove_id3v2 / set_id3v2, remove_id3v1 / set_id3v1]),
        FileType::Vorbis => edit_ogg!(VorbisFile, io, mode, values),
        FileType::Opus => edit_ogg!(OpusFile, io, mode, values),
        FileType::Speex => edit_ogg!(SpeexFile, io, mode, values),
        _ => Err(Refusal::Unsupported),
    })?
}

/// A block of tags as a generic `Tag`, to seed the first block from.
fn to_tag<T: Clone + Into<Tag>>(tag: &T) -> Tag {
    tag.clone().into()
}

/// The first block of a file that has none: the text of the first other
/// block (not its pictures, which stay where they are), or nothing.
fn seed<const N: usize>(tag_type: TagType, others: [Option<Tag>; N]) -> Tag {
    others.into_iter().flatten().next().map_or_else(
        || Tag::new(tag_type),
        |other| retyped(tag_type, other.items()),
    )
}

/// `items` as a block of `tag_type`, without the ones it cannot hold. The
/// year of an ID3v1 block becomes a date, where the other blocks keep it.
fn retyped<'a>(tag_type: TagType, items: impl Iterator<Item = &'a TagItem>) -> Tag {
    let mut tag = Tag::new(tag_type);
    for item in items {
        if !tag.push(item.clone()) && item.key() == ItemKey::Year {
            tag.push(TagItem::new(ItemKey::RecordingDate, item.value().clone()));
        }
    }
    tag
}

/// A block of tags with values written in.
trait Edit: Sized {
    fn edited(self, values: &Values) -> Self;
}

/// `tag` with `values` written in: lofty keeps aside what a generic `Tag`
/// cannot hold, and puts it back.
fn split_edited<T>(tag: T, values: &Values) -> T
where
    T: SplitTag,
    T::Remainder: MergeTag<Merged = T>,
{
    let (rest, mut generic) = tag.split_tag();
    apply(&mut generic, values);
    rest.merge_tag(generic)
}

macro_rules! split_edit {
    ($($tag:ty),*) => {
        $(
            impl Edit for $tag {
                fn edited(self, values: &Values) -> Self {
                    split_edited(self, values)
                }
            }
        )*
    };
}

split_edit!(
    Id3v2Tag,
    Id3v1Tag,
    ApeTag,
    Ilst,
    RiffInfoList,
    AiffTextChunks
);

/// lofty turns an ENCODER field into the vendor string of Vorbis comments,
/// and the vendor string is lost: both are kept aside here.
impl Edit for VorbisComments {
    fn edited(mut self, values: &Values) -> Self {
        let vendor = self.vendor().to_owned();
        let encoders: Vec<String> = self.remove("ENCODER").collect();
        let mut edited = split_edited(self, values);
        edited.set_vendor(vendor);
        for encoder in encoders {
            edited.push("ENCODER".to_owned(), encoder);
        }
        edited
    }
}

fn edited<T: Edit>(tag: T, values: &Values) -> T {
    tag.edited(values)
}

/// Sets each item of `values` in `tag`. An item the block cannot hold
/// (an album artist in ID3v1) is left out of it.
fn apply(tag: &mut Tag, values: &Values) {
    for (key, list) in &values.0 {
        let item = key.item();
        tag.remove_key(item);
        for value in list {
            tag.push(TagItem::new(item, ItemValue::Text(value.clone())));
        }
    }
}

fn save<F: AudioFile>(audio: &F, file: &mut fs::File) -> Result<(), Refusal> {
    file.rewind().map_err(|e| failed(&e))?;
    audio
        .save_to(file, write_options())
        .map_err(|e| Refusal::Failed {
            message: track::classify(&e).error.message,
        })
}

/// The text items of the block Kanade reads (the first, else the first
/// found), as that block: no pictures, no copy of a cover.
fn text_of(file: &TaggedFile) -> Tag {
    let tag_type = file.primary_tag_type();
    file.primary_tag().or_else(|| file.first_tag()).map_or_else(
        || Tag::new(tag_type),
        |found| retyped(tag_type, found.items()),
    )
}

/// The copy is the file with the new values, and nothing else changed:
/// the same audio, every block of tags still there with its other items and
/// its pictures, and the new values read as Kanade reads them.
fn check(before: &TaggedFile, after: &TaggedFile, values: &Values) -> Result<(), Refusal> {
    let differs = |what: &str| {
        Err(Refusal::Failed {
            message: format!("the copy written differs: {what}"),
        })
    };
    // Not the bitrate: lofty estimates it from the file's size (Opus), which
    // the tags change. The audio bytes themselves are compared by the tests.
    let audio = |file: &TaggedFile| {
        let p = file.properties();
        (
            p.duration(),
            p.sample_rate(),
            p.bit_depth(),
            p.channels(),
            p.channel_mask(),
        )
    };
    if audio(before) != audio(after) {
        return differs("audio properties");
    }
    let touched = values.touched();
    for tag in before.tags() {
        let Some(written) = after.tag(tag.tag_type()) else {
            // A block left with nothing (its last field removed) is not
            // written at all: nothing of it is lost.
            if kept_items(tag, &touched).is_empty() && tag.pictures().is_empty() {
                continue;
            }
            return differs("a block of tags is missing");
        };
        if !same(kept_items(tag, &touched), kept_items(written, &touched)) {
            return differs("items not edited");
        }
        if !same(
            tag.pictures().iter().collect(),
            written.pictures().iter().collect(),
        ) {
            return differs("pictures");
        }
    }
    let primary = before.primary_tag_type();
    if after
        .tags()
        .iter()
        .any(|t| t.tag_type() != primary && before.tag(t.tag_type()).is_none())
    {
        return differs("a block of tags was added");
    }
    let mut expected = text_of(before);
    apply(&mut expected, values);
    if shown(&expected) != shown(&text_of(after)) {
        return differs("the new values");
    }
    Ok(())
}

fn kept_items<'a>(tag: &'a Tag, touched: &[ItemKey]) -> Vec<&'a TagItem> {
    tag.items()
        .filter(|i| !touched.contains(&i.key()))
        .collect()
}

/// The same items, in any order.
fn same<T: PartialEq>(left: Vec<T>, mut right: Vec<T>) -> bool {
    for item in left {
        match right.iter().position(|r| *r == item) {
            Some(at) => {
                right.swap_remove(at);
            }
            None => return false,
        }
    }
    right.is_empty()
}

/// What Kanade shows of a block of tags.
fn shown(tag: &Tag) -> Track {
    let mut track = Track::bare(
        String::new(),
        FileStamp {
            size: 0,
            modified_ms: 0,
        },
    );
    track::fill_from_tag(&mut track, tag);
    track
}

fn unreadable(error: &dyn std::error::Error) -> Refusal {
    refusal_of(track::classify(error))
}

fn refusal_of(failure: track::ParseFailure) -> Refusal {
    if failure.allocation {
        Refusal::TooBig
    } else if failure.error.kind.retry() {
        Refusal::Failed {
            message: failure.error.message,
        }
    } else {
        Refusal::Damaged
    }
}

fn failed(error: &io::Error) -> Refusal {
    Refusal::Failed {
        message: error.to_string(),
    }
}

fn gone_or_failed(error: &io::Error) -> Refusal {
    if error.kind() == io::ErrorKind::NotFound {
        Refusal::Gone
    } else {
        failed(error)
    }
}

/// Windows' sharing and lock violations: another program has the file.
const SHARING_VIOLATION: i32 = 32;
const LOCK_VIOLATION: i32 = 33;

fn in_use_or_failed(error: &io::Error) -> Refusal {
    match error.raw_os_error() {
        Some(SHARING_VIOLATION | LOCK_VIOLATION) => Refusal::InUse,
        _ => gone_or_failed(error),
    }
}

/// Windows refuses to replace a file another program opened without
/// letting it be deleted.
fn not_replaced(error: &io::Error) -> Refusal {
    if error.kind() == io::ErrorKind::PermissionDenied {
        Refusal::InUse
    } else {
        in_use_or_failed(error)
    }
}

#[cfg(test)]
mod tests;
