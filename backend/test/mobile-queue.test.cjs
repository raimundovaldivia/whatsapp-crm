const { test }=require('node:test');const assert=require('node:assert/strict');const vm=require('node:vm');const fs=require('node:fs');const path=require('node:path');
function queue(createExpense, storage=new Map(), session={token:'a',user:{id:1},baseUrl:'https://test.invalid'}){
 const context={AsyncStorage:{getItem:async k=>storage.get(k),setItem:async(k,v)=>storage.set(k,v)},getSavedSession:async()=>session,createExpense};
 vm.createContext(context);let code=fs.readFileSync(path.resolve(__dirname,'../../mobile/src/utils/expenseQueue.js'),'utf8').replace(/^import .*;\r?\n/gm,'').replace(/export /g,'');vm.runInContext(code,context);
 return {call:code=>vm.runInContext(code,context),storage,session};
}
test('enqueue during flush preserves new expense and original request ID',async()=>{
 let release,started;const began=new Promise(r=>started=r),pending=new Promise(r=>release=r);const sent=[];
 const q=queue(async payload=>{sent.push(payload);started();await pending});
 await q.call("enqueueExpense({amount:100,clientRequestId:'expense_first'})");const flush=q.call('flushExpenses()');await began;
 await q.call("enqueueExpense({amount:200,clientRequestId:'expense_second'})");release();await flush;
 assert.equal(await q.call('pendingCount()'),1);assert.equal(sent[0].clientRequestId,'expense_first');
});
test('network retry preserves idempotency key, rejects are retained, other users see no expenses',async()=>{
 const ids=[];let failure=true;
 const q=queue(async payload=>{ids.push(payload.clientRequestId);if(failure)throw Error('timeout')});
 await q.call("enqueueExpense({amount:100,clientRequestId:'expense_same'})");await q.call('flushExpenses()');failure=false;await q.call('flushExpenses()');
 assert.deepEqual(ids,['expense_same','expense_same']);assert.equal(await q.call('pendingCount()'),0);
 await q.call("enqueueExpense({amount:200,clientRequestId:'expense_private'})");q.session.user.id=2;assert.equal(await q.call('pendingCount()'),0);
});
test('storage failure is reported instead of pretending the expense was saved',async()=>{
 const q=queue(async()=>{});q.storage.set=()=>{throw Error('disk full')};await assert.rejects(()=>q.call('enqueueExpense({amount:100})'),/disk full/);
});
