"""Legacy journal oracle and compatibility tests for the Hands turn adapter."""
import copy
import hashlib
import json
import math
from pathlib import Path
import re
import sqlite3
import sys
import tempfile
import time
import unittest
from unittest.mock import Mock

HANDS = Path(__file__).resolve().parents[2] / 'python/reverie/hands'
sys.path[:0] = [str(HANDS), str(HANDS.parents[1])]
import agent_journal as journal
journal_schema = journal
from agent_journal import encoded, uuid
from agent_loop import ChatNotFound
from reverie.instance import load_instance
from reverie.memory import MemoryStore


def digest(value):
    return hashlib.sha256(encoded(value).encode()).hexdigest()


def revision(message, room):
    """Legacy fingerprint for exercising the native capture against old SQLite data."""
    uuid(message.get('id'))
    at = message.get('at')
    if (message.get('roomId') != room or type(at) not in (int, float) or
            not math.isfinite(at) or at < 0 or not isinstance(message.get('text'), str)):
        raise ValueError('invalid journal source')
    return {'id': message['id'], 'at': at,
            'sha256': digest({'id': message['id'], 'at': at, 'roomId': room,
                              'text': message['text'], 'from': message.get('from')})}


# Recall ranks a pool of text matches the way generative-agent memories do (Park et al. 2023): relevance + recency +
# importance, each on a 0-1 scale, so a later decision is not buried under an older note that shares more words.
# Relevance is divided by the pool's best match (FTS rank has no fixed scale), so a weaker real match keeps proportional
# credit instead of dropping to zero; recency and importance are already 0-1, so entries saved minutes apart do not get
# an artificial full-point recency gap.
RECALL_POOL = 20
RECALL_LIMIT = 2
RECALL_HALF_LIFE_DAYS = 7
IMPORTANCE_WEIGHT = {'notable': 1 / 3, 'important': 2 / 3, 'keystone': 1.0}


def memory_scores(relevance, committed_ms, importance, now_ms):
    """One score per candidate: relevance as a share of the pool's best match (no positive best: 0), plus recency as
    a half-life decay (RECALL_HALF_LIFE_DAYS), plus the entry's own importance (unrated = 0)."""
    def scaled(values):
        best = max(values, default=0)
        return [max(0.0, v) / best if best > 0 else 0.0 for v in values]
    recency = [0.5 ** (max(0.0, now_ms - c) / 86400000 / RECALL_HALF_LIFE_DAYS) for c in committed_ms]
    weight = [IMPORTANCE_WEIGHT.get(i, 0.0) for i in importance]
    return [r + t + w for r, t, w in zip(scaled(relevance), recency, weight)]


