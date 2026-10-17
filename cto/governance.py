"""Configurable review directives and deterministic commit/merge admission checks."""
from __future__ import annotations
import argparse
import fnmatch
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import urllib.request


class PolicyError(ValueError): pass


def read_policy(path):
    value=json.loads(Path(path).expanduser().read_text())
    if not isinstance(value,dict): raise PolicyError('standing policy must be an object')
    return value


def review_context(policy, project_policy=None):
    """Required instructions, not a copy of credentials or unrelated agent history."""
    values=['Review directives:']
    for source in (policy,project_policy or {}):
        for rule in source.get('review_directives',[]):
            values.append('- '+rule['id']+': '+rule['instruction'])
    commit=policy.get('commits',{})
    if commit.get('require_review'): values.append('- Every commit needs review of its exact staged tree.')
    if commit.get('dco_signoff'): values.append('- Require DCO Signed-off-by trailers; this is distinct from cryptographic signing.')
    if commit.get('no_ai_coauthors'): values.append('- Credit human contributors appropriately; no AI Co-authored-by trailers.')
    return '\n'.join(values)


def valid_message(message, policy):
    commit=policy.get('commits',{})
    if commit.get('dco_signoff') and not re.search(r'^Signed-off-by: .+ <[^<>\s]+@[^<>\s]+>$',message,re.M):
        raise PolicyError('a DCO Signed-off-by trailer is required; use git commit -s')
    if commit.get('no_ai_coauthors'):
        agents=commit.get('ai_author_patterns',['codex','claude','chatgpt','copilot','openai','anthropic','\\[bot\\]'])
        for line in message.splitlines():
            if line.lower().startswith('co-authored-by:') and any(re.search(pattern,line,re.I) for pattern in agents):
                raise PolicyError('AI co-author trailers are disabled by owner policy')


def anonymity_pattern(policy):
    """Whole-word, case-sensitive matcher for the owner's agent names; None when the rule is off."""
    rule=policy.get('agent_anonymity') or {}
    names=sorted({n.strip() for n in rule.get('agent_names',[]) if isinstance(n,str) and n.strip()},key=len,reverse=True)
    if not names: return None
    return re.compile(r'(?<![A-Za-z0-9_])(?:'+'|'.join(map(re.escape,names))+r')(?![A-Za-z0-9_])')


def text_violations(text, pattern, where):
    return [{'where':where,'line':number,'name':match.group(0)}
            for number,line in enumerate(text.splitlines(),1) for match in pattern.finditer(line)]


def added_lines(diff):
    """(path, new line number, text) for every ADDED line of a unified diff.

    Hunk headers give exact line counts, so an added line whose own text starts with
    '++' or 'diff --git' is never mistaken for a file header."""
    path=None; old=new=0; number=0
    for line in diff.splitlines():
        if old>0 or new>0:
            if line.startswith('+'): yield path,number,line[1:]; number+=1; new-=1
            elif line.startswith('-'): old-=1
            elif line.startswith(' '): number+=1; old-=1; new-=1
            continue                                  # '\ No newline at end of file'
        if line.startswith('diff --git '): path=None
        elif line.startswith('+++ '):
            target=line[4:]
            path=None if target=='/dev/null' else (target[2:] if target.startswith('b/') else target)
        elif line.startswith('@@'):
            match=re.match(r'@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@',line)
            if not match: raise PolicyError('unparseable diff hunk header: '+line[:80])
            old=int(match.group(1) or 1); number=int(match.group(2)); new=int(match.group(3) or 1)


def staged_diff(repo):
    return subprocess.check_output(['git','-C',str(repo),'diff','--cached','-U0','--no-color','--no-ext-diff',
                                    '--no-renames','--src-prefix=a/','--dst-prefix=b/'],text=True,errors='replace')


def anonymity_violations(policy, message=None, diff=None):
    """Agent names in a commit message / PR text and in the added lines of a diff, minus allow_paths."""
    pattern=anonymity_pattern(policy)
    if pattern is None: return []
    allowed=(policy.get('agent_anonymity') or {}).get('allow_paths',[])
    found=text_violations(message,pattern,'message') if message else []
    for path,number,text in added_lines(diff or ''):
        if path is None or any(fnmatch.fnmatchcase(path,glob) for glob in allowed): continue
        found+=[{'where':path,'line':number,'name':match.group(0)} for match in pattern.finditer(text)]
    return found


