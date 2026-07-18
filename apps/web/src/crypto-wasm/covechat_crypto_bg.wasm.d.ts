/* tslint:disable */
/* eslint-disable */
export const memory: WebAssembly.Memory;
export const wasm_create_local_vault: (a: number, b: number, c: number, d: number) => [number, number, number, number];
export const wasm_decrypt_attachment_chunk: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number, number, number];
export const wasm_decrypt_backup: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
export const wasm_decrypt_signal_state: (a: number, b: number, c: number, d: number) => [number, number, number, number];
export const wasm_derive_recovery_signing_keypair: (a: number, b: number, c: number, d: number) => [number, number, number, number];
export const wasm_encrypt_attachment_chunk: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number, number, number];
export const wasm_encrypt_backup: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
export const wasm_encrypt_signal_state: (a: number, b: number, c: number, d: number) => [number, number, number, number];
export const wasm_generate_attachment_key: () => [number, number, number, number];
export const wasm_generate_recovery_secret: () => [number, number, number, number];
export const wasm_generate_signing_keypair: () => [number, number, number, number];
export const wasm_open_local_vault: (a: number, b: number, c: number, d: number) => [number, number, number, number];
export const wasm_sign_payload: (a: number, b: number, c: number, d: number) => [number, number, number, number];
export const wasm_signal_create_device: (a: number, b: number, c: number) => [number, number, number, number];
export const wasm_signal_decrypt: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => [number, number, number, number];
export const wasm_signal_encrypt: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: bigint) => [number, number, number, number];
export const wasm_signal_initiate_session: (a: number, b: number, c: number, d: number, e: bigint) => [number, number, number, number];
export const __wbindgen_free: (a: number, b: number, c: number) => void;
export const __wbindgen_exn_store: (a: number) => void;
export const __externref_table_alloc: () => number;
export const __wbindgen_externrefs: WebAssembly.Table;
export const __wbindgen_malloc: (a: number, b: number) => number;
export const __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
export const __externref_table_dealloc: (a: number) => void;
export const __wbindgen_start: () => void;