class Journal:
    """Additive tables in an already validated own room-memory SQLite file."""
    def __init__(self, path):
        self.db = sqlite3.connect(str(path), timeout=1)
        self.db.row_factory = sqlite3.Row
        try:
            self.db.executescript('''
          CREATE TABLE IF NOT EXISTS hands_journal (
            id INTEGER PRIMARY KEY, turn_id TEXT UNIQUE NOT NULL,
            committed_ms REAL NOT NULL, payload_hash TEXT NOT NULL,
            payload TEXT NOT NULL, end_at REAL NOT NULL);
          CREATE VIRTUAL TABLE IF NOT EXISTS hands_journal_fts USING fts5(text);
          CREATE TABLE IF NOT EXISTS hands_journal_links (
            superseding_id INTEGER NOT NULL, target_id INTEGER NOT NULL,
            PRIMARY KEY(superseding_id,target_id));
          CREATE INDEX IF NOT EXISTS hands_journal_links_target ON hands_journal_links(target_id,superseding_id);

            ''')
        except BaseException:
            self.db.close()
            raise

    def close(self):
        self.db.close()

    def status(self):
        row = self.db.execute('SELECT id, turn_id, committed_ms, end_at FROM hands_journal ORDER BY id DESC LIMIT 1').fetchone()
        return dict(row) if row else None

    @staticmethod
    def index_text(draft):
        # A remembered phrase may occur only in the cited source after the agent
        # compresses/paraphrases its journal. These remain retrieval cues, not an
        # independent truth signal; the worker still rechecks current sources.
        original = draft['text'] + ' ' + ' '.join(draft['tags']) + ' ' + ' '.join(s['quote'] for s in draft['sources'])
        topics = draft.get('annotations', {}).get('topics', [])
        return original + (' ' + ' '.join(topics) if topics else '')

    def commit(self, draft, captured, previous_id, now_ms=None):
        now_ms = time.time() * 1000 if now_ms is None else now_ms
        if type(now_ms) not in (int, float) or not math.isfinite(now_ms) or now_ms < 0:
            raise ValueError('invalid commit clock')
        payload = {'draft': draft, 'snapshot': captured,
                   'classification': 'source-linked agent account; interpretation is not verified fact'}
        fingerprint = digest(payload)
        self.db.execute('BEGIN IMMEDIATE')
        try:
            old = self.db.execute('SELECT id, payload_hash FROM hands_journal WHERE turn_id=?',
                                  (captured['end']['id'],)).fetchone()
            if old:
                if old['payload_hash'] != fingerprint:
                    raise ValueError('same turn already committed different content')
                self.db.rollback()
                return {'status': 'committed', 'entry_id': old['id'], 'replayed': True}
            last = self.status()
            if (last['id'] if last else None) != previous_id:
                raise ValueError('journal checkpoint changed; read status again')
            if last and (captured['end']['at'], captured['end']['id']) <= (last['end_at'], last['turn_id']):
                raise ValueError('journal cursor must advance beyond prior source time')
            targets = draft.get('annotations', {}).get('supersedes', [])
            for target in targets + draft.get('annotations', {}).get('related', []):
                prior = self.db.execute('SELECT end_at,committed_ms FROM hands_journal WHERE id=?', (target,)).fetchone()
                if prior is None or prior['end_at'] > captured['end']['at'] or prior['committed_ms'] > now_ms:
                    raise ValueError('correction target must exist in this own room at an earlier point')
            row = self.db.execute('INSERT INTO hands_journal(turn_id, committed_ms, payload_hash, payload, end_at) VALUES(?,?,?,?,?)',
                                  (captured['end']['id'], now_ms, fingerprint, encoded(payload), captured['end']['at']))
            self.db.execute('INSERT INTO hands_journal_fts(rowid,text) VALUES(?,?)',
                            (row.lastrowid, self.index_text(draft)))
            self.db.executemany('INSERT INTO hands_journal_links(superseding_id,target_id) VALUES(?,?)',
                                [(row.lastrowid, target) for target in targets])
            self.db.commit()
            return {'status': 'committed', 'entry_id': row.lastrowid, 'replayed': False,
                    'coverage': captured['coverage'], 'semantic_review': 'not_performed'}
        except BaseException:
            self.db.rollback()
            raise

    def receipt(self, turn_id, expected_hash=None):
        """Read a single durable operation receipt; never return journal text.
        turn_id is the request message UUID, or an int entry_id in this room's journal."""
        key = 'entry_id' if type(turn_id) is int else 'turn_id'
        if key == 'entry_id' and not 0 < turn_id < 10 ** 9:
            raise ValueError('entry_id out of range')
        if key == 'turn_id':
            uuid(turn_id)
        if expected_hash is not None and (not isinstance(expected_hash, str) or
                not re.fullmatch('[0-9a-f]{64}', expected_hash)):
            raise ValueError('canonical payload hash required')
        row = self.db.execute('SELECT id,turn_id,committed_ms,payload_hash,payload FROM hands_journal WHERE ' +
                              ('id=?' if key == 'entry_id' else 'turn_id=?'), (turn_id,)).fetchone()
        if row is None:
            return {'status': 'not_found', key: turn_id,
                    'evidence': 'no matching receipt at lookup time; not proof an unknown write never happened'}
        if (hashlib.sha256(row['payload'].encode()).hexdigest() != row['payload_hash'] or
                expected_hash is not None and row['payload_hash'] != expected_hash):
            return {'status': 'conflict', key: turn_id}
        return {'status': 'committed', 'turn_id': row['turn_id'], 'entry_id': row['id'],
                'committed_ms': row['committed_ms'], 'payload_sha256': row['payload_hash'],
                'evidence': 'durable write receipt only; no semantic or current-source verification'}

    def recall(self, query, now_ms=None):
        if not isinstance(query, str) or not 1 <= len(query.strip()) <= 300:
            raise ValueError('bounded query required')
        tokens = re.findall(r'[^\W_]+', query, re.UNICODE)[:12]
        if not tokens:
            return []
        expression = ' OR '.join('"' + t.replace('"', '""') + '"' for t in tokens)
        rows = self.db.execute('''SELECT j.id,j.committed_ms,j.payload,rank FROM hands_journal_fts f
             JOIN hands_journal j ON j.id=f.rowid WHERE hands_journal_fts MATCH ?
             ORDER BY rank,j.id DESC LIMIT ?''', (expression, RECALL_POOL)).fetchall()
        entries = [dict(id=r['id'], committed_ms=r['committed_ms'], **json.loads(r['payload'])) for r in rows]
        now_ms = time.time() * 1000 if now_ms is None else now_ms
        scores = memory_scores([-r['rank'] for r in rows], [r['committed_ms'] for r in rows],
                               [e['draft'].get('annotations', {}).get('importance') for e in entries], now_ms)
        order = sorted(range(len(entries)), key=lambda i: (-scores[i], -entries[i]['id']))
        return [entries[i] for i in order[:RECALL_LIMIT]]


