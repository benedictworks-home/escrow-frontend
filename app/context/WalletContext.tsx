"use client";
import {
  createContext,
  useContext,
  useState,
  useCallback,
  ReactNode,
  useEffect,
  useRef,
} from "react";
import { Networks, StellarWalletsKit } from "@creit.tech/stellar-wallets-kit";
import { defaultModules } from "@creit.tech/stellar-wallets-kit/modules/utils";
import { NETWORK_PASSPHRASE } from "@/app/lib/contract";
import { useToast } from "./ToastContext";
import {
  persistFreighterState,
  clearPersistedFreighterState,
  loadAndValidatePersistedFreighterState,
  reverifyFreighterState,
} from "@/app/lib/freighter_connector";

const STORAGE_KEY = "milesto_wallet_connected";

export const SUPPORTED_WALLETS = [
  { id: "freighter", label: "Freighter" },
  { id: "albedo", label: "Albedo" },
  { id: "xbull", label: "xBull" },
  { id: "hana", label: "Hana" },
] as const;

export type SupportedWalletId = (typeof SUPPORTED_WALLETS)[number]["id"];

interface KitSignResult {
  signedTxXdr?: string;
}

interface WalletContextType {
  address: string | null;
  connect: () => Promise<void>;
  disconnect: () => void;
  isConnecting: boolean;
  networkMismatch: boolean;
  selectedWalletId: SupportedWalletId;
  setSelectedWalletId: (walletId: SupportedWalletId) => void;
  signTransaction: (xdr: string) => Promise<string>;
}

const WalletContext = createContext<WalletContextType>({
  address: null,
  connect: async () => {},
  disconnect: () => {},
  isConnecting: false,
  networkMismatch: false,
  selectedWalletId: SUPPORTED_WALLETS[0].id,
  setSelectedWalletId: () => {},
  signTransaction: async () => "",
});

export function WalletProvider({ children }: { children: ReactNode }) {
  const [address, setAddress] = useState<string | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [selectedWalletId, setSelectedWalletId] = useState<SupportedWalletId>(
    SUPPORTED_WALLETS[0].id
  );
  const [networkMismatch, setNetworkMismatch] = useState(false);
  const initializedRef = useRef(false);
  const { showToast } = useToast();

  const checkNetwork = useCallback(async () => {
    try {
      const result = await StellarWalletsKit.getNetwork();
      setNetworkMismatch(result.networkPassphrase !== NETWORK_PASSPHRASE);
    } catch (e) {
      console.error("Failed to check network", e);
      setNetworkMismatch(false);
    }
  }, []);

  const ensureKitInitialized = useCallback(() => {
    if (initializedRef.current) return;

    const allowedIds = new Set<string>(SUPPORTED_WALLETS.map((wallet) => wallet.id));

    StellarWalletsKit.init({
      modules: defaultModules({
        filterBy: (module: { productId: string }) => allowedIds.has(module.productId),
      }),
      network: Networks.TESTNET,
      authModal: {
        showInstallLabel: true,
        hideUnsupportedWallets: false,
      },
    });

    initializedRef.current = true;
  }, []);

  useEffect(() => {
    if (selectedWalletId !== "freighter") {
      clearPersistedFreighterState();
    }
  }, [selectedWalletId]);

  useEffect(() => {
    ensureKitInitialized();

    let active = true;

    // Check if there is a valid persisted Freighter state first
    const persistedFreighter = loadAndValidatePersistedFreighterState();
    if (persistedFreighter) {
      reverifyFreighterState().then(async (liveAddress) => {
        if (!active) return;
        if (liveAddress) {
          setAddress(liveAddress);
          setSelectedWalletId("freighter");
          localStorage.setItem(STORAGE_KEY, "true");
          try {
            const freighterApi = await import("@stellar/freighter-api");
            const net = await freighterApi.getNetwork();
            persistFreighterState(liveAddress, net.networkPassphrase || net.network || "TESTNET");
          } catch (e) {
            console.error("Failed to update persisted freighter state network", e);
          }
          await checkNetwork();
        } else {
          clearPersistedFreighterState();
          // Fallback to standard kit if milesto_wallet_connected is true
          if (localStorage.getItem(STORAGE_KEY) === "true") {
            try {
              StellarWalletsKit.setWallet("freighter");
              const result = await StellarWalletsKit.getAddress();
              if (result.address && active) {
                setAddress(result.address);
                await checkNetwork();
              } else {
                localStorage.removeItem(STORAGE_KEY);
                setAddress(null);
              }
            } catch {
              localStorage.removeItem(STORAGE_KEY);
              setAddress(null);
            }
          } else {
            setAddress(null);
          }
        }
      }).catch(() => {
        if (!active) return;
        clearPersistedFreighterState();
        setAddress(null);
      });
      return () => {
        active = false;
      };
    }

    if (localStorage.getItem(STORAGE_KEY) !== "true") return;

    StellarWalletsKit.getAddress()
      .then(async (result: { address?: string }) => {
        if (!active) return;
        if (result.address) {
          setAddress(result.address);
          await checkNetwork();
        } else {
          localStorage.removeItem(STORAGE_KEY);
        }
      })
      .catch(() => {
        // Previously-connected wallet is no longer reachable.
        localStorage.removeItem(STORAGE_KEY);
      });

    return () => {
      active = false;
    };
  }, [ensureKitInitialized, checkNetwork]);

  const connect = useCallback(async () => {
    setIsConnecting(true);
    try {
      ensureKitInitialized();
      StellarWalletsKit.setWallet(selectedWalletId);

      const result = (await StellarWalletsKit.authModal()) as { address?: string };
      if (result.address) {
        setAddress(result.address);
        await checkNetwork();
        localStorage.setItem(STORAGE_KEY, "true");
        if (selectedWalletId === "freighter") {
          try {
            const freighterApi = await import("@stellar/freighter-api");
            const net = await freighterApi.getNetwork();
            persistFreighterState(result.address, net.networkPassphrase || net.network || "TESTNET");
          } catch (e) {
            console.error("Failed to persist freighter state network", e);
          }
        }
      }
    } catch (e) {
      console.error("Wallet connection failed", e);
      showToast("Failed to connect wallet.", "error");
    } finally {
      setIsConnecting(false);
    }
  }, [ensureKitInitialized, selectedWalletId, checkNetwork, showToast]);

  const disconnect = useCallback(() => {
    StellarWalletsKit.disconnect().catch((e) => {
      console.error("Wallet disconnect failed", e);
    });
    localStorage.removeItem(STORAGE_KEY);
    clearPersistedFreighterState();
    setNetworkMismatch(false);
    setAddress(null);
  }, []);

  const signTransaction = useCallback(async (xdr: string): Promise<string> => {
    if (!address) throw new Error("Wallet not connected");

    ensureKitInitialized();
    StellarWalletsKit.setWallet(selectedWalletId);

    const result = (await StellarWalletsKit.signTransaction(xdr, {
      address,
      networkPassphrase: NETWORK_PASSPHRASE,
    })) as KitSignResult;

    return result.signedTxXdr ?? "";
  }, [address, ensureKitInitialized, selectedWalletId]);

  return (
    <WalletContext.Provider
      value={{
        address,
        connect,
        disconnect,
        isConnecting,
        networkMismatch,
        selectedWalletId,
        setSelectedWalletId,
        signTransaction,
      }}
    >
      {children}
    </WalletContext.Provider>
  );
}

export const useWallet = () => useContext(WalletContext);
