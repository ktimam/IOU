// Hand-authored synthetic contracts and explicitly labelled, existing sanitized model captures.
// No user image files, fresh model inference, network calls or real ledger writes.
import {describe,it,expect,vi,beforeEach,beforeAll} from "vitest";
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
import {bindConnectedLocalApp,parseLocalAppDirectory,publicLocalAppCatalog,validateLocalAppInstallation} from "@oc-test/localAppDirectory";
import {initializeLocalAppDraftChoices,selectLocalAppDraftChoice,editLocalAppDraftScalar,assertLocalAppDraftChoiceConsistency} from "@oc-test/localAppDraftChoices";
import {LocalAppDraftStore, type LocalDraftDeliveryRequest} from "@oc-test/localAppDrafts";
import {sealLocalAppDelivery} from "@oc-test/localAppEncryption";
import {browserImageActionMode} from "@oc-test-store/browserImageActionMode";
import {createIouLocalAppPackage} from "../../src/features/openchat/localAppPackage";
import {createLocalProcessorContext} from "../../src/features/openchat/localProcessorContext";
import {orderedCurrencies} from "../../src/features/settings/currencies";
import {processLocalArtifactRequest} from "../../src/features/openchat/localProcessorArtifact";
import {createLocalImportNonce,createLocalImportReceiver,parseLocalImportPayload,decryptPendingLocalImport} from "../../src/features/openchat/localImportHandoff";
import {createLocalDeliveryEncryption, type LocalDeliveryEncryption} from "../../src/features/openchat/localImportEncryption";
import {prepareLocalImportReview} from "../../src/features/openchat/localImportReview";
import {decryptEntryPayload} from "../../src/features/crypto/devVetkd";
import * as entryBatch from "../../src/features/entries/batchImport";
import {iouImagePromptByModel} from "../../src/features/openchat/modelImageProfiles";
import smallerQwenCapture from "../../test/fixtures/openchat/model-acceptance/qwen-q4-v20-app-replay.json";
import gemmaCapture from "../../test/fixtures/openchat/model-acceptance/gemma-v15-app-replay.json";

const templates=[{id:"test-stay",name:"Reservation",direction:"debt" as const,txn_type:"iou" as const,keywords:[]}];
const destination="http://localhost:3000/openchat/import";
const recipientContext={principal:"rrkah-fqaaa-aaaaa-aaaaq-cai",backendHost:"http://127.0.0.1:4943",backendCanisterId:"ryjl3-tyaaa-aaaaa-aaaba-cai",pairId:"0000000000000001",sheetId:"0000000000000002"};
let deliveryKey:CryptoKeyPair,deliveryEncryption:LocalDeliveryEncryption;
beforeAll(async()=>{
  deliveryKey=await crypto.subtle.generateKey({name:"ECDH",namedCurve:"P-256"},false,["deriveBits"]);
  deliveryEncryption=await createLocalDeliveryEncryption(deliveryKey.publicKey,recipientContext);
});
const sealedOffer=async(request:LocalDraftDeliveryRequest,sessionNonce:string)=>{
  const sealed=await sealLocalAppDelivery(request);
  const {idempotencyKey,...header}=sealed;
  const offer={type:"oc:app-import:offer",version:2,sessionNonce,importId:idempotencyKey,...header};
  expect(offer).not.toHaveProperty("payload");expect(offer).not.toHaveProperty("recipient");
  expect(offer).not.toHaveProperty("deliveryEncryption");
  return offer;
};
const decryptQueued=(receiver:ReturnType<typeof createLocalImportReceiver>)=>decryptPendingLocalImport(receiver.pending()[0],deliveryKey.privateKey,deliveryEncryption,destination,()=>{});
const packageFor=()=>parseLocalAppCatalog(JSON.stringify(createIouLocalAppPackage("http://localhost:3000/openchat/import",{sha256:"a".repeat(64),byteLength:123},{recipientLabel:"Synthetic account review",processorContext:createLocalProcessorContext(templates,"EGP")}))).apps[0].actions[0];
const hostPayload=(action:LocalAppAction,candidates:readonly Record<string,unknown>[])=>{
  const initialized=initializeLocalAppDraftChoices(action,JSON.stringify(projectLocalAppPayload(action,candidates)));
  assertLocalAppDraftChoiceConsistency(action,initialized.editorJson);
  return JSON.parse(initialized.editorJson);
};
const client=()=>({clientOnlyApps:()=>true,enabledAiApps:vi.fn(),aiApps:vi.fn(),createAiAppCardProvenance:vi.fn(),sendMessageWithContent:vi.fn()});
beforeEach(()=>{vi.clearAllMocks();browserImageActionMode.set("model_only")});
const retainedImageCaptures=[smallerQwenCapture,gemmaCapture].flatMap((capture)=>capture.cases
  .filter((row)=>["dev-real-arabic-transfer","dev-real-payout-range"].includes(row.imageId)&&
    (!("repeated" in row)||!row.repeated))
  .map((row)=>({modelId:capture.modelId,promptSha256:capture.promptSha256,imageId:row.imageId,row})));