MAX_SOURCE_READS = 12
MAX_PAGE = 4
MAX_CORRECTIONS = 2
VIEW_BYTES = 12000


def decode(row):
    return dict(id=row['id'], committed_ms=row['committed_ms'], **json.loads(row['payload']))


class ReadModel:
    def __init__(self, journal, chat, room, as_of_ms=None):
        if as_of_ms is not None and (type(as_of_ms) not in (int,float) or not math.isfinite(as_of_ms) or as_of_ms < 0):
            raise ValueError('finite recorded-time cutoff required')
        self.journal, self.chat, self.room, self.as_of = journal, chat, room, as_of_ms
        self.sources = {}; self.source_reads = 0; self.omitted = False

    def checked(self, entry):
        """Source cache lasts only this one bounded operation, never across grants."""
        try:
            expected = {event['id']:event for event in entry['snapshot']['events']}
            if entry['snapshot']['room'] != self.room:raise ValueError('room mismatch')
            for source in entry['draft']['sources']:
                mid=source['id']
                if mid not in self.sources:
                    if self.source_reads >= MAX_SOURCE_READS:
                        self.omitted=True;return False
                    self.source_reads += 1
                    try:self.sources[mid]=revision(self.chat.exact_message(self.room,mid),self.room)
                    except Exception:self.sources[mid]=None
                if self.sources[mid] != expected[mid]:return False
            return True
        except (KeyError,TypeError,ValueError):return False

    def corrections(self, target):
        rows=self.journal.db.execute('''SELECT j.id,j.committed_ms,j.payload FROM hands_journal_links l
            JOIN hands_journal j ON j.id=l.superseding_id WHERE l.target_id=?
            AND (? IS NULL OR j.committed_ms<=?) ORDER BY j.id DESC LIMIT ?''',
            (target,self.as_of,self.as_of,MAX_CORRECTIONS+1)).fetchall()
        return [decode(row) for row in rows]

    def currentness(self, entry):
        later=self.corrections(entry['id'])
        if len(later)>MAX_CORRECTIONS:
            self.omitted=True;return 'unresolved',[]
        checked=[item['id'] for item in later if self.checked(item)]
        if checked:return 'superseded',checked
        if later:return 'unresolved',[]
        # Two independent corrections of the same target are competing accounts
        # until a subsequent correction explicitly supersedes both branches.
        targets=entry['draft'].get('annotations',{}).get('supersedes',[])
        for target in targets:
            siblings=self.corrections(target)
            if len(siblings)>MAX_CORRECTIONS:
                self.omitted=True;return 'unresolved',[]
            if any(s['id'] != entry['id'] and s['id'] not in targets for s in siblings):
                return 'unresolved',[]
        return 'current',[]

    def project(self, entries, current_only=False):
        result=[];seen=set();queue=[(entry,0)for entry in entries]
        while queue:
            entry,depth=queue.pop(0)
            if entry['id'] in seen:continue
            seen.add(entry['id'])
            if not self.checked(entry):self.omitted=True;continue
            state, superseded_by=self.currentness(entry)
            if current_only and state!='current':
                self.omitted=True
                if state=='superseded' and depth<2:
                    queue.extend((item,depth+1)for item in self.corrections(entry['id']) if item['id'] in superseded_by)
                continue
            draft=entry['draft'];annotations=draft.get('annotations',{})
            result.append(dict(entry=entry,currentness=state,superseded_by=superseded_by,
                view=dict(id=entry['id'],recorded_at_ms=entry['committed_ms'],occurred_at_ms=entry['snapshot']['end']['at'],
                    text=draft['text'],kinds=draft['tags'],topics=annotations.get('topics',[]),
                    importance=annotations.get('importance'),provenance=annotations.get('provenance','unknown'),
                    source_check='All cited revisions matched in this operation; this does not verify the interpretation',
                    source_ids=[s['id'] for s in draft['sources']],currentness=state,superseded_by=superseded_by,
                    related=annotations.get('related',[]))))
        return result

    def page(self, query='', before_id=None, snapshot_id=None):
        if not isinstance(query,str) or len(query)>300:raise ValueError('bounded query required')
        for value in (before_id,snapshot_id):
            if value is not None and (type(value) is not int or value<1):raise ValueError('positive entry cursor required')
        ceiling=self.journal.db.execute('SELECT max(id) FROM hands_journal').fetchone()[0] or 0
        ceiling=min(ceiling,snapshot_id) if snapshot_id is not None else ceiling
        tokens=re.findall(r'[^\W_]+',query,re.UNICODE)[:12]
        params=[ceiling,before_id,before_id,self.as_of,self.as_of]
        base='''SELECT j.id,j.committed_ms,j.payload FROM hands_journal j WHERE j.id<=?
                AND (? IS NULL OR j.id<?) AND (? IS NULL OR j.committed_ms<=?)'''
        if query.strip():
            if not tokens:rows=[]
            else:
                expression=' OR '.join('"'+t.replace('"','""')+'"'for t in tokens)
                base+=' AND j.id IN (SELECT rowid FROM hands_journal_fts WHERE hands_journal_fts MATCH ?)'
                params.append(expression)
                rows=self.journal.db.execute(base+' ORDER BY j.id DESC LIMIT ?',params+[MAX_PAGE+1]).fetchall()
        else:rows=self.journal.db.execute(base+' ORDER BY j.id DESC LIMIT ?',params+[MAX_PAGE+1]).fetchall()
        examined=rows[:MAX_PAGE];projected=self.project([decode(row)for row in examined])
        entries=[item['view'] for item in projected]
        # Counts are for this examined page after source validation, never private/global totals.
        tags={}
        for entry in entries:
            for tag in set(entry['topics']):tags.setdefault(tag,set()).add(entry['id'])
        edges=[];names=sorted(tags)
        for i,a in enumerate(names):
            for b in names[i+1:]:
                common=tags[a]&tags[b]
                if common:edges.append(dict(a=a,b=b,entry_ids=sorted(common),count=len(common)))
        value=dict(status='available',scope=self.room,entries=entries,
            tags=[dict(label=tag,count=len(tags[tag]),entry_ids=sorted(tags[tag]))for tag in names],edges=edges,
            coverage=dict(examined=len(examined),returned=len(entries),more=len(rows)>MAX_PAGE,
                          omitted_or_source_changed=self.omitted,meaning='bounded examined page only; no whole-history count'),
            cursor=dict(snapshot_id=ceiling,before_id=examined[-1]['id'])if len(rows)>MAX_PAGE and examined else None,
            as_of_recorded_ms=self.as_of)
        if len(journal_schema.encoded(value).encode())>VIEW_BYTES:
            # Return a truthful bound; never silently truncate an entry qualification.
            return dict(status='unavailable',scope=self.room,reason='projection_exceeds_byte_budget')
        return value


