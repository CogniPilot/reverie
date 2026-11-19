use super::{
    INPUTS,
    transcript::{Kind, Transcript},
};
use crossterm::{
    cursor::MoveTo,
    event::{self, Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers},
    execute, queue,
    style::{Attribute, Color, Print, ResetColor, SetAttribute, SetForegroundColor},
    terminal::{self, Clear, ClearType, EnterAlternateScreen, LeaveAlternateScreen},
};
use nix::sys::termios::{self, LocalFlags, SetArg, Termios};
use std::{
    collections::VecDeque,
    fs::{File, OpenOptions},
    io::{self, ErrorKind, Write},
    os::unix::fs::OpenOptionsExt,
    time::Duration,
};
use unicode_width::UnicodeWidthChar;

pub(super) struct Screen {
    output: File,
    original: Termios,
    input: Vec<char>,
    cursor: usize,
    scroll: usize,
    rows: u16,
    transcript_key: Option<(u64, u16)>,
    transcript_lines: Vec<(Kind, String)>,
}

impl Screen {
    pub(super) fn open() -> io::Result<Self> {
        let output = OpenOptions::new()
            .write(true)
            .custom_flags(nix::libc::O_NONBLOCK | nix::libc::O_NOCTTY)
            .open("/proc/self/fd/1")?;
        let original = termios::tcgetattr(io::stdin())?;
        let mut input = original.clone();
        // Preserve the tty's signal handling so Ctrl+C also interrupts a
        // synchronous model request in the foreground application.
        input
            .local_flags
            .remove(LocalFlags::ICANON | LocalFlags::ECHO);
        termios::tcsetattr(io::stdin(), SetArg::TCSANOW, &input)?;
        let mut screen = Self {
            output,
            original,
            input: Vec::new(),
            cursor: 0,
            scroll: 0,
            rows: 0,
            transcript_key: None,
            transcript_lines: Vec::new(),
        };
        execute!(screen.output, EnterAlternateScreen)?;
        Ok(screen)
    }

    pub(super) fn refresh(
        &mut self,
        transcript: &mut Transcript,
        queued: &mut VecDeque<String>,
    ) -> io::Result<()> {
        for _ in 0..32 {
            if !event::poll(Duration::ZERO)? {
                break;
            }
            if let Event::Key(key) = event::read()? {
                self.key(key, transcript, queued);
            }
        }
        let (width, height) = terminal::size()?;
        let frame = self.frame(
            width.saturating_sub(1).max(1),
            height,
            transcript,
            queued.len(),
        )?;
        match self.output.write_all(&frame) {
            Err(error) if error.kind() == ErrorKind::WouldBlock => Ok(()),
            result => result,
        }
    }

