import * as SecureStore from 'expo-secure-store';
import { useEffect, useRef, useState } from 'react';
import { isSnapshot, type Snapshot } from './contracts';

type Connection = 'disconnected' | 'connecting' | 'connected' | 'error';
type DeviceCredential = { deviceId: string; token: string; bridgeUrl: string };

const CREDENTIAL_KEY = 'ats-companion.device-credential';

export function useBridgeSession() {
  const [bridgeUrl, setBridgeUrl] = useState('');
  const [token, setToken] = useState('');
  const [manualCode, setManualCode] = useState('');
  const [polling, setPolling] = useState(false);
  const [connection, setConnection] = useState<Connection>('disconnected');
  const [connectionMessage, setConnectionMessage] = useState('');
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [stale, setStale] = useState(false);
  const [staleAgeSeconds, setStaleAgeSeconds] = useState(0);
  const [pairing, setPairing] = useState(false);
  const snapshotRef = useRef<Snapshot | null>(null);

  useEffect(() => {
    if (!stale || !snapshot) return;
    const interval = setInterval(() => {
      setStaleAgeSeconds(
        Math.max(0, Math.floor((Date.now() - Date.parse(snapshot.capturedAt)) / 1000)),
      );
    }, 1000);
    return () => clearInterval(interval);
  }, [snapshot, stale]);

  useEffect(() => {
    let active = true;
    SecureStore.getItemAsync(CREDENTIAL_KEY)
      .then((serialized) => {
        if (!serialized || !active) return;
        const saved: unknown = JSON.parse(serialized);
        if (
          !saved ||
          typeof saved !== 'object' ||
          !('deviceId' in saved) ||
          typeof saved.deviceId !== 'string' ||
          !('token' in saved) ||
          typeof saved.token !== 'string' ||
          !('bridgeUrl' in saved) ||
          typeof saved.bridgeUrl !== 'string'
        ) {
          throw new Error('Saved bridge credentials are invalid. Pair this device again.');
        }
        const credential = saved as DeviceCredential;
        setBridgeUrl(credential.bridgeUrl);
        setToken(credential.token);
        setPolling(true);
        setConnection('connecting');
      })
      .catch((error: unknown) => {
        if (active) {
          setConnection('error');
          setConnectionMessage(
            error instanceof Error ? error.message : 'Saved device credentials could not be loaded.',
          );
        }
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!polling) return;

    let active = true;
    let timeout: ReturnType<typeof setTimeout>;
    let controller: AbortController | undefined;

    const poll = async () => {
      const baseUrl = bridgeUrl.trim().replace(/\/+$/, '');
      if (!/^http:\/\/[^/]+$/i.test(baseUrl)) {
        setConnection('error');
        setConnectionMessage('Enter the bridge address, including http:// and its port.');
      } else if (!token.trim()) {
        setConnection('error');
        setConnectionMessage('Enter the pairing token shown in the bridge window.');
      } else {
        setConnection((current) => (current === 'connected' ? current : 'connecting'));
        controller = new AbortController();
        const requestTimeout = setTimeout(() => controller?.abort(), 4000);
        try {
          const response = await fetch(`${baseUrl}/api/v1/snapshot`, {
            headers: { Authorization: `Bearer ${token}` },
            signal: controller.signal,
          });
          const body: unknown = await response.json();

          if (!response.ok) {
            const message =
              body && typeof body === 'object' && 'error' in body
                ? (body as { error?: { message?: string } }).error?.message
                : undefined;
            throw new Error(message || `Bridge returned HTTP ${response.status}.`);
          }
          if (!isSnapshot(body)) {
            throw new Error('The bridge returned telemetry in an unsupported format.');
          }

          if (active) {
            snapshotRef.current = body;
            setSnapshot(body);
            setStale(false);
            setStaleAgeSeconds(0);
            setConnection('connected');
            setConnectionMessage('');
          }
        } catch (error) {
          if (active) {
            const lastSnapshot = snapshotRef.current;
            setStale(lastSnapshot !== null);
            if (lastSnapshot) {
              setStaleAgeSeconds(
                Math.max(0, Math.floor((Date.now() - Date.parse(lastSnapshot.capturedAt)) / 1000)),
              );
            }
            setConnection('error');
            setConnectionMessage(
              error instanceof Error
                ? error.name === 'AbortError'
                  ? 'The bridge did not respond in time.'
                  : error.message
                : 'Could not reach the bridge.',
            );
          }
        } finally {
          clearTimeout(requestTimeout);
        }
      }

      if (active) timeout = setTimeout(poll, 2000);
    };

    void poll();
    return () => {
      active = false;
      clearTimeout(timeout);
      controller?.abort();
    };
  }, [bridgeUrl, polling, token]);

  const pairWithCode = async (targetBridgeUrl: string, pairingCode: string) => {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(targetBridgeUrl.trim().replace(/\/+$/, ''));
    } catch {
      throw new Error('Enter the bridge address shown on the Windows setup page.');
    }
    if (
      parsedUrl.protocol !== 'http:' ||
      !parsedUrl.hostname ||
      parsedUrl.username ||
      parsedUrl.password ||
      parsedUrl.pathname !== '/' ||
      parsedUrl.search ||
      parsedUrl.hash
    ) {
      throw new Error('Use the local http:// bridge address shown on the Windows setup page.');
    }
    const code = pairingCode.trim().toUpperCase();
    if (!/^[23456789A-HJ-NP-Z]{8}$/.test(code)) {
      throw new Error('Enter the eight-character code shown below the QR code.');
    }

    setPairing(true);
    setConnectionMessage('');
    try {
      const response = await fetch(`${parsedUrl.origin}/api/v1/pair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, name: 'ATS Companion mobile' }),
      });
      const body: unknown = await response.json();
      if (!response.ok) {
        const message =
          body && typeof body === 'object' && 'error' in body
            ? (body as { error?: { message?: string } }).error?.message
            : undefined;
        throw new Error(message || `Pairing failed (HTTP ${response.status}).`);
      }
      if (
        !body ||
        typeof body !== 'object' ||
        !('deviceId' in body) ||
        typeof body.deviceId !== 'string' ||
        !('token' in body) ||
        typeof body.token !== 'string'
      ) {
        throw new Error('The bridge returned an invalid device credential.');
      }

      const nextCredential: DeviceCredential = {
        bridgeUrl: parsedUrl.origin,
        deviceId: body.deviceId,
        token: body.token,
      };
      try {
        await SecureStore.setItemAsync(CREDENTIAL_KEY, JSON.stringify(nextCredential));
      } catch (storageError) {
        try {
          const revocation = await fetch(`${nextCredential.bridgeUrl}/api/v1/pairing`, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${nextCredential.token}` },
          });
          if (!revocation.ok) throw new Error(`HTTP ${revocation.status}`);
        } catch (revocationError) {
          console.error('Could not revoke a device after secure storage failed:', revocationError);
        }
        throw storageError;
      }

      setBridgeUrl(nextCredential.bridgeUrl);
      setToken(nextCredential.token);
      setPolling(true);
      setConnection('connecting');
      setManualCode('');
    } finally {
      setPairing(false);
    }
  };

  const disconnect = async () => {
    if (!token || !bridgeUrl) return;
    try {
      const response = await fetch(`${bridgeUrl}/api/v1/pairing`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok && response.status !== 401) {
        throw new Error(`The bridge could not revoke this device (HTTP ${response.status}).`);
      }
      await SecureStore.deleteItemAsync(CREDENTIAL_KEY);
      setPolling(false);
      setToken('');
      setConnection('disconnected');
      setConnectionMessage('');
      setSnapshot(null);
      snapshotRef.current = null;
      setStale(false);
      setStaleAgeSeconds(0);
    } catch (error) {
      setConnectionMessage(
        error instanceof Error ? error.message : 'Could not revoke this device from the bridge.',
      );
    }
  };

  return {
    bridgeUrl,
    setBridgeUrl,
    paired: token !== '',
    manualCode,
    setManualCode,
    connection,
    connectionMessage,
    setConnectionMessage,
    snapshot,
    stale,
    staleAgeSeconds,
    pairing,
    pairWithCode,
    disconnect,
  };
}
