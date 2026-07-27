import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  persistFreighterState,
  clearPersistedFreighterState,
  loadAndValidatePersistedFreighterState,
  reverifyFreighterState,
  FREIGHTER_PERSIST_KEY,
} from "@/app/lib/freighter_connector";

const mockIsConnected = vi.fn();
const mockGetAddress = vi.fn();

vi.mock("@stellar/freighter-api", () => ({
  isConnected: () => mockIsConnected(),
  getAddress: () => mockGetAddress(),
}));

class SessionStorageMock {
  private store: Record<string, string> = {};

  getItem(key: string) {
    return this.store[key] || null;
  }

  setItem(key: string, value: string) {
    this.store[key] = String(value);
  }

  removeItem(key: string) {
    delete this.store[key];
  }

  clear() {
    this.store = {};
  }
}

describe("freighter_connector state persistence", () => {
  const mockAddress = "GA2C5RFPE6STU47ZL6Z6S6S6S6S6S6S6S6S6S6S6S6S6S6S6S6S6S6S6";
  const mockNetwork = "testnet";

  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(window, "sessionStorage", {
      value: new SessionStorageMock(),
      configurable: true,
    });

    // Inject freighter globals to simulate browser extension availability
    (window as any).freighter = {};
  });

  afterEach(() => {
    delete (window as any).freighter;
  });

  it("should successfully serialize and persist the active address and network", () => {
    persistFreighterState(mockAddress, mockNetwork);

    const storedStr = window.sessionStorage.getItem(FREIGHTER_PERSIST_KEY);
    expect(storedStr).not.toBeNull();

    const storedObj = JSON.parse(storedStr!);
    expect(storedObj.version).toBe(1);
    expect(storedObj.address).toBe(mockAddress);
    expect(storedObj.network).toBe(mockNetwork);
    expect(typeof storedObj.connectedAt).toBe("number");
  });

  it("should clear the persisted state", () => {
    persistFreighterState(mockAddress, mockNetwork);
    expect(window.sessionStorage.getItem(FREIGHTER_PERSIST_KEY)).not.toBeNull();

    clearPersistedFreighterState();
    expect(window.sessionStorage.getItem(FREIGHTER_PERSIST_KEY)).toBeNull();
  });

  it("should load and validate valid persisted state", () => {
    persistFreighterState(mockAddress, mockNetwork);

    const state = loadAndValidatePersistedFreighterState();
    expect(state).not.toBeNull();
    expect(state!.version).toBe(1);
    expect(state!.address).toBe(mockAddress);
    expect(state!.network).toBe(mockNetwork);
  });

  it("should return null and clear the persisted state if corrupted or invalid version", () => {
    // Malformed JSON
    window.sessionStorage.setItem(FREIGHTER_PERSIST_KEY, "{invalid json");
    let state = loadAndValidatePersistedFreighterState();
    expect(state).toBeNull();
    expect(window.sessionStorage.getItem(FREIGHTER_PERSIST_KEY)).toBeNull();

    // Invalid version
    const invalidVersionPayload = {
      version: 2,
      address: mockAddress,
      network: mockNetwork,
      connectedAt: Date.now(),
    };
    window.sessionStorage.setItem(FREIGHTER_PERSIST_KEY, JSON.stringify(invalidVersionPayload));
    state = loadAndValidatePersistedFreighterState();
    expect(state).toBeNull();
    expect(window.sessionStorage.getItem(FREIGHTER_PERSIST_KEY)).toBeNull();

    // Missing keys
    const missingKeysPayload = {
      version: 1,
      address: mockAddress,
      connectedAt: Date.now(),
    };
    window.sessionStorage.setItem(FREIGHTER_PERSIST_KEY, JSON.stringify(missingKeysPayload));
    state = loadAndValidatePersistedFreighterState();
    expect(state).toBeNull();
    expect(window.sessionStorage.getItem(FREIGHTER_PERSIST_KEY)).toBeNull();

    // Invalid Stellar address shape
    const invalidAddressPayload = {
      version: 1,
      address: "not-a-stellar-address",
      network: mockNetwork,
      connectedAt: Date.now(),
    };
    window.sessionStorage.setItem(FREIGHTER_PERSIST_KEY, JSON.stringify(invalidAddressPayload));
    state = loadAndValidatePersistedFreighterState();
    expect(state).toBeNull();
    expect(window.sessionStorage.getItem(FREIGHTER_PERSIST_KEY)).toBeNull();
  });

  it("should never serialize sensitive data/secrets", () => {
    persistFreighterState(mockAddress, mockNetwork);
    const storedStr = window.sessionStorage.getItem(FREIGHTER_PERSIST_KEY);
    const storedObj = JSON.parse(storedStr!);

    // Ensure absolutely no secret-bearing properties are present
    const allowedKeys = ["version", "address", "network", "connectedAt"];
    Object.keys(storedObj).forEach((key) => {
      expect(allowedKeys).toContain(key);
    });
  });

  describe("reverifyFreighterState", () => {
    it("should return live address when Freighter is connected and authorized", async () => {
      mockIsConnected.mockResolvedValue({ isConnected: true });
      mockGetAddress.mockResolvedValue({ address: mockAddress });

      const verifiedAddress = await reverifyFreighterState();
      expect(verifiedAddress).toBe(mockAddress);
      expect(mockIsConnected).toHaveBeenCalled();
      expect(mockGetAddress).toHaveBeenCalled();
    });

    it("should return null when Freighter is not connected", async () => {
      mockIsConnected.mockResolvedValue({ isConnected: false });

      const verifiedAddress = await reverifyFreighterState();
      expect(verifiedAddress).toBeNull();
      expect(mockGetAddress).not.toHaveBeenCalled();
    });

    it("should return null when Freighter getAddress fails or returns no address", async () => {
      mockIsConnected.mockResolvedValue({ isConnected: true });
      mockGetAddress.mockResolvedValue({ address: "", error: "Locked" });

      const verifiedAddress = await reverifyFreighterState();
      expect(verifiedAddress).toBeNull();
    });

    it("should return null if extension is not present", async () => {
      delete (window as any).freighter;
      const verifiedAddress = await reverifyFreighterState();
      expect(verifiedAddress).toBeNull();
    });
  });
});
