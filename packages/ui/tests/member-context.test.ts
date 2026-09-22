import {beforeEach,expect,it,vi} from 'vitest';
const mocked=vi.hoisted(()=>({request:vi.fn()}));
vi.mock('../src/utils/api',()=>({request:mocked.request,ApiRequestError:class extends Error{status=0;}}));
beforeEach(()=>{vi.resetModules();mocked.request.mockReset();localStorage.clear();});
const account=(id:string)=>({id,authMode:'local',authenticated:true,mustChangePassword:false});
const prefs={selfMemberId:null,selfProfileChoice:'skipped',defaultMemberId:null};
it('all hidden members produce empty selection without unscoped reminder reads',async()=>{
 mocked.request.mockImplementation(async(path:string)=>path==='session'?account('a'):path==='members'?[{id:'hidden',hidden:true,permission:'viewer'}]:prefs);
 const app=(await import('../src/composables/useAppContext')).useAppContext();await app.load();
 expect(app.selectedMemberId.value).toBe('');expect(app.members.value).toHaveLength(0);expect(app.allMembers.value).toHaveLength(1);
 expect(mocked.request.mock.calls.some(([path])=>path.startsWith('reminders'))).toBe(false);
});
it('older member list response cannot overwrite a newer authorization refresh',async()=>{
 mocked.request.mockImplementation(async(path:string)=>path==='session'?account('a'):path==='members'?[]:prefs);
 const app=(await import('../src/composables/useAppContext')).useAppContext();await app.load();
 let resolveOld:(value:unknown)=>void=()=>{};
 mocked.request.mockImplementation((path:string)=>path==='members'?new Promise(resolve=>{resolveOld=resolve;}):Promise.resolve(prefs));
 const old=app.refreshMembers();
 mocked.request.mockImplementation(async(path:string)=>path==='members'?[]:prefs);
 await app.refreshMembers();resolveOld([{id:'revoked',hidden:false,permission:'manager'}]);await old;
 expect(app.allMembers.value).toHaveLength(0);expect(app.selectedMemberId.value).toBe('');
});
it('new account load clears prior health state before its session request completes',async()=>{
 mocked.request.mockImplementation(async(path:string)=>path==='session'?account('a'):path==='members'?[{id:'a-member',hidden:false,permission:'viewer'}]:path==='account/preferences'?prefs:[]);
 const app=(await import('../src/composables/useAppContext')).useAppContext();await app.load();expect(app.members.value).toHaveLength(1);
 let finish:(value:unknown)=>void=()=>{};
 mocked.request.mockImplementation((path:string)=>path==='session'?new Promise(resolve=>{finish=resolve;}):Promise.resolve(path==='members'?[]:prefs));
 const next=app.load();expect(app.members.value).toHaveLength(0);expect(app.selectedMemberId.value).toBe('');
 finish(account('b'));await next;expect(app.session.value?.id).toBe('b');expect(app.members.value).toHaveLength(0);
});
