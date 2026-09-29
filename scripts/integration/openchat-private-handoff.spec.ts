// Hand-authored synthetic model-output fixtures only. No user image files or network inference.
import {describe,it,expect,vi,beforeEach} from "vitest";
import {readFileSync} from "node:fs";
import {dirname,resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {createHash} from "node:crypto";
import {createContext,runInContext} from "node:vm";
import {TextEncoder,TextDecoder} from "node:util";
const runtime=vi.hoisted(()=>({infer:vi.fn(),model:"qwen3-vl-2b-instruct-q4",ocr:vi.fn(),remote:vi.fn()}));
vi.mock("@oc-test/onDeviceInference",()=>({inferOnDevice:runtime.infer,inferOnDeviceTextOnlyNoProjector:runtime.infer,onDeviceInferenceCapability:()=>({available:true,runtimesSupported:["llama-cpp"],selectedModalities:["image","text"]}),usesWebInferenceRuntime:()=>true,isNativeClient:()=>false}));
vi.mock("@oc-test/webInference",()=>({browserImageModelFirstReadiness:async()=>({available:true}),browserTextModelReadiness:async()=>({available:true}),webImageInferenceEvidence:()=>undefined,webModelCatalogId:()=>runtime.model}));
vi.mock("@oc-test/browserOcr",()=>({recognizeBrowserImage:runtime.ocr,disposeBrowserOcr:async()=>{}}));
vi.mock("@oc-test/ocrImage",()=>({prepareImageForBrowserOcr:async(bytes:Uint8Array)=>bytes}));
vi.mock("@oc-test/appLocalProcessor",async(original)=>({...await original(),processWithApp:runtime.remote}));
import {extractPrivateAppAction} from "@oc-test/aiActionRunner";
import {parseLocalAppCatalog,projectLocalAppPayload,type LocalAppAction} from "@oc-test/localAppCatalog";
import {initializeLocalAppDraftChoices,selectLocalAppDraftChoice,editLocalAppDraftScalar,assertLocalAppDraftChoiceConsistency} from "@oc-test/localAppDraftChoices";
import {LocalAppDraftStore, type LocalDraftDeliveryRequest} from "@oc-test/localAppDrafts";
import {browserImageActionMode} from "@oc-test-store/browserImageActionMode";
import {createIouLocalAppPackage} from "../../src/features/openchat/localAppPackage";
import {createLocalProcessorContext} from "../../src/features/openchat/localProcessorContext";
import {processLocalArtifactRequest} from "../../src/features/openchat/localProcessorArtifact";
import {createLocalImportNonce,createLocalImportReceiver,parseLocalImportPayload} from "../../src/features/openchat/localImportHandoff";
import * as entryBatch from "../../src/features/entries/batchImport";

const templates=[{id:"test-stay",name:"Reservation",direction:"debt" as const,txn_type:"iou" as const,keywords:[]}];
const packageFor=()=>parseLocalAppCatalog(JSON.stringify(createIouLocalAppPackage("http://localhost:3000/openchat/import",{sha256:"a".repeat(64),byteLength:123},{recipientLabel:"Synthetic account review",processorContext:createLocalProcessorContext(templates,"EGP")}))).apps[0].actions[0];
const hostPayload=(action:LocalAppAction,candidates:readonly Record<string,unknown>[])=>{
  const initialized=initializeLocalAppDraftChoices(action,JSON.stringify(projectLocalAppPayload(action,candidates)));
  assertLocalAppDraftChoiceConsistency(action,initialized.editorJson);
  return JSON.parse(initialized.editorJson);
};
const client=()=>({clientOnlyApps:()=>true,enabledAiApps:vi.fn(),aiApps:vi.fn(),createAiAppCardProvenance:vi.fn(),sendMessageWithContent:vi.fn()});
beforeEach(()=>{vi.clearAllMocks();browserImageActionMode.set("model_only")});
describe("actual IOU export through actual OpenChat proposal/conformance/project/receiver",()=>{
  it.each(["iou","settlement"] as const)("reviews and delivers the compiled worker's %s draft with reversible named Type defaults",async(kind)=>{
    const artifactRoot=resolve(dirname(fileURLToPath(import.meta.url)),"../../public/openchat");
    const workerBytes=readFileSync(resolve(artifactRoot,"local-processor-v1.js"));
    const metadata=JSON.parse(readFileSync(resolve(artifactRoot,"local-processor-v1.sha256.json"),"utf8"));
    expect(createHash("sha256").update(workerBytes).digest("hex")).toBe(metadata.sha256);
    expect(workerBytes.byteLength).toBe(metadata.byteLength);
    const privateTypes=[
      {id:"synthetic-debt",name:"Synthetic booking",keywords:["booking"],direction:"debt" as const,txn_type:kind==="iou"?"settlement" as const:"iou" as const},
      {id:"synthetic-credit",name:"Synthetic alternative",keywords:["alternative"],direction:"credit" as const,txn_type:kind==="iou"?"settlement" as const:"iou" as const},
    ];
    const catalog=parseLocalAppCatalog(JSON.stringify(createIouLocalAppPackage("http://localhost:3000/openchat/import",metadata,
      {recipientLabel:"Synthetic account review",processorContext:createLocalProcessorContext(privateTypes,"EGP")})));
    const action=catalog.apps[0].actions[0];
    expect(catalog.apps[0].processor).toEqual({sha256:metadata.sha256,byteLength:metadata.byteLength});
    expect(action.processorContext).toMatchObject({draftEditorDefaults:"host-v1"});
    expect(action.draftEditor?.choices[0]).toMatchObject({field:"typeId",label:"Type",options:[
      {value:"synthetic-debt",label:"Synthetic booking",assign:[{field:"typeName",value:"Synthetic booking"}],defaults:[{field:"direction",value:"debt"}]},
      {value:"synthetic-credit",label:"Synthetic alternative",assign:[{field:"typeName",value:"Synthetic alternative"}],defaults:[{field:"direction",value:"credit"}]},
    ]});
    const request={type:"oc:local-process:request",version:1,actionId:action.definition.name,context:action.processorContext,
      input:{operation:"normalize",modality:"text",text:"booking 20 USD",candidates:[{kind,amount:20,currency:"USD",direction:"credit",note:"booking"}]}};
    let listener:((event:{data:unknown})=>void)|undefined;
    const replies:unknown[]=[];
    const dispatch=vi.fn((event:{data:unknown})=>listener!(event));
    // Run the real shipped classic worker, without network APIs, account credentials or ledger access.
    const worker=createContext({TextEncoder,TextDecoder,requestJson:JSON.stringify(request),dispatch,self:{
      addEventListener:(_event:string,callback:typeof listener)=>{listener=callback;},
      postMessage:(reply:unknown)=>replies.push(JSON.parse(JSON.stringify(reply))),
    }});
    runInContext(workerBytes.toString("utf8"),worker,{timeout:1000});
    runInContext("dispatch({data:JSON.parse(requestJson)})",worker,{timeout:1000});
    expect(dispatch).toHaveBeenCalledOnce();
    expect(replies).toEqual([{kind:"candidates",candidates:[{kind,amount:20,currency:"USD",direction:"credit",note:"booking",typeId:"synthetic-debt",typeName:"Synthetic booking"}]}]);
    const processed=replies[0] as {kind:"candidates";candidates:Record<string,unknown>[]};
    let choices=initializeLocalAppDraftChoices(action,JSON.stringify(projectLocalAppPayload(action,processed.candidates)));
    const initial={entries:[{kind,amount:20,currency:"USD",direction:"debt",note:"booking",typeId:"synthetic-debt",typeName:"Synthetic booking"}]};
    expect(JSON.parse(choices.editorJson)).toEqual(initial);
    const senderOrigin="http://localhost:5190",sessionNonce=createLocalImportNonce();
    const receiver=createLocalImportReceiver({senderOrigin,senderWindow:window,sessionNonce});
    const received=(data:unknown)=>({origin:senderOrigin,source:window,data});
    const persist=vi.spyOn(entryBatch,"addEntryBatch").mockImplementation(async()=>{throw new Error("Private proposal delivery must not save an entry");});
    try {
      const deliver=vi.fn(async(delivery:LocalDraftDeliveryRequest)=>{
        expect(receiver.receive(received({type:"oc:app-import:hello",version:1,sessionNonce})).kind).toBe("ready");
        const result=receiver.receive(received({type:"oc:app-import:offer",version:1,sessionNonce,importId:delivery.idempotencyKey,
          actionId:delivery.actionId,payload:delivery.payload}));
        expect(result.kind).toBe("queued");
        return {kind:"delivered" as const};
      });
      const store=new LocalAppDraftStore(deliver);
      store.setAccount("synthetic-openchat-account");
      const draft=store.create({target:{appId:catalog.apps[0].id,actionId:action.definition.name,destination:catalog.apps[0].destination,
        recipient:"Synthetic account review"},schema:action.draftSchema,payload:initial});
      const review=()=>{assertLocalAppDraftChoiceConsistency(action,choices.editorJson);return store.review(draft.id);};
      const commitChoice=()=>store.edit(draft.id,{payload:JSON.parse(choices.editorJson)});
      const originalApproval=review();
      choices=selectLocalAppDraftChoice(choices,0,"typeId",undefined);
      commitChoice();
      expect(JSON.parse(choices.editorJson)).toEqual({entries:[{kind,amount:20,currency:"USD",direction:"credit",note:"booking"}]});
      expect(store.get(draft.id)?.approval).toBeUndefined();
      expect(await store.confirm(draft.id,originalApproval.approvalId)).toEqual({kind:"blocked"});
      choices=selectLocalAppDraftChoice(choices,0,"typeId","synthetic-credit");commitChoice();
      choices=selectLocalAppDraftChoice(choices,0,"typeId","synthetic-debt");commitChoice();
      expect(JSON.parse(choices.editorJson)).toEqual(initial);
      choices=editLocalAppDraftScalar(choices,0,"direction","credit");commitChoice();
      for(const typeId of ["synthetic-credit","synthetic-debt",undefined,"synthetic-debt"]){
        choices=selectLocalAppDraftChoice(choices,0,"typeId",typeId);commitChoice();
        expect(JSON.parse(choices.editorJson).entries[0]).toMatchObject({kind,direction:"credit"});
      }
      const finalPayload={entries:[{kind,amount:20,currency:"USD",direction:"credit",note:"booking",typeId:"synthetic-debt",typeName:"Synthetic booking"}]};
      expect(JSON.parse(choices.editorJson)).toEqual(finalPayload);
      expect(parseLocalImportPayload(finalPayload)).toEqual(finalPayload);
      expect(deliver).not.toHaveBeenCalled();
      const approval=review();
      expect(approval.request.payload).toEqual(finalPayload);
      expect(Object.isFrozen(approval.request.payload)).toBe(true);
      expect(await store.confirm(draft.id,approval.approvalId)).toEqual({kind:"delivered"});
      expect(deliver).toHaveBeenCalledOnce();
      expect(deliver.mock.calls[0][0]).toBe(approval.request);
      expect(receiver.pending()).toHaveLength(1);
      expect(receiver.pending()[0]).toMatchObject({payload:finalPayload,status:"pending-review",importId:approval.request.idempotencyKey});
      expect(dispatch).toHaveBeenCalledOnce();
      expect(runtime.infer).not.toHaveBeenCalled();expect(runtime.ocr).not.toHaveBeenCalled();expect(runtime.remote).not.toHaveBeenCalled();
      expect(persist).not.toHaveBeenCalled();
    }finally{persist.mockRestore();receiver.close();}
  });
  it("explicitly reopens the identical received-but-unsaved request after the IOU receiver reloads",async()=>{
    const persist=vi.spyOn(entryBatch,"addEntryBatch").mockImplementation(async()=>{throw new Error("Receiving a private draft must never persist an entry");});
    try {
      const action=packageFor();
      const payload={entries:[{kind:"iou",amount:300,currency:"EGP",direction:"credit",date:"2026-09-28",note:"Synthetic received draft"}]};
      const senderOrigin="http://localhost:5190",senderWindow=window;
      const freshReceiver=()=>{
        const sessionNonce=createLocalImportNonce();
        return {sessionNonce,receiver:createLocalImportReceiver({senderOrigin,senderWindow,sessionNonce})};
      };
      let connection=freshReceiver();
      const nonces:string[]=[];
      const deliver=vi.fn(async(request:LocalDraftDeliveryRequest)=>{
        const {sessionNonce,receiver}=connection;
        nonces.push(sessionNonce);
        const event=(data:unknown)=>({origin:senderOrigin,source:senderWindow,data});
        expect(receiver.receive(event({type:"oc:app-import:hello",version:1,sessionNonce})).kind).toBe("ready");
        const result=receiver.receive(event({type:"oc:app-import:offer",version:1,sessionNonce,
          importId:request.idempotencyKey,actionId:request.actionId,payload:request.payload}));
        expect(result.kind).toBe("queued");
        if(result.kind!=="queued")throw new Error("The actual IOU receiver did not queue the reviewed draft");
        expect(result.reply).toMatchObject({type:"oc:app-import:received",status:"pending-review"});
        expect(result.draft.status).toBe("pending-review");
        return {kind:"delivered" as const};
      });
      const store=new LocalAppDraftStore(deliver);
      store.setAccount("synthetic-openchat-account");
      const draft=store.create({target:{appId:"iou",actionId:action.definition.name,
        destination:"http://localhost:3000/openchat/import",recipient:"Synthetic account review"},schema:action.draftSchema,payload});
      const approval=store.review(draft.id),originalJson=JSON.stringify(approval.request);
      expect(Object.isFrozen(approval.request)).toBe(true);
      expect(Object.isFrozen(approval.request.payload)).toBe(true);
      expect(await store.confirm(draft.id,approval.approvalId)).toEqual({kind:"delivered"});
      expect(store.get(draft.id)?.status).toBe("delivered");
      expect(connection.receiver.pending()).toHaveLength(1);
      expect(connection.receiver.pending()[0]).toMatchObject({importId:approval.request.idempotencyKey,payload});
      expect(persist).not.toHaveBeenCalled();

      const priorReceiver=connection.receiver;
      priorReceiver.close();
      connection=freshReceiver(); // IOU reload loses its memory-only queue; the OpenChat draft remains.
      expect(priorReceiver.pending()).toEqual([]);
      expect(connection.receiver.pending()).toEqual([]);
      await Promise.resolve();
      expect(deliver).toHaveBeenCalledOnce(); // Receiver reload never triggers an automatic resend.
      expect(await store.confirm(draft.id,approval.approvalId)).toEqual({kind:"blocked"});
      expect(await store.retryUncertain(draft.id,approval.approvalId)).toEqual({kind:"blocked"});
      expect(deliver).toHaveBeenCalledOnce();

      // A fresh explicit choice is a distinct operation, not another ordinary confirmation.
      expect(await store.reopenDelivered(draft.id,approval.approvalId)).toEqual({kind:"delivered"});
      expect(deliver).toHaveBeenCalledTimes(2);
      expect(deliver.mock.calls[0][0]).toBe(approval.request);
      expect(deliver.mock.calls[1][0]).toBe(approval.request);
      expect(JSON.stringify(deliver.mock.calls[1][0])).toBe(originalJson);
      expect(nonces[1]).not.toBe(nonces[0]);
      expect(connection.receiver.pending()).toHaveLength(1);
      expect(connection.receiver.pending()[0]).toMatchObject({importId:approval.request.idempotencyKey,payload,status:"pending-review"});
      expect(persist).not.toHaveBeenCalled();
      expect(runtime.infer).not.toHaveBeenCalled();
      expect(runtime.remote).not.toHaveBeenCalled();
    } finally {persist.mockRestore();}
  });
  it.each([
    ["qwen3-vl-2b-instruct-q4",{heading:"Reservation",total_text:"Total Payout $1,912.15",dates:["Sun, Jul 19","Thu, Aug 6"],kind:"iou"}],
    ["gemma-4-e2b-it-q4",{kind:"iou",currency_text:"$",amount_text:"1,912.15",date_text:"Sun, Jul 19 | Thu, Aug 6",note:"Reservation"}],
  ])("preserves all reviewed fields with %s raw contract",async(model,raw)=>{
    runtime.model=model as string;runtime.infer.mockResolvedValue({kind:"ok",text:JSON.stringify(raw)});
    const action=packageFor(),oc=client();
    const result=await extractPrivateAppAction(action.definition,{kind:"image_content",blobData:new Uint8Array([4,2])} as never,oc as never,{stillCurrent:()=>true,sourceTimestamp:Date.UTC(2026,6,3),processor:async(actionId,input)=>processLocalArtifactRequest({type:"oc:local-process:request",version:1,actionId,input,context:action.processorContext}) as never});
    if(result.kind!=="extracted")throw new Error(JSON.stringify(result));
    const payload=hostPayload(action,result.candidates);
    expect(payload).toEqual({entries:[{kind:"iou",amount:1912.15,currency:"USD",direction:"debt",date:"2026-07-19",note:"Reservation | From Sun, Jul 19 to Thu, Aug 6",typeId:"test-stay",typeName:"Reservation"}]});
    expect(parseLocalImportPayload(payload)).toEqual(payload);
    expect(runtime.infer).toHaveBeenCalledOnce();expect(runtime.ocr).not.toHaveBeenCalled();expect(runtime.remote).not.toHaveBeenCalled();
    for(const method of [oc.enabledAiApps,oc.aiApps,oc.createAiAppCardProvenance,oc.sendMessageWithContent])expect(method).not.toHaveBeenCalled();
  });
  it("keeps explicit private default currency and never restores a raw-source echo or guessed date",async()=>{
    const action=packageFor(),oc=client();
    const result=await extractPrivateAppAction(action.definition,{kind:"text_content",text:"owe me 300 food 400 Uber"},oc as never,{stillCurrent:()=>true,processor:async(actionId,input)=>processLocalArtifactRequest({type:"oc:local-process:request",version:1,actionId,input,context:action.processorContext}) as never});
    if(result.kind!=="extracted")throw new Error(JSON.stringify(result));
    const payload=hostPayload(action,result.candidates) as {entries:Record<string,unknown>[]};
    expect(payload.entries).toHaveLength(2);
    expect(payload.entries[0]).toMatchObject({amount:300,currency:"EGP",direction:"credit",kind:"iou"});
    expect(payload.entries[1]).toMatchObject({amount:400,currency:"EGP",direction:"credit",kind:"iou"});
    expect(payload.entries[0]).not.toHaveProperty("message");expect(payload.entries[0]).not.toHaveProperty("date");
    expect(runtime.infer).not.toHaveBeenCalled();expect(parseLocalImportPayload(payload)).toEqual(payload);
  });
  it.each([
    ["qwen3-vl-2b-instruct-q4",{heading:"تمت العملية بنجاح",total_text:"12,900 EGP",dates:["14 Aug 2026 09:47 PM"],kind:"settlement"}],
    ["gemma-4-e2b-it-q4",{kind:"settlement",currency_text:"EGP",amount_text:"12,900",date_text:"14 Aug 2026 09:47 PM",note:"تمت العملية بنجاح"}],
  ])("keeps the 12900 receipt exact through %s without applying a foreign Type",async(model,raw)=>{
    runtime.model=model as string;runtime.infer.mockResolvedValue({kind:"ok",text:JSON.stringify(raw)});
    const action=packageFor();const result=await extractPrivateAppAction(action.definition,{kind:"image_content",blobData:new Uint8Array([9,8])} as never,client() as never,{stillCurrent:()=>true,sourceTimestamp:Date.UTC(2026,7,14),processor:async(actionId,input)=>processLocalArtifactRequest({type:"oc:local-process:request",version:1,actionId,input,context:action.processorContext}) as never});
    if(result.kind!=="extracted")throw new Error(JSON.stringify(result));
    const payload=hostPayload(action,result.candidates);
    expect(payload).toEqual({entries:[{kind:"settlement",amount:12900,currency:"EGP",direction:"credit",date:"2026-08-14",note:"تمت العملية بنجاح"}]});
    expect(parseLocalImportPayload(payload)).toEqual(payload);expect(runtime.infer).toHaveBeenCalledOnce();expect(runtime.ocr).not.toHaveBeenCalled();
  });
});
