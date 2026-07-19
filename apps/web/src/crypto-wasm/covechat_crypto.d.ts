/* tslint:disable */
/* eslint-disable */

export function wasm_create_local_vault(passphrase: string, plaintext_base64: string): string;

export function wasm_decrypt_attachment_chunk(attachment_key: string, object_id_base64: string, chunk_index: number, blob_json: string): string;

export function wasm_decrypt_backup(recovery_secret: string, account_id_base64: string, blob_json: string): string;

export function wasm_decrypt_mls_state(device_private_key: string, blob_json: string): string;

export function wasm_decrypt_signal_state(device_private_key: string, blob_json: string): string;

export function wasm_decrypt_trust_state(device_private_key: string, blob_json: string): string;

export function wasm_derive_recovery_signing_keypair(recovery_secret: string, account_context_base64: string): string;

export function wasm_encrypt_attachment_chunk(attachment_key: string, object_id_base64: string, chunk_index: number, plaintext_base64: string): string;

export function wasm_encrypt_backup(recovery_secret: string, account_id_base64: string, plaintext_base64: string): string;

export function wasm_encrypt_mls_state(device_private_key: string, plaintext_base64: string): string;

export function wasm_encrypt_signal_state(device_private_key: string, plaintext_base64: string): string;

export function wasm_encrypt_trust_state(device_private_key: string, plaintext_base64: string): string;

export function wasm_generate_attachment_key(): string;

export function wasm_generate_recovery_secret(): string;

export function wasm_generate_signing_keypair(): string;

export function wasm_mls_add_member(state_json: string, group_id: string, key_package: string): string;

export function wasm_mls_create_device(identity: string): string;

export function wasm_mls_create_group(state_json: string, group_id_base64: string): string;

export function wasm_mls_delete_group(state_json: string, group_id: string): string;

export function wasm_mls_encrypt(state_json: string, group_id: string, plaintext_base64: string): string;

export function wasm_mls_join_group(state_json: string, welcome: string): string;

export function wasm_mls_process(state_json: string, group_id: string, ciphertext: string): string;

export function wasm_mls_refresh_key_package(state_json: string): string;

export function wasm_mls_remove_member(state_json: string, group_id: string, leaf_index: number): string;

export function wasm_open_local_vault(passphrase: string, vault_json: string): string;

export function wasm_sign_payload(private_key: string, payload_base64: string): string;

export function wasm_signal_create_device(local_name: string, device_id: number): string;

export function wasm_signal_decrypt(state_json: string, remote_name: string, remote_device_id: number, message_type: string, ciphertext: string): string;

export function wasm_signal_encrypt(state_json: string, remote_name: string, remote_device_id: number, plaintext_base64: string, now_millis: bigint): string;

export function wasm_signal_initiate_session(state_json: string, remote_bundle_json: string, now_millis: bigint): string;

export function wasm_signal_refresh_pre_keys(state_json: string, now_millis: bigint): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly wasm_create_local_vault: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly wasm_decrypt_attachment_chunk: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number, number, number];
    readonly wasm_decrypt_backup: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly wasm_decrypt_mls_state: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly wasm_decrypt_signal_state: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly wasm_decrypt_trust_state: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly wasm_derive_recovery_signing_keypair: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly wasm_encrypt_attachment_chunk: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number, number, number];
    readonly wasm_encrypt_backup: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly wasm_encrypt_mls_state: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly wasm_encrypt_signal_state: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly wasm_encrypt_trust_state: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly wasm_generate_attachment_key: () => [number, number, number, number];
    readonly wasm_generate_recovery_secret: () => [number, number, number, number];
    readonly wasm_generate_signing_keypair: () => [number, number, number, number];
    readonly wasm_mls_add_member: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly wasm_mls_create_device: (a: number, b: number) => [number, number, number, number];
    readonly wasm_mls_create_group: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly wasm_mls_delete_group: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly wasm_mls_encrypt: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly wasm_mls_join_group: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly wasm_mls_process: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly wasm_mls_refresh_key_package: (a: number, b: number) => [number, number, number, number];
    readonly wasm_mls_remove_member: (a: number, b: number, c: number, d: number, e: number) => [number, number, number, number];
    readonly wasm_open_local_vault: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly wasm_sign_payload: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly wasm_signal_create_device: (a: number, b: number, c: number) => [number, number, number, number];
    readonly wasm_signal_decrypt: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => [number, number, number, number];
    readonly wasm_signal_encrypt: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: bigint) => [number, number, number, number];
    readonly wasm_signal_initiate_session: (a: number, b: number, c: number, d: number, e: bigint) => [number, number, number, number];
    readonly wasm_signal_refresh_pre_keys: (a: number, b: number, c: bigint) => [number, number, number, number];
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
