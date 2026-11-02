"""One bounded read projection over own-room journals; no second memory store.

Caller must hold current room access before and after using this component.
Source checks use the existing exact-message actor transport. Topic labels and
self-reported confidence never grant access or certify semantic truth.
"""
import json
import math
import re
import agent_journal as journal_schema

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
                    try:self.sources[mid]=journal_schema.revision(self.chat.exact_message(self.room,mid),self.room)
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
