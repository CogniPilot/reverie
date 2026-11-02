"""Lost response controls: actual owned SQLite worker, never a live journal."""
import copy
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

HANDS = Path(__file__).resolve().parents[2] / 'python/reverie/hands'
sys.path[:0] = [str(HANDS), str(HANDS.parents[1])]
def load(name,path):
    spec=importlib.util.spec_from_file_location(name,path);module=importlib.util.module_from_spec(spec)
    sys.modules[name]=module;spec.loader.exec_module(module);return module
journal=importlib.import_module('agent_journal')
worker=load('recovery_worker',HANDS/'agent_memory_worker.py')
ROOM='20000000-0000-0000-0000-000000000002'
MID='30000000-0000-0000-0000-000000000003'
SID='10000000-0000-0000-0000-000000000001'
OTHER='40000000-0000-0000-0000-000000000004'

class RecoveryTests(unittest.TestCase):
    def setUp(self):
        temp=tempfile.TemporaryDirectory(prefix='recovery-');self.addCleanup(temp.cleanup)
        self.root=Path(temp.name);instance=self.root/'instance.json'
        instance.write_text(json.dumps(dict(id=SID,agent_name='Fixture',owner_name='Fixture owner',data_dir='memory',persona='Synthetic only')))
        self.cfg=dict(journal_enabled=True,memory_instance=str(instance),self_session_id=SID,memory_timeout_s=3,cli=None)
        self.msg=dict(id=MID,roomId=ROOM,at=100,text='Keep the paper kite memory.',**{'from':{'kind':'user','name':'Fixture owner'}})
        self.chat=Mock();self.chat.member_rooms.return_value=[dict(id=ROOM,visibility='private',members=[SID])]
        self.chat.exact_message.side_effect=lambda room,mid:copy.deepcopy(self.msg) if mid==MID else None
        self.calls=[]

    def perform(self,op,**p):
        self.calls.append(op)
        return worker.perform(dict(config=self.cfg,room=ROOM,op=op,**p),self.chat)

    def draft(self):
        return dict(text='The owner mentioned the paper kite memory.',tags=['lesson'],sources=[dict(id=MID,quote='paper kite')])

    def commit(self,turn):
        return turn.invoke({'function':dict(name='journal_commit',arguments=json.dumps(self.draft()))})

    def turn(self,op):
        return journal.Turn(self.cfg,ROOM,[self.msg],self.msg,op,now_ms=200)

    def test_lost_committed_response_recovers_exact_receipt_without_second_write(self):
        def operation(op,**p):
            result=self.perform(op,**p)
            return None if op=='journal_commit' else result
        result=self.commit(self.turn(operation))
        self.assertEqual(result['status'],'committed')
        self.assertTrue(result['recovered_after_unknown'])
        self.assertFalse(result['write_retried'])
        self.assertIsNone(result['replayed'])
        self.assertEqual(result['turn_id'],MID)
        self.assertEqual(self.calls,['journal_status','journal_commit','journal_receipt'])
        recalled=self.perform('journal_recall',query='kite')
        self.assertEqual([e['entry_id'] for e in recalled['entries']],[result['entry_id']])

    def test_no_receipt_does_not_turn_unknown_into_no_write(self):
        def operation(op,**p):
            if op=='journal_commit':self.calls.append(op);return None
            return self.perform(op,**p)
        result=self.commit(self.turn(operation))
        self.assertEqual(result['status'],'unknown')
        self.assertIn('do not retry',result['reason'])
        self.assertEqual(self.calls.count('journal_commit'),1)
        self.assertEqual(self.perform('journal_receipt',turn_id=MID)['status'],'not_found')

    def test_lost_recovery_response_stays_unknown_without_retry(self):
        def operation(op,**p):
            result=self.perform(op,**p)
            return None if op in ('journal_commit','journal_receipt') else result
        result=self.commit(self.turn(operation))
        self.assertEqual(result['status'],'unknown')
        self.assertEqual(self.calls.count('journal_commit'),1)
        self.assertEqual(self.perform('journal_receipt',turn_id=MID)['status'],'committed')

    def test_different_stored_payload_is_conflict_not_false_recovery(self):
        def operation(op,**p):
            if op=='journal_commit':
                p=copy.deepcopy(p);p['draft']['text']='Different synthetic account.'
                self.perform(op,**p);return None
            return self.perform(op,**p)
        result=self.commit(self.turn(operation))
        self.assertEqual(result['status'],'refused')
        self.assertEqual(result['reason'],'operation_payload_conflict')
        self.assertEqual(self.calls.count('journal_commit'),1)

    def test_receipt_has_no_body_and_preserves_checkpoint(self):
        self.commit(self.turn(self.perform))
        before=self.perform('journal_status')['checkpoint']
        receipt=self.perform('journal_receipt',turn_id=MID)
        self.assertEqual(set(receipt),{'status','turn_id','entry_id','committed_ms','payload_sha256','evidence'})
        self.assertNotIn('paper',json.dumps(receipt))
        self.assertEqual(self.perform('journal_status')['checkpoint'],before)
        self.assertEqual(self.perform('journal_receipt',turn_id=OTHER)['status'],'not_found')

    def test_receipt_requires_current_room_access(self):
        self.commit(self.turn(self.perform))
        for rooms in ([],[dict(id=ROOM,kind='dm',visibility='private',members=[SID])]):
            self.chat.member_rooms.return_value=rooms
            with self.assertRaises(PermissionError):self.perform('journal_receipt',turn_id=MID)

    def test_receipt_is_not_current_source_verification(self):
        self.commit(self.turn(self.perform))
        self.msg['text']='The source was edited later.'
        receipt=self.perform('journal_receipt',turn_id=MID)
        self.assertEqual(receipt['status'],'committed')
        self.assertIn('no semantic or current-source verification',receipt['evidence'])
        recalled=self.perform('journal_recall',query='kite')
        self.assertEqual(recalled['entries'],[])
        self.assertTrue(recalled['omitted_or_source_changed'])

    def test_forged_recovery_identity_or_hash_is_not_accepted(self):
        for change in ('turn','hash','entry'):
            def operation(op,**p):
                if op=='journal_commit':return None
                if op=='journal_receipt':
                    result=dict(status='committed',turn_id=p['turn_id'],payload_sha256=p['expected_hash'],entry_id=1,committed_ms=100)
                    if change=='turn':result['turn_id']=OTHER
                    if change=='hash':result['payload_sha256']='0'*64
                    if change=='entry':result['entry_id']=True
                    return result
                return self.perform(op,**p)
            self.assertEqual(self.commit(self.turn(operation))['status'],'unknown')

    def test_readonly_receipt_tool_rejects_model_room_override(self):
        self.msg['text']='Read-only receipt lookup'
        turn=self.turn(self.perform)
        self.assertIn('journal_receipt',turn.offered)
        result=turn.invoke({'function':dict(name='journal_receipt',arguments=json.dumps(dict(turn_id=MID,room=OTHER)))})
        self.assertEqual(result['status'],'refused')
        self.assertNotIn('journal_receipt',self.calls)

    def test_recovered_result_does_not_forward_extra_body_fields(self):
        def operation(op,**p):
            result=self.perform(op,**p)
            if op=='journal_commit':return None
            if op=='journal_receipt':result['text']='private fixture body must not escape'
            return result
        result=self.commit(self.turn(operation))
        self.assertEqual(result['status'],'committed')
        self.assertNotIn('text',result)
        self.assertNotIn('private fixture body',json.dumps(result))

    def test_actual_answer_recovers_then_reads_receipt_and_recall(self):
        import agent_loop as loop
        cfg=dict(loop.DEFAULTS,**self.cfg,self_name='Fixture',timezone='UTC')
        calls=[]
        def operation(cfg,room,op,**p):
            result=self.perform(op,**p)
            return None if op=='journal_commit' else result
        def model(cfg,messages,tools):
            calls.append(1)
            self.assertLessEqual(loop.request_chars(messages)+len(json.dumps(tools or [])),cfg['prompt_cap_chars'])
            if len(calls)==1:name,args='journal_commit',self.draft()
            elif len(calls)==2:
                self.assertIn('recovered_after_unknown',messages[-1]['content'])
                name,args='journal_receipt',dict(turn_id=MID)
            elif len(calls)==3:
                self.assertIn('durable write receipt only',messages[-1]['content'])
                name,args='journal_recall',dict(query='kite')
            else:
                self.assertIsNone(tools)
                return {'content':'The durable write receipt was recovered without repeating the write; the entry was recalled.'}
            return {'tool_calls':[{'id':str(len(calls)),'function':dict(name=name,arguments=json.dumps(args))}]}
        with patch.object(loop,'memory_op',side_effect=operation):
            reply,_,_=loop.answer(cfg,ROOM,[self.msg],self.msg,model,None)
        self.assertIn('without repeating',reply)
        self.assertEqual(self.calls,['journal_status','journal_commit','journal_receipt','journal_receipt','journal_recall'])
        self.assertEqual(len(calls),journal.MAX_CALLS+1)

if __name__=='__main__':unittest.main(verbosity=2)