def checked_journal_recall(journal, chat, room, query, compact=False):
    """Same current-source checks for automatic and deliberate journal reads."""
    entries = []
    omitted = False
    model = ReadModel(journal, chat, room)
    projected = model.project(journal.recall(query), current_only=True)
    omitted = model.omitted
    for checked in projected:
        entry = checked['entry']
        if compact:
            item = {'entry_id': entry['id'], 'committed_ms': entry['committed_ms'],
                    'text': entry['draft']['text'], 'tags': entry['draft']['tags'],
                    'source_ids': [s['id'] for s in entry['draft']['sources']],
                    'provenance': entry['draft'].get('annotations', {}).get('provenance', 'unknown'),
                    'supersedes': entry['draft'].get('annotations', {}).get('supersedes', []),
                    'related': entry['draft'].get('annotations', {}).get('related', [])}
            candidate = {'status': 'available', 'scope': room, 'entries': entries + [item],
                         'omitted_or_source_changed': False}
            fits = len(journal_schema.encoded(candidate).encode()) <= journal_schema.CAPSULE_BYTES
        else:
            item = {'entry_id': entry['id'], 'committed_ms': entry['committed_ms'],
                    **entry['draft'], 'source_ids': [s['id'] for s in entry['draft']['sources']],
                    'provenance': entry['draft'].get('annotations', {}).get('provenance', 'unknown'),
                    'supersedes': entry['draft'].get('annotations', {}).get('supersedes', []),
                    'related': entry['draft'].get('annotations', {}).get('related', []),
                    'evidence': 'source revisions checked; interpretation not verified'}
            fits = len(journal_schema.encoded(entries + [item])) <= journal_schema.RESULT_CHARS - 200
        if not fits:
            omitted = True
            continue  # Keep complete entries; never truncate away a qualification.
        entries.append(item)
    return {'status': 'available', **({'scope': room} if compact else {}),
            'entries': entries, 'omitted_or_source_changed': omitted}


