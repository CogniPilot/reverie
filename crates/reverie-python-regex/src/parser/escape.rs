use super::*;
fn decimal(point: u32) -> bool {
    matches!(point, 48..=57)
}
fn octal(point: u32) -> bool {
    matches!(point, 48..=55)
}
fn hex(point: u32) -> bool {
    matches!(point,48..=57|65..=70|97..=102)
}
fn digits(points: &[u32], base: u32) -> u32 {
    points.iter().fold(0, |value, &point| {
        value * base
            + match point {
                48..=57 => point - 48,
                65..=70 => point - 65 + 10,
                97..=102 => point - 97 + 10,
                _ => unreachable!("validated digit"),
            }
    })
}
impl Parser {
    pub(super) fn escape(&mut self, point: u32, in_class: bool) -> Result<Node> {
        let literal = match point {
            97 => Some(7),
            98 if in_class => Some(8),
            102 => Some(12),
            110 => Some(10),
            114 => Some(13),
            116 => Some(9),
            118 => Some(11),
            92 => Some(92),
            _ => None,
        };
        if let Some(point) = literal {
            return Ok(Node::Literal(point));
        }
        let category = match point {
            100 => Some(Category::Digit),
            68 => Some(Category::NotDigit),
            115 => Some(Category::Space),
            83 => Some(Category::NotSpace),
            119 => Some(Category::Word),
            87 => Some(Category::NotWord),
            _ => None,
        };
        if let Some(category) = category {
            return Ok(Node::Class {
                negate: false,
                members: vec![Member::Category(category)],
            });
        }
        if !in_class {
            let anchor = match point {
                65 => Some(Anchor::BeginningString),
                90 => Some(Anchor::EndString),
                98 => Some(Anchor::Boundary),
                66 => Some(Anchor::NonBoundary),
                _ => None,
            };
            if let Some(anchor) = anchor {
                return Ok(Node::At(anchor));
            }
        }
        let mut spelling = vec![92, point];
        if matches!(point, 120 | 117 | 85) {
            return self.hex_escape(point, spelling);
        }
        if point == 78 {
            return self.named_escape();
        }
        if (in_class && octal(point)) || point == 48 {
            spelling.extend(self.cursor.while_chars(2, octal)?);
            let value = digits(&spelling[1..], 8);
            if value > 0o377 {
                return Err(self.octal_error(&spelling));
            }
            return Ok(Node::Literal(value));
        }
        if !in_class && decimal(point) {
            return self.numeric_escape(point, spelling);
        }
        if matches!(point,65..=90|97..=122) || (in_class && decimal(point)) {
            return Err(self.bad_escape(&spelling));
        }
        Ok(Node::Literal(point))
    }
    fn hex_escape(&mut self, point: u32, mut spelling: Vec<u32>) -> Result<Node> {
        let count = match point {
            120 => 2,
            117 => 4,
            _ => 8,
        };
        let tail = self.cursor.while_chars(count, hex)?;
        spelling.extend(&tail);
        if tail.len() != count {
            let mut message = "incomplete escape "
                .chars()
                .map(u32::from)
                .collect::<Vec<_>>();
            message.extend(spelling.iter().copied());
            return Err(self.cursor.error_points(message, spelling.len()));
        }
        let value = digits(&tail, 16);
        if value <= 0x10ffff {
            return Ok(Node::Literal(value));
        }
        Err(self.bad_escape(&spelling))
    }
    fn named_escape(&mut self) -> Result<Node> {
        if !self.cursor.eat(b'{')? {
            return Err(self.cursor.error("missing {", 0));
        }
        let name = self.cursor.until(b'}', "character name")?;
        let name_string = name
            .iter()
            .map(|&point| char::from_u32(point))
            .collect::<Option<String>>();
        if let Some(point) = name_string.as_deref().and_then(facts::named) {
            return Ok(Node::Literal(point));
        }
        Err(self.cursor.error(
            &format!("undefined character name {}", facts::quoted(&name)),
            name.len() + 4,
        ))
    }
    fn numeric_escape(&mut self, point: u32, mut spelling: Vec<u32>) -> Result<Node> {
        if let Some(Token::Char(next)) = self.cursor.next
            && decimal(next)
        {
            self.cursor.take()?;
            spelling.push(next);
            if octal(point)
                && octal(next)
                && let Some(Token::Char(third)) = self.cursor.next
                && octal(third)
            {
                self.cursor.take()?;
                spelling.push(third);
                let value = digits(&spelling[1..], 8);
                return self.checked_octal(value, &spelling);
            }
        }
        let group = digits(&spelling[1..], 10) as usize;
        if group >= self.parsed.groups.len() {
            return Err(self.cursor.error(
                &format!("invalid group reference {group}"),
                spelling.len() - 1,
            ));
        }
        if self.parsed.groups[group].is_none() {
            return Err(self
                .cursor
                .error("cannot refer to an open group", spelling.len()));
        }
        self.check_behind(group)?;
        Ok(Node::Reference(group))
    }
    fn bad_escape(&self, spelling: &[u32]) -> RegexError {
        let mut message = "bad escape ".chars().map(u32::from).collect::<Vec<_>>();
        message.extend_from_slice(spelling);
        self.cursor.error_points(message, spelling.len())
    }
    fn checked_octal(&self, value: u32, spelling: &[u32]) -> Result<Node> {
        if value > 0o377 {
            return Err(self.octal_error(spelling));
        }
        Ok(Node::Literal(value))
    }
    fn octal_error(&self, spelling: &[u32]) -> RegexError {
        let mut message = "octal escape value "
            .chars()
            .map(u32::from)
            .collect::<Vec<_>>();
        message.extend_from_slice(spelling);
        message.extend(" outside of range 0-0o377".chars().map(u32::from));
        self.cursor.error_points(message, spelling.len())
    }
}
