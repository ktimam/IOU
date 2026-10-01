// Authenticated key-recovery lifecycle; no account credentials, storage or backend connection.
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const fixture=vi.hoisted(()=>({principal:undefined as string|undefined,identity:undefined as any,actor:undefined as any,
  generation:0,configured:undefined as string|undefined,recover:vi.fn(),provision:vi.fn(),configure:vi.fn()}));
vi.mock("../../src/features/auth/AuthProvider",()=>({useAuth:()=>({identity:fixture.identity,
  state:fixture.principal?{kind:"authenticated",principal:fixture.principal}:{kind:"anonymous"}})}));
vi.mock("../../src/features/flows/useActor",()=>({useActor:()=>({actor:fixture.actor})}));
vi.mock("../../src/features/openchat/consumerKeypair",()=>({
  configureConsumerKeypairBackend:(identity:any)=>{fixture.configure(identity);fixture.generation++;fixture.configured=identity?.getPrincipal().toText();},
  captureConsumerKeypairSession:(principal?:string)=>{
    if(principal!==fixture.configured)throw new Error("stale session");
    return {principal:fixture.configured,generation:fixture.generation};
  },loadExistingConsumerKeypair:fixture.recover,loadOrCreateConsumerKeypair:fixture.provision,
}));
import { LocalDeliveryKeyProvider,useLocalDeliveryKey } from "../../src/features/openchat/LocalDeliveryKeyProvider";
let keys:ReturnType<typeof useLocalDeliveryKey>,root:Root,container:HTMLDivElement;
const existing={publicKeySpkiPem:"synthetic-pinned-public-key"};
function Probe(){keys=useLocalDeliveryKey();return null;}
const render=async()=>{await act(async()=>root.render(<StrictMode><LocalDeliveryKeyProvider><Probe/></LocalDeliveryKeyProvider></StrictMode>));};
const signIn=(principal="aaaaa-aa")=>{
  fixture.principal=principal;fixture.identity={getPrincipal:()=>({toText:()=>principal,isAnonymous:()=>principal==="2vxsx-fae"})};
  fixture.actor={get_consumer_keypair:vi.fn(async()=>({keypair:[{public_key_pem:existing.publicKeySpkiPem}]}))};
};
function deferred<T>(){let resolve!:(value:T)=>void;return {promise:new Promise<T>(yes=>{resolve=yes;}),resolve:(value:T)=>resolve(value)};}
beforeEach(()=>{
  vi.clearAllMocks();vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);
  fixture.principal=undefined;fixture.identity=undefined;fixture.actor=undefined;fixture.configured=undefined;
  fixture.recover.mockResolvedValue(existing);fixture.provision.mockResolvedValue(existing);
  container=document.createElement("div");document.body.append(container);root=createRoot(container);
});
afterEach(async()=>{await act(async()=>root.unmount());container.remove();vi.unstubAllGlobals();});
describe("private receiver authenticated delivery key provider",()=>{
  it.each([undefined,"2vxsx-fae"])("never recovers or provisions an anonymous key (%s)",async(principal)=>{
    if(principal)signIn(principal);await render();expect(keys.ready).toBe(false);
    await expect(keys.load(true)).rejects.toThrow();await expect(keys.load(false)).rejects.toThrow();
    expect(fixture.recover).not.toHaveBeenCalled();expect(fixture.provision).not.toHaveBeenCalled();
  });
  it("does no key IO on mount and uses receive-only recovery for decrypt",async()=>{
    signIn();await render();expect(keys.ready).toBe(true);expect(fixture.recover).not.toHaveBeenCalled();
    expect(fixture.actor.get_consumer_keypair).not.toHaveBeenCalled();
    expect(await keys.load(false)).toBe(existing);expect(fixture.recover).toHaveBeenCalledOnce();
    expect(fixture.actor.get_consumer_keypair).toHaveBeenCalledTimes(2);expect(fixture.provision).not.toHaveBeenCalled();
  });
  it("permits provisioning only at an explicit authenticated Connect/export call",async()=>{
    signIn();await render();expect(fixture.provision).not.toHaveBeenCalled();
    expect(await keys.load(true)).toBe(existing);expect(fixture.provision).toHaveBeenCalledOnce();expect(fixture.recover).not.toHaveBeenCalled();
  });
  it("does not create or recover when the recipient has no current backend key",async()=>{
    signIn();fixture.actor.get_consumer_keypair.mockResolvedValue({keypair:[]});await render();
    await expect(keys.load(false)).rejects.toThrow("unavailable");
    expect(fixture.recover).not.toHaveBeenCalled();expect(fixture.provision).not.toHaveBeenCalled();
  });
  it.each([false,true])("rejects a key differing from the authoritative pinned PEM (provision %s)",async(provision)=>{
    signIn();fixture.actor.get_consumer_keypair.mockResolvedValue({keypair:[{public_key_pem:"rotated-key"}]});await render();
    await expect(keys.load(provision)).rejects.toThrow("key changed");
  });
  it.each(["logout","identity","actor","generation"])("does not release a key after %s changes during recovery",async(change)=>{
    signIn();await render();const pending=deferred<typeof existing>();fixture.recover.mockReturnValueOnce(pending.promise);
    const result=keys.load(false);const rejection=expect(result).rejects.toThrow();
    await vi.waitFor(()=>expect(fixture.recover).toHaveBeenCalledOnce());
    if(change==="logout"){fixture.principal=undefined;fixture.identity=undefined;fixture.actor=undefined;await render();}
    if(change==="identity"){signIn("rrkah-fqaaa-aaaaa-aaaaq-cai");await render();}
    if(change==="actor"){fixture.actor={...fixture.actor};await render();}
    if(change==="generation")fixture.generation++;
    pending.resolve(existing);await rejection;
  });
  it("rejects a changed session while the pre-recovery key lookup is pending",async()=>{
    signIn();const pending=deferred<any>();fixture.actor.get_consumer_keypair.mockReturnValueOnce(pending.promise);await render();
    const result=keys.load(false);const rejection=expect(result).rejects.toThrow();
    signIn("rrkah-fqaaa-aaaaa-aaaaq-cai");await render();pending.resolve({keypair:[{public_key_pem:existing.publicKeySpkiPem}]});
    await rejection;expect(fixture.recover).not.toHaveBeenCalled();expect(fixture.provision).not.toHaveBeenCalled();
  });
});
