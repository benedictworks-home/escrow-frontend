/**
 * freighter_connector — Freighter browser wallet integration helpers:
 * extension availability detection, signature time limits, and graceful
 * handling of user signature rejections.
 */

import type { ToastType } from "@/app/context/ToastContext";
import { isConnected, getAddress } from "@stellar/freighter-api";

const LOG_PREFIX = "[freighter_connector]";

/** Install URL surfaced when no Freighter extension is detected. */
export const FREIGHTER_INSTALL_URL = "https://www.freighter.app/";

/** Fallback copy shown when the Freighter extension is missing. */
export const FREIGHTER_SETUP_INSTRUCTION =
  "Freighter wallet extension not detected. Install Freighter and refresh this page to continue.";

export type FreighterAvailabilityStatus = "available" | "unavailable" | "error";

export interface FreighterAvailabilityState {
  available: boolean;
  status: FreighterAvailabilityStatus;
  /** User-facing setup instructions when the extension is missing. */
  setupInstruction: string | null;
  warningMessage: string | null;
}

export type FreighterToastHandler = (message: string, type: ToastType) => void;

/** Default bound for Freighter signature requests. */
export const DEFAULT_FREIGHTER_SIGNATURE_TIMEOUT_MS = 60_000;

export interface FreighterSignRequest {
  xdr: string;
  /** Sensitive buffer cleared on timeout / completion. */
  payload?: Uint8Array | null;
}