def source_refusal(chat, room, draft, captured, events):
    """Why the cited sources no longer verify for this save, or None when every one does."""
    selected = {s['id'] for s in draft['sources']} | {captured['end']['id']}
    for source_id in sorted(selected):
        try:
            actual = chat.exact_message(room, source_id)
        except ChatNotFound:  # the server says it is gone; a failed or timed-out read still raises
            return {'status': 'refused', 'reason': 'source_unavailable'}
        expected = captured['end'] if source_id == captured['end']['id'] else events[source_id]
        if revision(actual, room) != expected:
            return {'status': 'refused', 'reason': 'source_changed'}
        if any(s['quote'] not in actual['text'] for s in draft['sources'] if s['id'] == source_id):
            return {'status': 'refused', 'reason': 'quote_not_in_source'}
    return None


def require_room(chat, room):
    journal_schema.uuid(room)
    for listed in chat.member_rooms():
        if listed.get('id') != room:
            continue
        # Current ordinary rooms omit kind and identify their visibility and members.
        if ('kind' not in listed and not listed.get('dm') and
                listed.get('visibility') in ('public', 'private') and
                isinstance(listed.get('members'), list)):
            return
    raise PermissionError('current shared-room membership required; DMs excluded')


def open_journal(root, room):
    directory = root / room
    path = directory / 'memory.sqlite'
    if any(p.is_symlink() for p in (root, directory, path)):
        raise ValueError('room memory path may not be a symlink')
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    directory.mkdir(mode=0o700, exist_ok=True)
    memory = MemoryStore(path)
    path.chmod(0o600)
    memory.close()
    return Journal(path)