describe("actual IOU export through actual OpenChat proposal/conformance/project/receiver",()=>{
  it("binds the shipped public catalog to the actual encrypted private setup and persisted provenance",async()=>{
    const artifactRoot=resolve(dirname(fileURLToPath(import.meta.url)),"../../public/openchat");
    const directoryJson=readFileSync(resolve(artifactRoot,"apps-v1.json"),"utf8");
    const publicCatalogJson=readFileSync(resolve(artifactRoot,"local-app-v1.json"),"utf8");
    const publicApp=JSON.parse(publicCatalogJson).apps[0];
    const sourceUrl=new URL("/openchat/apps-v1.json",publicApp.destination).href;
    const processorBytes=readFileSync(resolve(artifactRoot,"local-processor-v1.js"));
    const metadata=JSON.parse(readFileSync(resolve(artifactRoot,"local-processor-v1.sha256.json"),"utf8"));
    const descriptor=parseLocalAppDirectory(directoryJson,sourceUrl).apps[0];
    // Installed clients pin this setup URL as part of the publisher identity.
    expect(descriptor.setupUrl).toBe(new URL("/openchat/connect",sourceUrl).href);
    expect(descriptor.catalog).toMatchObject({sha256:createHash("sha256").update(publicCatalogJson).digest("hex"),byteLength:Buffer.byteLength(publicCatalogJson)});
    expect(descriptor.processor).toMatchObject({sha256:createHash("sha256").update(processorBytes).digest("hex"),byteLength:processorBytes.byteLength});
    expect(metadata).toMatchObject({sha256:descriptor.processor.sha256,byteLength:descriptor.processor.byteLength});
    const advertised=publicLocalAppCatalog(publicCatalogJson,descriptor);
    const publicInbox=publicApp.deliveryInbox;
    const connectedEncryption=publicInbox?await createLocalDeliveryEncryption(deliveryKey.publicKey,{...recipientContext,
      backendHost:publicInbox.host,backendCanisterId:publicInbox.canisterId}):deliveryEncryption;
    const connectedInbox=publicInbox?{...publicInbox,inboxId:"a".repeat(64),writeCapability:"A".repeat(43),expiresAtMs:Date.now()+600000}:undefined;
    const setup=createIouLocalAppPackage(publicApp.destination,metadata,{recipientLabel:"Synthetic account and sheet",deliveryEncryption:connectedEncryption,
      ...(connectedInbox?{deliveryInbox:connectedInbox}:{}),
      processorContext:createLocalProcessorContext([{id:"synthetic-acceptance",name:"Synthetic acceptance",direction:"debt",txn_type:"iou",keywords:["TESTONLY"]}],"USD")},publicInbox);
    const json=JSON.stringify(setup);
    // Parse separately: a valid private encryption/context DTO is not proof of public-recipe binding.
    const parsed=parseLocalAppCatalog(json).apps[0];
    expect(parsed.deliveryEncryption).toEqual(connectedEncryption);
    if(connectedInbox)expect(parsed.deliveryInbox).toEqual(connectedInbox);
    expect(parsed.actions[0].draftEditor?.choices[0].options[0]).toMatchObject({value:"synthetic-acceptance",label:"Synthetic acceptance"});
    const connected=bindConnectedLocalApp(json,advertised);
    expect(connected).toEqual(parsed);
    const installation={appId:connected.id,sourceUrl,descriptor,publicCatalogJson};
    expect(await validateLocalAppInstallation(JSON.parse(JSON.stringify(installation)),connected)).toEqual(installation);
    expect(runtime.infer).not.toHaveBeenCalled();expect(runtime.ocr).not.toHaveBeenCalled();expect(runtime.remote).not.toHaveBeenCalled();
  });
  it("accepts current encrypted setup but still rejects changes to the pinned definition, final schema and handoff",()=>{
    const processor={sha256:"a".repeat(64),byteLength:123};
    const advertised=parseLocalAppCatalog(JSON.stringify(createIouLocalAppPackage(destination,processor)));
    const setup=createIouLocalAppPackage(destination,processor,{recipientLabel:"Synthetic recipient",deliveryEncryption,
      processorContext:createLocalProcessorContext([{id:"synthetic-acceptance",name:"Synthetic acceptance",direction:"debt",txn_type:"iou",keywords:["TESTONLY"]}],"USD")});
    expect(bindConnectedLocalApp(JSON.stringify(setup),advertised).deliveryEncryption).toEqual(deliveryEncryption);
    const mutations=[
      (app:typeof setup.apps[0])=>{app.actions[0].definition.card.title="Changed public title";},
      (app:typeof setup.apps[0])=>{app.actions[0].definition.card.rows.reverse();},
      (app:typeof setup.apps[0])=>{app.actions[0].definition.promptTemplate+=" Changed pinned prompt.";},
      (app:typeof setup.apps[0])=>{delete (app.actions[0].draftSchema.properties.entries.items.properties.currency as {pattern?:string}).pattern;},
      (app:typeof setup.apps[0])=>{app.actions[0].handoff={kind:"single"} as typeof app.actions[0].handoff;},
      (app:typeof setup.apps[0])=>{app.destination="http://localhost:3000/other-import";},
    ];
    for(const mutate of mutations){
      const changed=JSON.parse(JSON.stringify(setup)) as typeof setup;
      mutate(changed.apps[0]);
      expect(()=>bindConnectedLocalApp(JSON.stringify(changed),advertised)).toThrow();
    }
  });
  it("retains exactly the existing Arabic/range captures for both currently selected models",()=>{
    expect(retainedImageCaptures.map(({modelId,imageId})=>`${modelId}/${imageId}`).sort()).toEqual([
      "gemma-4-e2b-it-q4/dev-real-arabic-transfer","gemma-4-e2b-it-q4/dev-real-payout-range",
      "qwen3-vl-2b-instruct-q4/dev-real-arabic-transfer","qwen3-vl-2b-instruct-q4/dev-real-payout-range",
    ]);
    // Do not relabel historical formatting failures as strict-prompt passes.
    expect(gemmaCapture.cases.find((row)=>row.imageId==="dev-real-payout-range")?.strictPromptContractPassed).toBe(false);
  });
  it.each(retainedImageCaptures)("replays retained $modelId / $imageId through choices and encrypted delivery",async({modelId,promptSha256,imageId,row})=>{
    const profile=iouImagePromptByModel?.templates[modelId];
    expect(profile).toBeDefined();
    expect(createHash("sha256").update(profile!.template).digest("hex")).toBe(promptSha256);
    const originalRaw=row.raw;
    // Feed the retained reply verbatim, including fences/array/printed separator, to the host parser.
    // Fake image bytes are never decoded: this is captured-output replay, not new accuracy.
    runtime.model=modelId;runtime.infer.mockResolvedValue({kind:"ok",text:originalRaw});
    const action=packageFor(),oc=client();
    const result=await extractPrivateAppAction(action.definition,{kind:"image_content",blobData:new Uint8Array([4,2])} as never,oc as never,{
      stillCurrent:()=>true,sourceTimestamp:Date.parse(row.sourceTimestamp),
      processor:async(actionId,input)=>processLocalArtifactRequest({type:"oc:local-process:request",version:1,actionId,input,context:action.processorContext}) as never,
    });
    if(result.kind!=="extracted")throw new Error(JSON.stringify(result));
    const range=imageId==="dev-real-payout-range";
    const expectedEntry={...row.expectedAppForm,amount:Number(row.expectedAppForm.amount),direction:range?"debt":"credit",
      ...(range?{typeId:"test-stay",typeName:"Reservation"}:{})};
    // IOU exports the pre-Type default; the actual generic host initializer supplies Type direction.
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].direction).toBe("credit");
    const payload=hostPayload(action,result.candidates);
    expect(payload).toEqual({entries:[expectedEntry]});
    if(!range)expect(payload.entries[0]).not.toHaveProperty("typeId");
    const senderOrigin="http://localhost:5190",sessionNonce=createLocalImportNonce();
    const receiver=createLocalImportReceiver({senderOrigin,senderWindow:window,sessionNonce,destination});
    const received=(data:unknown)=>({origin:senderOrigin,source:window,data});
    const persist=vi.spyOn(entryBatch,"addEntryBatch").mockImplementation(async()=>{throw new Error("Delivery is not save consent");});
    try{
      const deliver=vi.fn(async(request:LocalDraftDeliveryRequest)=>{
        expect(receiver.receive(received({type:"oc:app-import:hello",version:2,sessionNonce})).kind).toBe("ready");
        const offer=await sealedOffer(request,sessionNonce);
        expect(JSON.stringify(offer)).not.toContain(expectedEntry.note);
        expect(JSON.stringify(offer)).not.toContain(expectedEntry.date);
        expect(receiver.receive(received(offer)).kind).toBe("queued");
        return {kind:"delivered" as const};
      });
      const store=new LocalAppDraftStore(deliver);
      store.setAccount("synthetic-openchat-account");
      const draft=store.create({target:{appId:"iou",appRevision:"local-import-v2",actionId:action.definition.name,destination,
        recipient:"Synthetic account review",deliveryEncryption},schema:action.draftSchema,payload});
      const review=store.review(draft.id);
      expect(deliver).not.toHaveBeenCalled();expect(receiver.pending()).toEqual([]);
      expect(await store.confirm(draft.id,review.approvalId)).toEqual({kind:"delivered"});
      expect(deliver).toHaveBeenCalledOnce();
      expect(receiver.pending()).toHaveLength(1);
      expect(receiver.pending()[0]).not.toHaveProperty("payload");
      expect(receiver.pending()[0]).toMatchObject({importId:review.request.idempotencyKey,status:"pending-review"});
      expect(await decryptQueued(receiver)).toEqual({entries:[expectedEntry]});
      expect(persist).not.toHaveBeenCalled();
      expect(runtime.infer).toHaveBeenCalledOnce();expect(runtime.ocr).not.toHaveBeenCalled();expect(runtime.remote).not.toHaveBeenCalled();
      for(const method of [oc.enabledAiApps,oc.aiApps,oc.createAiAppCardProvenance,oc.sendMessageWithContent])expect(method).not.toHaveBeenCalled();
      expect(row.raw).toBe(originalRaw);
    }finally{persist.mockRestore();receiver.close();}
  });
  it("encrypts in OpenChat, decrypts only for the connected IOU context, then encrypts the second-reviewed ledger write",async()=>{
    const action=packageFor(), senderOrigin="http://localhost:5190",sessionNonce=createLocalImportNonce();
    const receiver=createLocalImportReceiver({senderOrigin,senderWindow:window,sessionNonce,destination});
    const event=(data:unknown)=>({origin:senderOrigin,source:window,data});
    const backend={add_entry_batch:vi.fn(async()=>({entry_ids:[1n],replayed:false}))};
    const payload={entries:[{kind:"iou",direction:"debt",amount:12900,currency:"EGP",date:"2026-08-14",note:"Synthetic private bank receipt"}]};
    const store=new LocalAppDraftStore(async(request)=>{
      expect(receiver.receive(event({type:"oc:app-import:hello",version:2,sessionNonce})).kind).toBe("ready");
      const offer=await sealedOffer(request,sessionNonce);
      for(const secret of ["12900","2026-08-14","Synthetic private bank receipt"])expect(JSON.stringify(offer)).not.toContain(secret);
      expect(receiver.receive(event(offer)).kind).toBe("queued");
      return {kind:"delivered" as const};
    });
    store.setAccount("synthetic-openchat-account");
    const draft=store.create({target:{appId:"iou",appRevision:"local-import-v2",actionId:action.definition.name,destination,
      recipient:"Synthetic recipient",deliveryEncryption},schema:action.draftSchema,payload});
    const approved=store.review(draft.id);
    expect(receiver.pending()).toEqual([]);expect(backend.add_entry_batch).not.toHaveBeenCalled();
    expect(await store.confirm(draft.id,approved.approvalId)).toEqual({kind:"delivered"});
    expect(backend.add_entry_batch).not.toHaveBeenCalled();
    const wrongSheet=await createLocalDeliveryEncryption(deliveryKey.publicKey,{...recipientContext,sheetId:"0000000000000003"});
    await expect(decryptPendingLocalImport(receiver.pending()[0],deliveryKey.privateKey,wrongSheet,destination,()=>{})).rejects.toThrow();
    const decoded=await decryptQueued(receiver);
    expect(decoded).toEqual(payload);expect(backend.add_entry_batch).not.toHaveBeenCalled();
    const reviewed=prepareLocalImportReview({rows:decoded.entries,selectedTypeIds:[""],templates:[],importId:approved.request.idempotencyKey});
    expect(backend.add_entry_batch).not.toHaveBeenCalled(); // Second review is NOT save consent.
    const sheetKey=crypto.getRandomValues(new Uint8Array(32));
    await entryBatch.addEntryBatch({actor:backend,sheetId:recipientContext.sheetId,payloads:[...reviewed],messageHandle:approved.request.idempotencyKey,
      relayId:approved.request.idempotencyKey,sheetKey,beforeMutate:()=>expect(backend.add_entry_batch).not.toHaveBeenCalled()});
    expect(backend.add_entry_batch).toHaveBeenCalledOnce();
    const wire=backend.add_entry_batch.mock.calls[0][0];
    expect(Object.keys(wire).sort()).toEqual(["entries","import_id","sheet_id"]);
    expect(Object.keys(wire.entries[0]).sort()).toEqual(["ciphertext","entry_key","iv"]);
    const stored=wire.entries[0];
    const plaintext=await decryptEntryPayload(new Uint8Array(stored.entry_key),new Uint8Array(stored.iv),new Uint8Array(stored.ciphertext),sheetKey);
    expect(JSON.parse(new TextDecoder().decode(plaintext))).toEqual(reviewed[0]);
    expect(reviewed[0]).toMatchObject({amount_minor:1290000,currency:"EGP",direction:"debt",note:"Synthetic private bank receipt"});
    receiver.close();
  });
  it.each([
    {kind:"iou",direction:"credit"}, {kind:"iou",direction:"debt"},
    {kind:"settlement",direction:"credit"}, {kind:"settlement",direction:"debt"},
  ])(
    "keeps $kind/$direction values unchanged through presentation, projection and the receiver",({kind,direction})=>{
      const action=packageFor();
      expect(action.draftPresentation).toEqual({version:1,enumLabels:[
        {field:"kind",options:[{value:"iou",label:"IOU"},{value:"settlement",label:"Settlement"}]},
        {field:"direction",options:[{value:"credit",label:"Owed to you"},{value:"debt",label:"You owe"}]},
      ],controls:[
        {field:"currency",kind:"select",suggestions:orderedCurrencies("EGP")},
        {field:"date",kind:"date"},
        {field:"note",kind:"multiline",fullWidth:true},
      ]});
      const candidate={kind,direction,amount:20,currency:"USD",note:"Synthetic presentation parity"};
      const payload=hostPayload(action,[candidate]);
      expect(payload).toEqual({entries:[candidate]});
      expect(parseLocalImportPayload(payload)).toEqual(payload);
      const legacyPackage=createIouLocalAppPackage("http://localhost:3000/openchat/import",{sha256:"a".repeat(64),byteLength:123},
        {recipientLabel:"Synthetic account review",processorContext:createLocalProcessorContext(templates,"EGP")});
      const {draftPresentation:_presentation,...legacyAction}=legacyPackage.apps[0].actions[0];
      const legacy=parseLocalAppCatalog(JSON.stringify({...legacyPackage,apps:[{...legacyPackage.apps[0],actions:[legacyAction]}]})).apps[0].actions[0];
      expect(hostPayload(legacy,[candidate])).toEqual(payload);
    },
  );
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
    expect(action.draftEditor?.choices[0]).toMatchObject({field:"typeId",label:"Saved type",options:[
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
    const receiver=createLocalImportReceiver({senderOrigin,senderWindow:window,sessionNonce,destination});
    const received=(data:unknown)=>({origin:senderOrigin,source:window,data});
    const persist=vi.spyOn(entryBatch,"addEntryBatch").mockImplementation(async()=>{throw new Error("Private proposal delivery must not save an entry");});
    try {
      const deliver=vi.fn(async(delivery:LocalDraftDeliveryRequest)=>{
        expect(receiver.receive(received({type:"oc:app-import:hello",version:2,sessionNonce})).kind).toBe("ready");
        const result=receiver.receive(received(await sealedOffer(delivery,sessionNonce)));
        expect(result.kind).toBe("queued");
        return {kind:"delivered" as const};
      });
      const store=new LocalAppDraftStore(deliver);
      store.setAccount("synthetic-openchat-account");
      const draft=store.create({target:{appId:catalog.apps[0].id,appRevision:catalog.apps[0].revision,actionId:action.definition.name,destination:catalog.apps[0].destination,
        recipient:"Synthetic account review",deliveryEncryption},schema:action.draftSchema,payload:initial});
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
      expect(receiver.pending()[0]).toMatchObject({status:"pending-review",importId:approval.request.idempotencyKey});
      expect(receiver.pending()[0]).not.toHaveProperty("payload");
      expect(await decryptQueued(receiver)).toEqual(finalPayload);
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
        return {sessionNonce,receiver:createLocalImportReceiver({senderOrigin,senderWindow,sessionNonce,destination})};
      };
      let connection=freshReceiver();
      const nonces:string[]=[];
      const deliver=vi.fn(async(request:LocalDraftDeliveryRequest)=>{
        const {sessionNonce,receiver}=connection;
        nonces.push(sessionNonce);
        const event=(data:unknown)=>({origin:senderOrigin,source:senderWindow,data});
        expect(receiver.receive(event({type:"oc:app-import:hello",version:2,sessionNonce})).kind).toBe("ready");
        const result=receiver.receive(event(await sealedOffer(request,sessionNonce)));
        expect(result.kind).toBe("queued");
        if(result.kind!=="queued")throw new Error("The actual IOU receiver did not queue the reviewed draft");
        expect(result.reply).toMatchObject({type:"oc:app-import:received",status:"pending-review"});
        expect(result.draft.status).toBe("pending-review");
        return {kind:"delivered" as const};
      });
      const store=new LocalAppDraftStore(deliver);
      store.setAccount("synthetic-openchat-account");
      const draft=store.create({target:{appId:"iou",appRevision:"local-import-v2",actionId:action.definition.name,
        destination,recipient:"Synthetic account review",deliveryEncryption},schema:action.draftSchema,payload});
      const approval=store.review(draft.id),originalJson=JSON.stringify(approval.request);
      expect(Object.isFrozen(approval.request)).toBe(true);
      expect(Object.isFrozen(approval.request.payload)).toBe(true);
      expect(await store.confirm(draft.id,approval.approvalId)).toEqual({kind:"delivered"});
      expect(store.get(draft.id)?.status).toBe("delivered");
      expect(connection.receiver.pending()).toHaveLength(1);
      expect(connection.receiver.pending()[0]).toMatchObject({importId:approval.request.idempotencyKey});
      expect(await decryptQueued(connection.receiver)).toEqual(payload);
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
      expect(connection.receiver.pending()[0]).toMatchObject({importId:approval.request.idempotencyKey,status:"pending-review"});
      expect(await decryptQueued(connection.receiver)).toEqual(payload);
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
