'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const html=fs.readFileSync(require('node:path').join(__dirname,'../ui/index.html'),'utf8');
test('brand label changes without corrupting source filter value',()=>{
 const el={options:[{outerHTML:'<option value="">題庫來源</option>'}]};
 const ctx=vm.createContext({$:()=>el});
 vm.runInContext(html.slice(html.indexOf('const displayName'),html.indexOf('const api ='))+'\n'+html.match(/function fillSelect[^\n]+/)[0],ctx);
 vm.runInContext("fillSelect('#sBank',[{v:'凱爺數學',c:437}])",ctx);
 assert.match(el.innerHTML,/value="凱爺數學">K數學（437）/);
});
test('search requests enough rows for all 437 K questions and reports failures',async()=>{
 const els={};const $=s=>els[s]??=(s==='#sBank'?{value:'凱爺數學'}:{value:''});
 let url;const ctx=vm.createContext({$,URLSearchParams,selected:new Set(),document:{querySelectorAll:()=>[]},updateSel(){},esc:x=>x,STATUS_LABEL:{none:'尚未分析'},api:async p=>{url=p;return Array.from({length:437},(_,i)=>({id:'q'+i,item_no:String(i+1)}))}});
 vm.runInContext(html.slice(html.indexOf('async function doSearch()'),html.indexOf('function updateSel()')),ctx);
 await ctx.doSearch();assert.equal(new URL(url,'https://example.test').searchParams.get('source_bank'),'凱爺數學');assert.equal(new URL(url,'https://example.test').searchParams.get('limit'),'1000');assert.match(els['#searchStatus'].textContent,/437/);assert.equal(els['#btnSearch'].disabled,false);
 ctx.api=async()=>{throw Error('連線失敗')};await ctx.doSearch();assert.match(els['#searchStatus'].textContent,/搜尋失敗：連線失敗/);assert.equal(els['#btnSearch'].disabled,false);
});
