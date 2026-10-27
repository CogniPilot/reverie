#define _GNU_SOURCE
/* Fixed, libc-only lease peer. Production accepts no argv or path selection.
 * Build with -static -no-pie. Only the broker's closed framed protocol is read. */
#include <ctype.h>
#include <errno.h>
#include <fcntl.h>
#include <math.h>
#include <poll.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

#define MAX_MESSAGE 32768
#define MAX_FIELDS 8
#define MAX_VALUE 2048
static int descriptors[32], descriptor_count;
static int leasefd=-1,tmpfd=-1,fixture=-1,held=-1,reserved=-1,leasefixture=-1,barrier=-1,probe=-1;
static char attempt[37],nonce[65],tmpname[80],leasename[80],probename[96],reservename[96];
static char heldkey[64],reservedkey[64],barrierkey[64],probekey[64],fixturekey[64],leasefixturekey[64],reservekey[64],rootkey[64];
static int reservation_created,probe_created,root_known;
static double lifetime;
struct field { char name[64],value[MAX_VALUE]; int string; };
struct object { struct field fields[MAX_FIELDS]; int count; };
static void fail(void);
static double mono(void) { struct timespec t; if(clock_gettime(CLOCK_MONOTONIC,&t))fail();return t.tv_sec+t.tv_nsec/1e9; }
static double wall(void) { struct timespec t; if(clock_gettime(CLOCK_REALTIME,&t))fail();return t.tv_sec+t.tv_nsec/1e9; }
static int keep(int fd) { if(fd<0 || descriptor_count>=32)fail();descriptors[descriptor_count++]=fd;return fd; }
static void identity(struct stat *s,char *out) { snprintf(out,64,"%llu-%llu",(unsigned long long)s->st_dev,(unsigned long long)s->st_ino); }
static void fdkey(int fd,char *out) { struct stat s;if(fstat(fd,&s))fail();identity(&s,out); }
static int same(int parent,const char *name,const char *expected) { struct stat s;char key[64];if(fstatat(parent,name,&s,AT_SYMLINK_NOFOLLOW))return 0;identity(&s,key);return !strcmp(key,expected); }
static int waitfd(int fd,short events,double end) { for(;;){double left=end-mono();if(left<=0)return 0;struct pollfd p={fd,events,0};int n=poll(&p,1,(int)ceil(left*1000));if(n<0&&errno==EINTR)continue;return n>0&&(p.revents&(events|POLLHUP));} }
static int ioexact(int fd,void *data,size_t size,int write_,double end) { size_t done=0;while(done<size){if(!waitfd(fd,write_?POLLOUT:POLLIN,end))return 0;ssize_t n=write_?write(fd,(char*)data+done,size-done):read(fd,(char*)data+done,size-done);if(n<0&&(errno==EINTR||errno==EAGAIN))continue;if(n<=0)return 0;done+=(size_t)n;}return 1; }
static int sendjson(const char *data) { size_t n=strlen(data);unsigned char h[4]={(n>>24)&255,(n>>16)&255,(n>>8)&255,n&255};double end=mono()+2;return n<=MAX_MESSAGE&&ioexact(1,h,4,1,end)&&ioexact(1,(void*)data,n,1,end); }
static void whitespace(const char **p) { while(isspace((unsigned char)**p))++*p; }
static int string(const char **p,char *out,size_t cap) { if(*(*p)++!='"')return 0;size_t n=0;while(**p&&**p!='"'){unsigned char c=(unsigned char)*(*p)++;if(c<32||c>=127||c=='\\'||n+1>=cap)return 0;out[n++]=(char)c;}if(**p!='"')return 0;++*p;out[n]=0;return 1; }
static int parse(const char *data,struct object *o) { memset(o,0,sizeof(*o));const char *p=data;whitespace(&p);if(*p++!='{')return 0;for(;;){whitespace(&p);if(*p=='}'){p++;break;}if(o->count>=MAX_FIELDS)return 0;struct field *f=&o->fields[o->count];if(!string(&p,f->name,sizeof(f->name)))return 0;for(int i=0;i<o->count;i++)if(!strcmp(f->name,o->fields[i].name))return 0;whitespace(&p);if(*p++!=':')return 0;whitespace(&p);f->string=*p=='"';if(f->string){if(!string(&p,f->value,sizeof(f->value)))return 0;}else{const char *start=p;if(*p=='-')p++;if(!isdigit((unsigned char)*p))return 0;while(isdigit((unsigned char)*p)||*p=='.'||*p=='e'||*p=='E'||*p=='+'||*p=='-')p++;size_t n=(size_t)(p-start);if(n>=sizeof(f->value))return 0;memcpy(f->value,start,n);f->value[n]=0;char *end;double v=strtod(f->value,&end);if(*end||!isfinite(v))return 0;}o->count++;whitespace(&p);if(*p=='}'){p++;break;}if(*p++!=',')return 0;}whitespace(&p);return !*p; }
static const char *get(struct object *o,const char *name,int is_string) { for(int i=0;i<o->count;i++)if(!strcmp(o->fields[i].name,name)){if(o->fields[i].string!=is_string)fail();return o->fields[i].value;}fail();return NULL; }
static void receive(struct object *o,double end) { unsigned char h[4];char data[MAX_MESSAGE+1];if(!ioexact(0,h,4,0,end))fail();uint32_t n=((uint32_t)h[0]<<24)|((uint32_t)h[1]<<16)|((uint32_t)h[2]<<8)|h[3];if(!n||n>MAX_MESSAGE||!ioexact(0,data,n,0,end))fail();data[n]=0;if(!parse(data,o))fail(); }
static int hex(const char *s,size_t size) { if(strlen(s)!=size)return 0;for(size_t i=0;i<size;i++)if(!strchr("0123456789abcdef",s[i]))return 0;return 1; }
static int uuid_(const char *s) { if(strlen(s)!=36)return 0;for(int i=0;i<36;i++)if(i==8||i==13||i==18||i==23){if(s[i]!='-')return 0;}else if(!strchr("0123456789abcdef",s[i]))return 0;return 1; }
static int directory(const char *path) { if(path[0]!='/')fail();int fd=open("/",O_RDONLY|O_DIRECTORY|O_CLOEXEC);if(fd<0)fail();char copy[2048];if(strlen(path)>=sizeof(copy))fail();strcpy(copy,path+1);char *save,*part=strtok_r(copy,"/",&save);while(part){if(!strcmp(part,".")||!strcmp(part,".."))fail();int next=openat(fd,part,O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);close(fd);if(next<0)fail();fd=next;part=strtok_r(NULL,"/",&save);}struct stat s;if(fstat(fd,&s)||s.st_uid!=geteuid())fail();return keep(fd); }
static int mkdir_(int parent,const char *name) { if(mkdirat(parent,name,0700))fail();int fd=keep(openat(parent,name,O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC));struct stat s;if(fstat(fd,&s)||s.st_uid!=geteuid())fail();return fd; }
static int lockfile(int parent,const char *name,int create,int exclusive) { int fd=keep(openat(parent,name,O_RDWR|O_NOFOLLOW|O_NONBLOCK|O_CLOEXEC|(create?O_CREAT:0)|(exclusive?O_EXCL:0),0600));struct stat s;if(fstat(fd,&s)||!S_ISREG(s.st_mode)||s.st_uid!=geteuid()||s.st_nlink!=1)fail();return fd; }
static int remove_known(int parent,const char *name,const char *expected,int dir) { return same(parent,name,expected)&&!unlinkat(parent,name,dir?AT_REMOVEDIR:0); }
static int cleanup(void) { int ok=1;if(reservation_created)ok=remove_known(leasefd,reservename,reservekey,0)&&ok;if(probe_created)ok=remove_known(leasefd,probename,probekey,0)&&ok;if(root_known)ok=remove_known(leasefixture,"barrier.lock",rootkey,0)&&ok;if(leasefixture>=0)ok=remove_known(leasefd,leasename,leasefixturekey,1)&&ok;if(reserved>=0)ok=remove_known(fixture,"reserved",reservedkey,1)&&ok;if(held>=0)ok=remove_known(fixture,"held",heldkey,1)&&ok;if(fixture>=0)ok=remove_known(tmpfd,tmpname,fixturekey,1)&&ok;for(int i=descriptor_count-1;i>=0;i--)close(descriptors[i]);descriptor_count=0;return ok; }
static void fail(void) { cleanup();sendjson("{\"status\":\"FAILED\",\"error\":\"peer-control-unconfirmed\"}");_exit(2); }
static void pause_(double duration) { struct timespec t={(time_t)duration,(long)((duration-floor(duration))*1e9)};while(nanosleep(&t,&t)&&errno==EINTR){} }
int main(int argc,char **argv) {
 const char *home="/home/agent",*temporary="/tmp";
#ifdef REVERIE_TEST_ROOTS
 if(argc!=3){return 64;}
 home=argv[1];temporary=argv[2];
#else
 (void)argv;if(argc!=1)return 64;
#endif
 if(geteuid()==0){return 77;}
 if(prctl(PR_SET_DUMPABLE,0,0,0,0)){return 2;}
 for(int fd=0;fd<=1;fd++){int flags=fcntl(fd,F_GETFL);if(flags<0||fcntl(fd,F_SETFL,flags|O_NONBLOCK))return 2;}
 struct object start;receive(&start,mono()+10);if(start.count!=5||strcmp(get(&start,"version",0),"1"))fail();const char *a=get(&start,"attemptId",1),*n=get(&start,"nonce",1),*sub=get(&start,"leaseSubdirectory",1);if(!uuid_(a)||!hex(n,64))fail();strcpy(attempt,a);strcpy(nonce,n);if(!*sub||*sub=='/'||strstr(sub,"//")||sub[strlen(sub)-1]=='/'||strlen(sub)>1024)fail();for(const char *p=sub;*p;p++)if(!isalnum((unsigned char)*p)&&!strchr("._-/",*p))fail();char copied[1025];strcpy(copied,sub);char *save,*part=strtok_r(copied,"/",&save);while(part){if(!strcmp(part,".")||!strcmp(part,".."))fail();part=strtok_r(NULL,"/",&save);}
 double expiry=strtod(get(&start,"expiresAt",0),NULL),left=expiry-wall();if(!isfinite(expiry)||left<75||left>600)fail();lifetime=mono()+left;
 char path[2048];if(snprintf(path,sizeof(path),"%s/%s",home,sub)>=(int)sizeof(path))fail();leasefd=directory(path);tmpfd=directory(temporary);
 snprintf(tmpname,sizeof(tmpname),".reverie-lease-gate-%s",attempt);snprintf(leasename,sizeof(leasename),".acceptance-%s",attempt);snprintf(probename,sizeof(probename),"acceptance-%s.probe.lock",attempt);
 fixture=mkdir_(tmpfd,tmpname);fdkey(fixture,fixturekey);held=mkdir_(fixture,"held");fdkey(held,heldkey);reserved=mkdir_(fixture,"reserved");fdkey(reserved,reservedkey);leasefixture=mkdir_(leasefd,leasename);fdkey(leasefixture,leasefixturekey);
 barrier=lockfile(leasefd,"barrier.lock",1,0);fdkey(barrier,barrierkey);if(flock(barrier,LOCK_SH|LOCK_NB))fail();char heldlock[96];snprintf(heldlock,sizeof(heldlock),"%s.lock",heldkey);int h=lockfile(leasefd,heldlock,1,0);if(flock(h,LOCK_SH|LOCK_NB))fail();probe=lockfile(leasefd,probename,1,1);probe_created=1;fdkey(probe,probekey);if(flock(probe,LOCK_EX|LOCK_NB))fail();
 snprintf(reservename,sizeof(reservename),"%s.reserve.json",reservedkey);int r=openat(leasefd,reservename,O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW|O_CLOEXEC,0600);if(r<0)fail();fdkey(r,reservekey);reservation_created=1;char data[4096];int size=snprintf(data,sizeof(data),"{\"version\":1,\"created_utc\":%.9f,\"until_utc\":%.9f}",wall(),expiry);if(write(r,data,(size_t)size)!=size||fsync(r)){close(r);fail();}close(r);if(flock(barrier,LOCK_UN))fail();
 snprintf(data,sizeof(data),"{\"status\":\"PREPARED\",\"attemptId\":\"%s\",\"nonce\":\"%s\",\"uid\":%u,\"gid\":%u,\"probe\":{\"heldKey\":\"%s\",\"reservedKey\":\"%s\",\"barrierKey\":\"%s\",\"probeKey\":\"%s\",\"leaseFixtureKey\":\"%s\",\"tmpFixtureKey\":\"%s\"}}",attempt,nonce,geteuid(),getegid(),heldkey,reservedkey,barrierkey,probekey,leasefixturekey,fixturekey);if(!sendjson(data))fail();
 int state=0;for(;;){struct object request;receive(&request,lifetime);if(request.count!=4||strcmp(get(&request,"version",0),"1")||strcmp(get(&request,"attemptId",1),attempt)||strcmp(get(&request,"nonce",1),nonce))fail();const char *method=get(&request,"method",1);if(!strcmp(method,"retireOwn"))break;if((state!=0||strcmp(method,"during"))&&(state!=1||strcmp(method,"after")))fail();int root=lockfile(leasefixture,"barrier.lock",0,0);struct stat info;if(fstat(root,&info)||(info.st_mode&0777)!=0600)fail();fdkey(root,rootkey);root_known=1;if(flock(root,LOCK_SH|LOCK_NB)||flock(root,LOCK_UN))fail();double began=mono();const char *status;
 if(!strcmp(method,"during")){double end=began+5;for(;;){if(!flock(barrier,LOCK_SH|LOCK_NB)){flock(barrier,LOCK_UN);fail();}if(errno!=EWOULDBLOCK&&errno!=EAGAIN)fail();if(mono()>=end)break;pause_(.025);}status="REFUSED";}else{if(flock(barrier,LOCK_SH|LOCK_NB)||flock(barrier,LOCK_UN))fail();status="ACQUIRED";}
 if(!same(leasefd,"barrier.lock",barrierkey)||!same(leasefixture,"barrier.lock",rootkey)){fail();}
 snprintf(data,sizeof(data),"{\"status\":\"%s\",\"phase\":\"%s\",\"attemptId\":\"%s\",\"nonce\":\"%s\",\"durationSeconds\":%.9f,\"barrierKey\":\"%s\",\"rootBarrierKey\":\"%s\",\"rootBarrierUid\":%u,\"rootBarrierGid\":%u,\"rootBarrierMode\":384,\"uid\":%u}",status,method,attempt,nonce,mono()-began,barrierkey,rootkey,info.st_uid,info.st_gid,geteuid());if(!sendjson(data))fail();state++;
 }
 if(!cleanup()){sendjson("{\"status\":\"FAILED\",\"error\":\"cleanup-unconfirmed\"}");return 2;}snprintf(data,sizeof(data),"{\"status\":\"RETIRED\",\"attemptId\":\"%s\",\"nonce\":\"%s\",\"cleanupComplete\":true}",attempt,nonce);return sendjson(data)?0:2;
}