def check_anonymity(policy, message=None, diff=None):
    found=anonymity_violations(policy,message,diff)
    if found:
        shown='; '.join('%s:%s %s'%(v['where'],v['line'],v['name']) for v in found[:10])
        raise PolicyError('agent names are not allowed by owner policy (agent_anonymity): '+shown
                          +(' (+%d more)'%(len(found)-10) if len(found)>10 else ''))


def check_review(receipt, revision, author, directives=()):
    if receipt.get('revision')!=revision: raise PolicyError('review does not match the current revision')
    if receipt.get('approved') is not True or receipt.get('unresolved_findings',0):
        raise PolicyError('review has unresolved findings or no approval')
    if not receipt.get('reviewer') or receipt['reviewer']==author:
        raise PolicyError('review must identify an independent reviewer')
    covered=set(receipt.get('covered_directives',[]))
    if set(directives)-covered: raise PolicyError('review did not address required design directives')
    if not receipt.get('evidence'): raise PolicyError('review requires durable evidence')


def staged_tree(repo):
    return subprocess.check_output(['git','-C',str(repo),'write-tree'],text=True).strip()


def check_commit(repo, policy, receipt, message=None):
    tree=staged_tree(repo)
    if policy.get('agent_anonymity'): check_anonymity(policy,message,staged_diff(repo))
    if policy.get('commits',{}).get('require_review'):
        check_review(receipt,tree,os.environ.get('FLEET_AGENT_ID','implementer'),
                     [r['id'] for r in policy.get('review_directives',[])])
    if message is not None: valid_message(message,policy)
    return {'allowed':True,'tree':tree}


def merge_decision(pr, review, policy):
    repo=policy.get('repositories',{}).get(pr.get('repository'),{})
    if not repo.get('auto_merge',False): return {'action':'owner_review','reason':'automatic merging is not enabled for this repository'}
    if pr.get('draft') or pr.get('mergeable')!='MERGEABLE': return {'action':'wait','reason':'PR is draft, conflicting or not yet known mergeable'}
    for path in pr.get('files',[]):
        if any(fnmatch.fnmatchcase(path,pattern) for pattern in repo.get('owner_review_paths',[])):
            return {'action':'owner_review','reason':'change touches an owner-reviewed area'}
    if set(pr.get('labels',[])) & set(repo.get('owner_review_labels',[])):
        return {'action':'owner_review','reason':'PR carries an owner-review label'}
    checks=pr.get('checks',{})
    if not repo.get('required_checks'): return {'action':'owner_review','reason':'required checks are not configured'}
    if any(checks.get(name)!='SUCCESS' for name in repo['required_checks']):
        return {'action':'wait','reason':'required checks have not all passed'}
    try:
        check_review(review,pr['head_sha'],pr.get('author_agent'),
                     [r['id'] for r in policy.get('review_directives',[])])
        if set(review.get('reviewed_files',[]))!=set(pr.get('files',[])):
            raise PolicyError('review does not cover every changed file')
        messages=pr.get('commit_messages',[])
        if not messages: raise PolicyError('commit messages have not been checked')
        for message in messages: valid_message(message,policy)
    except PolicyError as error:
        return {'action':'adversarial_review','reason':str(error)}
    return {'action':'auto_merge','reason':'current revision passed configured review and checks',
            'head_sha':pr['head_sha'],'method':repo.get('merge_method','rebase')}


