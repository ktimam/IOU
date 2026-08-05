import { IDL } from "@dfinity/candid";
import { Principal } from "@dfinity/principal";
import { describe, expect, it } from "vitest";
import { idlFactory } from "./declarations";

describe("security-sensitive Candid bindings", () => {
  it("exposes only the encrypted close method and round-trips its bounded envelope", () => {
    const service = idlFactory({ IDL }) as any;
    const names = service._fields.map(([name]: [string]) => name);
    expect(names).toContain("close_sheet_encrypted");
    expect(names).not.toContain("close_sheet");

    const method = service._fields.find(
      ([name]: [string]) => name === "close_sheet_encrypted",
    )[1];
    const args = [
      "sheet-1",
      {
        entry_key: new Uint8Array(32),
        ciphertext: new Uint8Array(16),
        iv: new Uint8Array(12),
      },
    ];
    const wire = IDL.encode(method.argTypes, args);
    const decoded = IDL.decode(method.argTypes, wire) as any[];

    expect(decoded[0]).toBe("sheet-1");
    expect(Array.from(decoded[1].entry_key)).toHaveLength(32);
    expect(Array.from(decoded[1].ciphertext)).toHaveLength(16);
    expect(Array.from(decoded[1].iv)).toHaveLength(12);
  });

  it("requires a nat64 epoch for every consumer-key mutation", () => {
    const service = idlFactory({ IDL }) as any;
    const setMethod = service._fields.find(
      ([name]: [string]) => name === "set_consumer_keypair",
    )[1];
    const deleteMethod = service._fields.find(
      ([name]: [string]) => name === "delete_consumer_keypair",
    )[1];
    const getMethod = service._fields.find(
      ([name]: [string]) => name === "get_consumer_keypair",
    )[1];

    const setWire = IDL.encode(setMethod.argTypes, [7n, [1, 2, 3], "PEM"]);
    const setArgs = IDL.decode(setMethod.argTypes, setWire) as any[];
    expect(setArgs[0]).toBe(7n);
    expect(Array.from(setArgs[1])).toEqual([1, 2, 3]);

    const deleteWire = IDL.encode(deleteMethod.argTypes, [8n]);
    expect(IDL.decode(deleteMethod.argTypes, deleteWire)[0]).toBe(8n);

    const stateWire = IDL.encode(getMethod.retTypes, [
      { mutation_epoch: 9n, keypair: [] },
    ]);
    expect(IDL.decode(getMethod.retTypes, stateWire)[0]).toEqual({
      mutation_epoch: 9n,
      keypair: [],
    });
  });

  it("binds OpenChat publication and caller-scoped links to exact safe coordinates", () => {
    const service = idlFactory({ IDL }) as any;
    const names = service._fields.map(([name]: [string]) => name);
    expect(names).toContain("c2c_verify_ai_app_v2");
    expect(names).toContain("set_ai_app_verification_binding");

    const verifier = service._fields.find(
      ([name]: [string]) => name === "c2c_verify_ai_app_v2",
    )[1];
    const p = Principal.fromText("rrkah-fqaaa-aaaaa-aaaaq-cai");
    const binding = {
      user_index_canister_id: p,
      app_id: 7,
      app_revision: 99n,
      owner: p,
      canonical_name: "iou",
      app_canister_id: p,
      inbox_canister_id: [p],
      manifest_hash: new Uint8Array(32).fill(5),
    };
    const args = IDL.decode(
      verifier.argTypes,
      IDL.encode(verifier.argTypes, [{ binding }]),
    ) as any[];
    expect(args[0].binding.app_revision).toBe(99n);
    expect(Array.from(args[0].binding.manifest_hash)).toHaveLength(32);

    const connect = service._fields.find(
      ([name]: [string]) => name === "connect_openchat",
    )[1];
    const linked = {
      Success: {
        iou_principal: p,
        user_index_canister_id: p,
        app_id: 7,
        app_revision: 99n,
        app_canister_id: p,
        key_version: 3n,
        app_subject: new Uint8Array(32).fill(4),
        subject_version: 1,
        consumer_queue_selector: new Uint8Array(32).fill(6),
        consumer_queue_selector_version: 1,
        linked_at: 1n,
      },
    };
    const decoded = IDL.decode(connect.retTypes, IDL.encode(connect.retTypes, [linked])) as any[];
    expect(decoded[0].Success.app_revision).toBe(99n);
    expect(decoded[0].Success.key_version).toBe(3n);
    expect(Array.from(decoded[0].Success.app_subject)).toEqual(new Array(32).fill(4));
    expect(decoded[0].Success.subject_version).toBe(1);
    expect(Array.from(decoded[0].Success.consumer_queue_selector)).toEqual(
      new Array(32).fill(6),
    );
    expect(decoded[0].Success.consumer_queue_selector_version).toBe(1);
    expect(decoded[0].Success).not.toHaveProperty("openchat_user_id");

    const currentBinding = service._fields.find(
      ([name]: [string]) => name === "get_openchat_binding",
    )[1];
    const current = IDL.decode(
      currentBinding.retTypes,
      IDL.encode(currentBinding.retTypes, [[linked.Success]]),
    ) as any[];
    expect(current[0][0].key_version).toBe(3n);
    expect(Array.from(current[0][0].app_subject)).toHaveLength(32);
    expect(Array.from(current[0][0].consumer_queue_selector)).toHaveLength(32);
    expect(current[0][0]).not.toHaveProperty("openchat_user_id");

    const disconnect = service._fields.find(
      ([name]: [string]) => name === "disconnect_openchat",
    )[1];
    const proof = new Uint8Array(64).fill(7);
    const disconnectArgs = IDL.decode(
      disconnect.argTypes,
      IDL.encode(disconnect.argTypes, ["PEM", proof, 123n]),
    ) as any[];
    expect(disconnectArgs[0]).toBe("PEM");
    expect(Array.from(disconnectArgs[1])).toEqual(Array.from(proof));
    expect(disconnectArgs[2]).toBe(123n);
    expect(
      IDL.decode(
        disconnect.retTypes,
        IDL.encode(disconnect.retTypes, [{ KeyNotFound: null }]),
      )[0],
    ).toEqual({ KeyNotFound: null });
  });

  it("encodes exact card and final-confirmation attestation bindings without plaintext Type fields", () => {
    const service = idlFactory({ IDL }) as any;
    const p = Principal.fromText("rrkah-fqaaa-aaaaa-aaaaq-cai");
    const initial = service._fields.find(
      ([name]: [string]) => name === "c2c_attest_ai_app_card_v1",
    )[1];
    const content = {
      title: "Add to IOU",
      rows: [
        { label: "Amount", value: "25" },
        { label: "Type", value: "iou" },
      ],
      confirm_label: "Add to IOU",
      cancel_label: "Cancel",
      action_id: "iou.entry.import",
      disclosure: ["On confirm, an encrypted draft is delivered to your IOU app."],
      expires_at: [],
      confirm_payload: [new TextEncoder().encode('{"amount":25,"kind":"iou"}')],
    };
    const context = {
      context_version: 1,
      app_subject: new Uint8Array(32).fill(3),
      chat_handle: new Uint8Array(32).fill(4),
      message_handle: new Uint8Array(32).fill(5),
      app_id: 7,
      app_revision: 99n,
      action_id: "iou.entry.import",
    };
    const commitment = {
      context,
      content,
    };
    const initialArgs = [{
      binding: {
        user_index_canister_id: p,
        app_canister_id: p,
        commitment,
        authority_content_hash: new Uint8Array(32).fill(1),
      },
    }];
    const decodedInitial = IDL.decode(
      initial.argTypes,
      IDL.encode(initial.argTypes, initialArgs),
    ) as any[];
    expect(decodedInitial[0].binding.commitment.content.rows[1]).toEqual({
      label: "Type",
      value: "iou",
    });
    expect(
      new TextDecoder().decode(
        decodedInitial[0].binding.commitment.content.confirm_payload[0],
      ),
    ).not.toContain("template");
    expect(Array.from(decodedInitial[0].binding.commitment.context.app_subject)).toHaveLength(32);
    expect(decodedInitial[0].binding.commitment.context).not.toHaveProperty("user_id");
    expect(decodedInitial[0].binding.commitment.context).not.toHaveProperty("chat");
    expect(decodedInitial[0].binding.commitment.context).not.toHaveProperty("message_id");
    expect(decodedInitial[0].binding).not.toHaveProperty("commitment_hash");

    const confirmation = service._fields.find(
      ([name]: [string]) => name === "c2c_attest_ai_app_card_confirmation_v1",
    )[1];
    const opaque = new TextEncoder().encode(
      '{"amount":25,"template_ref":"ioutr1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}',
    );
    const finalArgs = [{
      binding: {
        user_index_canister_id: p,
        app_canister_id: p,
        context,
        content_hash: new Uint8Array(32).fill(2),
        confirm_payload: opaque,
        app_user_key_version: [4n],
      },
    }];
    const decodedFinal = IDL.decode(
      confirmation.argTypes,
      IDL.encode(confirmation.argTypes, finalArgs),
    ) as any[];
    const payload = new TextDecoder().decode(
      decodedFinal[0].binding.confirm_payload,
    );
    expect(payload).toContain("template_ref");
    expect(payload).not.toContain('"template":');
    expect(decodedFinal[0].binding.app_user_key_version).toEqual([4n]);
    expect(Array.from(decodedFinal[0].binding.context.chat_handle)).toHaveLength(32);
    expect(Array.from(decodedFinal[0].binding.context.message_handle)).toHaveLength(32);
    expect(decodedFinal[0].binding.context).not.toHaveProperty("chat_key");
    expect(decodedFinal[0].binding.context).not.toHaveProperty("user_id");
  });
});