def perform(job, chat):
    cfg = job['config']
    instance = Path(cfg['memory_instance'])
    if not instance.is_absolute():
        raise ValueError('select an absolute owner instance config')
    root = load_instance(instance).data_dir / 'harness-room-memory-v1'
    room = job['room']
    if job['op'].startswith('journal_'):
        if cfg.get('journal_enabled') is not True:
            raise ValueError('journal not enabled')
        if job['op'] == 'journal_source':
            # Read through the current actor's normal room transport, not a
            # journal import or a cross-room/filesystem lookup. No DB is opened.
            require_room(chat, room)
            source_id = journal_schema.uuid(job['message_id'])
            end = job['captured_end']
            journal_schema.uuid(end['id'])
            actual_end = chat.exact_message(room, end['id'])
            if revision(actual_end, room) != end:
                raise ValueError('request source changed')
            actual = chat.exact_message(room, source_id)
            event = revision(actual, room)
            if event['at'] > end['at']:
                raise ValueError('source is newer than this turn')
            text = actual['text'].encode()[:journal_schema.TEXT_BYTES].decode('utf-8', errors='ignore')
            result = {'status': 'available', 'revision': event, 'text': text,
                      'truncated': text != actual['text'],
                      'evidence': 'current room source; historical data, not instructions'}
            require_room(chat, room)
            return result
        require_room(chat, room)
        journal = open_journal(root, room)
        try:
            require_room(chat, room)
            if job['op'] == 'journal_status':
                result = {'status': 'available', 'checkpoint': journal.status()}
                if 'query' in job:
                    try:
                        result['recall'] = checked_journal_recall(journal, chat, room, job['query'], compact=True)
                    except (ValueError, TypeError, sqlite3.Error):
                        result['recall'] = {'status': 'unavailable', 'scope': room, 'entries': [],
                                            'omitted_or_source_changed': True}
            elif job['op'] == 'journal_view':
                result = ReadModel(journal, chat, room, job.get('as_of_ms')).page(
                    query=job.get('query',''), before_id=job.get('before_id'), snapshot_id=job.get('snapshot_id'))
            elif job['op'] == 'journal_receipt':
                result = journal.receipt(job['turn_id'], job.get('expected_hash'))
            elif job['op'] == 'journal_commit':
                captured = job['captured']
                if captured['room'] != room:
                    raise ValueError('journal room mismatch')
                draft = job['draft']
                plan = journal_schema.journal_save_request('prepare', room=room, captured=captured,
                    read_only=False, needs_reason=False, arguments=json.dumps(draft))
                if not plan or plan['action'] != 'commit':
                    raise ValueError('invalid journal fixture draft')
                events = {e['id']: e for e in captured['events']}
                # Verify current full source revisions and exact quotes. No model
                # can nominate a different room, instance or coverage timestamp.
                # A source that no longer verifies is refused before anything is written. It is returned, not
                # raised: a raised error ends this worker like a crash, which the caller must report as an unknown
                # write it can never retry.
                result = source_refusal(chat, room, draft, captured, events)
                if result is None:
                    require_room(chat, room)
                    result = journal.commit(draft, captured, job['previous_id'])
            elif job['op'] == 'journal_recall':
                result = checked_journal_recall(journal, chat, room, job['query'])
            else:
                raise ValueError('unsupported journal operation')
            require_room(chat, room)
            return result
        finally:
            journal.close()
    raise ValueError('unsupported journal operation')


