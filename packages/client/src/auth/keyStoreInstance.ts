/**
 * Singleton WebAuthn KeyStore for the app shell. Created once at module load; all auth
 * surfaces import this instance rather than constructing their own (the in-memory key state
 * is closure-local, so multiple instances would be independent unlocked states).
 *
 * On production: uses the live WebAuthn backend (navigator.credentials).
 * In tests: tests construct their own instance via createWebAuthnKeyStore({ backend }).
 */
import { createWebAuthnKeyStore } from '../identity/webAuthnKeyStore.js';

export const keyStore = createWebAuthnKeyStore();
