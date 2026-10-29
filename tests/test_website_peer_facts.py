"""Fact-only source controls. Engine/proc/mount/UID ports are controlled here;
 * real file copies/hashes/inodes distinguish host artifacts from image copies.
 * No actual engine, container, listener, owner session, permit or native claim.
"""
from contextlib import contextmanager, ExitStack
import copy
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from reverie import website_peer_facts as F
from reverie.owner_terminal_channel import Program


class WebsiteFactTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(dir=os.environ.get('TMPDIR'));self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name).resolve();self.executable=Path(sys.executable).resolve()
        self.invocation=Path(sys.executable)
        self.guest=self.root/'image-copy';shutil.copyfile(self.executable,self.guest);self.guest.chmod(0o444)
        self.expected={'sha256':hashlib.sha256(self.executable.read_bytes()).hexdigest(),'bytes':self.executable.stat().st_size}
        self.item={'Id':'a'*64,'Image':'sha256:'+'b'*64,'State':{'Running':True,'Pid':4242},
          'Config':{'User':str(os.getuid())+':'+str(os.getgid()),'Env':['PATH=/bin']},
          'HostConfig':{'OomKillDisable':False,'Memory':123,'ReadonlyRootfs':True,'Privileged':False,
                        'PidMode':'','CapDrop':['ALL'],'CapAdd':None,'SecurityOpt':['no-new-privileges:true']},
          'Mounts':[{'Type':'bind','Destination':'/data','Source':str(self.root),'RW':True,'Propagation':'rprivate'}]}
        program={'executable':str(self.executable),'argv':[str(self.invocation),'-I']}
        self.selection={'containerId':self.item['Id'],'imageId':self.item['Image'],
          'configDigest':F.digest(self.item['Config']),'hostConfigDigest':F.digest(self.item['HostConfig']),
          'mountsDigest':F.digest(F.mounts(self.item['Mounts'])),'initPid':None,'initStart':None,
          'uid':os.getuid(),'gid':os.getgid(),'bootstrap':program,'node':program,
          'codeFiles':{str(self.executable):self.expected}}
        self.initial={'pid':4242,'start':12345,'parent':1,'argv':'c'*64,'exe':(1,2),'namespaces':(3,4,5)}
        test=self
        class Engine:
            path='/not-a-real-engine'
            def guard(self):pass
            def get(self,path):
                test.assertEqual(path,'/containers/'+'a'*64+'/json')
                return copy.deepcopy(test.item)
        self.engine=Engine();self.readonly=True;self.links={};self.wrong_link=False

    @contextmanager
    def ports(self):
        original_open=os.open;original_fstat=os.fstat;original_lstat=Path.lstat
        uid=self.guest.stat().st_uid;host_identity=(self.executable.stat().st_dev,self.executable.stat().st_ino)
        unmapped=Path('/').stat().st_uid==65534 and self.executable.stat().st_uid==65534
        def normalized(value):
            fields=list(value);fields[4]=0;return os.stat_result(fields)
        def host_fstat(fd):
            value=original_fstat(fd)
            return normalized(value)if unmapped and(value.st_dev,value.st_ino)==host_identity else value
        def host_lstat(path,*args,**kwargs):
            value=original_lstat(path,*args,**kwargs)
            eligible=str(path).startswith('/nix/store/')or str(path)in('/','/nix','/nix/store')
            return normalized(value)if unmapped and eligible and value.st_uid==65534 else value
        def open_root(path,*args,**kwargs):
            if os.fspath(path)=='/proc/4242/root':return original_open(self.root,os.O_PATH|os.O_DIRECTORY|os.O_CLOEXEC)
            return original_open(path,*args,**kwargs)
        def open_image(root,path,*,path_link=False):
            if path_link:
                if path not in self.links:
                    link=self.root/('link-'+hashlib.sha256(path.encode()).hexdigest())
                    link.symlink_to('/nix/store/not-the-qualified-target'if self.wrong_link else os.readlink(path))
                    self.links[path]=link
                return original_open(self.links[path],os.O_PATH|os.O_NOFOLLOW|os.O_CLOEXEC)
            self.assertEqual(path,str(self.executable));return original_open(self.guest,os.O_RDONLY|os.O_CLOEXEC)
        with ExitStack()as stack:
            stack.enter_context(patch.object(F,'read_proc',side_effect=lambda _:copy.deepcopy(self.initial)))
            stack.enter_context(patch.object(F,'open_in_root',side_effect=open_image))
            stack.enter_context(patch.object(F,'mapped_root_uid',return_value=uid))
            stack.enter_context(patch.object(F.os,'open',side_effect=open_root))
            stack.enter_context(patch.object(F.os,'fstat',side_effect=host_fstat))
            stack.enter_context(patch.object(F.os,'fstatvfs',side_effect=lambda _:SimpleNamespace(f_flag=os.ST_RDONLY if self.readonly else 0)))
            if unmapped:stack.enter_context(patch.object(F.Path,'lstat',host_lstat))
            yield

    def bound(self):
        facts=F.WebsiteFacts(self.engine,self.selection);facts.bind_once();return facts

    def test_image_copy_inode_is_distinct_and_qualified_bytes_admit_namespace_program(self):
        with self.ports():
            facts=self.bound();peer=F.ProtectedPeer(facts)
            image=self.guest.stat();self.assertNotEqual((image.st_dev,image.st_ino),(self.executable.stat().st_dev,self.executable.stat().st_ino))
            process={'exe':(image.st_dev,image.st_ino),'argv':hashlib.sha256(b'\0'.join(v.encode()for v in peer.bootstrap.argv)+b'\0').hexdigest()}
            with self.assertRaises(ValueError):Program(str(self.executable),peer.bootstrap.argv).matches(process)
            peer.bootstrap.matches(process)
            with self.assertRaisesRegex(ValueError,'WEBSITE_BINDING_NO_REPLAY'):facts.bind_once()

    def test_changed_image_bytes_or_nonreadonly_filesystem_refuse(self):
        with self.ports():
            facts=self.bound();self.guest.chmod(0o644)
            with self.assertRaisesRegex(ValueError,'PROTECTED_IMAGE_CODE_REQUIRED'):facts.qualify_file(str(self.executable))
            data=self.guest.read_bytes();self.guest.write_bytes(bytes([data[0]^1])+data[1:]);self.guest.chmod(0o444)
            with self.assertRaisesRegex(ValueError,'BACKEND_CODE_BYTES_CHANGED'):facts.qualify_file(str(self.executable))
        self.guest.chmod(0o644);shutil.copyfile(self.executable,self.guest);self.guest.chmod(0o444);self.readonly=False
        with self.ports(),self.assertRaisesRegex(ValueError,'PROTECTED_IMAGE_CODE_REQUIRED'):self.bound()

    def test_complete_mounts_hostconfig_and_namespace_changes_are_not_discarded(self):
        with self.ports():
            facts=self.bound()
            self.item['HostConfig']['Memory']=124
            with self.assertRaisesRegex(ValueError,'WEBSITE_FULL_SPEC_CHANGED'):facts.inspect()
            self.item['HostConfig']['Memory']=123
            self.item['Mounts'][0]['Propagation']='rshared'
            with self.assertRaisesRegex(ValueError,'WEBSITE_FULL_SPEC_CHANGED'):facts.inspect()
            self.item['Mounts'][0]['Propagation']='rprivate';self.initial['namespaces']=(3,4,6)
            with self.assertRaisesRegex(ValueError,'WEBSITE_INIT_CHANGED'):facts.inspect()

    def test_loader_or_code_mount_requires_refusal_even_when_selected_digest_matches(self):
        for mutation in ('env','mount','caps','rw'):
            with self.subTest(mutation=mutation):
                item=copy.deepcopy(self.item)
                if mutation=='env':item['Config']['Env'].append('LD_LIBRARY_PATH=/data')
                elif mutation=='mount':item['Mounts'].append({'Type':'bind','Source':'/data','Destination':'/nix/store/code','RW':True})
                elif mutation=='caps':item['HostConfig']['CapAdd']=['SYS_PTRACE']
                else:item['HostConfig']['ReadonlyRootfs']=False
                with self.assertRaises(ValueError):F.protected_backend(item)

    def test_exact_host_symlink_invocation_preserved_but_changed_guest_link_rejected(self):
        if self.invocation==self.executable:self.skipTest('Selected Python invocation has no alias on this platform')
        with self.ports():
            facts=self.bound();program=facts.program(str(self.executable),(str(self.invocation),'-I'))
            self.assertEqual(program.argv[0],str(self.invocation));facts.qualify_alias(str(self.invocation),str(self.executable))
            for path in self.links.values():path.unlink();path.symlink_to('/nix/store/different')
            with self.assertRaisesRegex(ValueError,'IMAGE_INVOCATION_ALIAS_CHANGED'):facts.qualify_alias(str(self.invocation),str(self.executable))

    def test_with_bootstrap_preserves_subclass_custody_and_namespace_adapter(self):
        with self.ports():
            facts=self.bound()
            class CustodyPeer(F.ProtectedPeer):
                marker=object()
            peer=CustodyPeer(facts);replacement=peer.with_bootstrap(Program(str(self.executable),(str(self.invocation),'-I','-B')))
            self.assertIsInstance(replacement,CustodyPeer);self.assertIs(replacement.marker,peer.marker)
            self.assertIs(replacement.facts,facts);self.assertIs(replacement.node,peer.node)
            self.assertIsInstance(replacement.bootstrap,F.NamespaceProgram);self.assertNotEqual(replacement.bootstrap.argv,peer.bootstrap.argv)
            with self.assertRaises(ValueError):peer.with_bootstrap(Program('/nix/store/not-qualified',(str(self.invocation),)))

    def test_python_wrapper_and_bare_image_copies_are_both_qualified(self):
        bare=Path('/proc/self/exe').resolve(strict=True)
        self.assertNotEqual(bare,self.executable,'Declared flake environment wrapper required')
        guest_bare=self.root/'bare-image-copy';shutil.copyfile(bare,guest_bare);guest_bare.chmod(0o444)
        self.selection['bootstrap']={'executable':str(bare),'argv':[str(self.invocation),'-I']}
        self.selection['codeFiles'][str(bare)]={'sha256':hashlib.sha256(bare.read_bytes()).hexdigest(),'bytes':bare.stat().st_size}
        mapped=os.environ.get('NIX_BUILD_TOP') and Path('/').stat().st_uid==Path('/nix/store').stat().st_uid==65534
        with self.ports(),ExitStack() as extra:
            image_open=F.open_in_root;native_stat=Path.stat;native_fstat=os.fstat
            def image(root,path,**kwargs):
                return os.open(guest_bare,os.O_RDONLY|os.O_CLOEXEC)if path==str(bare) and not kwargs.get('path_link') else image_open(root,path,**kwargs)
            extra.enter_context(patch.object(F,'open_in_root',side_effect=image))
            if mapped:
                selected={bare,self.executable}
                def host_stat(path,*args,**kwargs):
                    value=native_stat(path,*args,**kwargs)
                    return SimpleNamespace(**{**{k:getattr(value,k)for k in dir(value)if k.startswith('st_')},'st_uid':0})if path in selected and value.st_uid==65534 else value
                identity=(native_stat(bare).st_dev,native_stat(bare).st_ino)
                def host_fstat(fd):
                    value=native_fstat(fd)
                    if(value.st_dev,value.st_ino)==identity and value.st_uid==65534:
                        fields=list(value);fields[4]=0;return os.stat_result(fields)
                    return value
                extra.enter_context(patch.object(Path,'stat',host_stat))
                extra.enter_context(patch.object(os,'fstat',host_fstat))
            facts=self.bound();program=facts.program(str(bare),(str(self.invocation),'-I'))
            st=guest_bare.stat();process={'exe':(st.st_dev,st.st_ino),'argv':hashlib.sha256(b'\0'.join(v.encode()for v in program.argv)+b'\0').hexdigest()}
            program.matches(process)
            wrong=dict(process,exe=(self.guest.stat().st_dev,self.guest.stat().st_ino))
            with self.assertRaisesRegex(ValueError,'PROGRAM_CHANGED'):program.matches(wrong)
            with self.assertRaisesRegex(ValueError,'INVOCATION_EXECUTABLE_CHANGED'):
                facts.program(str(bare),(str(self.invocation),'--unreviewed'))
            guest_bare.chmod(0o644);data=guest_bare.read_bytes();guest_bare.write_bytes(bytes([data[0]^1])+data[1:]);guest_bare.chmod(0o444)
            with self.assertRaisesRegex(ValueError,'BACKEND_CODE_BYTES_CHANGED'):program.matches(process)


