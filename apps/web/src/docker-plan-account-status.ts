import { DOCKER_PROVIDER_VIEW_ENV } from './docker-employee-provider-view-native.js';
import { dockerPlanGeneration, type DockerPlanGeneration } from './docker-plan-install-data.js';
/** Fixed read-only stock CLI observation. Only the actor's actual selected
 * generation/configuration earns context; stdout is never account material. */
import { z } from 'zod';
export const DOCKER_PLAN_ACCOUNT_STATUS_PROGRAM = String.raw`
'use strict';
const cp=require('node:child_process');
try{
 const provider=process.argv[1];if(!['anthropic','openai'].includes(provider))throw Error();
 const args=provider==='anthropic'?['auth','status','--json']:['login','status'];
 const result=cp.spawnSync(provider==='anthropic'?'claude':'codex',args,{env:process.env,encoding:'utf8',timeout:8000,maxBuffer:65536,windowsHide:true});
 if(result.error||result.signal||result.status!==0)throw Error();
 if(provider==='anthropic'){
  const value=JSON.parse(result.stdout);if(value?.loggedIn!==true||value.apiProvider!=='firstParty'||typeof value.authMethod!=='string'||!value.authMethod)throw Error();
 }else if(!/^Logged in(?:\s|$)/i.test((result.stdout+'\n'+result.stderr).trim()))throw Error();
 process.stdout.write(JSON.stringify({version:1,purpose:'reverie-plan-account-status-v1',provider,authenticated:true})+'\n');
}catch{process.stderr.write('Native selected account status unconfirmed\n');process.exitCode=1;}
`;
export const DockerPlanAccountStatus = z
  .object({
    version: z.literal(1),
    purpose: z.literal('reverie-plan-account-status-v1'),
    provider: z.enum(['anthropic', 'openai']),
    authenticated: z.literal(true),
  })
  .strict();

/** Pure fixed argv DATA. The caller separately proves the current target. */
export function dockerPlanAccountStatusArguments(input: DockerPlanGeneration): readonly string[] {
  const paths = dockerPlanGeneration(input);
  return [
    'exec',
    ...DOCKER_PROVIDER_VIEW_ENV,
    '--env',
    (input.provider === 'anthropic' ? 'CLAUDE_CONFIG_DIR=' : 'CODEX_HOME=') + paths.configDir,
    '--workdir',
    '/',
    input.containerId,
    '/opt/reverie-worker-client/bin/node',
    '--no-global-search-paths',
    '--no-addons',
    '--input-type=commonjs',
    '-e',
    DOCKER_PLAN_ACCOUNT_STATUS_PROGRAM,
    '--',
    input.provider,
  ];
}