    fn key(&mut self, key: KeyEvent, transcript: &mut Transcript, queued: &mut VecDeque<String>) {
        if key.kind == KeyEventKind::Release {
            return;
        }
        match key.code {
            KeyCode::Enter | KeyCode::Char('\n' | '\r') => self.submit(transcript, queued),
            KeyCode::Backspace if self.cursor > 0 => {
                self.cursor -= 1;
                self.input.remove(self.cursor);
            }
            KeyCode::Delete if self.cursor < self.input.len() => {
                self.input.remove(self.cursor);
            }
            KeyCode::Left => self.cursor = self.cursor.saturating_sub(1),
            KeyCode::Right => self.cursor = (self.cursor + 1).min(self.input.len()),
            KeyCode::Home => self.cursor = 0,
            KeyCode::End => {
                self.cursor = self.input.len();
                self.scroll = 0;
            }
            KeyCode::PageUp => self.scroll = self.scroll.saturating_add(self.scroll_step()),
            KeyCode::PageDown => self.scroll = self.scroll.saturating_sub(self.scroll_step()),
            KeyCode::Char('u') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                self.input.clear();
                self.cursor = 0;
            }
            KeyCode::Char(ch)
                if printable(ch)
                    && !key
                        .modifiers
                        .intersects(KeyModifiers::CONTROL | KeyModifiers::ALT)
                    && self.input.len() < transcript.settings.message_cap_chars =>
            {
                self.input.insert(self.cursor, ch);
                self.cursor += 1;
            }
            _ => (),
        }
    }

    fn scroll_step(&self) -> usize {
        usize::from(self.rows / 2).max(1)
    }

    fn submit(&mut self, transcript: &mut Transcript, queued: &mut VecDeque<String>) {
        let text = self.input.iter().collect::<String>();
        let text = text.trim();
        if text.is_empty() {
            return;
        }
        if queued.len() >= INPUTS {
            transcript.note("Input queue full; wait for the current reply.");
            return;
        }
        queued.push_back(text.to_owned());
        self.input.clear();
        self.cursor = 0;
        self.scroll = 0;
    }

    fn frame(
        &mut self,
        width: u16,
        height: u16,
        transcript: &Transcript,
        queued: usize,
    ) -> io::Result<Vec<u8>> {
        let mut frame = Vec::new();
        queue!(frame, Clear(ClearType::All), MoveTo(0, 0))?;
        if height < 6 {
            put(&mut frame, 0, width, &transcript.title())?;
            return Ok(frame);
        }
        self.rows = height - 6;
        queue!(frame, SetAttribute(Attribute::Bold))?;
        put(&mut frame, 0, width, &transcript.title())?;
        queue!(
            frame,
            SetAttribute(Attribute::Reset),
            SetForegroundColor(Color::Cyan)
        )?;
        put(&mut frame, 1, width, &transcript.model_line())?;
        queue!(frame, ResetColor)?;
        put(&mut frame, 2, width, &transcript.state_line())?;
        self.draw_transcript(&mut frame, width, transcript)?;
        put(
            &mut frame,
            height - 3,
            width,
            &format!(
                "Local prompt | queued {queued} | /help /status /clear /quit | PgUp/PgDn scroll"
            ),
        )?;
        let (input, column) = self.visible_input(width.saturating_sub(2));
        put(
            &mut frame,
            height - 2,
            width,
            &format!("> {}", transcript.clean(&input)),
        )?;
        let marker = if self.scroll > 0 { " [SCROLLED]" } else { "" };
        put(
            &mut frame,
            height - 1,
            width,
            &format!("Terminal prompts stay here; room replies appear above.{marker}"),
        )?;
        queue!(frame, MoveTo((2 + column).min(width - 1), height - 2))?;
        Ok(frame)
    }

    fn draw_transcript(
        &mut self,
        frame: &mut Vec<u8>,
        width: u16,
        transcript: &Transcript,
    ) -> io::Result<()> {
        let key = (transcript.revision, width);
        if self.transcript_key != Some(key) {
            self.transcript_lines.clear();
            for record in &transcript.records {
                let body = record.display_text();
                self.transcript_lines.extend(
                    wrapped(&body, width)
                        .into_iter()
                        .map(|line| (record.kind, line)),
                );
            }
            self.transcript_key = Some(key);
        }
        let rows = usize::from(self.rows);
        self.scroll = self
            .scroll
            .min(self.transcript_lines.len().saturating_sub(rows));
        let end = self.transcript_lines.len() - self.scroll;
        for (row, (kind, line)) in (3..).zip(&self.transcript_lines[end.saturating_sub(rows)..end])
        {
            match kind {
                Kind::Error => queue!(frame, SetForegroundColor(Color::Red))?,
                Kind::Reply => queue!(frame, SetForegroundColor(Color::Green))?,
                _ => (),
            }
            put(frame, row, width, line)?;
            queue!(frame, ResetColor)?;
        }
        Ok(())
    }

    fn visible_input(&self, width: u16) -> (String, u16) {
        let mut left = self.cursor;
        let mut cells = 0;
        while left > 0 {
            let next = cells + char_width(self.input[left - 1]);
            if next >= usize::from(width) {
                break;
            }
            left -= 1;
            cells = next;
        }
        (
            self.input[left..].iter().collect(),
            u16::try_from(cells).unwrap_or(width),
        )
    }
}

impl Drop for Screen {
    fn drop(&mut self) {
        let _ = termios::tcsetattr(io::stdin(), SetArg::TCSANOW, &self.original);
        let _ = execute!(self.output, ResetColor, LeaveAlternateScreen);
    }
}

fn printable(ch: char) -> bool {
    !ch.is_control() && !matches!(ch, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
}

fn char_width(ch: char) -> usize {
    ch.width().unwrap_or(0)
}

fn put(frame: &mut impl Write, row: u16, width: u16, text: &str) -> io::Result<()> {
    let mut remaining = usize::from(width);
    let visible = text
        .chars()
        .take_while(|&ch| {
            let cells = char_width(ch);
            if !printable(ch) || cells > remaining {
                return false;
            }
            remaining -= cells;
            true
        })
        .collect::<String>();
    queue!(frame, MoveTo(0, row), Print(visible))
}

fn wrapped(text: &str, width: u16) -> Vec<String> {
    let width = usize::from(width);
    let mut lines = Vec::new();
    for line in text.split('\n') {
        let mut part = String::new();
        let mut cells = 0;
        for ch in line.chars() {
            let span = char_width(ch);
            if span > width {
                continue;
            }
            if cells + span > width {
                lines.push(std::mem::take(&mut part));
                cells = 0;
            }
            part.push(ch);
            cells += span;
        }
        lines.push(part);
    }
    lines
}