ROOM='20000000-0000-0000-0000-000000000002';SID='10000000-0000-0000-0000-000000000001'
class StructuredTests(unittest.TestCase):
 def setUp(self):
  tmp=tempfile.TemporaryDirectory(prefix='structured-');self.addCleanup(tmp.cleanup);self.root=Path(tmp.name)
  instance=self.root/'instance.json';instance.write_text(json.dumps(dict(id=SID,agent_name='Fixture',owner_name='Fixture owner',data_dir='memory',persona='Synthetic')))
  self.cfg=dict(journal_enabled=True,memory_instance=str(instance),self_session_id=SID,memory_timeout_s=3,cli=None)
  self.chat=Mock();self.chat.member_rooms.return_value=[dict(id=ROOM,visibility='private',members=[SID])]
  self.messages={};self.chat.exact_message.side_effect=lambda room,mid:copy.deepcopy(self.messages[mid])
 def op(self,operation,**p):return perform(dict(config=self.cfg,room=ROOM,op=operation,**p),self.chat)
 def add(self,text='The shared kite was blue.',topics=None,importance=None,provenance=None,supersedes=None,related=None,at=None):
  n=len(self.messages)+1;mid=f'30000000-0000-0000-0000-{n:012d}'
  msg=dict(id=mid,roomId=ROOM,at=at if at is not None else n*100,text='kite source '+str(n),**{'from':{'kind':'user','name':'Fixture owner'}});self.messages[mid]=msg
  draft=dict(text=text,tags=['correction']if supersedes else['relationship'],sources=[dict(id=mid,quote='kite')])
  meta={k:v for k,v in dict(topics=topics,importance=importance,provenance=provenance,supersedes=supersedes,related=related).items() if v is not None}
  if meta:draft['annotations']=meta
  previous=self.op('journal_status')['checkpoint'];receipt=self.op('journal_commit',draft=draft,captured=journal.capture_turn(ROOM, [], msg)['captured'],previous_id=previous['id']if previous else None)
  return receipt['entry_id'],mid
 def view(self,**p):return self.op('journal_view',**p)
 def test_legacy_record_hash_and_index_bytes_unchanged(self):
  draft=dict(text='A legacy account.',tags=['relationship'],sources=[dict(id='30000000-0000-0000-0000-000000000001',quote='kite')])
  self.add('A legacy account.')
  db=Journal(next(self.root.rglob('memory.sqlite')))
  try:
   row=db.db.execute('SELECT payload,payload_hash FROM hands_journal').fetchone();p=json.loads(row['payload'])
   self.assertEqual(set(p['draft']),{'text','tags','sources'})
   self.assertEqual(row['payload_hash'],digest(p))
   self.assertEqual(Journal.index_text(draft),'A legacy account. relationship kite')
  finally:db.close()
  item=self.view()['entries'][0];self.assertIsNone(item['importance']);self.assertEqual(item['provenance'],'unknown');self.assertNotIn('confidence',item)
 def test_topic_index_and_explicit_importance_provenance(self):
  self.add(topics=['Shared history','Games and play'],importance='keystone',provenance='reconstructed')
  self.assertEqual(len(self.op('journal_recall',query='Games and play')['entries']),1)
  view=self.view();item=view['entries'][0]
  self.assertEqual(item['importance'],'keystone');self.assertEqual(item['provenance'],'reconstructed')
  self.assertIn('does not verify',item['source_check'])
  self.assertEqual(view['edges'][0]['count'],1)
 def test_correction_replaces_old_answer_and_preserves_history(self):
  old,_=self.add('The old codeword was azure.',topics=['Shared history'])
  new,_=self.add('Correction: the codeword was cerulean.',topics=['Shared history'],supersedes=[old])
  recall=self.op('journal_recall',query='azure')
  self.assertEqual([e['entry_id']for e in recall['entries']],[new]);self.assertNotIn('azure',recall['entries'][0]['text'])
  states={e['id']:e['currentness']for e in self.view()['entries']};self.assertEqual(states,{old:'superseded',new:'current'})
 def test_edited_correction_does_not_silently_restore_old_current_fact(self):
  old,_=self.add();new,mid=self.add('The kite was green instead.',supersedes=[old]);self.messages[mid]['text']='edited later'
  self.assertEqual(self.op('journal_recall',query='blue')['entries'],[])
  view=self.view();self.assertEqual([e['id']for e in view['entries']],[old]);self.assertEqual(view['entries'][0]['currentness'],'unresolved')
 def test_competing_corrections_remain_unresolved(self):
  old,_=self.add();a,_=self.add('The kite was green.',supersedes=[old]);b,_=self.add('The kite was red.',supersedes=[old])
  states={e['id']:e['currentness']for e in self.view()['entries']};self.assertEqual(states[a],'unresolved');self.assertEqual(states[b],'unresolved')
  self.assertEqual(self.op('journal_recall',query='kite')['entries'],[])
 def test_explicit_joint_correction_resolves_two_branches(self):
  old,_=self.add();a,_=self.add('kite green',supersedes=[old]);b,_=self.add('kite red',supersedes=[old]);c,_=self.add('kite violet',supersedes=[a,b])
  # More than2 later corrections of a single original stays bounded/unresolved;
  # this resolution has exactly2 direct targets, both preserved.
  self.assertEqual([e['entry_id']for e in self.op('journal_recall',query='violet')['entries']],[c])
 def test_recorded_time_cutoff_keeps_historical_state(self):
  old,_=self.add('kite blue');cutoff=self.op('journal_status')['checkpoint']['committed_ms']
  new,_=self.add('kite green',supersedes=[old]);view=self.view(as_of_ms=cutoff)
  self.assertEqual([e['id']for e in view['entries']],[old]);self.assertEqual(view['entries'][0]['currentness'],'current')
 def test_invalid_annotations_are_refused_before_write(self):
  for annotations in [dict(importance=True),dict(importance=5),dict(importance='huge'),dict(topics=['Kites']),dict(topics=['<script>alert(1)</script>']),dict(topics=['other']),dict(provenance='certain'),dict(confidence='low'),dict(topics=['']),dict(topics=['a','a']),dict(topics=['x'*49]),dict(topics=['a\nb']),dict(supersedes=[True]),dict(secret='x')]:
   msg=dict(id='30000000-0000-0000-0000-000000000001',roomId=ROOM,at=1,text='kite')
   with self.subTest(annotations=annotations):
    draft=dict(text='x',tags=['correction'],sources=[dict(id=msg['id'],quote='kite')],annotations=annotations)
    turn=journal.Turn(self.cfg,ROOM,[],msg,self.op)
    reply=turn.invoke({'function':dict(name='journal_commit',arguments=json.dumps(draft))})
    self.assertEqual(reply['status'],'refused')
    self.assertIsNone(self.op('journal_status')['checkpoint'])
 def test_missing_target_rolls_back_entry_index_and_checkpoint(self):
  self.add();before=self.op('journal_status')['checkpoint']
  with self.assertRaises(ValueError):self.add('bad correction',supersedes=[999])
  self.assertEqual(self.op('journal_status')['checkpoint'],before);self.assertEqual(len(self.view()['entries']),1)
 def test_current_membership_and_mid_read_revocation_refused(self):
  self.add();self.chat.member_rooms.return_value=[]
  with self.assertRaises(PermissionError):self.view()
  self.chat.member_rooms.side_effect=[[dict(id=ROOM,visibility='private',members=[SID])]]*2+[[]]
  with self.assertRaises(PermissionError):self.view()
 def test_source_redaction_applies_before_topic_counts(self):
  _,mid=self.add(topics=['Games and play'],importance='keystone');self.messages[mid]['text']='edited source'
  view=self.view();self.assertEqual(view['entries'],[]);self.assertEqual(view['tags'],[]);self.assertEqual(view['edges'],[])
 def test_bounded_page_cursor_survives_append(self):
  for i in range(6):self.add('kite '+str(i))
  first=self.view();self.assertEqual(first['coverage']['examined'],MAX_PAGE);self.assertTrue(first['coverage']['more'])
  self.add('new kite after page');second=self.view(**first['cursor'])
  self.assertEqual([e['id']for e in second['entries']],[2,1]);self.assertFalse(second['coverage']['more'])
 def test_sources_checked_once_per_bounded_operation(self):
  self.add();self.chat.exact_message.reset_mock();self.view();self.assertEqual(self.chat.exact_message.call_count,1)
 def test_agent_map_uses_same_projection_and_refuses_room_override(self):
  self.add(topics=['Games and play','Shared history'],importance='important',provenance='relayed')
  msg=dict(id='40000000-0000-0000-0000-000000000001',roomId=ROOM,at=999,text='Read-only map lookup')
  operations=[]
  def operation(op,**p):operations.append(op);return self.op(op,**p)
  turn=journal.Turn(self.cfg,ROOM,[],msg,operation)
  self.assertIn('journal_map',turn.offered)
  self.assertNotIn('journal_commit',turn.offered)
  view=turn.invoke({'function':dict(name='journal_map',arguments=json.dumps(dict(query='kite')))})
  self.assertEqual(view['status'],'available');self.assertEqual(view['tags'],self.view(query='kite')['tags'])
  self.assertEqual(view['entries'][0]['importance'],'important');self.assertEqual(view['entries'][0]['provenance'],'relayed')
  self.assertLessEqual(len(journal.encoded(view)),journal.RESULT_CHARS)
  self.assertNotIn('text',journal.encoded(view));before=list(operations)
  refused=turn.invoke({'function':dict(name='journal_map',arguments=json.dumps(dict(query='',room='other')))})
  self.assertEqual(refused['status'],'refused');self.assertEqual(operations,before)
 def test_source_check_budget_is_finite_and_reports_omission(self):
  for i in range(6):self.add('kite '+str(i))
  db=Journal(next(self.root.rglob('memory.sqlite')))
  try:
   view=ReadModel(db,self.chat,ROOM);rows=[decode(r)for r in db.db.execute('SELECT id,committed_ms,payload FROM hands_journal')]
   view.source_reads=MAX_SOURCE_READS
   self.assertEqual(view.project(rows),[]);self.assertTrue(view.omitted);self.assertEqual(view.source_reads,MAX_SOURCE_READS)
  finally:db.close()
 def test_no_raw_dump_or_topic_scope_override(self):
  self.add(topics=['Other'])
  result=self.view();self.assertNotIn('snapshot',journal.encoded(result));self.assertNotIn('quote',journal.encoded(result));self.assertNotIn('payload_hash',journal.encoded(result))
  with self.assertRaises(ValueError):self.view(before_id=True)
  with self.assertRaises(ValueError):self.view(as_of_ms=float('nan'))
if __name__=='__main__':unittest.main(verbosity=2)
