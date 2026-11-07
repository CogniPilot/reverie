use super::*;
struct Opening {
    capture: bool,
    atomic: bool,
    name: Option<Vec<u32>>,
    add: u32,
    remove: u32,
}
impl Parser {
    pub(super) fn group(&mut self) -> Result<()> {
        let start = self.cursor.position() - 1;
        let verbose = self.frame().verbose;
        let mut opening = Opening {
            capture: true,
            atomic: false,
            name: None,
            add: 0,
            remove: 0,
        };
        if self.cursor.eat(b'?')? && self.extension(start, verbose, &mut opening)? {
            return Ok(());
        }
        let number = if opening.capture {
            Some(self.capture_group(opening.name)?)
        } else {
            None
        };
        let verbose = (verbose || opening.add & VERBOSE != 0) && opening.remove & VERBOSE == 0;
        self.open(
            Kind::Group {
                number,
                add: opening.add,
                remove: opening.remove,
                atomic: opening.atomic,
            },
            start,
            verbose,
        );
        Ok(())
    }
    fn extension(&mut self, start: usize, verbose: bool, opening: &mut Opening) -> Result<bool> {
        let token = self
            .cursor
            .take()?
            .ok_or_else(|| self.cursor.error("unexpected end of pattern", 0))?;
        match token {
            Token::Char(80) => return self.named_group(opening),
            Token::Char(58) => opening.capture = false,
            Token::Char(35) => {
                self.comment(start)?;
                return Ok(true);
            }
            Token::Char(61 | 33 | 60) => {
                self.assert_group(token, start, verbose)?;
                return Ok(true);
            }
            Token::Char(40) => {
                self.conditional(start, verbose)?;
                return Ok(true);
            }
            Token::Char(62) => {
                opening.capture = false;
                opening.atomic = true;
            }
            token if super::flags::flag(token).is_some() || token.is(b'-') => {
                return self.inline_flags(token, start, opening);
            }
            token => return Err(self.unknown_extension("unknown extension ?", token, 1)),
        }
        Ok(false)
    }
    fn unknown_extension(&self, prefix: &str, token: Token, offset: usize) -> RegexError {
        let mut message = prefix.chars().map(u32::from).collect::<Vec<_>>();
        message.extend(token.points());
        self.cursor.error_points(message, token.len() + offset)
    }
    fn named_group(&mut self, opening: &mut Opening) -> Result<bool> {
        if self.cursor.eat(b'<')? {
            let name = self.cursor.until(b'>', "group name")?;
            self.group_name(&name, 1)?;
            opening.name = Some(name);
            return Ok(false);
        }
        if self.cursor.eat(b'=')? {
            let name = self.cursor.until(b')', "group name")?;
            self.group_name(&name, 1)?;
            let group = self.named_reference(&name)?;
            if self.parsed.groups[group].is_none() {
                return Err(self
                    .cursor
                    .error("cannot refer to an open group", name.len() + 1));
            }
            self.check_behind(group)?;
            self.append(Node::Reference(group));
            return Ok(true);
        }
        let next = self
            .cursor
            .take()?
            .ok_or_else(|| self.cursor.error("unexpected end of pattern", 0))?;
        Err(self.unknown_extension("unknown extension ?P", next, 2))
    }
    fn named_reference(&self, name: &[u32]) -> Result<usize> {
        self.names.get(name).copied().ok_or_else(|| {
            self.cursor.error(
                &format!("unknown group name {}", facts::quoted(name)),
                name.len() + 1,
            )
        })
    }
    fn comment(&mut self, start: usize) -> Result<()> {
        loop {
            if self.cursor.next.is_none() {
                return Err(self.cursor.error(
                    "missing ), unterminated comment",
                    self.cursor.position() - start,
                ));
            }
            if self.cursor.take()?.unwrap().is(b')') {
                return Ok(());
            }
        }
    }
    fn assert_group(&mut self, token: Token, start: usize, verbose: bool) -> Result<()> {
        let (negative, behind) = if token.is(b'<') {
            let next = self
                .cursor
                .take()?
                .ok_or_else(|| self.cursor.error("unexpected end of pattern", 0))?;
            if !next.is(b'=') && !next.is(b'!') {
                return Err(self.unknown_extension("unknown extension ?<", next, 2));
            }
            (next.is(b'!'), true)
        } else {
            (token.is(b'!'), false)
        };
        let previous = self.lookbehind;
        if behind && previous.is_none() {
            self.lookbehind = Some(self.parsed.groups.len());
        }
        self.open(
            Kind::Assert {
                negative,
                behind,
                previous,
            },
            start,
            verbose,
        );
        Ok(())
    }
    fn conditional(&mut self, start: usize, verbose: bool) -> Result<()> {
        let name = self.cursor.until(b')', "group name")?;
        let group = if name.iter().all(|point| matches!(point, 48..=57)) {
            self.conditional_group(&name)?
        } else {
            self.group_name(&name, 1)?;
            self.named_reference(&name)?
        };
        self.check_behind(group)?;
        self.open(Kind::Conditional(group), start, verbose);
        Ok(())
    }
    fn inline_flags(&mut self, token: Token, start: usize, opening: &mut Opening) -> Result<bool> {
        let Some((add, remove)) = self.flags(token)? else {
            if self.frames.len() != 1
                || self.frame().branches.len() != 1
                || !self.parsed.arena[self.current()].nodes.is_empty()
            {
                return Err(self.cursor.error(
                    "global flags not at the start of the expression",
                    self.cursor.position() - start,
                ));
            }
            self.frames.last_mut().unwrap().verbose = self.parsed.flags & VERBOSE != 0;
            return Ok(true);
        };
        opening.add = add;
        opening.remove = remove;
        opening.capture = false;
        Ok(false)
    }
    fn capture_group(&mut self, name: Option<Vec<u32>>) -> Result<usize> {
        let group = self.parsed.groups.len();
        self.parsed.groups.push(None);
        if self.parsed.groups.len() > MAX_GROUPS {
            return Err(self.plain_error("too many groups", "PatternError"));
        }
        let Some(name) = name else { return Ok(group) };
        if let Some(previous) = self.names.get(&name) {
            return Err(self.cursor.error(
                &format!(
                    "redefinition of group name {} as group {group}; was group {previous}",
                    facts::quoted(&name)
                ),
                name.len() + 1,
            ));
        }
        self.names.insert(name, group);
        Ok(group)
    }
    fn conditional_group(&mut self, name: &[u32]) -> Result<usize> {
        if name.len() > 4300 {
            return Err(self.plain_error(&format!("Exceeds the limit (4300 digits) for integer string conversion: value has {} digits; use sys.set_int_max_str_digits() to increase the limit",name.len()),"ValueError"));
        }
        let significant = name
            .iter()
            .copied()
            .skip_while(|&point| point == 48)
            .collect::<Vec<_>>();
        if significant.is_empty() {
            return Err(self.cursor.error("bad group number", name.len() + 1));
        }
        let group = significant.iter().try_fold(0usize, |value, &point| {
            value.checked_mul(10)?.checked_add((point - 48) as usize)
        });
        let Some(group) = group.filter(|&group| group < MAX_GROUPS) else {
            let digits = significant
                .iter()
                .map(|&point| char::from_u32(point).unwrap())
                .collect::<String>();
            return Err(self
                .cursor
                .error(&format!("invalid group reference {digits}"), name.len() + 1));
        };
        if !self
            .conditional_positions
            .iter()
            .any(|&(saved, _)| saved == group)
        {
            self.conditional_positions
                .push((group, self.cursor.position() - name.len() - 1));
        }
        Ok(group)
    }
}
