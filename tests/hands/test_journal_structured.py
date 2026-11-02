"""Read-model/correction controls against owned SQLite and exact fixture sources."""
import copy
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock
HANDS = Path(__file__).resolve().parents[2] / 'python/reverie/hands'
sys.path[:0] = [str(HANDS), str(HANDS.parents[1])]
def load(name,path):
 spec=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(spec);sys.modules[name]=m;spec.loader.exec_module(m);return m
journal=importlib.import_module('agent_journal')
model=importlib.import_module('agent_journal_model')
worker=load('structured_worker',HANDS/'agent_memory_worker.py')
ROOM='20000000-0000-0000-0000-000000000002';SID='10000000-0000-0000-0000-000000000001'
class StructuredTests(unittest.TestCase):
 def setUp(self):
  tmp=tempfile.TemporaryDirectory(prefix='structured-');self.addCleanup(tmp.cleanup);self.root=Path(tmp.name)
  instance=self.root/'instance.json';instance.write_text(json.dumps(dict(id=SID,agent_name='Fixture',owner_name='Fixture owner',data_dir='memory',persona='Synthetic')))
  self.cfg=dict(journal_enabled=True,memory_instance=str(instance),self_session_id=SID,memory_timeout_s=3,cli=None)
  self.chat=Mock();self.chat.member_rooms.return_value=[dict(id=ROOM,visibility='private',members=[SID])]
  self.messages={};self.chat.exact_message.side_effect=lambda room,mid:copy.deepcopy(self.messages[mid])
 def op(self,operation,**p):return worker.perform(dict(config=self.cfg,room=ROOM,op=operation,**p),self.chat)
 def add(self,text='The shared kite was blue.',topics=None,importance=None,provenance=None,supersedes=None,related=None,at=None):
  n=len(self.messages)+1;mid=f'30000000-0000-0000-0000-{n:012d}'
  msg=dict(id=mid,roomId=ROOM,at=at if at is not None else n*100,text='kite source '+str(n),**{'from':{'kind':'user','name':'Fixture owner'}});self.messages[mid]=msg
  draft=dict(text=text,tags=['correction']if supersedes else['relationship'],sources=[dict(id=mid,quote='kite')])
  meta={k:v for k,v in dict(topics=topics,importance=importance,provenance=provenance,supersedes=supersedes,related=related).items() if v is not None}
  if meta:draft['annotations']=meta
  previous=self.op('journal_status')['checkpoint'];receipt=self.op('journal_commit',draft=draft,captured=journal.snapshot(ROOM,[],msg),previous_id=previous['id']if previous else None)
  return receipt['entry_id'],mid
 def view(self,**p):return self.op('journal_view',**p)
 def test_legacy_record_hash_and_index_bytes_unchanged(self):
  draft=dict(text='A legacy account.',tags=['relationship'],sources=[dict(id='30000000-0000-0000-0000-000000000001',quote='kite')])
  self.add('A legacy account.')
  db=journal.Journal(next(self.root.rglob('memory.sqlite')))
  try:
   row=db.db.execute('SELECT payload,payload_hash FROM hands_journal').fetchone();p=json.loads(row['payload'])
   self.assertEqual(set(p['draft']),{'text','tags','sources'})
   self.assertEqual(row['payload_hash'],journal.digest(p))
   self.assertEqual(journal.Journal.index_text(draft),'A legacy account. relationship kite')
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
   with self.subTest(annotations=annotations),self.assertRaises(ValueError):journal.validate_draft(dict(text='x',tags=['correction'],sources=[dict(id=msg['id'],quote='kite')],annotations=annotations),journal.snapshot(ROOM,[],msg))
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
  first=self.view();self.assertEqual(first['coverage']['examined'],model.MAX_PAGE);self.assertTrue(first['coverage']['more'])
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
  db=journal.Journal(next(self.root.rglob('memory.sqlite')))
  try:
   view=model.ReadModel(db,self.chat,ROOM);rows=[model.decode(r)for r in db.db.execute('SELECT id,committed_ms,payload FROM hands_journal')]
   view.source_reads=model.MAX_SOURCE_READS
   self.assertEqual(view.project(rows),[]);self.assertTrue(view.omitted);self.assertEqual(view.source_reads,model.MAX_SOURCE_READS)
  finally:db.close()
 def test_no_raw_dump_or_topic_scope_override(self):
  self.add(topics=['Other'])
  result=self.view();self.assertNotIn('snapshot',journal.encoded(result));self.assertNotIn('quote',journal.encoded(result));self.assertNotIn('payload_hash',journal.encoded(result))
  with self.assertRaises(ValueError):self.view(before_id=True)
  with self.assertRaises(ValueError):self.view(as_of_ms=float('nan'))
if __name__=='__main__':unittest.main(verbosity=2)