class ImageMetadataRouteTests(unittest.TestCase):
    def test_added_capabilities_must_be_an_explicit_native_fact(self):
        item={'HostConfig':{'ReadonlyRootfs':True,'Privileged':False,'CapDrop':['ALL'],
                            'PidMode':'','SecurityOpt':['no-new-privileges:true']},
              'Mounts':[],'Config':{'Env':[]}}
        with self.assertRaisesRegex(ValueError,'PROTECTED_WEBSITE_NAMESPACE_REQUIRED'):
            F.protected_backend(item)
        for value in (None,[]):
            item['HostConfig']['CapAdd']=value;F.protected_backend(item)
        item['HostConfig']['CapAdd']=['SYS_ADMIN']
        with self.assertRaisesRegex(ValueError,'PROTECTED_WEBSITE_NAMESPACE_REQUIRED'):
            F.protected_backend(item)

    def test_image_ids_only_reach_the_same_bounded_read_only_transport(self):
        sent=[];closed=[];route='/images/sha256:'+'a'*64+'/json'
        class Connection:
            def __init__(self,host,timeout):
                self.host=host;self.timeout=timeout
            def request(self,method,path):sent.append((method,path))
            def getresponse(self):return SimpleNamespace(status=200,length=None,read=lambda maximum:b'{"Id":"synthetic"}',close=lambda:None)
            def close(self):closed.append(True)
        with patch.object(F,'socket_identity',return_value=(1,2,0,0)), \
             patch.object(F.http.client,'HTTPConnection',Connection),patch.object(F,'_MetadataSocket'):
            result=F.Engine('/synthetic/owned.sock',[1,2,0,0],'synthetic-engine').get(route)
        self.assertEqual(result,{'Id':'synthetic'})
        self.assertEqual(sent,[('GET',route)]);self.assertEqual(closed,[True])

    def test_image_aliases_queries_extra_paths_and_mutations_refuse_before_io(self):
        prefix='/images/sha256:'+'a'*64
        invalid=['/images/json','/images/reverie:latest/json','/images/sha256:'+'A'*64+'/json',
                 prefix+'/json?x=1',prefix+'/json/extra',prefix+'/push',prefix+'/delete',
                 '/images/sha256:'+'a'*63+'/json','/images/../containers/'+'a'*64+'/json']
        with patch.object(F,'socket_identity',side_effect=AssertionError('No I/O may precede rejection')):
            for route in invalid:
                with self.subTest(route=route),self.assertRaises(ValueError):
                    F.Engine('/synthetic/owned.sock',[1,2,0,0],'synthetic-engine').get(route)