export class FreighterSignatureTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Freighter signature timed out after ${timeoutMs}ms`);
    this.name = "FreighterSignatureTimeoutError";
  }
}

/** Zeroes and drops a sensitive buffer so it cannot be retained after abort. */
export function clearFreighterSensitiveMemory(
  request: FreighterSignRequest
): FreighterSignRequest {
  if (request.payload) {
    request.payload.fill(0);
  }
  request.payload = null;
  return request;
}

/**
 * Races a Freighter signature operation against a timeout clock. On timeout
 * the operation is aborted and any sensitive payload memory is cleared.
 */
export async function signFreighterWithTimeout<T>(
  request: FreighterSignRequest,
  signFn: (xdr: string) => Promise<T>,
  timeoutMs: number = DEFAULT_FREIGHTER_SIGNATURE_TIMEOUT_MS
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      clearFreighterSensitiveMemory(request);
      reject(new FreighterSignatureTimeoutError(timeoutMs));
    }, timeoutMs);
  });

  try {
    const result = await Promise.race([signFn(request.xdr), timeoutPromise]);
    clearFreighterSensitiveMemory(request);
    return result;
  } catch (err) {
    if (timedOut || err instanceof FreighterSignatureTimeoutError) {
      clearFreighterSensitiveMemory(request);
    }
    throw err;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Detects whether the Freighter browser extension is present. Accepts an
 * optional detector override for tests / non-browser runtimes.
 */
export function detectFreighterExtension(detector?: () => boolean): boolean {
  if (detector) {
    return detector();
  }
  if (typeof window === "undefined") {
    return false;
  }
  const w = window as unknown as Record<string, unknown>;
  return !!(w["freighterApi"] || w["freighter"]);
}

/**
 * Checks Freighter extension availability and returns fallback setup
 * instructions when the extension is missing or the check itself throws.
 */
export function checkFreighterAvailability(
  detector?: () => boolean
): FreighterAvailabilityState {
  try {
    const available = detectFreighterExtension(detector);
    if (available) {
      return {
        available: true,
        status: "available",
        setupInstruction: null,
        warningMessage: null,
      };
    }
    return {
      available: false,
      status: "unavailable",
      setupInstruction: FREIGHTER_SETUP_INSTRUCTION,
      warningMessage: FREIGHTER_SETUP_INSTRUCTION,
    };
  } catch (err) {
    console.warn(
      `${LOG_PREFIX} wallet availability check failed:`,
      err instanceof Error ? err.message : err
    );
    return {
      available: false,
      status: "error",
      setupInstruction: FREIGHTER_SETUP_INSTRUCTION,
      warningMessage: `Unable to verify wallet availability. ${FREIGHTER_SETUP_INSTRUCTION}`,
    };
  }
}

/**
 * Runs a Freighter availability check and surfaces a warning toast when the
 * extension is missing or the check errors.
 */
export function warnOnMissingFreighter(
  showToast: FreighterToastHandler,
  detector?: () => boolean
): FreighterAvailabilityState {
  const state = checkFreighterAvailability(detector);
  if (!state.available && state.warningMessage) {
    showToast(state.warningMessage, "warning");
  }
  return state;
}

export class FreighterUserRejectedError extends Error {
  constructor(message = "user rejected transaction") {
    super(message);
    this.name = "FreighterUserRejectedError";
  }
}

export function isFreighterUserRejected(err: unknown): boolean {
  if (err instanceof FreighterUserRejectedError) return true;
  if (!(err instanceof Error)) return false;
  const message = err.message.toLowerCase();
  return (
    message.includes("user rejected") ||
    message.includes("user declined") ||
    message.includes("request rejected") ||
    message.includes("denied by the user")
  );
}

/**
 * Runs a Freighter signature step. Catches "user rejected transaction"
 * exceptions, logs them, and shows a warning toast instead of surfacing a
 * raw error to the caller.
 */
export async function runFreighterSign<T>(
  signFn: () => Promise<T>,
  showToast: FreighterToastHandler
): Promise<T | null> {
  try {
    return await signFn();
  } catch (err) {
    if (isFreighterUserRejected(err)) {
      console.warn(
        `${LOG_PREFIX} signature rejected by user:`,
        err instanceof Error ? err.message : err
      );
      showToast("Signature cancelled — you rejected the request in your wallet.", "warning");
      return null;
    }
    throw err;
  }
}

export interface PersistedFreighterState {
  version: number;
  address: string;
  network: string;
  connectedAt: number;
}

export const FREIGHTER_PERSIST_KEY = "freighter_active_address_state";

/**
 * Serializes the active address and network state for Freighter to sessionStorage.
 * Treats inputs as public only and does not store secrets.
 */
export function persistFreighterState(address: string, network: string): void {
  if (typeof window === "undefined") return;
  const payload: PersistedFreighterState = {
    version: 1,
    address,
    network,
    connectedAt: Date.now(),
  };
  try {
    window.sessionStorage.setItem(FREIGHTER_PERSIST_KEY, JSON.stringify(payload));
  } catch (err) {
    console.error(`${LOG_PREFIX} Failed to persist freighter state:`, err);
  }
}

/**
 * Clears the persisted Freighter state from sessionStorage.
 */
export function clearPersistedFreighterState(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(FREIGHTER_PERSIST_KEY);
  } catch (err) {
    console.error(`${LOG_PREFIX} Failed to clear persisted freighter state:`, err);
  }
}

/**
 * Attempts to deserialize and validate the persisted Freighter state.
 * Gracefully handles missing, corrupted, or outdated data by falling back to null and clearing the storage.
 */
export function loadAndValidatePersistedFreighterState(): PersistedFreighterState | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(FREIGHTER_PERSIST_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      parsed.version === 1 &&
      typeof parsed.address === "string" &&
      parsed.address.startsWith("G") &&
      parsed.address.length === 56 &&
      typeof parsed.network === "string" &&
      typeof parsed.connectedAt === "number"
    ) {
      return parsed as PersistedFreighterState;
    }
    // Invalid shape/version, clear it and return null
    window.sessionStorage.removeItem(FREIGHTER_PERSIST_KEY);
    return null;
  } catch (err) {
    console.warn(`${LOG_PREFIX} Failed to load/validate persisted freighter state, clearing:`, err);
    try {
      window.sessionStorage.removeItem(FREIGHTER_PERSIST_KEY);
    } catch {}
    return null;
  }
}

/**
 * Re-verifies the rehydrated address against Freighter's live API.
 * Returns the live address if valid and active, or null if the extension is locked,
 * unauthorized, or has switched.
 */
export async function reverifyFreighterState(detector?: () => boolean): Promise<string | null> {
  if (typeof window === "undefined" || !detectFreighterExtension(detector)) {
    return null;
  }
  try {
    const connectedResult = await isConnected();
    if (!connectedResult || !connectedResult.isConnected) {
      return null;
    }

    const addressResult = await getAddress();
    if (!addressResult || !addressResult.address) {
      return null;
    }

    return addressResult.address;
  } catch (err) {
    console.warn(`${LOG_PREFIX} Freighter reverification failed:`, err);
    return null;
  }
}
