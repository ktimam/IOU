// Hand-authored synthetic model-output fixtures only. No user image files or network inference.
import {describe,it,expect,vi,beforeEach} from "vitest";
const runtime=vi.hoisted(()=>({infer:vi.fn(),model:"qwen3-vl-2b-instruct-q4",ocr:vi.fn(),remote:vi.fn()}));
vi.mock("@oc-test/onDeviceInference",()=>({inferOnDevice:runtime.infer,inferOnDeviceTextOnlyNoProjector:runtime.infer,onDeviceInferenceCapability:()=>({available:true,runtimesSupported:["llama-cpp"],selectedModalities:["image","text"]}),usesWebInferenceRuntime:()=>true,isNativeClient:()=>false}));
vi.mock("@oc-test/webInference",()=>({browserImageModelFirstReadiness:async()=>({available:true}),browserTextModelReadiness:async()=>({available:true}),webImageInferenceEvidence:()=>undefined,webModelCatalogId:()=>runtime.model}));
vi.mock("@oc-test/browserOcr",()=>({recognizeBrowserImage:runtime.ocr,disposeBrowserOcr:async()=>{}}));
vi.mock("@oc-test/ocrImage",()=>({prepareImageForBrowserOcr:async(bytes:Uint8Array)=>bytes}));
vi.mock("@oc-test/appLocalProcessor",async(original)=>({...await original(),processWithApp:runtime.remote}));
import {extractPrivateAppAction} from "@oc-test/aiActionRunner";
import {parseLocalAppCatalog,projectLocalAppPayload} from "@oc-test/localAppCatalog";
import {LocalAppDraftStore, type LocalDraftDeliveryRequest} from "@oc-test/localAppDrafts";
import {browserImageActionMode} from "@oc-test-store/browserImageActionMode";
import {createIouLocalAppPackage} from "../../src/features/openchat/localAppPackage";
import {createLocalProcessorContext} from "../../src/features/openchat/localProcessorContext";
import {processLocalArtifactRequest} from "../../src/features/openchat/localProcessorArtifact";
import {createLocalImportNonce,createLocalImportReceiver,parseLocalImportPayload} from "../../src/features/openchat/localImportHandoff";
import * as entryBatch from "../../src/features/entries/batchImport";

const templates=[{id:"test-stay",name:"Reservation",direction:"debt" as const,txn_type:"iou" as const,keywords:[]}];
const packageFor=()=>parseLocalAppCatalog(JSON.stringify(createIouLocalAppPackage("http://localhost:3000/openchat/import",{sha256:"a".repeat(64),byteLength:123},{recipientLabel:"Synthetic account review",processorContext:createLocalProcessorContext(templates,"EGP")}))).apps[0].actions[0];
const client=()=>({clientOnlyApps:()=>true,enabledAiApps:vi.fn(),aiApps:vi.fn(),createAiAppCardProvenance:vi.fn(),sendMessageWithContent:vi.fn()});
beforeEach(()=>{vi.clearAllMocks();browserImageActionMode.set("model_only")});
describe("actual IOU export through actual OpenChat proposal/conformance/project/receiver",()=>{
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
    const payload=projectLocalAppPayload(action,result.candidates);
    expect(payload).toEqual({entries:[{kind:"iou",amount:1912.15,currency:"USD",direction:"debt",date:"2026-07-19",note:"Reservation | From Sun, Jul 19 to Thu, Aug 6",typeId:"test-stay",typeName:"Reservation"}]});
    expect(parseLocalImportPayload(payload)).toEqual(payload);
    expect(runtime.infer).toHaveBeenCalledOnce();expect(runtime.ocr).not.toHaveBeenCalled();expect(runtime.remote).not.toHaveBeenCalled();
    for(const method of [oc.enabledAiApps,oc.aiApps,oc.createAiAppCardProvenance,oc.sendMessageWithContent])expect(method).not.toHaveBeenCalled();
  });
  it("keeps explicit private default currency and never restores a raw-source echo or guessed date",async()=>{
    const action=packageFor(),oc=client();
    const result=await extractPrivateAppAction(action.definition,{kind:"text_content",text:"owe me 300 food 400 Uber"},oc as never,{stillCurrent:()=>true,processor:async(actionId,input)=>processLocalArtifactRequest({type:"oc:local-process:request",version:1,actionId,input,context:action.processorContext}) as never});
    if(result.kind!=="extracted")throw new Error(JSON.stringify(result));
    const payload=projectLocalAppPayload(action,result.candidates) as {entries:Record<string,unknown>[]};
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
    const payload=projectLocalAppPayload(action,result.candidates);
    expect(payload).toEqual({entries:[{kind:"settlement",amount:12900,currency:"EGP",direction:"credit",date:"2026-08-14",note:"تمت العملية بنجاح"}]});
    expect(parseLocalImportPayload(payload)).toEqual(payload);expect(runtime.infer).toHaveBeenCalledOnce();expect(runtime.ocr).not.toHaveBeenCalled();
  });
});
