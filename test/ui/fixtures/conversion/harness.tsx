import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { EntryForm } from '../../../../src/features/entries/EntryForm';

// This is a real browser-mounted component test. Only preferences and the FX
// transport are synthetic; production EntryForm, hook, fetcher and math are bundled unchanged.
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
type FxRequest = { url: string; signal?: AbortSignal; resolve: (value: Response) => void; reject: (error: Error) => void; done: boolean };
let requests: FxRequest[] = [], saved: any[] = [], key = 0;
const failures: string[] = [], checks: string[] = [];
let selected = 'all', expectedCount = 0, completed = false;
const scenarios = [
  'manual rate wins over late aborted fetch; exact manual payload saved',
  'manual converted amount wins over late fetch and derives its rate',
  'currency-pair change aborts old request and accepts only new pair',
  'toggle off aborts; each later automatic enable fetches fresh quote',
  'unmount aborts pending FX without an account or network action',
  'fetch failure stays actionable; manual fallback remains usable and saves',
  'saved manual conversion retains original amount/pair and is not silently fetched',
  'unresolved selected conversion blocks submission with visible guidance',
];
const subject = document.getElementById('subject')!, output = document.getElementById('output')!;
const root = createRoot(subject);
const assert = (value: unknown, message: string) => { if (!value) throw new Error(message); };
const equal = (a: unknown, b: unknown, message: string) => assert(JSON.stringify(a) === JSON.stringify(b), `${message}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
const settle = async (action: () => unknown = () => {}) => { await act(async () => { action(); await Promise.resolve(); }); };
globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
  const text = String(url);
  if (!/^https:\/\/api\.frankfurter\.dev\/v2\/rate\/[A-Z]{3}\/[A-Z]{3}$/.test(text)) return Promise.reject(new Error('Blocked non-FX request in synthetic fixture'));
  assert(init?.credentials === 'omit' && init?.referrerPolicy === 'no-referrer' && init?.cache === 'no-store' && init?.redirect === 'error', 'FX privacy options changed');
  return new Promise((resolve, reject) => requests.push({ url: text, signal: init?.signal ?? undefined, resolve, reject, done: false }));
}) as typeof fetch;
const initial = { currency: 'USD', amount_minor: 10000, ts: Date.UTC(2026, 8, 27), txn_type: 'settlement' as const };
async function mount(extra: any = {}) {
  await settle(() => root.render(null)); requests = []; saved = [];
  await settle(() => root.render(<EntryForm key={++key} myPrincipal="synthetic-author" partnerPrincipal="synthetic-partner" initial={{...initial, ...extra}} onCancel={() => {}} onSubmit={async value => { saved.push(value); }} />));
}
function input(label: string): HTMLInputElement | HTMLSelectElement {
  for (const element of subject.querySelectorAll('label')) if (element.querySelector('span')?.textContent === label) {
    const control = element.querySelector('input,select'); if (control) return control as HTMLInputElement | HTMLSelectElement;
  }
  throw new Error('Missing actual form control: ' + label);
}
const exchange = () => subject.querySelector('input[step="any"]') as HTMLInputElement;
const converted = () => [...subject.querySelectorAll('label')].find(x => x.querySelector('span')?.textContent?.startsWith('Converted amount ('))!.querySelector('input')!;
const toggle = () => subject.querySelector('.conversion-toggle input') as HTMLInputElement;
async function type(element: HTMLInputElement | HTMLSelectElement, value: string) {
  await settle(() => { const proto = element.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(element, value); element.dispatchEvent(new Event(element.tagName === 'SELECT' ? 'change' : 'input', {bubbles:true})); });
}
async function click(element: HTMLElement) { await settle(() => element.click()); }
async function respond(index: number, rate: number) {
  const request=requests[index];assert(request&&!request.done,'Missing pending synthetic request');request.done=true;
  const [base,quote]=request.url.split('/').slice(-2);
  await settle(() => request.resolve({ok:true,status:200,json:async()=>({base,quote,rate,date:'2026-09-27'})} as Response));
}
async function reject(index: number) { const request=requests[index];assert(request&&!request.done,'Missing pending request');request.done=true;await settle(()=>request.reject(new TypeError('Failed to fetch: synthetic private detail'))); }
async function submit() { await settle(() => (subject.querySelector('form') as HTMLFormElement).requestSubmit()); }
async function check(name: string, body: () => Promise<void>) { if (selected !== 'all' && selected !== name) return; try { await body();checks.push(name); } catch(error) { failures.push(name+': '+String(error)); } }
function show() { output.dataset.complete=String(completed);output.textContent=JSON.stringify({kind:'actual mounted EntryForm/useCurrencyConversion synthetic browser qualification',passed:completed&&expectedCount>0&&failures.length===0&&checks.length===expectedCount,expectedTests:expectedCount,completed,checks,failures,noRealNetwork:true,noAccountsOrStorage:true,pending:requests.filter(x=>!x.done).length,savedSyntheticPayloads:saved},null,2); }

async function runAll() {
  selected = (document.getElementById('scenario') as HTMLSelectElement).value;
  assert(selected === 'all' || scenarios.includes(selected), 'Unknown scenario must not produce an empty pass');
  expectedCount = selected === 'all' ? scenarios.length : 1;
  completed = false;
  checks.length=0;failures.length=0;
  show();
  (document.getElementById('run') as HTMLButtonElement).disabled=true;
  await check('manual rate wins over late aborted fetch; exact manual payload saved',async()=>{
    await mount();await click(toggle());equal(requests.length,1,'one initial request');
    assert(!exchange().disabled&&!converted().disabled,'Manual inputs disabled during fetch');
    await type(exchange(),'50');assert(requests[0].signal?.aborted,'Manual edit did not abort');await respond(0,2);
    equal(exchange().value,'50','Late rate overwrote manual');equal(converted().value,'5000.00','Manual converted amount');
    await submit();equal(saved.length,1,'Save');equal(saved[0].amount_minor,500000,'Manual minor units');equal(saved[0].convert.rate_source,'manual','Manual provenance');
  });
  await check('manual converted amount wins over late fetch and derives its rate',async()=>{
    await mount();await click(toggle());await type(converted(),'123.45');await respond(0,99);
    equal(converted().value,'123.45','Late response overwrote target');equal(exchange().value,'1.2345','Derived rate');
    await submit();equal(saved[0].convert.to_amount_minor,12345,'Exact manual target');equal(saved[0].amount_minor,12345,'Saved target');
  });
  await check('currency-pair change aborts old request and accepts only new pair',async()=>{
    await mount();await click(toggle());await type(input('Convert to'),'GBP');equal(requests.length,2,'New pair request');assert(requests[0].signal?.aborted,'Old pair not aborted');
    await respond(0,2);equal(exchange().value,'','Old pair leaked');await respond(1,3);equal(exchange().value,'3','New pair rate');
    await submit();equal(saved[0].currency,'GBP','New target currency');equal(saved[0].amount_minor,30000,'New pair target');
  });
  await check('toggle off aborts; each later automatic enable fetches fresh quote',async()=>{
    await mount();await click(toggle());await click(toggle());assert(requests[0].signal?.aborted,'Off did not abort');await respond(0,2);assert(!exchange(),'Conversion controls remain visible');
    await click(toggle());equal(requests.length,2,'Re-enable request');await respond(1,3);equal(exchange().value,'3','Fresh quote');
    await click(toggle());await click(toggle());equal(requests.length,3,'Fetched quote reused as cache');await respond(2,4);equal(exchange().value,'4','Newest quote');
  });
  await check('unmount aborts pending FX without an account or network action',async()=>{
    await mount();await click(toggle());const request=requests[0];await settle(()=>root.render(null));assert(request.signal?.aborted,'Unmount did not abort');await respond(0,3);equal(subject.childElementCount,0,'Late response remounted');
  });
  await check('fetch failure stays actionable; manual fallback remains usable and saves',async()=>{
    await mount();await click(toggle());await reject(0);
    const message=subject.querySelector('[role="status"]')?.textContent??'';assert(message.includes('enter the rate manually'),'Missing manual fallback');assert(!message.includes('private detail'),'Raw transport detail exposed');
    assert(!exchange().disabled&&!converted().disabled,'Manual fallback disabled');await type(converted(),'222.22');assert(!subject.querySelector('[role="status"]'),'Error not cleared on manual edit');
    await submit();equal(saved[0].amount_minor,22222,'Manual after failure');equal(saved[0].convert.rate_source,'manual','Manual provenance');
  });
  await check('saved manual conversion retains original amount/pair and is not silently fetched',async()=>{
    await mount({currency:'EGP',amount_minor:491200,convert:{from_currency:'USD',from_amount_minor:10000,to_currency:'EGP',to_amount_minor:491200,rate:49.12,rate_source:'manual',rate_fetched_at:1700000000000}});
    equal(input('Currency').value,'USD','Saved source currency');equal(input('Amount').value,'100.00','Saved source amount');equal(exchange().value,'49.12','Saved rate');equal(requests.length,0,'Unexpected saved-rate fetch');
    await click(toggle());await click(toggle());equal(requests.length,0,'Manual agreement replaced on toggle');await type(input('Amount'),'200');equal(converted().value,'9824.00','Rate retained when amount changes');
  });
  await check('unresolved selected conversion blocks submission with visible guidance',async()=>{
    await mount();await click(toggle());await reject(0);await submit();equal(saved.length,0,'Unresolved conversion silently saved');assert(subject.querySelector('[role="alert"]')?.textContent?.includes('Enter an exchange rate or converted amount'),'Missing save validation');
  });
  // Leave a representative editable form on screen for desktop/mobile alignment checks.
  await mount();await click(toggle());await reject(0);await type(exchange(),'50');completed=true;show();
  (document.getElementById('run') as HTMLButtonElement).disabled=false;
}
for (const name of scenarios) { const option=document.createElement('option');option.value=name;option.textContent=name;document.getElementById('scenario')!.append(option); }
document.getElementById('run')!.addEventListener('click',()=>void runAll());
document.getElementById('reset')!.addEventListener('click',()=>void mount().then(show));
document.getElementById('fail')!.addEventListener('click',()=>{const i=requests.findIndex(x=>!x.done);if(i>=0)void reject(i).then(show);});
document.getElementById('resolve')!.addEventListener('click',()=>{const i=requests.findIndex(x=>!x.done);if(i>=0)void respond(i,2).then(show);});
document.getElementById('width')!.addEventListener('click',()=>{const main=document.querySelector('main')!;main.classList.toggle('mobile');});
void mount().then(show);
