use crate::{
    ast::*,
    error::{RegexError, Result},
    facts,
};
use rustpython_sre_engine::{SreAtCode as At, SreCatCode as Cat, SreOpcode as Op};
use std::{collections::BTreeSet, sync::Arc};
mod emit;
mod info;
enum Task<'a> {
    Sequence(Sub, u32),
    Node(&'a Node, u32),
    Word(u32),
    Patch(usize, usize),
    Branch(&'a [Sub], usize, u32, Vec<usize>),
    BranchEnd(&'a [Sub], usize, u32, Vec<usize>, usize),
    ConditionalEnd(usize, Option<Sub>, u32),
}
struct Compiler<'a> {
    parsed: &'a Parsed,
    source: &'a Arc<[u32]>,
    code: Vec<u32>,
    tasks: Vec<Task<'a>>,
}
pub(crate) fn compile(parsed: &Parsed, source: &Arc<[u32]>) -> Result<Vec<u32>> {
    let mut compiler = Compiler {
        parsed,
        source,
        code: info::compile(parsed),
        tasks: vec![Task::Sequence(parsed.root, parsed.flags)],
    };
    while let Some(task) = compiler.tasks.pop() {
        compiler.step(task)?;
    }
    compiler.code.push(Op::SUCCESS as u32);
    Ok(compiler.code)
}
impl<'a> Compiler<'a> {
    fn step(&mut self, task: Task<'a>) -> Result<()> {
        match task {
            Task::Word(word) => self.code.push(word),
            Task::Patch(index, extra) => patch(&mut self.code, index, extra, self.source)?,
            Task::Sequence(sub, flags) => self.tasks.extend(
                self.parsed.arena[sub]
                    .nodes
                    .iter()
                    .rev()
                    .map(|node| Task::Node(node, flags)),
            ),
            Task::Branch(branches, index, flags, tails) => {
                self.branch(branches, index, flags, tails)?
            }
            Task::BranchEnd(branches, index, flags, mut tails, skip) => {
                self.code.push(Op::JUMP as u32);
                tails.push(self.code.len());
                self.code.push(0);
                patch(&mut self.code, skip, 0, self.source)?;
                self.tasks
                    .push(Task::Branch(branches, index + 1, flags, tails));
            }
            Task::ConditionalEnd(skip, no, flags) => self.conditional_end(skip, no, flags)?,
            Task::Node(node, flags) => self.node(node, flags)?,
        }
        Ok(())
    }
    fn branch(
        &mut self,
        branches: &'a [Sub],
        index: usize,
        flags: u32,
        tails: Vec<usize>,
    ) -> Result<()> {
        if index == branches.len() {
            self.code.push(Op::FAILURE as u32);
            for tail in tails {
                patch(&mut self.code, tail, 0, self.source)?;
            }
            return Ok(());
        }
        let skip = self.code.len();
        self.code.push(0);
        self.tasks
            .push(Task::BranchEnd(branches, index, flags, tails, skip));
        self.tasks.push(Task::Sequence(branches[index], flags));
        Ok(())
    }
    fn conditional_end(&mut self, skip: usize, no: Option<Sub>, flags: u32) -> Result<()> {
        if let Some(no) = no {
            self.code.push(Op::JUMP as u32);
            let tail = self.code.len();
            self.code.push(0);
            patch(&mut self.code, skip, 1, self.source)?;
            self.tasks.push(Task::Patch(tail, 0));
            self.tasks.push(Task::Sequence(no, flags));
        } else {
            patch(&mut self.code, skip, 0, self.source)?;
        }
        Ok(())
    }
}
fn patch(code: &mut [u32], index: usize, extra: usize, source: &Arc<[u32]>) -> Result<()> {
    code[index] = u32::try_from(code.len() - index + extra).map_err(|_| {
        RegexError::new(source, "regular expression code size limit exceeded", None)
    })?;
    Ok(())
}
fn lower(point: u32, flags: u32) -> u32 {
    if flags & UNICODE != 0 {
        facts::lower(point)
    } else if matches!(point, 65..=90) {
        point + 32
    } else {
        point
    }
}
fn literal(code: &mut Vec<u32>, point: u32, negate: bool, flags: u32) {
    if flags & IGNORE == 0 {
        code.push(if negate { Op::NOT_LITERAL } else { Op::LITERAL } as u32);
        code.push(point);
        return;
    }
    let lo = lower(point, flags);
    let cased = if flags & UNICODE != 0 {
        lo != point || facts::upper(point) != point
    } else {
        matches!(point,65..=90|97..=122)
    };
    if !cased {
        code.push(if negate { Op::NOT_LITERAL } else { Op::LITERAL } as u32);
        code.push(point);
        return;
    }
    if flags & UNICODE != 0 && !facts::extra(lo).is_empty() {
        let mut members = vec![Member::Literal(point)];
        members.extend(facts::extra(lo).iter().copied().map(Member::Literal));
        class(code, negate, &members, flags);
        return;
    }
    code.push(match (negate, flags & UNICODE != 0) {
        (false, true) => Op::LITERAL_UNI_IGNORE,
        (true, true) => Op::NOT_LITERAL_UNI_IGNORE,
        (false, false) => Op::LITERAL_IGNORE,
        (true, false) => Op::NOT_LITERAL_IGNORE,
    } as u32);
    code.push(lo);
}
fn category(category: Category, unicode: bool) -> Cat {
    match (category, unicode) {
        (Category::Digit, false) => Cat::DIGIT,
        (Category::NotDigit, false) => Cat::NOT_DIGIT,
        (Category::Space, false) => Cat::SPACE,
        (Category::NotSpace, false) => Cat::NOT_SPACE,
        (Category::Word, false) => Cat::WORD,
        (Category::NotWord, false) => Cat::NOT_WORD,
        (Category::Digit, true) => Cat::UNI_DIGIT,
        (Category::NotDigit, true) => Cat::UNI_NOT_DIGIT,
        (Category::Space, true) => Cat::UNI_SPACE,
        (Category::NotSpace, true) => Cat::UNI_NOT_SPACE,
        (Category::Word, true) => Cat::UNI_WORD,
        (Category::NotWord, true) => Cat::UNI_NOT_WORD,
    }
}
fn folded(points: &mut BTreeSet<u32>, point: u32, flags: u32) {
    let point = lower(point, flags);
    points.insert(point);
    if flags & UNICODE != 0 {
        points.extend(facts::extra(point));
    }
}
fn class(code: &mut Vec<u32>, negate: bool, members: &[Member], flags: u32) {
    let ignore = flags & IGNORE != 0;
    let unicode = flags & UNICODE != 0;
    code.push(if !ignore {
        Op::IN
    } else if unicode {
        Op::IN_UNI_IGNORE
    } else {
        Op::IN_IGNORE
    } as u32);
    let skip = code.len();
    code.push(0);
    if negate {
        code.push(Op::NEGATE as u32);
    }
    let mut points = BTreeSet::new();
    let mut tail = Vec::new();
    let range_opcode = if unicode {
        Op::RANGE_UNI_IGNORE
    } else {
        Op::RANGE
    } as u32;
    for member in members {
        match *member {
            Member::Literal(point) => {
                if ignore {
                    folded(&mut points, point, flags)
                } else {
                    points.insert(point);
                }
            }
            Member::Category(value) => {
                tail.push(Op::CATEGORY as u32);
                tail.push(category(value, unicode) as u32);
            }
            Member::Range(lo, hi) => {
                if !ignore {
                    tail.extend([Op::RANGE as u32, lo, hi]);
                    continue;
                }
                let boundary = if unicode { 65536 } else { 256 };
                for point in lo..=hi.min(boundary - 1) {
                    folded(&mut points, point, flags);
                }
                if hi >= boundary {
                    tail.extend([range_opcode, lo.max(boundary), hi]);
                }
            }
        }
    }
    let mut intervals: Vec<(u32, u32)> = Vec::new();
    for point in points {
        if let Some((_, end)) = intervals.last_mut()
            && *end + 1 == point
        {
            *end = point;
            continue;
        }
        intervals.push((point, point));
    }
    for (start, end) in intervals {
        if start == end {
            code.extend([Op::LITERAL as u32, start]);
        } else {
            code.extend([Op::RANGE as u32, start, end]);
        }
    }
    code.extend(tail);
    code.push(Op::FAILURE as u32);
    code[skip] = (code.len() - skip) as u32;
}