class GitHub:
    """Run on the credential-owning broker, outside writable agent mounts."""
    def __init__(self, token_env='GH_TOKEN'):
        self.token=os.environ.get(token_env)
        if not self.token: raise PolicyError('GitHub broker credential is unavailable')

    def call(self,method,path,body=None):
        if not path.startswith('/repos/') or '..' in path: raise PolicyError('unsupported GitHub route')
        headers={'Authorization':'Bearer '+self.token,'Accept':'application/vnd.github+json',
                 'X-GitHub-Api-Version':'2022-11-28','Content-Type':'application/json'}
        request=urllib.request.Request('https://api.github.com'+path,
            data=json.dumps(body).encode() if body is not None else None,method=method,headers=headers)
        with urllib.request.urlopen(request,timeout=30) as response: return json.load(response)

    def snapshot(self,repository,number):
        if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+',repository) or not isinstance(number,int) or number<=0:
            raise PolicyError('invalid repository or PR number')
        base='/repos/'+repository; path=base+'/pulls/'+str(number)
        pr=self.call('GET',path); head=pr['head']['sha']
        # Paginate complete file/commit/check lists; never infer a small diff from a truncated first page.
        def pages(route):
            values=[]
            for page in range(1,101):
                result=self.call('GET',route+('&' if '?' in route else '?')+'per_page=100&page='+str(page))
                items=result.get('check_runs',[]) if isinstance(result,dict) else result
                values.extend(items)
                if len(items)<100: return values
            raise PolicyError('PR metadata exceeds bounded pagination')
        files=pages(path+'/files'); commits=pages(path+'/commits')
        runs=pages(base+'/commits/'+head+'/check-runs')
        statuses=self.call('GET',base+'/commits/'+head+'/status')
        checks={item['name']:str(item.get('conclusion') or item.get('status','')).upper() for item in reversed(runs)}
        checks.update({s['context']:'SUCCESS' if s['state']=='success' else s['state'].upper() for s in statuses.get('statuses',[])})
        if len(files)!=pr['changed_files']: raise PolicyError('GitHub did not return the complete changed-file list')
        return {'repository':repository,'number':number,'head_sha':head,'draft':pr['draft'],
                'mergeable':'MERGEABLE' if pr.get('mergeable') is True else 'UNKNOWN',
                'author_agent':pr['user']['login'],'files':[f['filename'] for f in files],
                'labels':[label['name'] for label in pr['labels']],'checks':checks,
                'commit_messages':[c['commit']['message'] for c in commits]}

    def merge(self,repository,number,review,policy):
        snapshot=self.snapshot(repository,number)
        decision=merge_decision(snapshot,review,policy)
        if decision['action']!='auto_merge': return decision
        # SHA match makes a concurrent new commit fail rather than merging unreviewed code.
        return self.call('PUT','/repos/'+repository+'/pulls/'+str(number)+'/merge',
                         {'sha':decision['head_sha'],'merge_method':decision['method']})


def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--policy',type=Path,default=os.environ.get('FLEET_STANDING_POLICY'))
    sub=parser.add_subparsers(dest='action',required=True)
    check=sub.add_parser('check-commit'); check.add_argument('--repo',type=Path,default=Path.cwd()); check.add_argument('--receipt',type=Path,required=True); check.add_argument('--message-file',type=Path)
    review=sub.add_parser('review-context'); review.add_argument('--project-policy',type=Path)
    anonymity=sub.add_parser('check-anonymity',help='scan a message/PR text and optionally the staged diff')
    anonymity.add_argument('--text-file',type=Path); anonymity.add_argument('--staged',type=Path,metavar='REPO')
    merge=sub.add_parser('merge'); merge.add_argument('repository'); merge.add_argument('number',type=int); merge.add_argument('--receipt',type=Path,required=True)
    args=parser.parse_args(argv)
    if not args.policy: parser.error('select an owner-controlled standing policy')
    policy=read_policy(args.policy)
    if args.action=='review-context':
        print(review_context(policy,read_policy(args.project_policy) if args.project_policy else None)); return 0
    if args.action=='check-anonymity':
        found=anonymity_violations(policy,args.text_file.read_text() if args.text_file else None,
                                   staged_diff(args.staged) if args.staged else None)
        print(json.dumps({'allowed':not found,'violations':found})); return 0 if not found else 1
    receipt=json.loads(args.receipt.read_text())
    if args.action=='check-commit': result=check_commit(args.repo,policy,receipt,args.message_file.read_text() if args.message_file else None)
    else: result=GitHub(policy.get('github',{}).get('token_env','GH_TOKEN')).merge(args.repository,args.number,receipt,policy)
    print(json.dumps(result)); return 0

if __name__=='__main__': raise SystemExit(main())