if __name__=='__main__':unittest.main()


class EngineDeadlineTests(unittest.TestCase):
    """Actual owned UDS HTTP; no daemon, native instance or authority."""
    @contextmanager
    def endpoint(self, parts, delay=0):
        import socket
        import threading
        with tempfile.TemporaryDirectory(prefix='facts-http-') as directory:
            path=str(Path(directory).resolve()/'own.sock')
            listener=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
            listener.bind(path);listener.listen(1);listener.settimeout(1)
            stop=threading.Event();errors=[];closed=[];requests=[]
            def serve():
                try:
                    connection,_=listener.accept()
                    with connection:
                        connection.settimeout(1);request=b''
                        while b'\r\n\r\n'not in request:
                            data=connection.recv(2048)
                            if not data:raise ValueError('owned fixture request ended')
                            request+=data
                            if len(request)>4096:raise ValueError('owned fixture request bound')
                        requests.append(request.split(b'\r\n',1)[0])
                        for part in parts:
                            if stop.wait(delay):break
                            connection.sendall(part)
                        connection.shutdown(socket.SHUT_WR)
                        closed.append(connection.recv(1)==b'')
                except(BrokenPipeError,ConnectionResetError):closed.append(True)
                except BaseException as error:errors.append(type(error).__name__)
            thread=threading.Thread(target=serve);thread.start()
            try:
                yield F.Engine(path,F.socket_identity(path),'owned-fixture')
            finally:
                stop.set();thread.join(3);listener.close()
                self.assertFalse(thread.is_alive());self.assertEqual(errors,[])
                self.assertEqual(requests,[b'GET /info HTTP/1.1'])
                self.assertEqual(closed,[True], 'client must close its socket on every outcome')

    def test_fixed_length_chunked_and_eof_delimited_responses_remain_usable(self):
        for raw in [b'HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}',
                    b'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\n{}\r\n0\r\n\r\n',
                    b'HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n{}']:
            with self.subTest(raw=raw[:30]),self.endpoint([raw])as engine:
                self.assertEqual(engine.get('/info'),{})

    def test_progressing_headers_and_body_share_one_absolute_budget(self):
        import time
        examples=[
            [b'HTTP/1.1 ',b'200 OK\r\n',b'Content-Length: 2\r\n',b'\r\n',b'{}'],
            [b'HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\n',b' ',b' ',b' ',b'{',b'}'],
        ]
        for parts in examples:
            with self.subTest(parts=parts[:1]),patch.object(F,'ENGINE_SECONDS',.15),self.endpoint(parts,.055)as engine:
                start=time.monotonic()
                with self.assertRaises(TimeoutError):engine.get('/info')
                self.assertLess(time.monotonic()-start,.4)

    def test_truncated_declared_length_and_chunk_framing_refuse_valid_json_prefix(self):
        import http.client
        for raw in [b'HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\n{}',
                    b'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\n{}\r\n']:
            with self.subTest(raw=raw[:35]),self.endpoint([raw])as engine:
                with self.assertRaises((ValueError,http.client.IncompleteRead)):engine.get('/info')

    def test_declared_body_and_header_wire_bounds_close_before_acceptance(self):
        for raw in [b'HTTP/1.1 200 OK\r\nContent-Length: '+str(F.MAX_ENGINE_BODY+1).encode()+b'\r\n\r\n',
                    b'HTTP/1.1 200 OK\r\nX-Fixture: '+b'a'*256+b'\r\nContent-Length: 2\r\n\r\n{}']:
            with self.subTest(raw=raw[:35]),patch.object(F,'MAX_ENGINE_WIRE',128),self.endpoint([raw])as engine:
                with self.assertRaises(ValueError):engine.get('/info')
