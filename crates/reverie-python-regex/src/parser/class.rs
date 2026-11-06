use super::*;
use std::collections::HashSet;
fn member(node: Node) -> Member {
    match node {
        Node::Literal(point) => Member::Literal(point),
        Node::Class { mut members, .. } => members.remove(0),
        _ => unreachable!("class escape returns literal/category"),
    }
}
impl Parser {
    pub(super) fn class(&mut self) -> Result<Node> {
        let here = self.cursor.position() - 1;
        let negate = self.cursor.eat(b'^')?;
        let mut members = Vec::new();
        loop {
            let Some(token) = self.cursor.take()? else {
                return Err(self
                    .cursor
                    .error("unterminated character set", self.cursor.position() - here));
            };
            if token.is(b']') && !members.is_empty() {
                break;
            }
            let first = match token {
                Token::Escape(point) => member(self.escape(point, true)?),
                Token::Char(point) => Member::Literal(point),
            };
            if !self.cursor.eat(b'-')? {
                members.push(first);
                continue;
            }
            if self.range(token, first, &mut members, here)? {
                break;
            }
        }
        let mut seen = HashSet::new();
        members.retain(|member| seen.insert(member.clone()));
        if let [Member::Literal(point)] = members.as_slice() {
            return Ok(if negate {
                Node::NotLiteral(*point)
            } else {
                Node::Literal(*point)
            });
        }
        Ok(Node::Class { negate, members })
    }
    fn range(
        &mut self,
        token: Token,
        first: Member,
        members: &mut Vec<Member>,
        here: usize,
    ) -> Result<bool> {
        let Some(that) = self.cursor.take()? else {
            return Err(self
                .cursor
                .error("unterminated character set", self.cursor.position() - here));
        };
        if that.is(b']') {
            members.push(first);
            members.push(Member::Literal(45));
            return Ok(true);
        }
        let second = match that {
            Token::Escape(point) => member(self.escape(point, true)?),
            Token::Char(point) => Member::Literal(point),
        };
        if let (Member::Literal(lo), Member::Literal(hi)) = (first, second)
            && hi >= lo
        {
            members.push(Member::Range(lo, hi));
            return Ok(false);
        }
        let mut message = "bad character range "
            .chars()
            .map(u32::from)
            .collect::<Vec<_>>();
        message.extend(token.points());
        message.push(45);
        message.extend(that.points());
        Err(self
            .cursor
            .error_points(message, token.len() + 1 + that.len()))
    }
}
