"""Owned synthetic capture files; upload ports are controlled, never HTTP."""
import gzip,hashlib,io,json,os,tarfile,tempfile,time,unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock
from reverie import browser_job_requests as jobs

class ArtifactControls(unittest.TestCase):
    def fixture(self,tmp):
        task=Path(tmp).resolve();root=task/'f';(root/'capture').mkdir(parents=True);(root/'artifacts').mkdir();p=root/'capture'/'FRAME.json';p.write_text('{"frame":0}\n');p.chmod(0o600);return task,p
    def test_only_owned_regular_files_are_exported_with_relative_names(self):
        with tempfile.TemporaryDirectory()as tmp:
            task,file=self.fixture(tmp);members=jobs.artifact_members(task,1024);raw=[];parts=jobs.stream_artifacts(members,lambda n,data,sha:raw.append(data)or{'part':n,'sha':sha})
            self.assertEqual(len(parts),1)
            with tarfile.open(fileobj=io.BytesIO(gzip.decompress(b''.join(raw))))as archive:
                self.assertEqual(archive.getnames(),['capture/FRAME.json']);item=archive.getmembers()[0];self.assertEqual(item.uid,0);self.assertEqual(item.gid,0);self.assertEqual(archive.extractfile(item).read(),file.read_bytes())
            file.unlink();file.symlink_to('/unread/foreign')
            with self.assertRaisesRegex(jobs.BrowserJobRefused,'OWN_ARTIFACT'):jobs.artifact_members(task,1024)
    def test_replaced_file_refuses_before_any_upload(self):
        with tempfile.TemporaryDirectory()as tmp:
            task,file=self.fixture(tmp);members=jobs.artifact_members(task,1024);file.write_text('changed');send=Mock()
            with self.assertRaisesRegex(jobs.BrowserJobRefused,'REPLACED'):jobs.stream_artifacts(members,send)
            send.assert_not_called()
    def test_unknown_upload_is_not_retried_or_reported_delivered(self):
        with tempfile.TemporaryDirectory()as tmp:
            task,_=self.fixture(tmp);actor=object.__new__(jobs.BrowserJobRequests);actor.policy={'limits':{'outputBytes':268435456},'ownerCue':{'roomId':'00000000-0000-4000-8000-000000000001'}};actor.authority=Mock();actor.office_post=Mock(side_effect=TimeoutError('response lost'))
            record={'actor':{'sessionId':'00000000-0000-4000-8000-000000000002'},'requestMessageId':'00000000-0000-4000-8000-000000000003','operationId':'a'*32,'authority':{}}
            with self.assertRaises(TimeoutError):actor.deliver(task,record,time.monotonic()+5)
            actor.office_post.assert_called_once();self.assertTrue((task/'DELIVERY-ATTEMPT.json').exists());self.assertFalse((task/'DELIVERY-DONE.json').exists())
            with self.assertRaises(FileExistsError):actor.deliver(task,record,time.monotonic()+5)
            actor.office_post.assert_called_once()
    def test_actor_revoked_after_upload_cannot_post_a_message(self):
        with tempfile.TemporaryDirectory()as tmp:
            task,_=self.fixture(tmp);actor=object.__new__(jobs.BrowserJobRequests);actor.policy={'limits':{'outputBytes':268435456},'ownerCue':{'roomId':'00000000-0000-4000-8000-000000000001'}};actor.authority=Mock(side_effect=[{}, {},jobs.BrowserJobRefused('owner lost')])
            operation='a'*32;actor.office_post=Mock(side_effect=lambda sid,path,raw,kind,deadline:{'file':{'id':'00000000-0000-4000-8000-000000000004','name':'capture-'+operation+'.tar.gz.part-001','size':len(raw)}})
            record={'actor':{'sessionId':'00000000-0000-4000-8000-000000000002'},'requestMessageId':'00000000-0000-4000-8000-000000000003','operationId':operation,'authority':{}}
            with self.assertRaisesRegex(jobs.BrowserJobRefused,'owner lost'):actor.deliver(task,record,time.monotonic()+5)
            actor.office_post.assert_called_once();self.assertIn('/files?',actor.office_post.call_args.args[1]);self.assertFalse((task/'DELIVERY-DONE.json').exists())
if __name__=='__main__':unittest.main()
